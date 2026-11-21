// Offline shell only. API calls are never cached: they always go to your server.
const CACHE = 'omarchy-server-v3'

const isHtml = (res) => /(?:^|[\s;,])text\/html(?:$|[\s;,])/i.test(res?.headers?.get?.('content-type') ?? '')
const canCacheAsset = (res) => Boolean(res && res.ok && res.status !== 206 && !isHtml(res))
const canCacheNav = (res) => Boolean(res && res.ok && res.status !== 206)

function assetPaths(html) {
	const out = new Set()
	for (const m of String(html).matchAll(/["'](\/assets\/[^"'?#\s>]+)["']/g)) out.add(m[1])
	return out
}

function sameSet(a, b) {
	if (a.size !== b.size) return false
	for (const x of a) if (!b.has(x)) return false
	return true
}

async function pruneAssets(cache, keep) {
	const keys = await cache.keys()
	await Promise.all(
		keys.map((req) => {
			const path = new URL(req.url, location.origin).pathname
			if (path.startsWith('/assets/') && !keep.has(path)) return cache.delete(req)
		}),
	)
}

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.ico', '/favicon-32.png', '/icon-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(async () => {
				const c = await caches.open(CACHE)
				const shell = await c.match('/')
				if (!shell || !canCacheNav(shell)) return
				const keep = assetPaths(await shell.text())
				if (keep.size > 0) await pruneAssets(c, keep)
			})
			.then(() => self.clients.claim()),
	)
})

self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url)
	if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
	if (url.pathname.startsWith('/assets/')) {
		e.respondWith(
			caches.match(e.request).then((hit) => {
				if (canCacheAsset(hit)) return hit
				return fetch(e.request).then((res) => {
					if (canCacheAsset(res)) {
						const copy = res.clone()
						const work = caches.open(CACHE).then((c) => c.put(e.request, copy))
						e.waitUntil?.(work)
					}
					return res
				})
			}),
		)
		return
	}
	if (e.request.mode === 'navigate') {
		e.respondWith(
			fetch(e.request)
				.then((res) => {
					if (canCacheNav(res)) {
						const copy = res.clone()
						const htmlCopy = res.clone()
						const work = caches.open(CACHE).then(async (c) => {
							const prev = await c.match('/')
							await c.put('/', copy)
							if (prev && canCacheNav(prev)) {
								const oldAssets = assetPaths(await prev.text())
								const newAssets = assetPaths(await htmlCopy.text())
								if (newAssets.size && !sameSet(oldAssets, newAssets)) await pruneAssets(c, newAssets)
							}
						})
						e.waitUntil?.(work)
					}
					return res
				})
				.catch(() => caches.match('/')),
		)
	}
})
