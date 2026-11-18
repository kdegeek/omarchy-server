// Sign in with ChatGPT: the OAuth flow against a fake OpenAI, token refresh, and the Responses API.
import assert from 'node:assert/strict'
import {generateKeyPairSync, sign} from 'node:crypto'
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {AUTHORIZE, JWKS, PLAN_SCOPE, RESOURCE, SCOPE, TOKEN, verifyIdToken} from '../omarchyd/assistant/chatgpt.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {responsesInput, streamResponses} from '../omarchyd/assistant/providers.mjs'

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256', use: 'sig'}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const idToken = (claims, key = privateKey) => {
	const head = b64({alg: 'RS256', kid: 'k1', typ: 'JWT'})
	const body = b64(claims)
	return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`
}
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {'content-type': 'application/json'}})
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}})

// A fake auth.openai.com + api.openai.com. `nonce` comes from the authorize URL the test opened.
function fakeOpenAI({scope = SCOPE, refresh = 'ok'} = {}) {
	const seen = {token: [], responses: [], revoked: []}
	let nonce = null
	let n = 0
	const fetchImpl = async (url, init = {}) => {
		const u = String(url)
		if (u === JWKS) return json({keys: [jwk]})
		if (u === TOKEN) {
			const body = Object.fromEntries(new URLSearchParams(String(init.body)))
			seen.token.push(body)
			if (body.grant_type === 'authorization_code') {
				if (body.code !== 'the-code') return json({error: 'invalid_grant'}, 400)
				return json({access_token: 'at-1', refresh_token: 'rt-1', id_token: idToken({iss: 'https://auth.openai.com', aud: body.client_id, sub: 'acct-9', email: 'chris@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600}), expires_in: 3600, scope, token_type: 'Bearer'})
			}
			if (refresh === 'gone') return json({error: 'refresh_token_reused'}, 400)
			if (refresh === 'down') return json({error: 'server_error'}, 503)
			n++
			return json({access_token: `at-r${n}`, refresh_token: `rt-r${n}`, expires_in: 3600})
		}
		if (u === `${RESOURCE}/models`) return json({data: [{slug: 'gpt-plan', display_name: 'GPT Plan', visibility: 'list'}, {slug: 'hidden', visibility: 'hide'}]})
		if (u === 'https://auth.openai.com/.well-known/openid-configuration') return json({revocation_endpoint: 'https://auth.openai.com/oauth/revoke'})
		if (u === 'https://auth.openai.com/oauth/revoke') {
			seen.revoked.push(Object.fromEntries(new URLSearchParams(String(init.body))))
			return new Response('', {status: 200})
		}
		if (u === `${RESOURCE}/responses`) {
			seen.responses.push({auth: init.headers.authorization, body: JSON.parse(init.body)})
			return sse([
				{type: 'response.output_text.delta', delta: 'You have '},
				{type: 'response.output_text.delta', delta: '2 apps.'},
				{type: 'response.completed', response: {}},
			])
		}
		throw new Error(`unexpected fetch ${u}`)
	}
	return {fetchImpl, seen, setNonce: (v) => (nonce = v)}
}

const accounts = {getUser: (id) => ({owner: {userId: 'owner', role: 'owner'}, sam: {userId: 'sam', role: 'member'}})[id] ?? null}
async function box(opts = {}) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'siwc-'))
	const ai = fakeOpenAI(opts)
	const asst = createAssistant({
		dataDir,
		accounts,
		fetchImpl: ai.fetchImpl,
		chatgptOptions: {listen: opts.listen ?? false, ports: opts.ports},
		runProcedure: async (name) => ({'system.getHostname': 'box', 'apps.list': [{id: 'a'}, {id: 'b'}]})[name] ?? null,
	})
	const p = (name) => (input, userId = 'owner') => asst.procedures[name].run(input, {auth: {userId}})
	return {dataDir, ai, asst, start: p('assistant.chatgptStart'), finish: p('assistant.chatgptFinish'), status: p('assistant.chatgptStatus'), close: () => (asst.chatgpt.close(), rm(dataDir, {recursive: true, force: true}))}
}

test('first sign-in registers this install with PKCE, a stable host id and the plan scope', async () => {
	const b = await box()
	try {
		const {url, redirect} = await b.start({})
		assert.ok(url.startsWith(`${AUTHORIZE}?`))
		const q = new URL(url).searchParams
		assert.equal(q.get('client_id'), 'dynamic_agent_client')
		assert.equal(q.get('agent_name_hint'), 'Omarchy Server')
		assert.match(q.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/)
		assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
		assert.equal(q.get('resource'), 'https://api.openai.com/v1')
		assert.equal(q.get('code_challenge_method'), 'S256')
		assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
		assert.equal(q.get('response_type'), 'code')
		assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
		assert.equal(q.get('redirect_uri'), redirect)
		// The host id is kept: the next sign-in uses the same one.
		const again = new URL((await b.start({})).url).searchParams
		assert.equal(again.get('ext_agent_host_id'), q.get('ext_agent_host_id'))
		assert.equal((await stat(join(b.dataDir, 'assistant', 'chatgpt-host-id'))).mode & 0o777, 0o600)
	} finally {
		await b.close()
	}
})

test('pasting the callback address signs in: tokens stay on the server, the row is personal', async () => {
	const b = await box()
	try {
		const {url, redirect} = await b.start({})
		const q = new URL(url).searchParams
		b.ai.setNonce(q.get('nonce'))
		// A different sign-in's address is refused.
		await assert.rejects(b.finish({url: `${redirect}?code=the-code&state=wrong&client_id=oaiapp_1`}), /different sign-in/)
		await assert.rejects(b.finish({url: 'not a url'}), /Paste the whole address/)
		const row = await b.finish({url: `${redirect}?code=the-code&state=${q.get('state')}&client_id=oaiapp_1&scope=x`})
		assert.equal(row.provider, 'chatgpt')
		assert.equal(row.account, 'chris@example.com')
		assert.equal(row.model, 'gpt-plan', 'the first listed model')
		assert.equal(JSON.stringify(row).match(/at-1|rt-1|eyJ/), null, 'no token in what the browser gets')
		const ex = b.ai.seen.token[0]
		assert.deepEqual(Object.keys(ex).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource'])
		assert.equal(ex.client_id, 'oaiapp_1')
		assert.equal(ex.redirect_uri, redirect)
		assert.match(ex.code_verifier, /^[A-Za-z0-9_-]{43}$/)
		const file = join(b.dataDir, 'assistant', 'keys.json')
		assert.equal((await stat(file)).mode & 0o777, 0o600)
		const saved = JSON.parse(await readFile(file, 'utf8')).keys[0]
		assert.equal(saved.chatgpt.clientId, 'oaiapp_1')
		assert.equal(saved.chatgpt.refreshToken, 'rt-1')
		// Not visible to anyone else on the server.
		assert.deepEqual(await b.asst.procedures['assistant.keys'].run(undefined, {auth: {userId: 'sam'}}), [])
		// Signing in again for this row reuses the issued client and hints the account.
		const re = new URL((await b.start({keyId: row.id})).url).searchParams
		assert.equal(re.get('client_id'), 'oaiapp_1')
		assert.equal(re.get('login_hint'), 'chris@example.com')
		assert.ok(re.get('id_token_hint'))
		assert.equal(re.get('agent_name_hint'), null)
		await assert.rejects(b.start({keyId: row.id}, 'sam'), /isn’t here/)
	} finally {
		await b.close()
	}
})

test('without the plan scope (no Plus/Pro, or not allowed), nothing is saved', async () => {
	const b = await box({scope: 'openid profile email offline_access'})
	try {
		const {url, redirect} = await b.start({})
		const q = new URL(url).searchParams
		b.ai.setNonce(q.get('nonce'))
		await assert.rejects(b.finish({url: `${redirect}?code=the-code&state=${q.get('state')}&client_id=oaiapp_1`}), /Plus or Pro/)
		assert.deepEqual(await b.asst.keys.listPublic('owner'), [])
	} finally {
		await b.close()
	}
})

test('an ID token with the wrong nonce, audience or signature is refused', async () => {
	const {fetchImpl} = fakeOpenAI()
	const base = {iss: 'https://auth.openai.com', aud: 'oaiapp_1', sub: 's', nonce: 'n1', exp: Math.floor(Date.now() / 1000) + 600}
	assert.equal((await verifyIdToken(idToken(base), {clientId: 'oaiapp_1', nonce: 'n1', fetchImpl})).sub, 's')
	await assert.rejects(verifyIdToken(idToken(base), {clientId: 'oaiapp_1', nonce: 'other', fetchImpl}), /invalid sign-in/)
	await assert.rejects(verifyIdToken(idToken(base), {clientId: 'oaiapp_2', nonce: 'n1', fetchImpl}), /invalid sign-in/)
	await assert.rejects(verifyIdToken(idToken({...base, iss: 'https://evil.example'}), {clientId: 'oaiapp_1', nonce: 'n1', fetchImpl}), /invalid sign-in/)
	const other = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey
	await assert.rejects(verifyIdToken(idToken(base, other), {clientId: 'oaiapp_1', nonce: 'n1', fetchImpl}), /invalid sign-in/)
})

test('a browser on this machine: omarchyd catches the callback on 127.0.0.1 itself', async () => {
	const b = await box({listen: true, ports: [0 + 47321, 47322]})
	try {
		const {url, redirect} = await b.start({})
		assert.match(redirect, /^http:\/\/127\.0\.0\.1:4732[12]\/auth\/callback$/)
		const q = new URL(url).searchParams
		b.ai.setNonce(q.get('nonce'))
		assert.deepEqual(await b.status(undefined), {pending: true})
		const page = await fetch(`${redirect}?code=the-code&state=${q.get('state')}&client_id=oaiapp_1`)
		assert.equal(page.status, 200)
		assert.match(await page.text(), /Signed in to ChatGPT/)
		const st = await b.status(undefined)
		assert.equal(st.key.provider, 'chatgpt')
		assert.deepEqual(await b.status(undefined), {pending: false})
		// The listener is gone once it's done.
		await assert.rejects(fetch(redirect))
	} finally {
		await b.close()
	}
})

async function signedIn(opts) {
	const b = await box(opts)
	const {url, redirect} = await b.start({})
	const q = new URL(url).searchParams
	b.ai.setNonce(q.get('nonce'))
	const row = await b.finish({url: `${redirect}?code=the-code&state=${q.get('state')}&client_id=oaiapp_1`})
	return {...b, row}
}

test('a turn uses the plan through the Responses API, refreshing the token when it’s old', async () => {
	const b = await signedIn()
	try {
		await b.asst.keys.updateChatGptTokens(b.row.id, {expiresAt: Date.now() - 1})
		const events = []
		await b.asst.runTurn({userId: 'owner', role: 'owner', message: 'how many apps?', emit: (e) => events.push(e)})
		assert.equal(events.filter((e) => e.event === 'text').map((e) => e.data.text).join(''), 'You have 2 apps.')
		const refresh = b.ai.seen.token.at(-1)
		assert.deepEqual(refresh, {grant_type: 'refresh_token', client_id: 'oaiapp_1', refresh_token: 'rt-1', resource: 'https://api.openai.com/v1'})
		const call = b.ai.seen.responses[0]
		assert.equal(call.auth, 'Bearer at-r1')
		assert.equal(call.body.model, 'gpt-plan')
		assert.equal(call.body.store, false)
		assert.equal(call.body.stream, true)
		assert.match(call.body.instructions, /Omarchy Server assistant/)
		assert.equal(call.body.input.some((i) => i.role === 'system'), false, 'no system input items')
		assert.equal(call.body.tools.find((t) => t.name === 'apps_list').type, 'function')
		// The rotated refresh token is kept.
		assert.equal((await b.asst.keys.getSecret(b.row.id)).chatgpt.refreshToken, 'rt-r1')
	} finally {
		await b.close()
	}
})

test('a refresh token that’s no longer valid asks to sign in again; a temporary failure keeps the sign-in', async () => {
	const down = await signedIn({refresh: 'down'})
	try {
		await down.asst.keys.updateChatGptTokens(down.row.id, {expiresAt: 0})
		await assert.rejects(down.asst.chatgpt.accessToken(down.row.id), /try again in a moment/)
		assert.equal((await down.asst.keys.getSecret(down.row.id)).chatgpt.refreshToken, 'rt-1')
	} finally {
		await down.close()
	}
	const gone = await signedIn({refresh: 'gone'})
	try {
		await gone.asst.keys.updateChatGptTokens(gone.row.id, {expiresAt: 0})
		const events = []
		await gone.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.match(events.find((e) => e.event === 'error').data.message, /Sign in with ChatGPT again/)
		assert.equal((await gone.asst.keys.getSecret(gone.row.id)).chatgpt.refreshToken, null)
	} finally {
		await gone.close()
	}
})

test('removing the sign-in revokes it at OpenAI', async () => {
	const b = await signedIn()
	try {
		await b.asst.procedures['assistant.removeKey'].run({id: b.row.id}, {auth: {userId: 'owner'}})
		assert.deepEqual(b.ai.seen.revoked, [{token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'oaiapp_1'}])
		assert.deepEqual(await b.asst.keys.listPublic('owner'), [])
	} finally {
		await b.close()
	}
})

test('Responses API: tool calls come back as tool events; history becomes input items', async () => {
	const msgs = [
		{role: 'system', content: 'be brief'},
		{role: 'user', content: 'restart nextcloud'},
		{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'apps_restart', arguments: '{"appId":"nextcloud"}'}}]},
		{role: 'tool', tool_call_id: 'c1', content: 'done'},
	]
	assert.deepEqual(responsesInput(msgs), {
		instructions: 'be brief',
		input: [
			{role: 'user', content: 'restart nextcloud'},
			{type: 'function_call', call_id: 'c1', name: 'apps_restart', arguments: '{"appId":"nextcloud"}'},
			{type: 'function_call_output', call_id: 'c1', output: 'done'},
		],
	})
	const fetchImpl = async () =>
		sse([
			{type: 'response.output_item.done', item: {type: 'function_call', call_id: 'c2', name: 'apps_list', arguments: '{}'}},
			{type: 'response.completed', response: {}},
		])
	const out = []
	for await (const e of streamResponses({accessToken: 't', model: 'm', messages: msgs, tools: [], fetchImpl})) out.push(e)
	assert.deepEqual(out, [{type: 'tool', id: 'c2', name: 'apps_list', arguments: '{}'}])
	// Cut off before response.completed: an error, not a half answer.
	const cut = async () => new Response(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: 'Hal'})}\n\n`)
	const got = []
	for await (const e of streamResponses({accessToken: 't', model: 'm', messages: msgs, tools: [], fetchImpl: cut})) got.push(e)
	assert.equal(got.at(-1).type, 'error')
	assert.equal(PLAN_SCOPE, 'chatgpt.tokens.use.direct')
	assert.ok(createKeyStore)
})
