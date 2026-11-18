import {callMcpTool, forgetMcpTools, listMcpTools} from './mcp.mjs'
import {streamChat, streamResponses} from './providers.mjs'
import {filterAppStore, isWriteTool, lookupTool, openAiTools, writeTool} from './tools.mjs'

export const SYSTEM_PROMPT = 'You are the Omarchy Server assistant on this machine and its Local swarm. You do not write programs or propose shell commands. Use only the given tools. Lookups run immediately. Writes become Approve cards the person must approve. Theme colours only: omarchy_setTheme. Wallpaper or theme plus wallpaper: only omarchy_setBackground with the theme slug. Do not call both. Stay on this host.'

const LIMIT = 'I hit the lookup limit for this turn.'
const KEY_REJECTED = 'That API key was rejected. Replace it in Settings → Assistant.'
const CHATGPT_REJECTED = 'ChatGPT turned down the request. Sign in with ChatGPT again in Settings → Assistant.'
const MAX_CALLS = 16
const MAX_MESSAGES = 40

const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null))

function stripSecrets(value) {
	if (Array.isArray(value)) return value.map(stripSecrets)
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const [k, v] of Object.entries(value)) {
		if (k === 'password' || k === 'apiKey' || k === 'credentials' || k === 'defaultPassword') continue
		out[k] = stripSecrets(v)
	}
	return out
}

function plainInput(args) {
	const input = stripSecrets(args)
	return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

function redactToolResult(name, result) {
	if (name !== 'apps_list' && name !== 'appStore_app') return result
	if (Array.isArray(result)) return result.map(stripSecrets)
	return stripSecrets(result)
}

const BACKGROUND_ID = /^[0-9a-f]{16}$/

function lookAlreadyApplied(row) {
	let lastUserAt = 0
	for (const m of row?.messages ?? []) if (m.role === 'user') lastUserAt = m.at ?? 0
	return (row?.actions ?? []).some((a) => {
		if (a.toolName !== 'omarchy_setTheme' && a.toolName !== 'omarchy_setBackground') return false
		if (a.status !== 'done') return false
		return (a.resolvedAt ?? a.createdAt ?? 0) >= lastUserAt
	})
}

export function publicAction(action) {
	if (!action || typeof action !== 'object') return action
	const copy = {...action}
	delete copy.password
	if (action.rpc && typeof action.rpc === 'object') copy.rpc = {path: action.rpc.path, input: plainInput(action.rpc.input)}
	if (action.mcp && typeof action.mcp === 'object') copy.mcp = {...action.mcp, arguments: stripSecrets(action.mcp.arguments)}
	if (action.toolName === 'omarchy_setBackground') {
		const input = copy.rpc?.input && typeof copy.rpc.input === 'object' ? copy.rpc.input : {}
		const theme = String(input.theme ?? action.detail ?? '').trim() || null
		const selected = BACKGROUND_ID.test(String(input.id ?? '')) ? String(input.id) : null
		copy.picker = {theme, selected}
	}
	return copy
}

function storedArguments(name, raw) {
	const text = raw || '{}'
	if (name !== 'machines_create') return text
	try {
		return JSON.stringify(plainInput(parseArgs(text)))
	} catch {
		return text
	}
}

function storedMcpArguments(raw) {
	try {
		return JSON.stringify(plainInput(parseArgs(raw)))
	} catch {
		return raw || '{}'
	}
}

function cardFor(name, args) {
	const a = args && typeof args === 'object' ? args : {}
	const appId = String(a.appId ?? '').trim()
	const apps = {apps_install: 'Install', apps_start: 'Start', apps_stop: 'Stop', apps_restart: 'Restart', apps_uninstall: 'Uninstall', apps_update: 'Update'}
	if (apps[name]) return {title: appId ? `${apps[name]} ${appId}` : `${apps[name]} an app`, detail: appId || name}
	if (name === 'machines_create') {
		const vm = String(a.name ?? '').trim()
		const bits = []
		if (a.osId) bits.push(String(a.osId))
		if (a.cores != null && a.cores !== '') bits.push(`${a.cores} cores`)
		if (a.memoryGb != null && a.memoryGb !== '') bits.push(`${a.memoryGb} GB memory`)
		if (a.diskSizeGb != null && a.diskSizeGb !== '') bits.push(`${a.diskSizeGb} GB disk`)
		if (a.username) bits.push(`user ${a.username}`)
		bits.push('You type its password when you approve')
		return {title: vm ? `Create VM “${vm}”` : 'Create a virtual machine', detail: bits.join(' · ')}
	}
	const id = String(a.id ?? '').trim()
	const vmVerb = {machines_start: 'Start', machines_stop: 'Stop', machines_restart: 'Restart', machines_uninstall: 'Remove'}[name]
	if (vmVerb) return {title: id ? `${vmVerb} VM ${id}` : `${vmVerb} a virtual machine`, detail: id || name}
	if (name === 'machines_updateSettings') {
		const n = Array.isArray(a.portForwards) ? a.portForwards.length : 0
		return {title: id ? `Update settings for ${id}` : 'Update virtual machine settings', detail: n ? `${n} port forward${n === 1 ? '' : 's'}` : 'Settings'}
	}
	if (name === 'swarm_action') {
		const labels = {'plugin-install': 'Install a swarm plugin', 'plugin-remove': 'Remove a swarm plugin', 'theme-set': 'Set a swarm theme', reboot: 'Reboot a swarm computer'}
		return {title: labels[a.name] || 'Swarm action', detail: [a.id, a.name, a.pluginId, a.theme].filter((v) => v != null && v !== '').map(String).join(' · ')}
	}
	if (name === 'swarm_rename') return {title: a.name ? `Rename swarm computer to ${a.name}` : 'Rename a swarm computer', detail: [a.id, a.name].filter(Boolean).join(' · ')}
	if (name === 'omarchy_setTheme') return {title: a.slug ? `Set theme ${a.slug}` : 'Set the Omarchy theme', detail: String(a.slug ?? '')}
	if (name === 'omarchy_setBackground') {
		const theme = String(a.theme ?? '').trim()
		return {title: theme ? `Set wallpaper for ${theme}` : 'Set the wallpaper', detail: theme || String(a.id ?? '')}
	}
	if (name === 'omarchy_installPlugin') return {title: a.id ? `Install plugin ${a.id}` : 'Install an Omarchy plugin', detail: String(a.id ?? '')}
	if (name === 'omarchy_removePlugin') return {title: a.id ? `Remove plugin ${a.id}` : 'Remove an Omarchy plugin', detail: String(a.id ?? '')}
	if (name === 'system_restart') return {title: 'Restart this server', detail: 'The server restarts when you approve'}
	if (name === 'system_shutdown') return {title: 'Shut down this server', detail: 'The server shuts down when you approve'}
	return {title: name, detail: ''}
}

function cardForMcp(spec, args) {
	const shown = plainInput(args)
	const bits = []
	for (const [k, v] of Object.entries(shown)) bits.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v ?? null)}`)
	return {title: `${spec.appName}: ${spec.mcpName}`, detail: bits.join(' · ') || spec.description || ''}
}

function pendingNote(actions) {
	const open = (actions ?? []).filter((a) => a.status === 'pending')
	if (!open.length) return ''
	return open.map((a) => `Pending approval: ${a.title}. ${a.detail}`).join('\n')
}

const WAITING = 'this step is still waiting for Approve'

function toOpenAI(m) {
	if (m.role === 'user') return {role: 'user', content: String(m.content ?? '')}
	if (m.role === 'assistant') {
		const msg = {role: 'assistant', content: m.content ? String(m.content) : null}
		if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
			msg.tool_calls = m.toolCalls.map((t) => ({
				id: t.id,
				type: 'function',
				function: {name: t.name, arguments: t.arguments || '{}'},
			}))
		}
		return msg
	}
	if (m.role === 'tool') return {role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '')}
	return null
}

function placeholder(action) {
	if (action?.status === 'error') return action.error || 'That step failed'
	if (action?.status === 'rejected') return 'user rejected this step'
	return WAITING
}

// Tool results must sit immediately after their tool_calls. A later user message, or an Approve that appends the real result at the end, would otherwise leave a gap the provider rejects. Missing results stay synthetic; the action is not changed.
function providerHistory(messages, actions) {
	const toolById = new Map()
	for (const m of messages) {
		if (m?.role === 'tool' && m.toolCallId && !toolById.has(m.toolCallId)) toolById.set(m.toolCallId, m)
	}
	const actionByCall = new Map()
	for (const a of actions ?? []) if (a?.toolCallId) actionByCall.set(a.toolCallId, a)
	const out = []
	for (const m of messages) {
		if (m?.role === 'tool') continue
		const o = toOpenAI(m)
		if (!o) continue
		out.push(o)
		if (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || !m.toolCalls.length) continue
		for (const t of m.toolCalls) {
			const found = toolById.get(t.id)
			out.push(found ? toOpenAI(found) : {role: 'tool', tool_call_id: t.id, content: placeholder(actionByCall.get(t.id))})
		}
	}
	const history = out.slice(-MAX_MESSAGES)
	while (history[0]?.role === 'tool') history.shift()
	return history
}

function parseArgs(raw) {
	if (!raw || !String(raw).trim()) return {}
	const args = JSON.parse(raw)
	if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
	return args
}

function abortError() {
	const error = new Error('The turn was stopped')
	error.name = 'AbortError'
	return error
}

// Stop waiting as soon as the turn is aborted, and pass the signal through so the call can stop too.
function watchAbort(signal, pending) {
	if (!signal) return pending
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError())
		if (signal.aborted) {
			onAbort()
			Promise.resolve(pending).catch(() => {})
			return
		}
		signal.addEventListener('abort', onAbort, {once: true})
		Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
	})
}

export function createLoop({keys, conversations, runProcedure, fetchImpl, mcpTargets, chatgpt = null, now = () => Date.now()}) {
	const stamp = () => now()

	async function grab(name, auth, input = {}) {
		if (!runProcedure) return null
		try {
			return await runProcedure(name, input, auth)
		} catch {
			return null
		}
	}

	async function facts(role, auth) {
		const owner = role === 'owner'
		const hostname = await grab('system.getHostname', auth)
		const device = await grab('system.device', auth)
		const apps = await grab('apps.list', auth)
		const swarm = owner ? await grab('swarm.list', auth) : null
		const appIds = Array.isArray(apps) ? apps.map((a) => a?.id).filter(Boolean) : []
		const swarmNames = Array.isArray(swarm) ? swarm.map((s) => s?.name).filter(Boolean) : []
		const lines = [SYSTEM_PROMPT, '', `Role: ${owner ? 'owner' : 'member'}`]
		if (typeof hostname === 'string' && hostname) lines.push(`Hostname: ${hostname}`)
		if (device && typeof device === 'object' && device.device) lines.push(`Device: ${device.device}${device.os ? ` (${device.os})` : ''}`)
		lines.push(`Installed apps: ${appIds.join(', ') || 'none'}`)
		if (owner) lines.push(`Swarm: ${swarmNames.join(', ') || 'none'}`)
		return lines.join('\n')
	}

	// Built-in writes live in WRITE_TOOLS. An MCP tool is a write unless readOnlyHint is true.
	// URLs this loop last saw running. A URL that leaves mcpTargets drops its cached tool list; the 60s TTL still covers apps that stay up.
	const mcpLive = new Set()
	async function mcpCatalog(signal) {
		if (typeof mcpTargets !== 'function') return []
		let targets
		try {
			targets = await mcpTargets()
		} catch (e) {
			if (e?.name === 'AbortError' || signal?.aborted) throw e
			return []
		}
		if (!Array.isArray(targets)) return []
		const running = []
		for (const target of targets) {
			if (!target || target.running === false) continue
			if (typeof target.appId !== 'string' || !target.appId || typeof target.url !== 'string' || !target.url) continue
			running.push(target)
		}
		const urls = new Set(running.map((t) => t.url))
		const gone = []
		for (const url of mcpLive) if (!urls.has(url)) gone.push(url)
		if (gone.length) forgetMcpTools(gone)
		mcpLive.clear()
		for (const url of urls) mcpLive.add(url)
		const out = []
		const seen = new Set()
		for (const target of running) {
			let listed = []
			try {
				listed = await listMcpTools({url: target.url, transport: target.transport, fetchImpl, signal})
			} catch (e) {
				if (e?.name === 'AbortError' || signal?.aborted) throw e
				continue
			}
			for (const tool of listed ?? []) {
				if (!tool?.name) continue
				const name = `app__${target.appId}__${tool.name}`
				if (!/^[a-zA-Z0-9_-]+$/.test(name) || seen.has(name)) continue
				seen.add(name)
				out.push({
					name,
					appId: target.appId,
					appName: String(target.name || target.appId),
					mcpName: tool.name,
					description: tool.description || tool.name,
					parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {type: 'object', properties: {}},
					readOnly: tool.readOnly === true,
					url: target.url,
				})
			}
		}
		return out
	}

	async function propose(tool, auth, conversationId) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		let name = tool.name
		if (name === 'omarchy_setTheme') {
			const slug = String(args.slug ?? args.theme ?? '').trim()
			name = 'omarchy_setBackground'
			args = {theme: slug, ...(BACKGROUND_ID.test(String(args.id ?? '')) ? {id: String(args.id)} : {})}
		}
		const spec = writeTool(name)
		if (!spec || (spec.ownerOnly && auth.role !== 'owner')) return {content: 'unknown tool', state: 'done'}
		if (name === 'omarchy_setBackground') {
			const row = await conversations.get(auth.userId, conversationId)
			if (lookAlreadyApplied(row)) {
				return {content: 'Theme and wallpaper were already applied for this request. Do not call omarchy_setTheme or omarchy_setBackground again unless they ask for a different look.', state: 'done'}
			}
		}
		const card = cardFor(spec.name, args)
		const action = await conversations.putAction(auth.userId, conversationId, {
			kind: 'rpc',
			toolName: spec.name,
			toolCallId: tool.id,
			title: card.title,
			detail: card.detail,
			rpc: {path: spec.rpc, input: plainInput(args)},
			mcp: null,
			ownerOnly: !!spec.ownerOnly,
		})
		return {action}
	}

	async function proposeMcp(tool, auth, conversationId, spec) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		const card = cardForMcp(spec, args)
		const action = await conversations.putAction(auth.userId, conversationId, {
			kind: 'mcp',
			toolName: spec.name,
			toolCallId: tool.id,
			title: card.title,
			detail: card.detail,
			rpc: null,
			mcp: {appId: spec.appId, tool: spec.mcpName, arguments: plainInput(args)},
			ownerOnly: false,
		})
		return {action}
	}

	async function runMcp(tool, spec, signal) {
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		try {
			const result = await callMcpTool({url: spec.url, name: spec.mcpName, arguments: args, fetchImpl, signal})
			return {content: textOf(result), state: 'done'}
		} catch (e) {
			if (e?.name === 'AbortError' || signal?.aborted) throw e
			return {content: e?.message || 'tool failed', state: 'error'}
		}
	}

	async function runTool(tool, auth, signal) {
		if (signal?.aborted) throw abortError()
		const read = lookupTool(tool.name)
		if (!read) return {content: 'unknown tool', state: 'done'}
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		try {
			if (signal?.aborted) throw abortError()
			if (!runProcedure) return {content: 'tool failed', state: 'error'}
			const pending = read.name === 'appStore_search' ? runProcedure('appStore.registry', {}, auth, signal) : runProcedure(read.rpc, args, auth, signal)
			const raw = await watchAbort(signal, pending)
			if (signal?.aborted) throw abortError()
			const result = read.name === 'appStore_search' ? filterAppStore(raw, args) : raw
			return {content: textOf(redactToolResult(read.name, result)), state: 'done'}
		} catch (e) {
			if (signal?.aborted || e?.name === 'AbortError') throw e?.name === 'AbortError' ? e : abortError()
			return {content: e?.message || 'tool failed', state: 'error'}
		}
	}

	async function runTurn({userId, role, message, conversationId, keyId, signal, emit, continue: resume}) {
		const say = (event, data) => {
			if (typeof emit === 'function') emit({event, data})
		}
		let row = null
		const finish = (conversationIdOut) => ({conversationId: conversationIdOut ?? null})
		try {
			if (conversationId) row = await conversations.get(userId, conversationId)
			let key
			try {
				key = await keys.resolveForUser(userId, keyId || row?.keyId || undefined)
			} catch (e) {
				say('error', {message: e?.message || 'Sign in with ChatGPT or add an API key in Settings → Assistant (or ask the owner to share one)'})
				return finish(row?.id)
			}
			if (resume && !row) {
				say('error', {message: 'That chat isn’t here'})
				return finish(null)
			}
			if (!row) {
				const title = String(message ?? '').split(/\r?\n/)[0].trim().slice(0, 48) || 'Chat'
				row = await conversations.create(userId, {keyId: key.id, title})
			} else if (row.keyId !== key.id) {
				row = await conversations.setKey(userId, row.id, key.id)
			}
			const auth = {userId, role}
			if (!resume) row = await conversations.append(userId, row.id, {role: 'user', content: String(message ?? ''), at: stamp()})
			const system = await facts(role, auth)
			let catalog = []
			try {
				catalog = await mcpCatalog(signal)
			} catch (e) {
				if (signal?.aborted || e?.name === 'AbortError') return finish(row.id)
				catalog = []
			}
			if (signal?.aborted) return finish(row.id)
			const mcpByName = new Map(catalog.map((t) => [t.name, t]))
			const mcpWrite = (name) => {
				const spec = mcpByName.get(name)
				return !!spec && spec.readOnly !== true
			}
			const tools = [
				...openAiTools(role),
				...catalog.map((t) => ({
					type: 'function',
					function: {name: t.name, description: t.description, parameters: t.parameters},
				})),
			]
			let used = 0

			const stopped = async (text) => {
				if (text) row = await conversations.append(userId, row.id, {role: 'assistant', content: text, at: stamp()})
			}

			for (;;) {
				if (signal?.aborted) return finish(row.id)
				const history = providerHistory(row.messages, row.actions)
				const note = pendingNote(row.actions)
				const messages = [{role: 'system', content: note ? `${system}\n\n${note}` : system}, ...history]
				let text = ''
				const toolCalls = []
				let providerError = null
				try {
					// A ChatGPT sign-in uses the person's plan through the Responses API; everything else
					// is an OpenAI-style Chat Completions endpoint.
					const events =
						key.provider === 'chatgpt'
							? streamResponses({accessToken: await chatgpt.accessToken(key.id), model: key.model, messages, tools, fetchImpl, signal})
							: streamChat({baseUrl: key.baseUrl, apiKey: key.apiKey, model: key.model, messages, tools, fetchImpl, signal})
					for await (const ev of events) {
						if (signal?.aborted) break
						if (ev.type === 'text') {
							text += ev.text
							say('text', {text: ev.text})
						} else if (ev.type === 'tool') toolCalls.push(ev)
						else if (ev.type === 'error') {
							providerError = ev
							break
						}
					}
				} catch (e) {
					await stopped(text)
					if (signal?.aborted || e?.name === 'AbortError') return finish(row.id)
					say('error', {message: e?.message || 'The assistant did not answer'})
					return finish(row.id)
				}
				if (signal?.aborted) {
					await stopped(text)
					return finish(row.id)
				}
				if (providerError) {
					await stopped(text)
					say('error', {message: providerError.status === 401 ? (key.provider === 'chatgpt' ? CHATGPT_REJECTED : KEY_REJECTED) : (providerError.message || 'The assistant did not answer')})
					return finish(row.id)
				}
				if (!toolCalls.length) {
					await stopped(text)
					say('done', {conversationId: row.id})
					return finish(row.id)
				}
				let end = toolCalls.length
				for (let i = 0; i < toolCalls.length; i++) {
					if (isWriteTool(toolCalls[i].name) || mcpWrite(toolCalls[i].name)) {
						end = i + 1
						break
					}
				}
				const batch = toolCalls.slice(0, end)
				row = await conversations.append(userId, row.id, {
					role: 'assistant',
					content: text,
					toolCalls: batch.map((t) => ({id: t.id, name: t.name, arguments: mcpByName.has(t.name) ? storedMcpArguments(t.arguments) : storedArguments(t.name, t.arguments)})),
					at: stamp(),
				})
				let hit = false
				for (const tool of batch) {
					if (isWriteTool(tool.name)) {
						const outcome = await propose(tool, auth, row.id)
						if (outcome.action) {
							say('action', publicAction(outcome.action))
							say('done', {conversationId: row.id})
							return finish(row.id)
						}
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: outcome.content,
							at: stamp(),
						})
						say('tool', {name: tool.name, state: outcome.state})
						used++
						if (used >= MAX_CALLS) hit = true
						continue
					}
					if (mcpWrite(tool.name)) {
						const outcome = await proposeMcp(tool, auth, row.id, mcpByName.get(tool.name))
						if (outcome.action) {
							say('action', publicAction(outcome.action))
							say('done', {conversationId: row.id})
							return finish(row.id)
						}
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: outcome.content,
							at: stamp(),
						})
						say('tool', {name: tool.name, state: outcome.state})
						used++
						if (used >= MAX_CALLS) hit = true
						continue
					}
					if (used >= MAX_CALLS) {
						hit = true
						row = await conversations.append(userId, row.id, {
							role: 'tool',
							toolCallId: tool.id,
							name: tool.name,
							content: LIMIT,
							at: stamp(),
						})
						continue
					}
					if (signal?.aborted) return finish(row.id)
					const outcome = mcpByName.has(tool.name) ? await runMcp(tool, mcpByName.get(tool.name), signal) : await runTool(tool, auth, signal)
					if (signal?.aborted) return finish(row.id)
					used++
					row = await conversations.append(userId, row.id, {
						role: 'tool',
						toolCallId: tool.id,
						name: tool.name,
						content: outcome.content,
						at: stamp(),
					})
					say('tool', {name: tool.name, state: outcome.state})
					if (used >= MAX_CALLS) hit = true
				}
				if (!hit) continue
				row = await conversations.append(userId, row.id, {role: 'assistant', content: LIMIT, at: stamp()})
				say('text', {text: LIMIT})
				say('done', {conversationId: row.id})
				return finish(row.id)
			}
		} catch (e) {
			if (signal?.aborted || e?.name === 'AbortError') return finish(row?.id)
			say('error', {message: e?.message || 'The assistant did not answer'})
			return finish(row?.id)
		}
	}

	function runTurnContinue(opts) {
		return runTurn({...opts, continue: true})
	}

	return {runTurn, runTurnContinue}
}
