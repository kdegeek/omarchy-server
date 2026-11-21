// HTTP caching, static fallback 404s, and Allow / Retry-After headers in server/app.mjs.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

async function startTestApp(t, {staticDir, withBackend = true} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'server-headers-'))
	const fake = withBackend ? await startFakeserverd({accessTtlMs: 60 * 60 * 1000}) : null
	const store = await createStore(join(root, 'store'))
	if (fake) await store.setConfig({backendUrl: fake.url})
	const app = createApp({store, staticDir, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	t.after(async () => {
		app.closeRelays()
		await new Promise((r) => server.close(r))
		if (fake) await fake.close()
		await rm(root, {recursive: true, force: true})
	})
	const base = `http://127.0.0.1:${server.address().port}`
	let cookie = ''
	const req = async (method, path, body) => {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? {'content-type': 'application/json'} : {}),
				...(method !== 'GET' ? {'x-omarchy-server': '1'} : {}),
				...(cookie ? {cookie} : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		const set = res.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid='))
		if (set) cookie = set.split(';')[0]
		return res
	}
	return {root, base, req, signIn: async () => assert.equal((await req('POST', '/api/auth/login', {username: 'Chris', password: 'correct horse'})).status, 200)}
}

test('failed thumbnail responses are not cached; successful thumbnails are cached (#444)', async (t) => {
	const s = await startTestApp(t)
	await s.signIn()

	const miss = await s.req('GET', '/api/files/thumbnail/x.jpg?path=/nonexist')
	assert.equal(miss.status, 404)
	assert.equal(miss.headers.get('cache-control'), 'private, no-store')

	const ok = await s.req('GET', '/api/files/thumbnail/Sunset.webp?path=/Home/Photos/Sunset.jpg')
	assert.equal(ok.status, 200)
	assert.equal(ok.headers.get('cache-control'), 'private, max-age=3600')

	const view = await s.req('GET', '/api/files/view?path=/Home/Photos/Sunset.jpg')
	assert.equal(view.status, 200)
	assert.equal(view.headers.get('cache-control'), 'private, no-store')
})
