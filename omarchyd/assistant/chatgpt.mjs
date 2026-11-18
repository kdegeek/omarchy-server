// Sign in with ChatGPT (OpenAI's open-source "ChatGPT plan usage" flow): the assistant uses the
// person's own ChatGPT Plus or Pro plan instead of an API key.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// - OpenID Connect with PKCE. The first sign-in registers this install (client_id=dynamic_agent_client);
//   OpenAI returns an issued client id, kept with that account's tokens.
// - OpenAI only redirects to an http://127.0.0.1:<port>/auth/callback address. When the browser is on
//   this server, omarchyd catches it on that port. From a phone or another computer, that page won't
//   load: the person pastes its address back into Omarchy Server, which checks it the same way.
// - Tokens stay in omarchyd (keys.json, 0600) and never reach the browser. Access tokens last an hour
//   and are refreshed here; each refresh rotates the refresh token.
import {createHash, createPublicKey, randomBytes, randomUUID, verify} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import http from 'node:http'
import {join} from 'node:path'

import {RpcError} from '../rpc.mjs'

export const AUTH = 'https://auth.openai.com'
export const AUTHORIZE = `${AUTH}/api/accounts/authorize`
export const TOKEN = `${AUTH}/api/accounts/oauth/token`
export const JWKS = `${AUTH}/.well-known/jwks.json`
export const RESOURCE = 'https://api.openai.com/v1'
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const AGENT_NAME = 'Omarchy Server'
const PORTS = [1455, 1456, 1457, 1458, 1459, 1460]
const PENDING_MS = 10 * 60_000
// Refresh errors that mean the sign-in is over: sign in again.
const SIGNED_OUT = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const fromB64url = (s) => Buffer.from(String(s), 'base64url')
const SIGN_IN_AGAIN = 'Sign in with ChatGPT again in Settings → Assistant'

// Check an ID token's signature (RS256, OpenAI's published keys) and claims.
export async function verifyIdToken(idToken, {clientId, nonce, fetchImpl = fetch, now = Date.now}) {
	const parts = String(idToken ?? '').split('.')
	if (parts.length !== 3) throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	let header, claims
	try {
		header = JSON.parse(fromB64url(parts[0]).toString('utf8'))
		claims = JSON.parse(fromB64url(parts[1]).toString('utf8'))
	} catch {
		throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	}
	if (header.alg !== 'RS256') throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	const res = await fetchImpl(JWKS, {signal: AbortSignal.timeout(15_000)})
	if (!res.ok) throw new RpcError('BAD_GATEWAY', 'Couldn’t reach ChatGPT to check the sign-in')
	const {keys = []} = await res.json()
	const jwk = keys.find((k) => k.kid === header.kid) ?? (header.kid ? null : keys[0])
	if (!jwk) throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({key: jwk, format: 'jwk'}), fromB64url(parts[2]))
	if (!ok) throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
	if (claims.iss !== AUTH || !aud.includes(clientId) || claims.nonce !== nonce || !claims.sub) throw new RpcError('BAD_GATEWAY', 'ChatGPT sent an invalid sign-in')
	if (typeof claims.exp !== 'number' || claims.exp * 1000 < now() - 60_000) throw new RpcError('BAD_GATEWAY', 'That sign-in has expired; try again')
	return claims
}

export function createChatGpt({dataDir, keys, fetchImpl = fetch, now = Date.now, listen = true, ports = PORTS}) {
	const pending = new Map() // userId -> one sign-in at a time
	const refreshing = new Map() // keyId -> promise (refreshes are serialized)

	// Stable per install, opaque, not a credential: urn:uuid, generated once.
	let hostIdP = null
	const hostId = () =>
		(hostIdP ??= (async () => {
			const file = join(dataDir, 'assistant', 'chatgpt-host-id')
			const have = (await readFile(file, 'utf8').catch(() => '')).trim()
			if (/^urn:uuid:[0-9a-f-]{36}$/.test(have)) return have
			const id = `urn:uuid:${randomUUID()}`
			await mkdir(join(dataDir, 'assistant'), {recursive: true, mode: 0o700})
			await writeFile(file, `${id}\n`, {mode: 0o600})
			return id
		})())

	const closeListener = (p) => {
		if (p?.server) p.server.close()
		if (p) p.server = null
	}
	const drop = (userId) => {
		const p = pending.get(userId)
		closeListener(p)
		clearTimeout(p?.timer)
		pending.delete(userId)
	}

	// A short-lived listener on 127.0.0.1 for a browser on this machine. Busy port: the next one.
	async function openListener(p, userId) {
		for (const port of ports) {
			const server = http.createServer((req, res) => {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
				if (url.pathname !== '/auth/callback') return res.writeHead(404).end()
				finish(userId, url.href).then(
					() => page(res, 200, 'Signed in to ChatGPT', 'You can close this tab and go back to Omarchy Server.'),
					(e) => page(res, 400, 'Couldn’t sign in', e.message),
				)
			})
			const ok = await new Promise((resolve) => {
				server.once('error', () => resolve(false))
				server.listen(port, '127.0.0.1', () => resolve(true))
			})
			if (ok) {
				p.server = server
				return port
			}
		}
		return ports[0] // nothing free here: the pasted address still works
	}
	const page = (res, status, title, body) => {
		const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c])
		res.writeHead(status, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'})
		res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui;margin:3em auto;max-width:28em;padding:0 1em"><h1>${esc(title)}</h1><p>${esc(body)}</p>`)
	}

	// Start: the address to open. `keyId` signs an existing ChatGPT row in again (same issued client).
	async function start(userId, {keyId} = {}) {
		drop(userId)
		const again = keyId ? await keys.getSecret(String(keyId)) : null
		if (keyId && (!again || again.provider !== 'chatgpt' || again.ownerUserId !== userId)) throw new RpcError('NOT_FOUND', 'That sign-in isn’t here')
		const verifier = b64url(randomBytes(32))
		const p = {
			state: b64url(randomBytes(24)),
			nonce: b64url(randomBytes(24)),
			verifier,
			clientId: again?.chatgpt?.clientId ?? null,
			keyId: again?.id ?? null,
			result: null,
			error: null,
			server: null,
		}
		pending.set(userId, p)
		p.timer = setTimeout(() => pending.get(userId) === p && drop(userId), PENDING_MS)
		p.timer.unref?.()
		const port = listen ? await openListener(p, userId) : ports[0]
		p.redirect = `http://127.0.0.1:${port}/auth/callback`
		const q = new URLSearchParams({
			response_type: 'code',
			client_id: p.clientId ?? 'dynamic_agent_client',
			redirect_uri: p.redirect,
			scope: SCOPE,
			resource: RESOURCE,
			state: p.state,
			nonce: p.nonce,
			code_challenge_method: 'S256',
			code_challenge: b64url(createHash('sha256').update(verifier).digest()),
			ext_agent_host_id: await hostId(),
		})
		if (p.clientId) {
			if (again.chatgpt?.idToken) q.set('id_token_hint', again.chatgpt.idToken)
			if (again.chatgpt?.email) q.set('login_hint', again.chatgpt.email)
		} else q.set('agent_name_hint', AGENT_NAME)
		return {url: `${AUTHORIZE}?${q}`, redirect: p.redirect}
	}

	// The callback address (caught here, or pasted from the browser's address bar).
	async function finish(userId, pasted) {
		const p = pending.get(userId)
		if (!p) throw new RpcError('PRECONDITION_FAILED', 'Start signing in again')
		if (p.result) return p.result
		let url
		try {
			url = new URL(String(pasted ?? '').trim())
		} catch {
			throw new RpcError('BAD_REQUEST', 'Paste the whole address from the page that didn’t load')
		}
		const q = url.searchParams
		if (q.get('state') !== p.state) throw new RpcError('BAD_REQUEST', 'That address is from a different sign-in. Start again.')
		if (q.get('error')) {
			drop(userId)
			throw new RpcError('FORBIDDEN', q.get('error_description') || 'ChatGPT didn’t allow the sign-in')
		}
		const code = q.get('code')
		if (!code) throw new RpcError('BAD_REQUEST', 'That address has no sign-in code')
		const issued = q.get('client_id')
		if (p.clientId && issued && issued !== p.clientId) throw new RpcError('BAD_REQUEST', 'That address is from a different sign-in. Start again.')
		const clientId = p.clientId ?? issued
		if (!clientId || clientId === 'dynamic_agent_client') throw new RpcError('BAD_GATEWAY', 'ChatGPT didn’t register Omarchy Server; try again')
		if (p.busy) return p.busy
		p.busy = (async () => {
			const res = await fetchImpl(TOKEN, {
				method: 'POST',
				headers: {'content-type': 'application/x-www-form-urlencoded'},
				body: new URLSearchParams({grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirect, resource: RESOURCE}),
				signal: AbortSignal.timeout(30_000),
			})
			const body = await res.json().catch(() => ({}))
			if (!res.ok) {
				drop(userId)
				throw new RpcError('BAD_GATEWAY', body.error === 'invalid_grant' ? 'That sign-in code expired. Start again.' : body.error_description || 'ChatGPT didn’t finish the sign-in')
			}
			const claims = await verifyIdToken(body.id_token, {clientId, nonce: p.nonce, fetchImpl, now})
			const scope = String(body.scope ?? '')
			if (!scope.split(/\s+/).includes(PLAN_SCOPE)) {
				drop(userId)
				throw new RpcError('FORBIDDEN', 'ChatGPT didn’t allow using your plan here. It needs ChatGPT Plus or Pro, and you have to allow it on the consent page.')
			}
			const tokens = {
				sub: claims.sub,
				email: typeof claims.email === 'string' ? claims.email : null,
				clientId,
				accessToken: body.access_token,
				refreshToken: body.refresh_token,
				idToken: body.id_token,
				expiresAt: now() + (Number(body.expires_in) || 3600) * 1000,
				scope,
			}
			const listed = await models(tokens.accessToken).catch(() => [])
			const row = await keys.saveChatGpt(userId, {...tokens, model: listed[0]?.id})
			p.result = row
			closeListener(p)
			return row
		})()
		try {
			return await p.busy
		} catch (e) {
			p.busy = null
			throw e
		}
	}

	// For the Settings page while the browser is on this machine: did the listener finish it?
	function status(userId) {
		const p = pending.get(userId)
		if (!p) return {pending: false}
		if (p.result) {
			const row = p.result
			drop(userId)
			return {pending: false, key: row}
		}
		return {pending: true}
	}

	// A fresh access token for this row (refreshed shortly before it expires).
	async function accessToken(keyId) {
		const k = await keys.getSecret(keyId)
		if (!k?.chatgpt?.refreshToken) throw new RpcError('PRECONDITION_FAILED', SIGN_IN_AGAIN)
		if (k.chatgpt.accessToken && k.chatgpt.expiresAt - 120_000 > now()) return k.chatgpt.accessToken
		if (!refreshing.has(keyId)) {
			const run = (async () => {
				const res = await fetchImpl(TOKEN, {
					method: 'POST',
					headers: {'content-type': 'application/x-www-form-urlencoded'},
					body: new URLSearchParams({grant_type: 'refresh_token', client_id: k.chatgpt.clientId, refresh_token: k.chatgpt.refreshToken, resource: RESOURCE}),
					signal: AbortSignal.timeout(30_000),
				})
				const body = await res.json().catch(() => ({}))
				if (!res.ok) {
					if (SIGNED_OUT.has(body.error)) {
						await keys.updateChatGptTokens(keyId, {accessToken: null, refreshToken: null})
						throw new RpcError('PRECONDITION_FAILED', SIGN_IN_AGAIN)
					}
					// A temporary failure: keep the sign-in.
					throw new RpcError('BAD_GATEWAY', 'Couldn’t reach ChatGPT; try again in a moment')
				}
				await keys.updateChatGptTokens(keyId, {
					accessToken: body.access_token,
					refreshToken: body.refresh_token || k.chatgpt.refreshToken,
					...(body.id_token ? {idToken: body.id_token} : {}),
					expiresAt: now() + (Number(body.expires_in) || 3600) * 1000,
				})
				return body.access_token
			})()
			refreshing.set(keyId, run)
			run.finally(() => refreshing.delete(keyId)).catch(() => {})
		}
		return refreshing.get(keyId)
	}

	// Models this plan can use (shown by name; the slug is what's sent).
	async function models(token) {
		const res = await fetchImpl(`${RESOURCE}/models`, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15_000)})
		if (!res.ok) throw new RpcError('BAD_GATEWAY', 'Couldn’t list ChatGPT models')
		const body = await res.json().catch(() => ({}))
		return (Array.isArray(body.data) ? body.data : [])
			.filter((m) => m && (m.visibility === undefined || m.visibility === 'list'))
			.map((m) => ({id: String(m.slug ?? m.id), name: String(m.display_name ?? m.slug ?? m.id)}))
			.filter((m) => m.id && m.id !== 'undefined')
	}

	// Signing out revokes the refresh token at OpenAI (best effort) before the row is deleted.
	async function revoke(keyId) {
		const k = await keys.getSecret(keyId)
		if (!k?.chatgpt?.refreshToken) return
		try {
			const conf = await (await fetchImpl(`${AUTH}/.well-known/openid-configuration`, {signal: AbortSignal.timeout(10_000)})).json()
			if (typeof conf.revocation_endpoint !== 'string' || !conf.revocation_endpoint.startsWith(`${AUTH}/`)) return
			await fetchImpl(conf.revocation_endpoint, {
				method: 'POST',
				headers: {'content-type': 'application/x-www-form-urlencoded'},
				body: new URLSearchParams({token: k.chatgpt.refreshToken, token_type_hint: 'refresh_token', client_id: k.chatgpt.clientId}),
				signal: AbortSignal.timeout(10_000),
			})
		} catch {}
	}

	return {start, finish, status, accessToken, models: async (keyId) => models(await accessToken(keyId)), revoke, close: () => [...pending.keys()].forEach(drop)}
}
