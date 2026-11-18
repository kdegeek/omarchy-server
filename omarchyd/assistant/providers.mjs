import {randomBytes} from 'node:crypto'

const completeArgs = (s) => {
	if (!s) return false
	try {
		JSON.parse(s)
		return true
	} catch {
		return false
	}
}

const callId = () => 'call_' + randomBytes(4).toString('hex')

const TOOL_PREFIXES = ['<tool_call', '<function=']

function incompleteToolStart(rest) {
	const unclosedCall = rest.search(/<tool_call>/)
	if (unclosedCall >= 0 && !rest.includes('</tool_call>', unclosedCall)) return unclosedCall
	const unclosedFn = rest.search(/<function=/)
	if (unclosedFn >= 0 && !rest.includes('</function>', unclosedFn)) return unclosedFn
	const lt = rest.lastIndexOf('<')
	if (lt >= 0) {
		const tail = rest.slice(lt)
		if (TOOL_PREFIXES.some((p) => p.startsWith(tail))) return lt
		if (['</tool_call>', '</function>'].some((p) => p.startsWith(tail))) return lt
	}
	return -1
}

const paramsToArgs = (body) => {
	const args = {}
	const re = /<parameter=([^\s>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
	let m
	while ((m = re.exec(body))) args[m[1]] = m[2]
	return Object.keys(args).length ? JSON.stringify(args) : '{}'
}

const toolsFromXmlInner = (block) => {
	const tools = []
	const json = String(block ?? '').trim()
	if (json.startsWith('{')) {
		try {
			const obj = JSON.parse(json)
			const name = String(obj.name ?? obj.function ?? '').trim()
			if (name) {
				const raw = obj.arguments
				const argumentsText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
				tools.push({type: 'tool', id: callId(), name, arguments: argumentsText || '{}'})
			}
		} catch {}
		return tools
	}
	const fn = /<function=([^\s>]+)>([\s\S]*?)<\/function>/g
	let m
	while ((m = fn.exec(block))) tools.push({type: 'tool', id: callId(), name: m[1], arguments: paramsToArgs(m[2])})
	return tools
}

export function takeXmlTools(buf, final) {
	let text = ''
	const tools = []
	let rest = String(buf ?? '')
	for (;;) {
		const wrapped = rest.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
		const fn = rest.match(/<function=([^\s>]+)>([\s\S]*?)<\/function>/)
		const wAt = wrapped ? rest.indexOf(wrapped[0]) : -1
		const fAt = fn ? rest.indexOf(fn[0]) : -1
		let at = -1
		let raw = ''
		let inner = ''
		if (wAt >= 0 && (fAt < 0 || wAt <= fAt)) {
			at = wAt
			raw = wrapped[0]
			inner = wrapped[1]
		} else if (fAt >= 0) {
			at = fAt
			raw = fn[0]
			inner = fn[0]
		}
		if (at < 0) break
		text += rest.slice(0, at)
		tools.push(...toolsFromXmlInner(inner))
		rest = rest.slice(at + raw.length).replace(/^\s*<\/(?:tool_call|function)>/, '')
	}
	rest = rest.replace(/^\s*<\/(?:tool_call|function)>/, '')
	const hold = incompleteToolStart(rest)
	if (hold >= 0) {
		text += rest.slice(0, hold)
		rest = final ? '' : rest.slice(hold)
		return {text, tools, rest}
	}
	text += rest
	return {text, tools, rest: ''}
}

const errorMessage = (raw, status) => {
	try {
		const json = JSON.parse(raw)
		const m = json.error?.message || json.message
		if (m) return String(m)
	} catch {}
	return (raw && String(raw).trim()) || `HTTP ${status}`
}

function parseEvent(event, pending) {
	const data = event.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).replace(/^ /, ''))
		.join('\n')
	const out = {content: '', tools: []}
	if (!data || data === '[DONE]') return out
	let json
	try {
		json = JSON.parse(data)
	} catch {
		return out
	}
	const choice = json.choices?.[0] ?? {}
	const delta = choice.delta ?? {}
	if (typeof delta.content === 'string' && delta.content) out.content += delta.content
	if (typeof choice.message?.content === 'string' && choice.message.content) out.content += choice.message.content
	const addCall = (tc) => {
		if (!tc || typeof tc !== 'object') return
		const i = tc.index ?? pending.length
		const row = pending[i] ?? (pending[i] = {id: '', name: '', arguments: '', done: false})
		if (tc.id) row.id = tc.id
		if (tc.function?.name) row.name = tc.function.name
		if (typeof tc.function?.arguments === 'string') row.arguments += tc.function.arguments
		else if (tc.function?.arguments && typeof tc.function.arguments === 'object') row.arguments = JSON.stringify(tc.function.arguments)
		if (!row.done && row.name && completeArgs(row.arguments)) {
			row.done = true
			if (!row.id) row.id = callId()
			out.tools.push({type: 'tool', id: row.id, name: row.name, arguments: row.arguments})
		}
	}
	for (const tc of delta.tool_calls ?? []) addCall(tc)
	for (const tc of choice.message?.tool_calls ?? []) addCall(tc)
	return out
}



export async function* streamChat({baseUrl, apiKey, model, messages, tools, fetchImpl = fetch, signal}) {
	const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages,
			tools,
			stream: true,
			parallel_tool_calls: false,
			tool_choice: 'auto',
		}),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorMessage(raw, res.status), status: res.status}
		return
	}
	const pending = []
	const decoder = new TextDecoder()
	let buf = ''
	let contentBuf = ''
	const pump = function* (event, final) {
		const parsed = parseEvent(event, pending)
		if (parsed.content) contentBuf += parsed.content
		const next = takeXmlTools(contentBuf, final)
		contentBuf = next.rest
		if (next.text) yield {type: 'text', text: next.text}
		for (const t of next.tools) yield t
		for (const t of parsed.tools) yield t
	}
	const body = res.body
	if (body) {
		for await (const chunk of body) {
			buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})
			buf = buf.replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* pump(event, false)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* pump(buf.replace(/\r\n/g, '\n'), false)
	yield* pump('', true)
	for (const row of pending) {
		if (row?.done || !row?.name) continue
		const args = row.arguments && completeArgs(row.arguments) ? row.arguments : '{}'
		row.done = true
		if (!row.id) row.id = callId()
		yield {type: 'tool', id: row.id, name: row.name, arguments: args}
	}
}

// ---- ChatGPT plan usage: the Responses API -----------------------------------------------------
// Sign in with ChatGPT supports only POST /v1/responses, with store:false and stream:true. The loop
// speaks Chat Completions, so its messages and tools are converted here, and the stream comes back
// as the same {text | tool | error} events. A system message becomes `instructions` (system input
// items are refused).
export function responsesInput(messages) {
	let instructions = ''
	const input = []
	for (const m of messages ?? []) {
		if (!m) continue
		if (m.role === 'system') instructions += (instructions ? '\n\n' : '') + String(m.content ?? '')
		else if (m.role === 'user') input.push({role: 'user', content: String(m.content ?? '')})
		else if (m.role === 'assistant') {
			if (m.content) input.push({role: 'assistant', content: String(m.content)})
			for (const t of m.tool_calls ?? []) input.push({type: 'function_call', call_id: t.id, name: t.function?.name, arguments: t.function?.arguments || '{}'})
		} else if (m.role === 'tool') input.push({type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '')})
	}
	return {instructions, input}
}

export const responsesTools = (tools) =>
	(tools ?? []).map((t) => ({type: 'function', name: t.function?.name, description: t.function?.description ?? '', parameters: t.function?.parameters ?? {type: 'object', properties: {}}}))

export async function* streamResponses({accessToken, model, messages, tools, fetchImpl = fetch, signal, baseUrl = 'https://api.openai.com/v1'}) {
	const {instructions, input} = responsesInput(messages)
	const res = await fetchImpl(`${baseUrl}/responses`, {
		method: 'POST',
		headers: {'content-type': 'application/json', authorization: `Bearer ${accessToken}`, accept: 'text/event-stream'},
		body: JSON.stringify({model, instructions, input, tools: responsesTools(tools), tool_choice: 'auto', parallel_tool_calls: false, store: false, stream: true}),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorMessage(raw, res.status), status: res.status}
		return
	}
	const decoder = new TextDecoder()
	let buf = ''
	let completed = false
	const handle = function* (event) {
		const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
		if (!data || data === '[DONE]') return
		let ev
		try {
			ev = JSON.parse(data)
		} catch {
			return
		}
		if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string' && ev.delta) yield {type: 'text', text: ev.delta}
		else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call' && ev.item.name) {
			yield {type: 'tool', id: ev.item.call_id || ev.item.id || callId(), name: ev.item.name, arguments: ev.item.arguments || '{}'}
		} else if (ev.type === 'response.completed') completed = true
		else if (ev.type === 'response.failed' || ev.type === 'response.incomplete' || ev.type === 'error') {
			completed = true
			const err = ev.response?.error ?? ev.error ?? ev
			yield {type: 'error', message: String(err?.message || ev.response?.incomplete_details?.reason || 'ChatGPT didn’t finish the answer'), status: Number(err?.status) || 0}
		}
	}
	if (res.body) {
		for await (const chunk of res.body) {
			buf += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})).replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* handle(event)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* handle(buf.replace(/\r\n/g, '\n'))
	// An interrupted stream is a failure, not an answer.
	if (!completed && !signal?.aborted) yield {type: 'error', message: 'The answer from ChatGPT was cut off; try again'}
}
