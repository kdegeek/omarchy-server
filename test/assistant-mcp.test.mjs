import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import YAML from 'yaml'

import {createApps, parseMcp, prepareCompose} from '../omarchyd/apps.mjs'
import {createAssistant} from '../omarchyd/assistant.mjs'
import {callMcpTool, listMcpTools} from '../omarchyd/assistant/mcp.mjs'
import {openAiTools} from '../omarchyd/assistant/tools.mjs'

test('parseMcp accepts a listing block and rejects junk', () => {
	assert.deepEqual(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'http'}), {service: 'web', port: 8080, path: '/mcp', transport: 'http'})
	assert.equal(parseMcp({service: 'web', port: 0}), null)
	assert.equal(parseMcp(null), null)
	assert.equal(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'stdio'}), null)
	assert.equal(parseMcp({service: 'web', port: 8080, path: 'mcp', transport: 'http'}), null)
	assert.deepEqual(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'sse'}), {service: 'web', port: 8080, path: '/mcp', transport: 'sse'})
})

test('prepareCompose publishes mcp on loopback and never as a public port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => 19001, {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8090, path: '/mcp', transport: 'http'}})
	assert.match(text, /127\.0\.0\.1:19001:8090/)
	assert.doesNotMatch(text, /0\.0\.0\.0/)
	assert.ok(mcpInternalPort)
	assert.equal(internalPort, 19001)
})

test('prepareCompose leaves mcpInternalPort null when the listing has no mcp', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	const {mcpInternalPort} = prepareCompose('demo', compose, () => 19001, {web: {service: 'web', port: 8080}})
	assert.equal(mcpInternalPort, null)
})

test('prepareCompose reuses the web loopback when mcp uses that container port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	let calls = 0
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => (calls++, 19001), {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8080, path: '/mcp', transport: 'sse'}})
	assert.equal(calls, 1)
	assert.equal(internalPort, 19001)
	assert.equal(mcpInternalPort, 19001)
	assert.deepEqual(YAML.parse(text).services.web.ports, ['127.0.0.1:19001:8080'])
})

test('prepareCompose gives a sidecar its own loopback when it shares the web container port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n  sidecar:\n    image: y\n    ports: ["8080:8080"]\n'
	let n = 0
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => 19001 + n++, {web: {service: 'web', port: 8080}, mcp: {service: 'sidecar', port: 8080, path: '/mcp', transport: 'http'}})
	const doc = YAML.parse(text)
	assert.equal(internalPort, 19001)
	assert.equal(mcpInternalPort, 19002)
	assert.notEqual(mcpInternalPort, internalPort)
	assert.deepEqual(doc.services.web.ports, ['127.0.0.1:19001:8080'])
	assert.deepEqual(doc.services.sidecar.ports, ['127.0.0.1:19002:8080'])
	assert.doesNotMatch(text, /0\.0\.0\.0/)
})

test('prepareCompose replaces a public mcp publish with loopback', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080", "0.0.0.0:8090:8090"]\n'
	let n = 0
	const {text, mcpInternalPort} = prepareCompose('demo', compose, () => 19001 + n++, {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8090, path: '/mcp', transport: 'http'}})
	assert.equal(mcpInternalPort, 19002)
	assert.deepEqual(YAML.parse(text).services.web.ports, ['127.0.0.1:19001:8080', '127.0.0.1:19002:8090'])
	assert.doesNotMatch(text, /0\.0\.0\.0/)
})

test('install keeps mcp on the app, publishes it on loopback, and mcpTargets skips the rest', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-mcp-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const gateway = 34000 + Math.floor(Math.random() * 2000)
	const up = new Set()
	const opened = []
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'})
	const run = async (cmd, args) => {
		if (cmd === 'git') return git(args, undefined).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'ps') return JSON.stringify([...up].map((project) => ({Labels: {'com.docker.compose.project': project}, State: 'running'})))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
	const until = async (fn, ms = 8000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 30))
		}
	}
	let apps
	try {
		await writeFile(sock, '')
		await mkdir(join(store, 'mcpapp'), {recursive: true})
		await mkdir(join(store, 'plain'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, 'mcpapp', 'omarchy-app.yml'), `manifestVersion: 1\nid: mcpapp\nname: Mcp App\nversion: "1"\nport: ${gateway}\nweb:\n  service: web\n  port: 8080\nmcp:\n  service: web\n  port: 8090\n  path: /mcp\n  transport: http\nopenPorts: [6881, 8090]\n`)
		await writeFile(join(store, 'mcpapp', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports:\n      - "8080:8080"\n      - "8090:8090"\n      - "6881:6881"\n')
		await writeFile(join(store, 'plain', 'omarchy-app.yml'), `manifestVersion: 1\nid: plain\nname: Plain\nversion: "1"\nport: ${gateway + 1}\nweb:\n  service: web\n  port: 8080\n`)
		await writeFile(join(store, 'plain', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		apps = createApps({dataDir: data, home, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null, run, firewall: {open: async (p) => opened.push(p), close: async () => {}}})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('appStore.addRepository', {url: `file://${store}`})
		const listed = (await call('appStore.registry')).find((r) => r.url.endsWith('/store')).apps.find((a) => a.id === 'mcpapp')
		assert.equal(listed.mcp, undefined, 'the store browse payload does not grow an mcp field')
		assert.deepEqual(listed.openPorts, [6881])
		await call('apps.install', {appId: 'mcpapp'})
		await until(async () => (await call('apps.list')).find((a) => a.id === 'mcpapp' && a.state === 'running'))
		await call('apps.install', {appId: 'plain'})
		await until(async () => (await call('apps.list')).find((a) => a.id === 'plain' && a.state === 'running'))
		const saved = await until(async () => {
			const row = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8')).apps.find((a) => a.id === 'mcpapp')
			return row?.mcpInternalPort ? row : null
		})
		assert.deepEqual(saved.mcp, {service: 'web', port: 8090, path: '/mcp', transport: 'http'})
		assert.equal(typeof saved.mcpInternalPort, 'number')
		assert.notEqual(saved.mcpInternalPort, saved.internalPort)
		assert.deepEqual(saved.openPorts, [6881])
		const ports = YAML.parse(await readFile(join(data, 'apps', 'installed', 'mcpapp', 'compose.omarchy.yml'), 'utf8')).services.web.ports
		assert.ok(ports.includes(`127.0.0.1:${saved.internalPort}:8080`))
		assert.ok(ports.includes(`127.0.0.1:${saved.mcpInternalPort}:8090`))
		assert.ok(!ports.some((p) => String(p).includes('0.0.0.0') || String(p) === '8090:8090'))
		assert.ok(ports.includes('6881:6881'))
		assert.ok(opened.includes(6881))
		assert.ok(!opened.includes(8090))
		assert.deepEqual(await apps.mcpTargets(), [{appId: 'mcpapp', name: 'Mcp App', url: `http://127.0.0.1:${saved.mcpInternalPort}/mcp`, transport: 'http', running: true}])
		await call('apps.stop', {appId: 'mcpapp'})
		await new Promise((r) => setTimeout(r, 1700))
		assert.deepEqual(await apps.mcpTargets(), [])
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
})

const loopbackPort = (id) => 20_000 + (parseInt(createHash('sha256').update(id).digest('hex').slice(0, 4), 16) % 9000)

// A container app whose second loopback (the MCP port) is the port a system app would otherwise take.
function collidingIds() {
	const byPort = new Map()
	for (let i = 0; i < 20000; i++) byPort.set(loopbackPort(`m${i.toString(36)}`), `m${i.toString(36)}`)
	for (let i = 0; i < 20000; i++) {
		const sys = `s${i.toString(36)}`
		const mcp = byPort.get(loopbackPort(sys) - 1)
		if (mcp) return {mcp, sys}
	}
	throw new Error('no ids')
}

test('a system app does not take an installed app’s mcp loopback port', async () => {
	const {mcp, sys} = collidingIds()
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-mcp-sys-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const gateway = 36000 + Math.floor(Math.random() * 2000)
	const up = new Set()
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'})
	const run = async (cmd, args) => {
		if (cmd === 'git') return execFileSync('git', args, {stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'ps') return JSON.stringify([...up].map((project) => ({Labels: {'com.docker.compose.project': project}, State: 'running'})))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
	const until = async (fn, ms = 8000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 30))
		}
	}
	const systemApps = {
		listings: () => [{id: sys, name: 'Sys', system: true, version: '1'}],
		permissions: () => [],
		install: async () => {},
		liveState: async () => 'running',
		uninstall: async () => {},
		close: () => {},
	}
	let apps
	try {
		await writeFile(sock, '')
		await mkdir(join(store, mcp), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, mcp, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${mcp}\nname: Mcp\nversion: "1"\nport: ${gateway}\nweb:\n  service: web\n  port: 8080\nmcp:\n  service: web\n  port: 8090\n  path: /mcp\n  transport: http\n`)
		await writeFile(join(store, mcp, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		apps = createApps({dataDir: data, home, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps, run})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('appStore.addRepository', {url: `file://${store}`})
		await call('apps.install', {appId: mcp})
		await until(async () => (await call('apps.list')).find((a) => a.id === mcp && a.state === 'running'))
		await call('apps.install', {appId: sys})
		await until(async () => (await call('apps.list')).find((a) => a.id === sys && a.state === 'running'))
		const {mcpApp, sysApp} = await until(async () => {
			const rows = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8')).apps
			const mcpApp = rows.find((a) => a.id === mcp)
			const sysApp = rows.find((a) => a.id === sys)
			return mcpApp?.mcpInternalPort && sysApp?.internalPort ? {mcpApp, sysApp} : null
		})
		assert.equal(mcpApp.mcpInternalPort, loopbackPort(mcp) + 1)
		assert.equal(loopbackPort(sys), mcpApp.mcpInternalPort)
		assert.notEqual(sysApp.internalPort, mcpApp.mcpInternalPort)
		assert.notEqual(sysApp.internalPort, mcpApp.internalPort)
		assert.equal(sysApp.internalPort, mcpApp.mcpInternalPort + 1)
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
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

function scripted(responses) {
	const seen = []
	const fetchImpl = async (url, opts) => {
		if (new URL(url).hostname === '127.0.0.1') return fetch(url, opts)
		const body = JSON.parse(opts.body)
		seen.push({url, opts, body})
		const step = responses[Math.min(seen.length - 1, responses.length - 1)]
		return typeof step === 'function' ? step(body) : step
	}
	return {seen, fetchImpl}
}

const fakeAccounts = () => ({
	getUser(userId) {
		if (userId === 'owner') return {userId, role: 'owner'}
		return null
	},
})

async function withAssistant(opts = {}) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'mcp-loop-'))
	const calls = []
	const runProcedure = async (name, input, auth) => {
		calls.push({name, input, auth})
		if (opts.runProcedure) return opts.runProcedure(name, input, auth)
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return []
		if (name === 'swarm.list') return []
		return null
	}
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 50, runProcedure, fetchImpl: opts.fetchImpl, mcpTargets: opts.mcpTargets})
	await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'test-key-1234', model: 'grok-4.7'})
	return {
		dataDir,
		asst,
		calls,
		async close() {
			await rm(dataDir, {recursive: true, force: true})
		},
	}
}

function startMcp({tools, fail = false, onCall, frame = 'json'} = {}) {
	const seen = []
	const srv = http.createServer(async (req, res) => {
		const chunks = []
		for await (const c of req) chunks.push(c)
		let msg = {}
		try {
			msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
		} catch {
			msg = {}
		}
		seen.push({reqMethod: req.method, url: req.url, ...msg})
		if (fail) {
			res.writeHead(500, {'content-type': 'application/json'})
			res.end(JSON.stringify({jsonrpc: '2.0', id: msg.id ?? null, error: {code: -32000, message: 'nope'}}))
			return
		}
		if (msg.method === 'notifications/initialized') {
			res.writeHead(202)
			res.end()
			return
		}
		const send = (result) => {
			const payload = {jsonrpc: '2.0', id: msg.id, result}
			if (frame === 'sse') {
				res.writeHead(200, {'content-type': 'text/event-stream'})
				res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
				return
			}
			res.writeHead(200, {'content-type': 'application/json'})
			res.end(JSON.stringify(payload))
		}
		if (msg.method === 'initialize') return send({protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'fake', version: '1'}})
		if (msg.method === 'tools/list') return send({tools})
		if (msg.method === 'tools/call') {
			if (onCall) await onCall(msg)
			const name = msg.params?.name
			return send({content: [{type: 'text', text: name === 'status' ? 'ok-status' : 'renamed'}], isError: false})
		}
		res.writeHead(400, {'content-type': 'application/json'})
		res.end(JSON.stringify({jsonrpc: '2.0', id: msg.id ?? null, error: {code: -32601, message: 'Method not found'}}))
	})
	return {
		seen,
		listen: () => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port
			const path = `/mcp/${port}/${Math.random().toString(16).slice(2)}`
			resolve({port, path, url: `http://127.0.0.1:${port}${path}`})
		})),
		close: () => new Promise((resolve) => srv.close(resolve)),
	}
}

const builtinNames = () => openAiTools('owner').map((t) => t.function.name)

test('readOnly MCP tools auto-run; others become pending', async () => {
	const mcp = startMcp({tools: [
		{name: 'status', description: 'Read the status', inputSchema: {type: 'object', properties: {verbose: {type: 'boolean'}}}, annotations: {readOnlyHint: true}},
		{name: 'rename', description: 'Rename something', inputSchema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']}, annotations: {readOnlyHint: false}},
		{name: 'bad.name', description: 'nope', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}},
	]})
	const addr = await mcp.listen()
	const {seen, fetchImpl} = scripted([
		toolSse('call_status', 'app__demo__status', JSON.stringify({verbose: true})),
		toolSse('call_rename', 'app__demo__rename', JSON.stringify({title: 'Cabinet'})),
		textSse('Renamed.'),
	])
	const box = await withAssistant({
		fetchImpl,
		mcpTargets: async () => [{appId: 'demo', name: 'Demo', url: addr.url, transport: 'sse', running: true}],
	})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'rename the shelf', emit: (e) => events.push(e)})
		const names = seen[0].body.tools.map((t) => t.function.name)
		assert.deepEqual(names.slice(0, builtinNames().length), builtinNames())
		assert.ok(names.includes('app__demo__status'))
		assert.ok(names.includes('app__demo__rename'))
		assert.equal(names.some((n) => n.includes('bad')), false)
		const statusTool = seen[0].body.tools.find((t) => t.function.name === 'app__demo__status')
		const renameTool = seen[0].body.tools.find((t) => t.function.name === 'app__demo__rename')
		assert.equal(statusTool.function.description, 'Read the status')
		assert.deepEqual(statusTool.function.parameters, {type: 'object', properties: {verbose: {type: 'boolean'}}})
		assert.equal(renameTool.function.description, 'Rename something')
		assert.deepEqual(renameTool.function.parameters, {type: 'object', properties: {title: {type: 'string'}}, required: ['title']})
		const init = mcp.seen.find((m) => m.method === 'initialize')
		assert.equal(init.jsonrpc, '2.0')
		assert.equal(init.params.protocolVersion, '2024-11-05')
		assert.equal(init.params.clientInfo.name, 'Omarchy Server')
		assert.ok(mcp.seen.every((m) => m.reqMethod === 'POST' && m.url === addr.path && m.jsonrpc === '2.0'))
		const statusCall = mcp.seen.filter((m) => m.method === 'tools/call' && m.params?.name === 'status')
		assert.equal(statusCall.length, 1)
		assert.deepEqual(statusCall[0].params.arguments, {verbose: true})
		assert.equal(mcp.seen.some((m) => m.method === 'tools/call' && m.params?.name === 'rename'), false)
		const toolMsg = seen[1].body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_status')
		assert.match(toolMsg.content, /ok-status/)
		assert.deepEqual(events.map((e) => e.event), ['tool', 'action', 'done'])
		assert.equal(events[0].data.name, 'app__demo__status')
		assert.equal(events[0].data.state, 'done')
		const action = events[1].data
		assert.equal(action.kind, 'mcp')
		assert.equal(action.status, 'pending')
		assert.equal(action.toolName, 'app__demo__rename')
		assert.equal(action.title, 'Demo: rename')
		assert.equal(action.detail, 'title: Cabinet')
		assert.equal(action.rpc, null)
		assert.deepEqual(action.mcp, {appId: 'demo', tool: 'rename', arguments: {title: 'Cabinet'}})
		assert.equal(JSON.stringify(action).includes('bad.name'), false)
		const before = box.calls.length
		await box.asst.procedures['assistant.approve'].run({actionId: action.id}, {auth: {userId: 'owner'}})
		assert.equal(box.calls.length, before)
		const renameCall = mcp.seen.filter((m) => m.method === 'tools/call' && m.params?.name === 'rename')
		assert.equal(renameCall.length, 1)
		assert.deepEqual(renameCall[0].params.arguments, {title: 'Cabinet'})
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.actions[0].status, 'done')
		assert.match(saved.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_rename').content, /renamed/)
		const follow = []
		await box.asst.runTurn({userId: 'owner', role: 'owner', conversationId: out.conversationId, continue: true, emit: (e) => follow.push(e)})
		assert.equal(follow.find((e) => e.event === 'text').data.text, 'Renamed.')
		assert.equal(follow.at(-1).event, 'done')
		const posted = seen.at(-1).body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_rename')
		assert.match(posted.content, /renamed/)
		await box.asst.procedures['assistant.approve'].run({actionId: action.id}, {auth: {userId: 'owner'}}).then(
			() => assert.fail('second approve'),
			(e) => assert.equal(e.code, 'CONFLICT'),
		)
		assert.equal(mcp.seen.filter((m) => m.method === 'tools/call' && m.params?.name === 'rename').length, 1)
	} finally {
		await box.close()
		await mcp.close()
	}
})

test('listing without mcp contributes no tools', async () => {
	const {seen, fetchImpl} = scripted([textSse('Hello.')])
	const guarded = async (url, opts) => {
		if (new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost') throw new Error(`unexpected fetch ${url}`)
		return fetchImpl(url, opts)
	}
	const box = await withAssistant({fetchImpl: guarded, mcpTargets: async () => []})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(seen[0].body.tools.map((t) => t.function.name), builtinNames())
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.find((e) => e.event === 'text').data.text, 'Hello.')
	} finally {
		await box.close()
	}
})

test('stopped app contributes no tools', async () => {
	const paused = startMcp({tools: [{name: 'secret', description: 'Secret', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}]})
	const rejected = startMcp({fail: true, tools: [{name: 'streamed', description: 'Streamed', inputSchema: {type: 'object', properties: {}}}]})
	const pausedAddr = await paused.listen()
	const rejectedAddr = await rejected.listen()
	const {seen, fetchImpl} = scripted([textSse('Hello.')])
	const box = await withAssistant({
		fetchImpl,
		mcpTargets: async () => [
			{appId: 'paused', name: 'Paused', url: pausedAddr.url, transport: 'http', running: false},
			{appId: 'stream', name: 'Stream', url: rejectedAddr.url, transport: 'sse', running: true},
			{appId: 'down', name: 'Down', url: 'http://127.0.0.1:1/mcp', transport: 'http', running: true},
		],
	})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(paused.seen.length, 0)
		assert.deepEqual(seen[0].body.tools.map((t) => t.function.name), builtinNames())
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.at(-1).event, 'done')
	} finally {
		await box.close()
		await paused.close()
		await rejected.close()
	}
})

test('callMcpTool refuses a non-loopback URL', async () => {
	let fetched = false
	const fetchImpl = async () => {
		fetched = true
		throw new Error('fetched')
	}
	await assert.rejects(() => callMcpTool({url: 'http://example.com/mcp', name: 'x', arguments: {}, fetchImpl}), /loopback/)
	await assert.rejects(() => callMcpTool({url: 'https://127.0.0.1/mcp', name: 'x', arguments: {}, fetchImpl}), /loopback/)
	await assert.rejects(() => callMcpTool({url: 'http://localhost/mcp', name: 'x', arguments: {}, fetchImpl}), /loopback/)
	await assert.rejects(() => callMcpTool({url: 'http://[::1]/mcp', name: 'x', arguments: {}, fetchImpl}), /loopback/)
	assert.equal(fetched, false)
	assert.deepEqual(await listMcpTools({url: 'http://example.com/mcp', transport: 'http', fetchImpl}), [])
	assert.deepEqual(await listMcpTools({url: 'http://127.0.0.1:9/mcp', transport: 'stdio', fetchImpl}), [])
	assert.equal(fetched, false)
})

test('listMcpTools caches a URL until the TTL', async () => {
	const mcp = startMcp({tools: [
		{name: 'status', description: 'Read the status', inputSchema: {type: 'object', properties: {verbose: {type: 'boolean'}}}, annotations: {readOnlyHint: true}},
		{name: 'rename', description: 'Rename something', inputSchema: {type: 'object', properties: {title: {type: 'string'}}}},
		{name: 'peek', description: 'Peek', inputSchema: {type: 'object', properties: {}}, readOnlyHint: true},
	]})
	const addr = await mcp.listen()
	let now = 10_000
	try {
		const listed = await listMcpTools({url: addr.url, transport: 'http', fetchImpl: fetch, now: () => now})
		assert.deepEqual(listed.map((t) => ({name: t.name, readOnly: t.readOnly})), [
			{name: 'status', readOnly: true},
			{name: 'rename', readOnly: false},
			{name: 'peek', readOnly: true},
		])
		assert.deepEqual(listed[0].inputSchema, {type: 'object', properties: {verbose: {type: 'boolean'}}})
		const n = mcp.seen.length
		assert.ok(n >= 1)
		const again = await listMcpTools({url: addr.url, transport: 'http', fetchImpl: fetch, now: () => now})
		assert.deepEqual(again, listed)
		assert.equal(mcp.seen.length, n)
		now += 59_999
		await listMcpTools({url: addr.url, transport: 'http', fetchImpl: fetch, now: () => now})
		assert.equal(mcp.seen.length, n)
		now += 1
		await listMcpTools({url: addr.url, transport: 'http', fetchImpl: fetch, now: () => now})
		assert.ok(mcp.seen.length > n)
	} finally {
		await mcp.close()
	}
})

test('approving an MCP action errors when the app is gone', async () => {
	const mcp = startMcp({tools: [
		{name: 'rename', description: 'Rename something', inputSchema: {type: 'object', properties: {title: {type: 'string'}}}, annotations: {readOnlyHint: false}},
	]})
	const addr = await mcp.listen()
	let live = true
	const {fetchImpl} = scripted([
		toolSse('call_rename', 'app__demo__rename', JSON.stringify({title: 'Cabinet'})),
		textSse('stopped'),
	])
	const box = await withAssistant({
		fetchImpl,
		mcpTargets: async () => (live ? [{appId: 'demo', name: 'Demo', url: addr.url, transport: 'http', running: true}] : []),
	})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'rename it', emit: (e) => events.push(e)})
		const action = events.find((e) => e.event === 'action').data
		assert.equal(action.kind, 'mcp')
		assert.equal(action.status, 'pending')
		live = false
		const before = mcp.seen.filter((m) => m.method === 'tools/call').length
		await assert.rejects(
			() => box.asst.procedures['assistant.approve'].run({actionId: action.id}, {auth: {userId: 'owner'}}),
			/not running/,
		)
		assert.equal(mcp.seen.filter((m) => m.method === 'tools/call').length, before)
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.actions[0].status, 'error')
		assert.match(saved.actions[0].error, /not running/)
		assert.match(saved.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_rename').content, /not running/)
	} finally {
		await box.close()
		await mcp.close()
	}
})

test('overlapping MCP Approves call the tool once', async () => {
	let release = () => {}
	const hold = new Promise((r) => {
		release = r
	})
	let entered = () => {}
	const inside = new Promise((r) => {
		entered = r
	})
	const mcp = startMcp({
		tools: [{name: 'rename', description: 'Rename something', inputSchema: {type: 'object', properties: {title: {type: 'string'}}}, annotations: {readOnlyHint: false}}],
		onCall: async () => {
			entered()
			await hold
		},
	})
	const addr = await mcp.listen()
	const {fetchImpl} = scripted([
		toolSse('call_rename', 'app__demo__rename', JSON.stringify({title: 'Cabinet'})),
		textSse('stopped'),
	])
	const box = await withAssistant({
		fetchImpl,
		mcpTargets: async () => [{appId: 'demo', name: 'Demo', url: addr.url, transport: 'http', running: true}],
	})
	try {
		const events = []
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'rename it', emit: (e) => events.push(e)})
		const id = events.find((e) => e.event === 'action').data.id
		const approve = () => box.asst.procedures['assistant.approve'].run({actionId: id}, {auth: {userId: 'owner'}})
		const first = approve()
		await inside
		const second = approve()
		const settled = Promise.allSettled([first, second])
		release()
		const done = await settled
		assert.equal(mcp.seen.filter((m) => m.method === 'tools/call').length, 1)
		assert.equal(done.filter((s) => s.status === 'fulfilled').length, 1)
		const rejected = done.find((s) => s.status === 'rejected')
		assert.equal(rejected.reason.code, 'CONFLICT')
		assert.equal(rejected.reason.message, 'That step was already handled')
	} finally {
		release()
		await box.close()
		await mcp.close()
	}
})

test('a restart within the TTL lists tools again', async () => {
	const tool = {name: 'status', description: 'Read the status', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}
	const mcp = startMcp({tools: [tool]})
	const other = startMcp({tools: [{name: 'other', description: 'Other', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}]})
	const addr = await mcp.listen()
	const otherAddr = await other.listen()
	let running = true
	const lists = () => mcp.seen.filter((m) => m.method === 'tools/list').length
	const {seen, fetchImpl} = scripted([
		textSse('Hi.'),
		textSse('Still.'),
		textSse('Gone.'),
		toolSse('call_status', 'app__demo__status', '{}'),
		textSse('Done.'),
	])
	const box = await withAssistant({
		fetchImpl,
		mcpTargets: async () => (running ? [{appId: 'demo', name: 'Demo', url: addr.url, transport: 'http', running: true}] : []),
	})
	try {
		await listMcpTools({url: otherAddr.url, transport: 'http', fetchImpl: fetch, now: () => 10_000})
		const otherLists = other.seen.filter((m) => m.method === 'tools/list').length
		const first = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: () => {}})
		assert.equal(lists(), 1)
		assert.equal(seen[0].body.tools.some((t) => t.function.name === 'app__demo__status'), true)
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'again', conversationId: first.conversationId, emit: () => {}})
		assert.equal(lists(), 1)
		running = false
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'stopped', conversationId: first.conversationId, emit: () => {}})
		assert.equal(lists(), 1)
		assert.equal(seen[2].body.tools.some((t) => t.function.name === 'app__demo__status'), false)
		tool.annotations.readOnlyHint = false
		running = true
		const events = []
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'check', conversationId: first.conversationId, emit: (e) => events.push(e)})
		assert.equal(lists(), 2)
		assert.equal(mcp.seen.filter((m) => m.method === 'tools/call').length, 0)
		const action = events.find((e) => e.event === 'action')
		assert.equal(action.data.kind, 'mcp')
		assert.equal(action.data.status, 'pending')
		assert.equal(action.data.mcp.tool, 'status')
		await listMcpTools({url: otherAddr.url, transport: 'http', fetchImpl: fetch, now: () => 10_000})
		assert.equal(other.seen.filter((m) => m.method === 'tools/list').length, otherLists)
	} finally {
		await box.close()
		await mcp.close()
		await other.close()
	}
})

test('an sse transport that answers the POST with an event still lists tools', async () => {
	const mcp = startMcp({
		frame: 'sse',
		tools: [{name: 'status', description: 'Read the status', inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: true}}],
	})
	const addr = await mcp.listen()
	try {
		const listed = await listMcpTools({url: addr.url, transport: 'sse', fetchImpl: fetch, ttlMs: 0})
		assert.deepEqual(listed.map((t) => t.name), ['status'])
		assert.equal(listed[0].readOnly, true)
		assert.ok(mcp.seen.every((m) => m.reqMethod === 'POST'))
	} finally {
		await mcp.close()
	}
})
