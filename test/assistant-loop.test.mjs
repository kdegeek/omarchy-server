import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {createAssistant} from '../omarchyd/assistant.mjs'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {SYSTEM_PROMPT} from '../omarchyd/assistant/loop.mjs'
import {streamChat} from '../omarchyd/assistant/providers.mjs'
import {READ_TOOLS, WRITE_TOOLS, filterAppStore, toolsFor} from '../omarchyd/assistant/tools.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ALLOWED} from '../server/app.mjs'

test('a user cannot read another user’s conversation', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ac-'))
	try {
		const c = createConversations({dataDir, now: () => 1})
		const row = await c.create('owner', {keyId: 'k_1', title: 'Need a VM'})
		assert.equal(row.title, 'Need a VM')
		await assert.rejects(() => c.get('sam', row.id), /isn.t/)
		await c.append('owner', row.id, {role: 'user', content: 'hello', at: 1})
		const loaded = await c.get('owner', row.id)
		assert.equal(loaded.messages[0].content, 'hello')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('streamChat yields text then a whole tool call', async () => {
	const body = [
		'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"system_diskUsage","arguments":"{}"}}]}}]}\n\n',
		'data: [DONE]\n\n',
	].join('')
	const srv = http.createServer((req, res) => {
		assert.match(req.url, /\/chat\/completions$/)
		assert.equal(req.headers.authorization, 'Bearer k')
		res.writeHead(200, {'content-type': 'text/event-stream'})
		res.end(body)
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	try {
		const port = srv.address().port
		const out = []
		for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'grok-4.7', messages: [], tools: [], fetchImpl: fetch})) out.push(ev)
		assert.deepEqual(out.map((e) => e.type), ['text', 'tool'])
		assert.equal(out[0].text, 'Hi')
		assert.equal(out[1].name, 'system_diskUsage')
	} finally {
		await new Promise((r) => srv.close(r))
	}
})

test('streamChat surfaces HTTP 401 as error', async () => {
	const srv = http.createServer((_q, res) => {
		res.writeHead(401, {'content-type': 'application/json'})
		res.end(JSON.stringify({error: {message: 'Incorrect API key'}}))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	try {
		const port = srv.address().port
		const out = []
		for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad', model: 'm', messages: [], tools: []})) out.push(ev)
		assert.equal(out[0].type, 'error')
		assert.match(out[0].message, /key/i)
	} finally {
		await new Promise((r) => srv.close(r))
	}
})

const SECRET = 'xai-secret-abcd'
const LIMIT = 'I hit the lookup limit for this turn.'
const KEY_REJECTED = 'That API key was rejected. Replace it in Settings → Assistant.'

const fakeAccounts = () => ({
	getUser(userId) {
		if (userId === 'sam') return {userId, role: 'member'}
		if (userId === 'owner') return {userId, role: 'owner'}
		return null
	},
})

const sse = (text) => ({
	ok: true,
	status: 200,
	text: async () => text,
	body: (async function* () {
		yield text
	})(),
})

const toolSse = (id, name, args = '{}') => sse(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id, function: {name, arguments: args}}]}}]})}\n\ndata: [DONE]\n\n`)
const textSse = (text) => sse(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)

test('streamChat treats Qwen XML split across tokens as a tool call', async () => {
	const pieces = ['<function', '=', 'system', '_memory', 'Usage', '>', '\n</', 'function', '>', '\n</tool_call>']
	const body = pieces.map((p) => `data: ${JSON.stringify({choices: [{delta: {content: p}}]})}\n\n`).join('') + 'data: [DONE]\n\n'
	const out = []
	for await (const ev of streamChat({baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => sse(body)})) out.push(ev)
	assert.deepEqual(out.map((e) => e.type), ['tool'])
	assert.equal(out[0].name, 'system_memoryUsage')
	assert.equal(out[0].arguments, '{}')
})

test('streamChat treats Qwen XML content as a tool call', async () => {
	const xml = '<function=system_diskUsage>\n</function>\n</tool_call>'
	const out = []
	for await (const ev of streamChat({baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => textSse(xml)})) out.push(ev)
	assert.deepEqual(out.map((e) => e.type), ['tool'])
	assert.equal(out[0].name, 'system_diskUsage')
	assert.equal(out[0].arguments, '{}')
})

test('streamChat parses Qwen XML parameters and hides the markup', async () => {
	const xml = 'Looking.\n<function=appStore_app>\n<parameter=appId>\nhome-assistant\n</parameter>\n</function>\n</tool_call>'
	const out = []
	for await (const ev of streamChat({baseUrl: 'http://127.0.0.1/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl: async () => textSse(xml)})) out.push(ev)
	assert.equal(out[0].type, 'text')
	assert.equal(out[0].text.trim(), 'Looking.')
	assert.equal(out[1].type, 'tool')
	assert.equal(out[1].name, 'appStore_app')
	assert.equal(JSON.parse(out[1].arguments).appId, 'home-assistant')
	assert.equal(out.some((e) => e.type === 'text' && /function=|tool_call/.test(e.text)), false)
})

test('runTurn runs a Qwen XML read tool then streams the reply', async () => {
	const xml = '<function=system_diskUsage>\n</function>\n</tool_call>'
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') return {free: '12 GB'}
	})
	const {fetchImpl} = scripted([textSse(xml), textSse('12 GB free')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'how much disk', emit: (e) => events.push(e)})
		assert.equal(calls.some((c) => c.name === 'system.diskUsage'), true)
		const visible = events.filter((e) => e.event === 'text' || e.event === 'done')
		assert.deepEqual(visible.map((e) => e.event), ['text', 'done'])
		assert.equal(visible[0].data.text, '12 GB free')
		assert.equal(JSON.stringify(events).includes('function='), false)
	} finally {
		await box.close()
	}
})

function scripted(responses) {
	const seen = []
	const fetchImpl = async (url, opts) => {
		const body = JSON.parse(opts.body)
		seen.push({url, opts, body})
		const step = responses[Math.min(seen.length - 1, responses.length - 1)]
		return typeof step === 'function' ? step(body) : step
	}
	return {seen, fetchImpl}
}

async function withAssistant(opts) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 50, ...opts})
	const key = await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: SECRET, model: 'grok-4.7'})
	return {
		dataDir,
		asst,
		key,
		async close() {
			await rm(dataDir, {recursive: true, force: true})
		},
	}
}

function factsProcedure(extra) {
	const calls = []
	const runProcedure = async (name, input, auth) => {
		calls.push({name, input, auth})
		if (extra) {
			const out = await extra(name, input, auth, calls)
			if (out !== undefined) return out
		}
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return [{id: 'files', credentials: {defaultPassword: 'app-secret'}}]
		if (name === 'swarm.list') return [{name: 'nas'}]
		return null
	}
	return {calls, runProcedure}
}

test('read tools are the curated list and members do not get swarm_list', () => {
	assert.deepEqual(READ_TOOLS.map((t) => t.name), [
		'system_diskUsage',
		'system_cpuUsage',
		'system_memoryUsage',
		'system_gpuUsage',
		'system_cpuTemperature',
		'system_uptime',
		'system_device',
		'system_getHostname',
		'system_getIpAddresses',
		'apps_list',
		'appStore_app',
		'appStore_search',
		'machines_list',
		'machines_details',
		'machines_osImages',
		'machines_capabilities',
		'swarm_list',
		'omarchy_plugins',
		'omarchy_listBackgrounds',
		'notifications_get',
	])
	assert.deepEqual(READ_TOOLS.find((t) => t.name === 'system_diskUsage'), {
		name: 'system_diskUsage',
		rpc: 'system.diskUsage',
		description: 'Disk used and free on this server',
		parameters: {type: 'object', properties: {}},
		ownerOnly: false,
	})
	assert.equal(READ_TOOLS.find((t) => t.name === 'swarm_list').ownerOnly, true)
	assert.equal(READ_TOOLS.find((t) => t.name === 'swarm_list').rpc, 'swarm.list')
	assert.equal(READ_TOOLS.find((t) => t.name === 'appStore_app').parameters.properties.appId.type, 'string')
	assert.equal(READ_TOOLS.find((t) => t.name === 'machines_details').parameters.properties.id.type, 'string')
	assert.ok(READ_TOOLS.find((t) => t.name === 'omarchy_plugins').parameters.properties.q)
	assert.ok(READ_TOOLS.find((t) => t.name === 'appStore_search').parameters.properties.limit)
	assert.equal(READ_TOOLS.find((t) => t.name === 'omarchy_listBackgrounds').rpc, 'omarchy.backgrounds')
	assert.ok(READ_TOOLS.find((t) => t.name === 'omarchy_listBackgrounds').parameters.properties.theme)
	assert.equal(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').rpc, 'omarchy.setBackground')
	assert.equal(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').ownerOnly, true)
	assert.ok(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').parameters.properties.id)
	assert.ok(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').parameters.properties.theme)
	assert.equal(toolsFor('member').some((t) => t.name === 'omarchy_setBackground'), false)
	assert.equal(toolsFor('owner').some((t) => t.name === 'omarchy_setBackground'), true)
	assert.match(SYSTEM_PROMPT, /omarchy_setBackground/)
	assert.match(SYSTEM_PROMPT, /wallpaper/i)
	assert.match(SYSTEM_PROMPT, /only omarchy_setBackground|not also call omarchy_setTheme|Do not call both/i)
	assert.match(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').description, /wallpaper|background/i)
	assert.match(WRITE_TOOLS.find((t) => t.name === 'omarchy_setBackground').description, /theme/i)
	assert.equal(toolsFor('member').some((t) => t.name === 'swarm_list'), false)
	assert.equal(toolsFor('owner').some((t) => t.name === 'swarm_list'), true)
	assert.equal([...READ_TOOLS, ...WRITE_TOOLS].some((t) => /shell|podman|web_search|x_search/i.test(t.name)), false)
	assert.equal(WRITE_TOOLS.some((t) => t.name === 'apps_install'), true)
})

test('appStore_search keeps a short listing, not the registry dump', () => {
	const apps = Array.from({length: 30}, (_, i) => ({
		id: `a${i}`,
		name: `App ${i}`,
		tagline: 't',
		category: i % 2 ? 'media' : 'files',
		version: '1',
		icon: 'nope',
		compose: 'secret-compose',
	}))
	const registry = [{url: 'https://example.invalid/store', apps}]
	const defaults = filterAppStore(registry, {})
	assert.equal(defaults.length, 12)
	assert.deepEqual(Object.keys(defaults[0]).sort(), ['category', 'id', 'name', 'tagline', 'version'])
	assert.equal(defaults[0].icon, undefined)
	assert.equal(filterAppStore(registry, {limit: 100}).length, 24)
	assert.deepEqual(filterAppStore(registry, {q: 'app 4', category: 'files'}).map((a) => a.id), ['a4'])
	assert.equal(JSON.stringify(defaults).includes('secret-compose'), false)
})

test('runTurn runs a read tool then streams the reply', async () => {
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') return {free: '12 GB'}
	})
	const {seen, fetchImpl} = scripted([toolSse('call_1', 'system_diskUsage', '{}'), textSse('12 GB free')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'how much disk', emit: (e) => events.push(e)})
		assert.equal(calls.some((c) => c.name === 'system.diskUsage'), true)
		const disk = calls.find((c) => c.name === 'system.diskUsage')
		assert.deepEqual(disk.input, {})
		assert.equal(disk.auth.userId, 'owner')
		assert.equal(disk.auth.role, 'owner')
		const visible = events.filter((e) => e.event === 'text' || e.event === 'done')
		assert.deepEqual(visible.map((e) => e.event), ['text', 'done'])
		assert.equal(visible[0].data.text, '12 GB free')
		assert.equal(visible[1].data.conversationId, out.conversationId)
		assert.equal(JSON.stringify(events).includes(SECRET), false)
		const first = seen[0]
		const second = seen[1]
		assert.match(first.url, /\/chat\/completions$/)
		assert.equal(first.opts.headers.authorization, `Bearer ${SECRET}`)
		assert.equal(first.body.stream, true)
		assert.equal(first.body.parallel_tool_calls, false)
		assert.equal(first.body.messages[0].content.startsWith(`${SYSTEM_PROMPT}\n`), true)
		assert.match(first.body.messages[0].content, /Role: owner/)
		assert.match(first.body.messages[0].content, /Hostname: box/)
		assert.match(first.body.messages[0].content, /Device: ThinkPad \(Omarchy\)/)
		assert.match(first.body.messages[0].content, /Installed apps: files/)
		assert.match(first.body.messages[0].content, /Swarm: nas/)
		assert.equal(first.body.messages[0].content.includes('app-secret'), false)
		assert.equal(first.body.tools.some((t) => t.function.name === 'system_diskUsage'), true)
		assert.equal(first.body.tools.some((t) => t.function.name === 'swarm_list'), true)
		assert.equal(JSON.stringify(first.body.messages).includes(SECRET), false)
		const tool = second.body.messages.find((m) => m.role === 'tool')
		const call = second.body.messages.find((m) => m.tool_calls)
		assert.equal(tool.tool_call_id, 'call_1')
		assert.match(tool.content, /12 GB/)
		assert.equal(call.tool_calls[0].id, 'call_1')
		assert.equal(call.tool_calls[0].function.name, 'system_diskUsage')
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.title, 'how much disk')
		assert.equal(saved.messages.at(-1).content, '12 GB free')
		assert.equal(saved.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_1'), true)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes(SECRET), false)
	} finally {
		await box.close()
	}
})

test('a member tool list omits swarm_list and swarm is not loaded', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([textSse('hello')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.keys.update({userId: 'owner', role: 'owner'}, {id: box.key.id, sharedWith: ['sam']})
		const events = []
		await box.asst.runTurn({userId: 'sam', role: 'member', message: 'hi', keyId: box.key.id, emit: (e) => events.push(e)})
		assert.equal(toolsFor('member').some((t) => t.name === 'swarm_list'), false)
		assert.equal(seen[0].body.tools.some((t) => t.function.name === 'swarm_list'), false)
		assert.equal(calls.some((c) => c.name === 'swarm.list'), false)
		assert.doesNotMatch(seen[0].body.messages[0].content, /^Swarm:/m)
		assert.equal(seen[0].body.messages[0].content.includes('nas'), false)
		assert.match(seen[0].body.messages[0].content, /Role: member/)
		assert.equal(events.some((e) => e.event === 'done'), true)
	} finally {
		await box.close()
	}
})

test('an unknown tool is not executed', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([toolSse('call_x', 'shell_exec', '{"cmd":"id"}'), textSse('no')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'run id', emit: () => {}})
		assert.ok(calls.every((c) => ['system.getHostname', 'system.device', 'apps.list', 'swarm.list'].includes(c.name)))
		const tool = seen[1].body.messages.find((m) => m.role === 'tool')
		assert.equal(tool.tool_call_id, 'call_x')
		assert.equal(tool.content, 'unknown tool')
	} finally {
		await box.close()
	}
})

test('a write tool is not run until Approve', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([toolSse('call_w', 'apps_install', '{"appId":"jellyfin"}'), textSse('cannot')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'install jellyfin', emit: (e) => events.push(e)})
		assert.equal(calls.some((c) => c.name === 'apps.install'), false)
		assert.equal(seen.length, 1)
		const card = events.find((e) => e.event === 'action')
		assert.equal(card.data.status, 'pending')
		assert.equal(card.data.toolName, 'apps_install')
		assert.equal(card.data.rpc.input.appId, 'jellyfin')
		assert.equal(events.at(-1).event, 'done')
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.actions[0].status, 'pending')
		assert.equal(saved.messages.some((m) => m.role === 'tool'), false)
	} finally {
		await box.close()
	}
})

test('appStore_search filters the registry inside the turn', async () => {
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'appStore.registry') {
			return [{apps: [
				{id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', category: 'media', version: '1', compose: 'secret-compose'},
				{id: 'nextcloud', name: 'Nextcloud', tagline: 'Files', category: 'files', version: '2'},
			]}]
		}
	})
	const {seen, fetchImpl} = scripted([toolSse('call_s', 'appStore_search', '{"q":"jelly","limit":5}'), textSse('Jellyfin')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'find jellyfin', emit: () => {}})
		assert.equal(calls.some((c) => c.name === 'appStore.registry'), true)
		const tool = seen[1].body.messages.find((m) => m.role === 'tool')
		const rows = JSON.parse(tool.content)
		assert.deepEqual(rows, [{id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', category: 'media', version: '1'}])
		assert.equal(tool.content.includes('secret-compose'), false)
	} finally {
		await box.close()
	}
})

test('apps_list and appStore_app results omit passwords', async () => {
	const {runProcedure} = factsProcedure(async (name) => {
		if (name === 'apps.list') return [{id: 'files', name: 'Files', state: 'running', port: 8080, credentials: {defaultUsername: 'admin', defaultPassword: 'app-secret', showBeforeOpen: true}}]
		if (name === 'appStore.app') return {id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', port: 8096, defaultUsername: 'jelly', defaultPassword: 'store-secret', deterministicPassword: true}
	})
	const {seen, fetchImpl} = scripted([
		toolSse('call_a', 'apps_list', '{}'),
		toolSse('call_b', 'appStore_app', '{"appId":"jellyfin"}'),
		textSse('listed'),
	])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'which apps', emit: () => {}})
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes('app-secret'), false)
		assert.equal(raw.includes('store-secret'), false)
		assert.equal(raw.includes('defaultPassword'), false)
		assert.equal(raw.includes('credentials'), false)
		const listed = JSON.parse(saved.messages.find((m) => m.name === 'apps_list').content)
		assert.equal(listed[0].id, 'files')
		assert.equal(listed[0].name, 'Files')
		assert.equal(listed[0].state, 'running')
		assert.equal(listed[0].port, 8080)
		const detail = JSON.parse(saved.messages.find((m) => m.name === 'appStore_app').content)
		assert.equal(detail.name, 'Jellyfin')
		assert.equal(detail.port, 8096)
		assert.equal(detail.defaultUsername, 'jelly')
		assert.equal(detail.tagline, 'Media')
		const posted = JSON.stringify(seen.slice(1).map((s) => s.body.messages))
		assert.equal(posted.includes('app-secret'), false)
		assert.equal(posted.includes('store-secret'), false)
		assert.equal(posted.includes('defaultPassword'), false)
		assert.equal(posted.includes('credentials'), false)
	} finally {
		await box.close()
	}
})

test('a failed read is given back to the model', async () => {
	const {runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') throw new Error('disk vanished')
	})
	const {seen, fetchImpl} = scripted([toolSse('call_d', 'system_diskUsage', '{}'), textSse('could not read disk')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'disk?', emit: (e) => events.push(e)})
		assert.equal(seen[1].body.messages.find((m) => m.role === 'tool').content, 'disk vanished')
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.some((e) => e.event === 'text' && e.data.text === 'could not read disk'), true)
	} finally {
		await box.close()
	}
})

test('sixteen lookups stop the turn', async () => {
	let fetches = 0
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') return {free: fetches}
	})
	const fetchImpl = async (url, opts) => {
		fetches++
		JSON.parse(opts.body)
		if (fetches > 16) return textSse('too many')
		return toolSse(`call_${fetches}`, 'system_diskUsage', '{}')
	}
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'keep looking', emit: (e) => events.push(e)})
		assert.equal(fetches, 16)
		assert.equal(calls.filter((c) => c.name === 'system.diskUsage').length, 16)
		assert.equal(events.some((e) => e.event === 'text' && e.data.text === LIMIT), true)
		assert.equal(events.at(-1).event, 'done')
		assert.equal(events.some((e) => e.data?.text === 'too many'), false)
	} finally {
		await box.close()
	}
})

test('the prompt keeps the last 40 messages and a new chat title is the first line', async () => {
	const {runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([textSse('ok'), textSse('ok')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const long = `${'N'.repeat(60)}\nsecond line`
		const created = await box.asst.runTurn({userId: 'owner', role: 'owner', message: long, emit: () => {}})
		const conv = await box.asst.conversations.get('owner', created.conversationId)
		assert.equal(conv.title, 'N'.repeat(48))
		for (let i = 0; i < 45; i++) await box.asst.conversations.append('owner', conv.id, {role: 'user', content: `old-${i}`, at: i})
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'new-one', conversationId: conv.id, emit: () => {}})
		const body = seen[1].body
		const users = body.messages.filter((m) => m.role === 'user').map((m) => m.content)
		assert.equal(body.messages.filter((m) => m.role !== 'system').length, 40)
		assert.equal(users[0], 'old-6')
		assert.equal(users.at(-1), 'new-one')
		assert.equal(users.includes('old-0'), false)
		assert.equal((await box.asst.conversations.get('owner', conv.id)).title, 'N'.repeat(48))
	} finally {
		await box.close()
	}
})

test('a rejected key uses the settings message', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => ({ok: false, status: 401, text: async () => JSON.stringify({error: {message: 'Incorrect API key'}})})
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(events, [{event: 'error', data: {message: KEY_REJECTED}}])
		assert.ok(out.conversationId)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes(SECRET), false)
		assert.equal(raw.includes('Incorrect API key'), false)
	} finally {
		await box.close()
	}
})

test('a provider transport failure becomes an error event', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => {
		throw new Error('socket hang up')
	}
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(events, [{event: 'error', data: {message: 'socket hang up'}}])
		assert.ok(out.conversationId)
	} finally {
		await box.close()
	}
})

test('abort keeps partial assistant text and does not emit an error', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		text: async () => '',
		body: (async function* () {
			yield 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
			throw Object.assign(new Error('aborted'), {name: 'AbortError'})
		})(),
	})
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.some((e) => e.event === 'done'), false)
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.messages.at(-1).content, 'Partial')
	} finally {
		await box.close()
	}
})

test('missing key does not call the provider', async () => {
	let called = false
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	try {
		const asst = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 1,
			runProcedure: async () => null,
			fetchImpl: async () => {
				called = true
				return textSse('no')
			},
		})
		const events = []
		const out = await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(called, false)
		assert.equal(out.conversationId, null)
		assert.match(events[0].data.message, /Settings → Assistant/)
		assert.equal(events.some((e) => e.event === 'done'), false)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('conversation RPCs list, read, and delete only the caller’s threads', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, runProcedure: async () => null})
		assert.equal(asst.procedures['assistant.conversations'].kind, 'query')
		assert.equal(asst.procedures['assistant.getConversation'].kind, 'query')
		assert.equal(asst.procedures['assistant.deleteConversation'].kind, 'mutation')
		assert.equal(ALLOWED['assistant.conversations'], 'query')
		assert.equal(ALLOWED['assistant.getConversation'], 'query')
		assert.equal(ALLOWED['assistant.deleteConversation'], 'mutation')
		const made = await asst.conversations.create('owner', {title: 'Need a VM'})
		await asst.conversations.create('sam', {title: 'Other'})
		const list = await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'owner'}})
		assert.deepEqual(list.map((r) => r.id), [made.id])
		assert.equal(list[0].title, 'Need a VM')
		assert.equal(list[0].messages, undefined)
		const got = await asst.procedures['assistant.getConversation'].run({id: made.id}, {auth: {userId: 'owner'}})
		assert.equal(got.userId, 'owner')
		assert.equal(got.apiKey, undefined)
		await assert.rejects(() => asst.procedures['assistant.getConversation'].run({id: made.id}, {auth: {userId: 'sam'}}), /isn.t/)
		await assert.rejects(() => asst.procedures['assistant.deleteConversation'].run({id: made.id}, {auth: {userId: 'sam'}}), /isn.t/)
		assert.equal(await asst.procedures['assistant.deleteConversation'].run({id: made.id}, {auth: {userId: 'owner'}}), true)
		assert.deepEqual(await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'owner'}}), [])
		assert.equal((await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'sam'}})).length, 1)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('omarchyd serves the conversation RPCs', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'al-'))
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'accounts.json')
		const state = JSON.parse(await readFile(file, 'utf8'))
		state.users.push({userId: 'sam', name: 'Sam', role: 'member', language: 'en', salt: state.users[0].salt, hash: state.users[0].hash, createdAt: Date.now()})
		await writeFile(file, JSON.stringify(state, null, '\t'))
		const d = await startOmarchyd({port: 0, dataDir: data, home: root})
		try {
			const anon = await fetch(`${d.url}/trpc/assistant.conversations`)
			assert.equal(anon.status, 401)
			const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
			const headers = {authorization: `Bearer ${login.result.data.accessToken}`}
			const list = await (await fetch(`${d.url}/trpc/assistant.conversations`, {headers})).json()
			assert.deepEqual(list.result.data, [])
			const missing = await fetch(`${d.url}/trpc/assistant.getConversation?input=${encodeURIComponent(JSON.stringify({id: 'c_nope'}))}`, {headers})
			assert.equal(missing.status, 404)
			const gone = await fetch(`${d.url}/trpc/assistant.deleteConversation`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({id: 'c_nope'})})
			assert.equal(gone.status, 404)
		} finally {
			await d.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('omarchyd streams a turn as server-sent events', async () => {
	const secret = 'xai-secret-stream'
	const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'
	let providerBody = null
	const srv = http.createServer(async (req, res) => {
		assert.match(req.url, /\/chat\/completions$/)
		assert.equal(req.headers.authorization, `Bearer ${secret}`)
		const chunks = []
		for await (const c of req) chunks.push(c)
		providerBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
		res.writeHead(200, {'content-type': 'text/event-stream'})
		res.end(sseBody)
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	const port = srv.address().port
	const root = await mkdtemp(join(os.tmpdir(), 'al-'))
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const fetchImpl = (url, opts) => {
			const u = new URL(url)
			u.protocol = 'http:'
			u.host = `127.0.0.1:${port}`
			return fetch(u, opts)
		}
		const d = await startOmarchyd({port: 0, dataDir: data, home: root, assistantOptions: {fetchImpl}})
		try {
			const anon = await fetch(`${d.url}/assistant/stream`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({message: 'how much disk'})})
			assert.equal(anon.status, 401)
			const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
			const headers = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
			const added = await (await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers, body: JSON.stringify({name: 'x', provider: 'spacexai', apiKey: secret, model: 'grok-4.7'})})).json()
			assert.equal(added.result.data.apiKey, undefined)
			const res = await fetch(`${d.url}/assistant/stream`, {method: 'POST', headers, body: JSON.stringify({message: 'how much disk'})})
			assert.equal(res.status, 200)
			assert.equal(res.headers.get('content-type'), 'text/event-stream')
			assert.equal(res.headers.get('cache-control'), 'no-store')
			const text = await res.text()
			assert.match(text, /event: text\ndata: \{"text":"Hi"\}/)
			assert.match(text, /event: done\ndata: \{"conversationId":"c_/)
			assert.equal(text.includes(secret), false)
			assert.match(providerBody.messages[0].content, /Role: owner/)
			assert.equal(providerBody.stream, true)
			assert.equal(providerBody.parallel_tool_calls, false)
			const bad = await fetch(`${d.url}/assistant/stream`, {method: 'POST', headers, body: '{'})
			assert.equal(bad.status, 400)
		} finally {
			await d.close()
		}
	} finally {
		await new Promise((r) => srv.close(r))
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 40})
	}
})

function streamPair(body) {
	const chunks = []
	const req = {
		socket: {on() {}, off() {}, setNoDelay() {}},
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(JSON.stringify(body))
		},
	}
	const res = {
		writableEnded: false,
		destroyed: false,
		writeHead() {},
		write(chunk) {
			chunks.push(String(chunk))
			return true
		},
		end() {
			this.writableEnded = true
		},
		on() {},
		chunks,
	}
	return {req, res, chunks}
}

function assertToolPairs(messages) {
	const rest = messages.filter((m) => m.role !== 'system')
	const covered = new Set()
	for (let i = 0; i < rest.length; i++) {
		const calls = rest[i].role === 'assistant' ? rest[i].tool_calls : null
		if (!calls?.length) continue
		for (let j = 0; j < calls.length; j++) {
			const next = rest[i + 1 + j]
			assert.equal(next?.role, 'tool')
			assert.equal(next.tool_call_id, calls[j].id)
			covered.add(i + 1 + j)
		}
	}
	rest.forEach((m, i) => {
		if (m.role === 'tool') assert.equal(covered.has(i), true)
	})
}

test('a user message while a write is pending keeps a valid tool list', async () => {
	const calls = []
	const runProcedure = async (name, input) => {
		calls.push({name, input})
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return []
		if (name === 'machines.create') return {id: 'vm1'}
		return null
	}
	const args = {name: 'ubuntu', osId: 'ubuntu-2404', cores: 2, memoryGb: 4, diskSizeGb: 32, username: 'chris'}
	const {seen, fetchImpl} = scripted([
		toolSse('call_vm', 'machines_create', JSON.stringify(args)),
		textSse('Noted.'),
		textSse('Created.'),
	])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'add ubuntu vm', emit: () => {}})
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'call it web', conversationId: out.conversationId, emit: () => {}})
		const posted = seen[1].body.messages
		assertToolPairs(posted)
		const tool = posted.find((m) => m.role === 'tool' && m.tool_call_id === 'call_vm')
		assert.equal(tool.content, 'this step is still waiting for Approve')
		const users = posted.filter((m) => m.role === 'user').map((m) => m.content)
		assert.deepEqual(users, ['add ubuntu vm', 'call it web'])
		assert.ok(posted.indexOf(tool) < posted.findIndex((m) => m.role === 'user' && m.content === 'call it web'))
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.actions[0].status, 'pending')
		assert.equal(saved.messages.some((m) => m.role === 'tool'), false)
		assert.equal(calls.some((c) => c.name === 'machines.create'), false)
		await box.asst.procedures['assistant.approve'].run({actionId: saved.actions[0].id, password: 'pick-one'}, {auth: {userId: 'owner'}})
		assert.equal(calls.filter((c) => c.name === 'machines.create').length, 1)
		assert.equal((await box.asst.conversations.get('owner', out.conversationId)).actions[0].status, 'done')
		await box.asst.runTurn({userId: 'owner', role: 'owner', conversationId: out.conversationId, continue: true, emit: () => {}})
		const follow = seen.at(-1).body.messages
		assertToolPairs(follow)
		const real = follow.find((m) => m.role === 'tool' && m.tool_call_id === 'call_vm')
		assert.match(real.content, /vm1/)
		assert.equal(real.content.includes('still waiting'), false)
		assert.equal(follow.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_vm').length, 1)
	} finally {
		await box.close()
	}
})

test('overlapping Approves run the RPC once', async () => {
	let release
	const gate = new Promise((r) => {
		release = r
	})
	let creates = 0
	const runProcedure = async (name) => {
		if (name === 'machines.create') {
			creates++
			await gate
			return {id: 'vm1'}
		}
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return []
		return null
	}
	const args = {name: 'ubuntu', osId: 'ubuntu-2404', cores: 2, memoryGb: 4, diskSizeGb: 32, username: 'chris'}
	const {fetchImpl} = scripted([toolSse('call_vm', 'machines_create', JSON.stringify(args))])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const events = []
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'add ubuntu vm', emit: (e) => events.push(e)})
		const id = events.find((e) => e.event === 'action').data.id
		const approve = () => box.asst.procedures['assistant.approve'].run({actionId: id, password: 'pick-one'}, {auth: {userId: 'owner'}})
		const first = approve()
		const second = approve()
		const settled = Promise.allSettled([first, second])
		release()
		const done = await settled
		assert.equal(creates, 1)
		assert.equal(done.filter((s) => s.status === 'fulfilled').length, 1)
		const rejected = done.find((s) => s.status === 'rejected')
		assert.equal(rejected.reason.code, 'CONFLICT')
		assert.equal(rejected.reason.message, 'That step was already handled')
		assert.equal((await box.asst.conversations.get('owner', out.conversationId)).actions[0].status, 'done')
	} finally {
		release()
		await box.close()
	}
})

test('a write tool becomes pending and Approve runs the RPC once', async () => {
	const calls = []
	const runProcedure = async (name, input, auth) => {
		calls.push({name, input, auth})
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return []
		if (name === 'machines.create') return {id: 'vm1'}
		return null
	}
	const args = {name: 'ubuntu', osId: 'ubuntu-2404', cores: 2, memoryGb: 4, diskSizeGb: 32, username: 'chris'}
	const {seen, fetchImpl} = scripted([
		toolSse('call_vm', 'machines_create', JSON.stringify(args)),
		textSse('Created.'),
	])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'add ubuntu vm', emit: (e) => events.push(e)})
		const actionEv = events.find((e) => e.event === 'action')
		assert.equal(actionEv.data.status, 'pending')
		assert.equal(actionEv.data.kind, 'rpc')
		assert.equal(actionEv.data.toolName, 'machines_create')
		assert.match(actionEv.data.detail, /You type its password when you approve/)
		assert.equal(JSON.stringify(actionEv.data).includes('"password"'), false)
		assert.equal(events.at(-1).event, 'done')
		assert.equal(calls.some((c) => c.name === 'machines.create'), false)
		assert.equal(seen.length, 1)
		const schema = seen[0].body.tools.find((t) => t.function.name === 'machines_create')
		assert.equal(schema.function.parameters.properties.password, undefined)
		assert.equal(seen[0].body.tools.some((t) => t.function.name === 'swarm_action'), true)
		const providerCalls = seen.length
		// Approve needs the password typed on the card; without it nothing runs and the step stays open.
		await assert.rejects(box.asst.procedures['assistant.approve'].run({actionId: actionEv.data.id}, {auth: {userId: 'owner'}}), /Enter a password for the machine/)
		assert.equal(calls.some((c) => c.name === 'machines.create'), false)
		await box.asst.procedures['assistant.approve'].run({actionId: actionEv.data.id, password: 'Typed-on-the-card 9'}, {auth: {userId: 'owner'}})
		assert.equal(seen.length, providerCalls, 'Approve runs the RPC without calling the model')
		const created = calls.filter((c) => c.name === 'machines.create')
		assert.equal(created.length, 1)
		assert.equal(created[0].input.name, 'ubuntu')
		assert.equal(created[0].input.osId, 'ubuntu-2404')
		assert.equal(created[0].input.cores, 2)
		assert.equal(created[0].input.memoryGb, 4)
		assert.equal(created[0].input.diskSizeGb, 32)
		assert.equal(created[0].input.username, 'chris')
		assert.equal(created[0].input.password, 'Typed-on-the-card 9')
		assert.equal(created[0].auth.role, 'owner')
		const password = created[0].input.password
		assert.equal(JSON.stringify(events).includes(password), false)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes(password), false)
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.actions[0].status, 'done')
		const toolMsg = saved.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_vm')
		assert.match(toolMsg.content, /vm1/)
		assert.equal(toolMsg.content.includes(password), false)
		const {req, res, chunks} = streamPair({conversationId: out.conversationId, continue: true})
		await box.asst.handleStream(req, res, {userId: 'owner'})
		const follow = chunks.join('')
		assert.match(follow, /event: text\ndata: \{"text":"Created\."\}/)
		assert.match(follow, /event: done\ndata: \{"conversationId":/)
		assert.equal(follow.includes(password), false)
		const after = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(after.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'), 'add ubuntu vm')
		assert.equal(calls.filter((c) => c.name === 'machines.create').length, 1)
		assert.equal(JSON.stringify(seen.at(-1).body).includes(password), false)
		await box.asst.procedures['assistant.approve'].run({actionId: actionEv.data.id}, {auth: {userId: 'owner'}}).then(
			() => assert.fail('second approve'),
			(e) => {
				assert.equal(e.code, 'CONFLICT')
				assert.equal(e.message, 'That step was already handled')
			},
		)
		assert.equal(calls.filter((c) => c.name === 'machines.create').length, 1)
	} finally {
		await box.close()
	}
})

test('Reject does not run the RPC', async () => {
	const calls = []
	const runProcedure = async (name, input) => {
		calls.push({name, input})
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return [{id: 'abc', name: 'nas'}]
		return true
	}
	const {fetchImpl} = scripted([toolSse('call_s', 'swarm_action', JSON.stringify({id: 'abc', name: 'reboot'}))])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'reboot the swarm box', emit: (e) => events.push(e)})
		assert.equal(events.find((e) => e.event === 'action').data.status, 'pending')
		assert.equal(calls.some((c) => c.name === 'swarm.action'), false)
		await box.asst.procedures['assistant.reject'].run({actionId: events.find((e) => e.event === 'action').data.id}, {auth: {userId: 'owner'}})
		assert.equal(calls.some((c) => c.name === 'swarm.action'), false)
		const again = await box.asst.procedures['assistant.getConversation'].run({id: out.conversationId}, {auth: {userId: 'owner'}})
		assert.equal(again.actions[0].status, 'rejected')
		assert.equal(again.messages.some((m) => m.role === 'tool' && m.content === 'user rejected this step'), true)
		assert.equal(ALLOWED['assistant.reject'], 'mutation')
	} finally {
		await box.close()
	}
})

test('a member cannot approve swarm.action', async () => {
	const calls = []
	const runProcedure = async (name, input) => (calls.push({name, input}), true)
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, runProcedure, fetchImpl: fetch})
		assert.equal(WRITE_TOOLS.every((t) => t.kind === 'mutation'), true)
		assert.equal(toolsFor('member').some((t) => t.name === 'swarm_action'), false)
		assert.equal(toolsFor('member').some((t) => t.name === 'system_restart' || t.name === 'system_shutdown'), false)
		assert.equal(toolsFor('member').some((t) => t.ownerOnly), false)
		assert.equal(toolsFor('owner').some((t) => t.name === 'swarm_action'), true)
		assert.equal(toolsFor('member').some((t) => t.name === 'machines_create'), true)
		const conv = await asst.conversations.create('sam', {title: 'x'})
		const action = await asst.conversations.putAction('sam', conv.id, {
			kind: 'rpc',
			toolName: 'swarm_action',
			title: 'Reboot',
			detail: '',
			rpc: {path: 'swarm.action', input: {id: 'abc', name: 'reboot'}},
			ownerOnly: true,
		})
		await assert.rejects(
			asst.procedures['assistant.approve'].run({actionId: action.id}, {auth: {userId: 'sam'}}),
			/owner|Forbidden|swarm/i,
		)
		assert.equal(calls.length, 0)
		assert.equal((await asst.conversations.get('sam', conv.id)).actions[0].status, 'error')
		assert.equal(ALLOWED['assistant.approve'], 'mutation')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('approving a wallpaper uses the chosen background id', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([toolSse('call_bg', 'omarchy_setBackground', JSON.stringify({theme: 'tokyo-night', id: 'aaaaaaaaaaaaaaaa'}))])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'change wallpaper', emit: (e) => events.push(e)})
		const action = events.find((e) => e.event === 'action')?.data
		assert.equal(action?.toolName, 'omarchy_setBackground')
		assert.match(action.title, /wallpaper/i)
		assert.equal(action.detail, 'tokyo-night')
		assert.deepEqual(action.picker, {theme: 'tokyo-night', selected: 'aaaaaaaaaaaaaaaa'})
		assert.equal(calls.some((c) => c.name === 'omarchy.setBackground'), false)
		const providerCalls = seen.length
		await box.asst.procedures['assistant.approve'].run({actionId: action.id, id: 'bbbbbbbbbbbbbbbb'}, {auth: {userId: 'owner'}})
		assert.equal(seen.length, providerCalls, 'Approve runs the RPC without calling the model')
		const bg = calls.find((c) => c.name === 'omarchy.setBackground')
		assert.equal(bg?.input.id, 'bbbbbbbbbbbbbbbb')
		assert.equal(bg.input.theme, 'tokyo-night')
		assert.equal(ALLOWED['omarchy.backgrounds'], 'query')
		assert.equal(ALLOWED['omarchy.setBackground'], 'mutation')
	} finally {
		await box.close()
	}
})

test('a theme write is one wallpaper Approve, not a second card after follow-up', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {fetchImpl} = scripted([
		toolSse('call_theme', 'omarchy_setTheme', JSON.stringify({slug: 'solitude'})),
		toolSse('call_bg', 'omarchy_setBackground', JSON.stringify({theme: 'solitude'})),
		textSse('Done.'),
	])
	const box = await withAssistant({runProcedure, fetchImpl})
	const first = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'Change theme and background to solitude', emit: (e) => first.push(e)})
		const action = first.find((e) => e.event === 'action')?.data
		assert.equal(action?.toolName, 'omarchy_setBackground')
		assert.equal(action.picker?.theme, 'solitude')
		assert.equal(first.filter((e) => e.event === 'action').length, 1)
		assert.equal(calls.some((c) => c.name === 'omarchy.setTheme'), false)
		await box.asst.procedures['assistant.approve'].run({actionId: action.id, id: 'ccccccccccccccdd'}, {auth: {userId: 'owner'}})
		const follow = []
		await box.asst.runTurn({userId: 'owner', role: 'owner', conversationId: out.conversationId, continue: true, emit: (e) => follow.push(e)})
		assert.equal(follow.some((e) => e.event === 'action'), false)
		assert.equal(calls.filter((c) => c.name === 'omarchy.setBackground').length, 1)
		assert.equal(calls.some((c) => c.name === 'omarchy.setTheme'), false)
	} finally {
		await box.close()
	}
})

test('closing the assistant stream aborts the provider call', async () => {
	let providerAborted = false
	const srv = http.createServer(async (req, res) => {
		const chunks = []
		for await (const c of req) chunks.push(c)
		res.writeHead(200, {'content-type': 'text/event-stream'})
		res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 2_000)
			res.on('close', () => {
				if (!res.writableEnded) providerAborted = true
				clearTimeout(timer)
				resolve()
			})
		})
		if (!res.writableEnded) res.end('data: [DONE]\n\n')
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	const port = srv.address().port
	const root = await mkdtemp(join(os.tmpdir(), 'al-'))
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const fetchImpl = (url, opts) => {
			const u = new URL(url)
			u.protocol = 'http:'
			u.host = `127.0.0.1:${port}`
			return fetch(u, opts)
		}
		const d = await startOmarchyd({port: 0, dataDir: data, home: root, assistantOptions: {fetchImpl}})
		try {
			const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
			const headers = {authorization: `Bearer ${login.result.data.accessToken}`, 'content-type': 'application/json'}
			await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers, body: JSON.stringify({name: 'x', provider: 'spacexai', apiKey: 'xai-secret-stream', model: 'grok-4.7'})})
			const res = await fetch(`${d.url}/assistant/stream`, {method: 'POST', headers, body: JSON.stringify({message: 'how much disk'})})
			const reader = res.body.getReader()
			const first = new TextDecoder().decode((await reader.read()).value)
			assert.match(first, /event: text/)
			await reader.cancel()
			await new Promise((r) => setTimeout(r, 300))
			assert.equal(providerAborted, true)
		} finally {
			await d.close()
		}
	} finally {
		await new Promise((r) => srv.close(r))
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 40})
	}
})

test('a ../ conversation id cannot read or write keys.json or accounts.json', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ac-escape-'))
	try {
		const assistant = join(dataDir, 'assistant')
		const convDir = join(assistant, 'conversations')
		await mkdir(convDir, {recursive: true})
		const keysBody = '{\n\t"keys": [\n\t\t{"apiKey": "super-secret"}\n\t]\n}\n'
		const accountsBody = '{"users":[{"userId":"owner"}]}\n'
		const keys = join(assistant, 'keys.json')
		const accounts = join(dataDir, 'accounts.json')
		await writeFile(keys, keysBody, {mode: 0o600})
		await writeFile(accounts, accountsBody, {mode: 0o600})
		await writeFile(join(assistant, 'pwn.json'), JSON.stringify({id: '../accounts', userId: 'owner', title: 'x', createdAt: 1, updatedAt: 1, messages: [], actions: []}))
		await writeFile(join(assistant, 'pwn-keys.json'), JSON.stringify({id: '../keys', userId: 'owner', title: 'x', createdAt: 1, updatedAt: 1, messages: [], actions: []}))
		const outside = join(dataDir, 'outside.json')
		await writeFile(outside, JSON.stringify({id: '../accounts', userId: 'owner', title: 'z', createdAt: 1, updatedAt: 1, messages: [], actions: []}))
		const c = createConversations({dataDir, now: () => 1})
		await assert.rejects(() => c.get('owner', '../pwn'), (e) => e.code === 'NOT_FOUND')
		await assert.rejects(() => c.append('owner', '../pwn', {role: 'user', content: 'hi', at: 2}), (e) => e.code === 'NOT_FOUND')
		await assert.rejects(() => c.append('owner', '../pwn-keys', {role: 'user', content: 'hi', at: 2}), (e) => e.code === 'NOT_FOUND')
		await assert.rejects(() => c.remove('owner', '../accounts'), (e) => e.code === 'NOT_FOUND')
		const poisoned = 'c_' + 'a'.repeat(12)
		await writeFile(join(convDir, `${poisoned}.json`), JSON.stringify({id: '../keys', userId: 'owner', title: 'x', createdAt: 1, updatedAt: 1, messages: [], actions: []}))
		const saved = await c.append('owner', poisoned, {role: 'user', content: 'safe', at: 2})
		assert.equal(saved.id, poisoned)
		assert.equal(saved.messages.at(-1).content, 'safe')
		const linkId = 'c_' + 'b'.repeat(12)
		await symlink(outside, join(convDir, `${linkId}.json`))
		await assert.rejects(() => c.get('owner', linkId), (e) => e.code === 'NOT_FOUND')
		await assert.rejects(() => c.append('owner', linkId, {role: 'user', content: 'nope', at: 3}), (e) => e.code === 'NOT_FOUND')
		assert.equal(await readFile(keys, 'utf8'), keysBody)
		assert.equal(await readFile(accounts, 'utf8'), accountsBody)
		assert.equal(await readFile(outside, 'utf8').then((t) => t.includes('nope')), false)
		const row = await c.create('owner', {title: 'ok'})
		assert.match(row.id, /^c_[0-9a-f]{12}$/)
		assert.equal((await c.append('owner', row.id, {role: 'user', content: 'hi', at: 4})).messages[0].content, 'hi')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a stale save cannot undo Approve', async () => {
	const calls = []
	const runProcedure = async (name) => {
		calls.push(name)
		if (name === 'machines.create') return {id: 'vm1'}
		return null
	}
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-stale-'))
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, runProcedure, fetchImpl: fetch})
		const conv = await asst.conversations.create('owner', {title: 't'})
		const action = await asst.conversations.putAction('owner', conv.id, {
			kind: 'rpc',
			toolName: 'machines_create',
			title: 'Create',
			detail: '',
			rpc: {path: 'machines.create', input: {name: 'ubuntu', username: 'chris'}},
		})
		const snap = await asst.conversations.get('owner', conv.id)
		await asst.procedures['assistant.approve'].run({actionId: action.id, password: 'pick-one'}, {auth: {userId: 'owner'}})
		assert.equal(calls.filter((n) => n === 'machines.create').length, 1)
		await asst.conversations.saveAction('owner', snap.actions[0])
		await asst.conversations.append('owner', conv.id, {role: 'tool', toolCallId: 'call_x', name: 'machines_create', content: 'late', at: 9})
		await assert.rejects(
			asst.procedures['assistant.approve'].run({actionId: action.id, password: 'pick-one'}, {auth: {userId: 'owner'}}),
			(e) => e.code === 'CONFLICT' && e.message === 'That step was already handled',
		)
		assert.equal(calls.filter((n) => n === 'machines.create').length, 1)
		const after = await asst.conversations.get('owner', conv.id)
		assert.equal(after.actions[0].status, 'done')
		assert.equal(after.messages.some((m) => m.content === 'late'), true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('aborting a turn stops the tool call so Approve stays done', async () => {
	let toolAborted = false
	let toolFinished = false
	let releaseTool = () => {}
	let timer
	let creates = 0
	let releaseStarted
	const started = new Promise((resolve) => {
		releaseStarted = resolve
	})
	const runProcedure = async (name, _input, _auth, signal) => {
		if (name === 'system.diskUsage') {
			releaseStarted()
			await new Promise((resolve, reject) => {
				releaseTool = resolve
				timer = setTimeout(resolve, 30_000)
				const stop = () => {
					clearTimeout(timer)
					toolAborted = true
					const error = new Error('aborted')
					error.name = 'AbortError'
					reject(error)
				}
				if (signal?.aborted) return stop()
				if (signal) signal.addEventListener('abort', stop, {once: true})
			})
			toolFinished = true
			return {used: 1}
		}
		if (name === 'machines.create') {
			creates++
			return {id: 'vm1'}
		}
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return []
		return null
	}
	const {fetchImpl} = scripted([toolSse('call_disk', 'system_diskUsage', '{}')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const ac = new AbortController()
	let turnP
	try {
		const conv = await box.asst.conversations.create('owner', {title: 't'})
		const action = await box.asst.conversations.putAction('owner', conv.id, {
			kind: 'rpc',
			toolName: 'machines_create',
			title: 'Create',
			detail: '',
			rpc: {path: 'machines.create', input: {name: 'ubuntu', username: 'chris'}},
		})
		turnP = box.asst.runTurn({userId: 'owner', role: 'owner', message: 'how much disk', conversationId: conv.id, signal: ac.signal, emit: () => {}})
		await started
		ac.abort()
		await box.asst.procedures['assistant.approve'].run({actionId: action.id, password: 'pick-one'}, {auth: {userId: 'owner'}})
		const outcome = await Promise.race([turnP.then(() => 'ended', () => 'ended'), new Promise((resolve) => setTimeout(() => resolve('hung'), 400))])
		assert.equal(outcome, 'ended')
		assert.equal(toolAborted, true)
		assert.equal(toolFinished, false)
		assert.equal(creates, 1)
		assert.equal((await box.asst.conversations.get('owner', conv.id)).actions[0].status, 'done')
		await assert.rejects(
			box.asst.procedures['assistant.approve'].run({actionId: action.id, password: 'pick-one'}, {auth: {userId: 'owner'}}),
			(e) => e.code === 'CONFLICT',
		)
		assert.equal(creates, 1)
	} finally {
		clearTimeout(timer)
		releaseTool()
		ac.abort()
		if (turnP) await turnP.catch(() => {})
		await box.close()
	}
})
