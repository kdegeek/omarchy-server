import {mkdir, readFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {writeAtomic} from '../atomic.mjs'
import {RpcError} from '../rpc.mjs'

const SPACEXAI = 'https://api.x.ai/v1'
const OPENAI = 'https://api.openai.com/v1'
// A ChatGPT sign-in belongs to the person who signed in: never shared, never the system default.
const personal = (k) => k.provider === 'chatgpt'
const ID = () => 'k_' + randomBytes(6).toString('hex')
const last4 = (s) => String(s).slice(-4)
const normalizeBaseUrl = (raw) => {
	const s = String(raw ?? '').trim().replace(/\/+$/, '')
	try {
		const u = new URL(s)
		if (!u.pathname || u.pathname === '/') return `${u.origin}/v1`
	} catch {}
	return s
}
const publicOf = (k, userId) => ({
	id: k.id,
	name: k.name,
	provider: k.provider,
	baseUrl: k.baseUrl,
	model: k.model,
	last4: k.last4,
	...(k.provider === 'chatgpt' ? {account: k.chatgpt?.email ?? null, signedIn: !!k.chatgpt?.refreshToken} : {}),
	ownerUserId: k.ownerUserId,
	sharedWith: k.sharedWith,
	systemDefault: !!k.systemDefault,
	mine: k.ownerUserId === userId,
	createdAt: k.createdAt,
	updatedAt: k.updatedAt,
})
const canUse = (k, userId) => k.ownerUserId === userId || (!personal(k) && (k.sharedWith.includes(userId) || k.systemDefault))

export function createKeyStore({dataDir, now = () => Date.now()}) {
	const file = join(dataDir, 'assistant', 'keys.json')
	let state = {keys: []}
	const loaded = mkdir(join(dataDir, 'assistant'), {recursive: true, mode: 0o700})
		.then(() => readFile(file, 'utf8'))
		.then((t) => {
			state = JSON.parse(t)
			if (!Array.isArray(state.keys)) state.keys = []
		})
		.catch(() => {})
	const save = () => writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600})
	const find = (id) => state.keys.find((k) => k.id === id)

	return {
		async listPublic(userId) {
			await loaded
			return state.keys.filter((k) => canUse(k, userId)).map((k) => publicOf(k, userId))
		},
		async add(actor, input) {
			await loaded
			const ownerUserId = actor.userId
			const provider = ['openai-compatible', 'spacexai', 'openai'].includes(input?.provider) ? input.provider : null
			if (!provider) throw new RpcError('BAD_REQUEST', 'Choose Grok, OpenAI or an OpenAI-compatible endpoint')
			// A custom endpoint makes omarchyd send requests to any address it can reach (your network
			// included), so only the server's owner can add one.
			if (provider === 'openai-compatible' && actor.role !== 'owner') throw new RpcError('FORBIDDEN', 'Only the server’s owner can add a custom endpoint')
			const apiKey = String(input?.apiKey ?? '').trim()
			if (apiKey.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			if (provider !== 'openai-compatible' && apiKey.length < 4) throw new RpcError('BAD_REQUEST', 'Enter an API key')
			const model = String(input?.model ?? '').trim()
			if (!model || model.length > 80) throw new RpcError('BAD_REQUEST', 'Enter a model id')
			const name = String(input?.name ?? '').trim().slice(0, 48) || ({spacexai: 'Grok', openai: 'OpenAI'}[provider] ?? 'API')
			let baseUrl = provider === 'spacexai' ? SPACEXAI : provider === 'openai' ? OPENAI : normalizeBaseUrl(input?.baseUrl)
			if (provider === 'openai-compatible') {
				if (!/^https?:\/\/[^\s]+/i.test(baseUrl) || baseUrl.length > 200) throw new RpcError('BAD_REQUEST', 'Enter the API base URL')
			}
			const t = now()
			const row = {id: ID(), ownerUserId, name, provider, baseUrl, model, apiKey, last4: last4(apiKey), sharedWith: [], systemDefault: false, createdAt: t, updatedAt: t}
			state.keys.push(row)
			await save()
			return publicOf(row, ownerUserId)
		},
		async update(actor, input) {
			await loaded
			const k = find(String(input?.id ?? ''))
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (personal(k) && (input?.systemDefault === true || (Array.isArray(input?.sharedWith) && input.sharedWith.length))) {
				throw new RpcError('FORBIDDEN', 'A ChatGPT sign-in is only for the person who signed in')
			}
			if (input?.systemDefault === true) {
				if (actor.role === 'member') throw new RpcError('FORBIDDEN', 'Only the server’s owner can set the default key')
				if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'You can only make a key you own the default')
				for (const x of state.keys) x.systemDefault = x.id === k.id
			} else if (input?.systemDefault === false && k.ownerUserId === actor.userId && actor.role !== 'member') {
				k.systemDefault = false
			}
			if (k.ownerUserId !== actor.userId && input?.sharedWith === undefined && input?.name === undefined && input?.model === undefined && input?.apiKey === undefined && input?.baseUrl === undefined && input?.systemDefault === undefined) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			if (k.ownerUserId !== actor.userId && (input?.sharedWith || input?.name || input?.model || input?.apiKey || input?.baseUrl)) {
				throw new RpcError('FORBIDDEN', 'Only the person who added this key can change it')
			}
			if (k.ownerUserId === actor.userId) {
				if (typeof input?.name === 'string') k.name = input.name.trim().slice(0, 48) || k.name
				if (typeof input?.model === 'string' && input.model.trim()) k.model = input.model.trim().slice(0, 80)
				if (typeof input?.apiKey === 'string') {
					const next = input.apiKey.trim()
					if (next.length > 512) throw new RpcError('BAD_REQUEST', 'Enter an API key')
					if (personal(k)) throw new RpcError('BAD_REQUEST', 'Sign in with ChatGPT again instead')
					if (k.provider !== 'openai-compatible' && next.length < 4) throw new RpcError('BAD_REQUEST', 'Enter an API key')
					if (k.provider === 'openai-compatible' || next.length >= 4) {
						k.apiKey = next
						k.last4 = last4(k.apiKey)
					}
				}
				if (k.provider === 'openai-compatible' && typeof input?.baseUrl === 'string') {
					if (actor.role !== 'owner') throw new RpcError('FORBIDDEN', 'Only the server’s owner can change a custom endpoint')
					k.baseUrl = normalizeBaseUrl(input.baseUrl)
				}
				if (Array.isArray(input?.sharedWith)) k.sharedWith = [...new Set(input.sharedWith.map((id) => String(id)).filter((id) => id && id !== k.ownerUserId))].slice(0, 32)
			}
			k.updatedAt = now()
			await save()
			return publicOf(k, actor.userId)
		},
		async remove(actor, id) {
			await loaded
			const k = find(id)
			if (!k) throw new RpcError('NOT_FOUND', 'That key isn’t here')
			if (k.ownerUserId !== actor.userId) throw new RpcError('FORBIDDEN', 'Only the person who added this key can delete it')
			state.keys = state.keys.filter((x) => x.id !== id)
			await save()
			return true
		},
		// Sign in with ChatGPT: one row per person and ChatGPT account (signing in again updates it).
		async saveChatGpt(userId, {sub, email, clientId, accessToken, refreshToken, idToken, expiresAt, scope, model}) {
			await loaded
			const t = now()
			let k = state.keys.find((x) => x.provider === 'chatgpt' && x.ownerUserId === userId && x.chatgpt?.sub === sub)
			if (!k) {
				k = {id: ID(), ownerUserId: userId, name: 'ChatGPT', provider: 'chatgpt', baseUrl: OPENAI, model: model || '', apiKey: '', last4: '', sharedWith: [], systemDefault: false, createdAt: t}
				state.keys.push(k)
			}
			if (model && !k.model) k.model = model
			k.chatgpt = {sub, email: email ?? null, clientId, accessToken, refreshToken, idToken, expiresAt, scope}
			k.updatedAt = t
			await save()
			return publicOf(k, userId)
		},
		async updateChatGptTokens(id, tokens) {
			await loaded
			const k = find(id)
			if (!k || k.provider !== 'chatgpt') return null
			k.chatgpt = {...k.chatgpt, ...tokens}
			await save()
			return k
		},
		async getSecret(id) {
			await loaded
			return find(id) ?? null
		},
		async resolveForUser(userId, keyId) {
			await loaded
			if (keyId) {
				const k = find(keyId)
				if (!k || !canUse(k, userId)) throw new RpcError('NOT_FOUND', 'That key isn’t available')
				return k
			}
			const own = state.keys.filter((k) => k.ownerUserId === userId)
			if (own.length) return own.sort((a, b) => b.updatedAt - a.updatedAt)[0]
			const shared = state.keys.filter((k) => k.sharedWith.includes(userId))
			if (shared.length) return shared[0]
			const def = state.keys.find((k) => k.systemDefault)
			if (def) return def
			throw new RpcError('PRECONDITION_FAILED', 'Sign in with ChatGPT or add an API key in Settings → Assistant (or ask the owner to share one)')
		},
	}
}
