// Service worker: never cache failed or HTML-fallback asset responses, and prune stale assets.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'
import vm from 'node:vm'

const SW_SOURCE = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://server.local'

function createSwEnv(initialCaches = {}) {
	const store = new Map()
	for (const [name, entries] of Object.entries(initialCaches)) {
		const map = new Map()
		for (const [path, res] of Object.entries(entries)) {
			map.set(new URL(path, ORIGIN).href, res)
		}
		store.set(name, map)
	}

	const makeCache = (map) => ({
		async put(req, res) {
			const key = new URL(typeof req === 'string' ? req : req.url, ORIGIN).href
			map.set(key, res.clone())
		},
		async match(req) {
			const key = new URL(typeof req === 'string' ? req : req.url, ORIGIN).href
			const hit = map.get(key)
			return hit ? hit.clone() : undefined
		},
		async addAll(urls) {
			await Promise.all(
				urls.map(async (u) => {
					const req = new Request(new URL(u, ORIGIN).href)
					const res = await fetchFn(req)
					if (!res.ok) throw new Error(`Failed to cache ${u}: ${res.status}`)
					await this.put(req, res)
				}),
			)
		},
		async keys() {
			return Array.from(map.keys(), (u) => new Request(u))
		},
		async delete(req) {
			const key = new URL(typeof req === 'string' ? req : req.url, ORIGIN).href
			return map.delete(key)
		},
	})

	const caches = {
		async open(name) {
			if (!store.has(name)) store.set(name, new Map())
			return makeCache(store.get(name))
		},
		async match(req) {
			const key = new URL(typeof req === 'string' ? req : req.url, ORIGIN).href
			for (const map of store.values()) {
				const hit = map.get(key)
				if (hit) return hit.clone()
			}
			return undefined
		},
		async keys() {
			return Array.from(store.keys())
		},
		async delete(name) {
			return store.delete(name)
		},
	}

	const listeners = new Map()
	let fetchHandler = async () => new Response('missing', {status: 404})
	const fetchCalls = []
	const fetchFn = async (req) => {
		const r = req instanceof Request ? req : new Request(new URL(typeof req === 'string' ? req : req.url, ORIGIN).href)
		fetchCalls.push(r.url)
		return fetchHandler(r)
	}

	const selfObj = {
		addEventListener(type, fn) {
			const list = listeners.get(type) ?? []
			list.push(fn)
			listeners.set(type, list)
		},
		skipWaiting: async () => {},
		clients: {claim: async () => {}},
	}

	const context = {
		self: selfObj,
		caches,
		fetch: fetchFn,
		location: {origin: ORIGIN},
		URL,
		Request,
		Response,
		Headers,
		Promise,
		Set,
		Map,
		Array,
		RegExp,
	}
	vm.runInNewContext(SW_SOURCE, context, {filename: 'web/public/sw.js'})

	async function dispatchLifecycle(type) {
		const waits = []
		for (const fn of listeners.get(type) ?? []) {
			fn({waitUntil: (p) => waits.push(Promise.resolve(p))})
		}
		await Promise.all(waits)
	}

	async function dispatchFetch(path, {mode = 'cors'} = {}) {
		const url = new URL(path, ORIGIN).href
		const request = {url, method: 'GET', mode}
		const waits = []
		let responded
		const event = {
			request,
			waitUntil: (p) => waits.push(Promise.resolve(p)),
			respondWith: (p) => {
				responded = Promise.resolve(p)
			},
		}
		for (const fn of listeners.get('fetch') ?? []) fn(event)
		const response = responded ? await responded : await fetchFn(request)
		await Promise.all(waits)
		return response
	}

	return {
		store,
		caches,
		fetchCalls,
		setFetch(fn) {
			fetchHandler = fn
		},
		dispatchLifecycle,
		dispatchFetch,
		activeCacheName() {
			return Array.from(store.keys())[0]
		},
		cachedPaths(cacheName) {
			const map = store.get(cacheName)
			return map ? Array.from(map.keys(), (u) => new URL(u).pathname) : []
		},
	}
}

const htmlShell = (assets) =>
	`<!doctype html><html><head>${assets.map((a) => `<script type="module" src="${a}"></script>`).join('')}</head><body>ok</body></html>`

describe('service worker', () => {
	test('failed navigation responses (502/503) do not overwrite the cached offline shell', async () => {
		const env = createSwEnv()
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/app-v1.js']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('icon', {status: 200, headers: {'content-type': 'image/png'}})
		})
		await env.dispatchLifecycle('install')
		await env.dispatchLifecycle('activate')

		for (const status of [502, 503]) {
			env.setFetch(async () => new Response(`bad gateway ${status}`, {status, headers: {'content-type': 'text/html'}}))
			const errRes = await env.dispatchFetch('/', {mode: 'navigate'})
			assert.equal(errRes.status, status)
		}

		env.setFetch(async () => {
			throw new Error('offline')
		})
		const offlineRes = await env.dispatchFetch('/', {mode: 'navigate'})
		assert.equal(offlineRes.status, 200)
		assert.match(await offlineRes.text(), /\/assets\/app-v1\.js/)
	})

	test('asset errors (404/500) and text/html fallbacks are not cached; valid JS assets are cached', async () => {
		const env = createSwEnv()
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/app-v1.js']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('ok', {status: 200})
		})
		await env.dispatchLifecycle('install')
		await env.dispatchLifecycle('activate')
		const cacheName = env.activeCacheName()

		env.setFetch(async () => new Response('not found', {status: 404, headers: {'content-type': 'text/plain'}}))
		assert.equal((await env.dispatchFetch('/assets/missing-404.js')).status, 404)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/missing-404.js'), false)

		env.setFetch(async () => new Response('server err', {status: 500, headers: {'content-type': 'text/plain'}}))
		assert.equal((await env.dispatchFetch('/assets/missing-500.js')).status, 500)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/missing-500.js'), false)

		env.setFetch(async () => new Response('<!doctype html><html></html>', {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}}))
		assert.equal((await env.dispatchFetch('/assets/missing-spa.js')).status, 200)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/missing-spa.js'), false)

		env.setFetch(async () => new Response('console.log(1)', {status: 200, headers: {'content-type': 'application/javascript'}}))
		env.fetchCalls.length = 0
		const first = await env.dispatchFetch('/assets/app-v1.js')
		assert.equal(first.status, 200)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/app-v1.js'), true)
		assert.equal(env.fetchCalls.length, 1)

		const second = await env.dispatchFetch('/assets/app-v1.js')
		assert.equal(await second.text(), 'console.log(1)')
		assert.equal(env.fetchCalls.length, 1, 'second asset load should come from cache')
	})

	test('pre-existing poisoned HTML entry under /assets/ in cache is bypassed and replaced on refetch', async () => {
		const env = createSwEnv()
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/poison.js']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('ok', {status: 200})
		})
		await env.dispatchLifecycle('install')
		await env.dispatchLifecycle('activate')
		const cacheName = env.activeCacheName()
		const c = await env.caches.open(cacheName)
		await c.put('/assets/poison.js', new Response('<html>poison</html>', {status: 200, headers: {'content-type': 'text/html'}}))

		env.fetchCalls.length = 0
		env.setFetch(async () => new Response('console.log("clean")', {status: 200, headers: {'content-type': 'application/javascript'}}))
		const res = await env.dispatchFetch('/assets/poison.js')
		assert.equal(await res.text(), 'console.log("clean")')
		assert.equal(env.fetchCalls.length, 1)
	})

	test('activate drops old cache names and prunes unreferenced /assets/ while keeping shell and referenced assets', async () => {
		const env = createSwEnv({
			'omarchy-server-v1': {'/': new Response('old', {status: 200})},
			'omarchy-server-v2': {'/assets/legacy.js': new Response('old', {status: 200})},
		})
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/app-v2.js', '/assets/app-v2.css']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('icon', {status: 200})
		})
		await env.dispatchLifecycle('install')
		const cacheName = Array.from(env.store.keys()).find((k) => k !== 'omarchy-server-v1' && k !== 'omarchy-server-v2')
		assert.ok(cacheName)
		const active = await env.caches.open(cacheName)
		await active.put('/assets/app-v2.js', new Response('new js', {status: 200, headers: {'content-type': 'application/javascript'}}))
		await active.put('/assets/stale-v1.js', new Response('stale js', {status: 200, headers: {'content-type': 'application/javascript'}}))

		await env.dispatchLifecycle('activate')
		assert.equal(env.store.has('omarchy-server-v1'), false)
		assert.equal(env.store.has('omarchy-server-v2'), false)
		const kept = env.cachedPaths(cacheName)
		assert.equal(kept.includes('/'), true)
		assert.equal(kept.includes('/icon-192.png'), true)
		assert.equal(kept.includes('/assets/app-v2.js'), true)
		assert.equal(kept.includes('/assets/stale-v1.js'), false)
	})

	test('navigate evicts old /assets/ when index.html updates, and keeps lazy chunks when shell asset list is unchanged', async () => {
		const env = createSwEnv()
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/app-v1.js']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('asset', {status: 200, headers: {'content-type': 'application/javascript'}})
		})
		await env.dispatchLifecycle('install')
		await env.dispatchLifecycle('activate')
		const cacheName = env.activeCacheName()

		await env.dispatchFetch('/assets/app-v1.js')
		await env.dispatchFetch('/assets/Settings-v1.js')

		// Same index.html asset set: lazy chunk Settings-v1.js must remain cached.
		await env.dispatchFetch('/', {mode: 'navigate'})
		assert.equal(env.cachedPaths(cacheName).includes('/assets/Settings-v1.js'), true)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/app-v1.js'), true)

		// Updated index.html referencing v2: stale v1 assets and old lazy chunks are evicted.
		env.setFetch(async (req) => {
			const p = new URL(req.url).pathname
			if (p === '/') return new Response(htmlShell(['/assets/app-v2.js']), {status: 200, headers: {'content-type': 'text/html'}})
			return new Response('asset-v2', {status: 200, headers: {'content-type': 'application/javascript'}})
		})
		await env.dispatchFetch('/', {mode: 'navigate'})
		assert.equal(env.cachedPaths(cacheName).includes('/assets/app-v1.js'), false)
		assert.equal(env.cachedPaths(cacheName).includes('/assets/Settings-v1.js'), false)
		assert.equal(env.cachedPaths(cacheName).includes('/'), true)
	})
})
