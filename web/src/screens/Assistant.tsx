import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {ApiError, mutate, query, type AssistantAction, type AssistantKey} from '../api'
import {cardAction, markReopenAssistant, streamAssistant, threadItems, type AssistantConversation, type AssistantConversationSummary, type AssistantItem, type AssistantStreamBody} from '../assistant'
import {useUser} from '../data'
import {Icon} from '../icons'
import {haptic, omarchyBackgroundUrl, useOmarchyThemes, usePortalRoot, type Prefs} from '../ui'

const prettyTool = (name: string) => name.replaceAll('_', ' ')

async function waitForDesktopTheme(slug: string) {
	const want = slug.trim().toLowerCase()
	const start = Date.now()
	while (Date.now() - start < 12_000) {
		try {
			const data = await query<{current?: string | null}>('omarchy.themes')
			const now = String(data?.current ?? '').toLowerCase()
			if (want && now === want) return
			if (!want && Date.now() - start > 1500) return
		} catch {}
		await new Promise((r) => setTimeout(r, 400))
	}
}

async function waitForServer() {
	const start = Date.now()
	let sawDown = false
	while (Date.now() - start < 10 * 60_000) {
		try {
			const r = await fetch('/api/bootstrap', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000)})
			if (r.ok && sawDown) return
			if (!r.ok) sawDown = true
		} catch {
			sawDown = true
		}
		await new Promise((r) => setTimeout(r, sawDown ? 1500 : 400))
	}
}

async function renderMarkdown(src: string) {
	const [{marked}, {default: DOMPurify}] = await Promise.all([import('marked'), import('dompurify')])
	const html = await marked.parse(src, {gfm: true, breaks: true})
	return DOMPurify.sanitize(html, {FORBID_TAGS: ['style', 'form', 'input'], USE_PROFILES: {html: true}})
}

function BubbleMarkdown({text}: {text: string}) {
	const [html, setHtml] = useState('')
	useEffect(() => {
		if (!text) {
			setHtml('')
			return
		}
		let on = true
		void renderMarkdown(text).then((next) => {
			if (on) setHtml(next)
		})
		return () => {
			on = false
		}
	}, [text])
	if (!html) return <>{text}</>
	return (
		<div
			className="md"
			dangerouslySetInnerHTML={{__html: html}}
			onClick={(e) => {
				const a = (e.target as HTMLElement).closest('a')
				if (!a?.href) return
				e.preventDefault()
				window.open(a.href, '_blank', 'noopener,noreferrer')
			}}
		/>
	)
}

const statusText = (action: AssistantAction) => {
	if (action.status === 'done') return 'Approved'
	if (action.status === 'rejected') return 'Rejected'
	if (action.status === 'error') return action.error || 'Didn’t finish'
	return null
}

function WallpaperPicker({
	action,
	selected,
	disabled,
	onChange,
}: {
	action: AssistantAction
	selected: string
	disabled: boolean
	onChange: (id: string) => void
}) {
	const themes = useOmarchyThemes()
	const groups = themes.data?.groups ?? []
	const want = (action.picker?.theme || action.detail || themes.data?.theme || '').trim()
	const group = groups.find((g) => g.theme === want) ?? groups.find((g) => g.theme === themes.data?.theme) ?? groups[0]
	const items = group?.items ?? []
	const fallback = (action.picker?.selected && items.some((it) => it.id === action.picker?.selected) ? action.picker.selected : items[0]?.id) ?? ''
	useEffect(() => {
		if (fallback && (!selected || !items.some((it) => it.id === selected))) onChange(fallback)
	}, [fallback, items, selected, onChange])
	if (themes.isLoading) return <p>Looking for wallpapers…</p>
	if (!items.length) return <p>No pictures for this theme.</p>
	return (
		<div className="assistant-bg-pick" role="radiogroup" aria-label="Wallpaper">
			{items.map((it) => {
				const on = selected === it.id
				return (
					<label key={it.id} className={`assistant-bg-row${on ? ' on' : ''}`}>
						<input type="radio" name={`bg-${action.id}`} checked={on} disabled={disabled} onChange={() => onChange(it.id)} />
						<img src={omarchyBackgroundUrl(it.id)} alt="" loading="lazy" decoding="async" />
						<span>{it.name}</span>
					</label>
				)
			})}
		</div>
	)
}

function ActionCard({
	action,
	onDecide,
}: {
	action: AssistantAction
	onDecide: (actionId: string, path: 'assistant.approve' | 'assistant.reject', extra?: {id?: string; password?: string}) => void
}) {
	const running = action.status === 'running'
	const pending = action.status === 'pending' || running
	const status = statusText(action)
	const wallpaper = action.toolName === 'omarchy_setBackground'
	const [chosen, setChosen] = useState(action.picker?.selected ?? '')
	// A new machine's password is typed here and sent only with Approve: the model and the chat never see it.
	const vm = action.toolName === 'machines_create'
	const [password, setPassword] = useState('')
	return (
		<div className="assistant-card glass" role="group" aria-label={action.title || 'Approval'}>
			<b>{action.title || 'Approve this step'}</b>
			{wallpaper ? null : action.detail ? <p>{action.detail}</p> : null}
			{wallpaper && pending ? <WallpaperPicker action={action} selected={chosen} disabled={running} onChange={setChosen} /> : null}
			{vm && action.status === 'pending' ? (
				<label className="field assistant-password">
					<span>Password for the machine</span>
					<input type="password" autoComplete="new-password" value={password} maxLength={256} onChange={(e) => setPassword(e.target.value)} />
				</label>
			) : null}
			{pending ? (
				<div className="assistant-actions">
					<button type="button" className="btn primary" disabled={running || (wallpaper && !chosen) || (vm && !password)} onClick={() => onDecide(action.id, 'assistant.approve', wallpaper ? {id: chosen} : vm ? {password} : undefined)}>
						Approve
					</button>
					<button type="button" className="btn" disabled={running} onClick={() => onDecide(action.id, 'assistant.reject')}>
						Reject
					</button>
				</div>
			) : status ? (
				<p>{status}</p>
			) : null}
		</div>
	)
}

export function Assistant({onClose, onSettings, prefs, setPrefs}: {onClose?: () => void; onSettings: () => void; prefs?: Prefs; setPrefs?: (p: Prefs) => void}) {
	const portalRoot = usePortalRoot()
	const screenRef = useRef<HTMLDivElement>(null)
	const threadRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const stick = useRef(true)
	const acRef = useRef<AbortController | null>(null)
	const alive = useRef(true)
	const conversationIdRef = useRef<string | undefined>(undefined)
	const seq = useRef(0)
	const turn = useRef(0)
	const deciding = useRef(new Set<string>())
	const decisionAbort = useRef(new Map<string, AbortController>())
	const followQueued = useRef(false)
	const pumping = useRef(false)
	const focused = useRef(false)
	const user = useUser()
	const qc = useQueryClient()
	const member = user.data?.role === 'member'
	const keys = useQuery({queryKey: ['assistant.keys', undefined], queryFn: () => query<AssistantKey[]>('assistant.keys'), retry: false, staleTime: 15_000})
	const hasKeys = (keys.data?.length ?? 0) > 0
	const convs = useQuery({
		queryKey: ['assistant.conversations', undefined],
		queryFn: () => query<AssistantConversationSummary[]>('assistant.conversations'),
		enabled: hasKeys,
		retry: false,
		staleTime: 0,
	})
	const lastId = convs.data?.[0]?.id
	const thread = useQuery({
		queryKey: ['assistant.getConversation', lastId ? {id: lastId} : undefined],
		queryFn: () => query<AssistantConversation>('assistant.getConversation', {id: lastId}),
		enabled: hasKeys && !!lastId,
		retry: false,
		staleTime: 0,
	})
	const [items, setItems] = useState<AssistantItem[] | null>(null)
	const itemsRef = useRef<AssistantItem[] | null>(null)
	itemsRef.current = items
	const [draft, setDraft] = useState('')
	const [activity, setActivity] = useState<string | null>(null)
	const [turnError, setTurnError] = useState<string | null>(null)
	const [decidingCount, setDecidingCount] = useState(0)
	const noteDeciding = () => setDecidingCount(deciding.current.size)

	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
			acRef.current?.abort()
			for (const ac of decisionAbort.current.values()) ac.abort()
		}
	}, [])

	useEffect(() => {
		if (!onClose) return
		const vv = window.visualViewport
		const el = screenRef.current
		if (!vv || !el) return
		const apply = () => {
			el.style.top = `${vv.offsetTop}px`
			el.style.height = `${vv.height}px`
			el.classList.toggle('kbd-open', window.innerHeight - vv.height > 120)
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
		}
	}, [onClose])

	useEffect(() => {
		if (!onClose) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	useEffect(() => {
		if (items !== null || !keys.isSuccess || !hasKeys) return
		if (convs.isError) {
			setItems([])
			setTurnError((convs.error as Error).message)
			return
		}
		if (!convs.isSuccess) return
		if (!convs.data.length) {
			setItems([])
			return
		}
		if (thread.isError) {
			setItems([])
			setTurnError((thread.error as Error).message)
			return
		}
		if (!thread.isSuccess) return
		conversationIdRef.current = thread.data.id
		setItems(threadItems(thread.data))
	}, [items, keys.isSuccess, hasKeys, convs.isError, convs.isSuccess, convs.data, convs.error, thread.isError, thread.isSuccess, thread.data, thread.error])

	useEffect(() => {
		const el = threadRef.current
		if (el && stick.current) el.scrollTop = el.scrollHeight
	}, [items, activity, turnError])

	useEffect(() => {
		if (onClose || !items || focused.current) return
		focused.current = true
		inputRef.current?.focus()
	}, [items, onClose])

	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`
	}

	const runStream = async (body: AssistantStreamBody, ac: AbortController, aid: string) => {
		let aborted = false
		let failed = false
		let sawAction = false
		try {
			await streamAssistant(body, (e) => {
				if (!alive.current || ac.signal.aborted) return
				if (e.event === 'text') {
					setActivity(null)
					setItems((bs) => bs?.map((b) => (b.kind === 'text' && b.id === aid ? {...b, content: b.content + e.data.text} : b)) ?? bs)
				} else if (e.event === 'tool') {
					const name = prettyTool(e.data.name)
					setActivity(e.data.state === 'error' ? `Couldn’t check ${name}` : `Checked ${name}`)
				} else if (e.event === 'action') {
					sawAction = true
					const action = cardAction(e.data)
					if (!action.id) return
					setActivity(null)
					setItems((bs) => {
						if (!bs) return bs
						const card: AssistantItem = {id: `card-${action.id}`, kind: 'card', action}
						const idx = bs.findIndex((b) => b.kind === 'card' && b.action.id === action.id)
						if (idx >= 0) return bs.map((b, i) => (i === idx ? card : b))
						const live = bs.findIndex((b) => b.kind === 'text' && b.id === aid && !b.content)
						if (live >= 0) {
							const next = bs.slice()
							next.splice(live, 0, card)
							return next
						}
						return [...bs, card]
					})
				} else if (e.event === 'done') {
					conversationIdRef.current = e.data.conversationId
				} else if (e.event === 'error') {
					failed = true
					setTurnError(e.data.message)
				}
			}, ac.signal)
		} catch (err) {
			aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError')
			if (!aborted) {
				failed = true
				setTurnError(err instanceof Error ? err.message : 'The assistant did not answer')
			}
		} finally {
			if (!alive.current) return
			setItems((bs) => {
				if (!bs) return bs
				return bs.flatMap((b) => {
					if (b.kind !== 'text' || b.id !== aid) return [b]
					if (!b.content && (aborted || failed || sawAction)) return []
					return [{...b, streaming: false}]
				})
			})
			if (acRef.current === ac) setActivity(null)
		}
	}

	const newSession = () => {
		haptic(6)
		acRef.current?.abort()
		acRef.current = null
		turn.current++
		conversationIdRef.current = undefined
		setItems([])
		setActivity(null)
		setTurnError(null)
		setDraft('')
		if (inputRef.current) inputRef.current.style.height = 'auto'
	}

	const send = async () => {
		const text = draft.trim()
		if (!text || items === null || deciding.current.size > 0) return
		const token = ++turn.current
		const previous = acRef.current
		previous?.abort()
		let conversationId = conversationIdRef.current
		// The id arrives on `done`. A second send before that stays on the thread just created.
		if (previous && !conversationId) {
			const list = await query<AssistantConversationSummary[]>('assistant.conversations').catch(() => null)
			const found = list?.[0]?.id
			if (found) {
				conversationId = found
				conversationIdRef.current = found
			}
		}
		if (turn.current !== token || !alive.current || deciding.current.size > 0) return
		const ac = new AbortController()
		acRef.current = ac
		const id = ++seq.current
		const aid = `live-${id}`
		setDraft('')
		if (inputRef.current) inputRef.current.style.height = 'auto'
		setTurnError(null)
		setActivity(null)
		stick.current = true
		setItems((bs) => [...(bs ?? []), {id: `user-${id}`, kind: 'text', role: 'user', content: text}, {id: aid, kind: 'text', role: 'assistant', content: '', streaming: true}])
		await runStream(conversationId ? {conversationId, message: text} : {message: text}, ac, aid)
	}

	const pumpFollow = async () => {
		if (pumping.current || deciding.current.size > 0 || !followQueued.current || !alive.current) return
		pumping.current = true
		followQueued.current = false
		const conversationId = conversationIdRef.current
		acRef.current?.abort()
		const ac = new AbortController()
		acRef.current = ac
		const id = ++seq.current
		const aid = `live-${id}`
		stick.current = true
		setTurnError(null)
		setActivity(null)
		if (conversationId) setItems((bs) => [...(bs ?? []), {id: aid, kind: 'text', role: 'assistant', content: '', streaming: true}])
		try {
			if (conversationId) await runStream({conversationId, continue: true}, ac, aid)
		} finally {
			pumping.current = false
			if (followQueued.current && deciding.current.size === 0 && alive.current) void pumpFollow()
		}
	}

	const decide = async (actionId: string, path: 'assistant.approve' | 'assistant.reject', extra?: {id?: string; password?: string}) => {
		if (deciding.current.has(actionId)) return
		const conversationId = conversationIdRef.current
		if (!conversationId) {
			setTurnError('That chat isn’t here')
			return
		}
		const cur = itemsRef.current?.find((b) => b.kind === 'card' && b.action.id === actionId)
		if (!cur || cur.kind !== 'card' || cur.action.status !== 'pending') return
		const own = new AbortController()
		decisionAbort.current.set(actionId, own)
		deciding.current.add(actionId)
		noteDeciding()
		// Drop a send that is still resolving the thread id. The follow-up does not use this token.
		++turn.current
		acRef.current?.abort()
		haptic(6)
		setTurnError(null)
		setActivity(null)
		setItems((bs) => bs?.map((b) => (b.kind === 'card' && b.action.id === actionId ? {...b, action: {...b.action, status: 'running'}} : b)) ?? bs)
		let follow = false
		let reloadTheme: string | null = null
		let reloadAfterRestart = false
		try {
			const updated = await mutate<AssistantAction>(path, {actionId, ...(extra?.id ? {id: extra.id} : {}), ...(extra?.password ? {password: extra.password} : {})})
			if (!alive.current || own.signal.aborted) return
			setItems((bs) =>
				bs?.map((b) => {
					if (b.kind !== 'card' || b.action.id !== actionId) return b
					const extra = updated && typeof updated === 'object' && !Array.isArray(updated) ? updated : {}
					return {...b, action: cardAction({...b.action, ...extra, id: actionId})}
				}) ?? bs,
			)
			follow = true
			const status = updated && typeof updated === 'object' && !Array.isArray(updated) ? updated.status : undefined
			const ok = !status || status === 'done'
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'omarchy_setTheme') reloadTheme = cur.action.detail || ''
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'system_restart') reloadAfterRestart = true
			if (path === 'assistant.approve' && ok && cur.action.toolName === 'omarchy_setBackground' && extra?.id && setPrefs && prefs) {
				setPrefs({
					...prefs,
					omarchyBackground: extra.id,
					solidColor: null,
					theme: prefs.theme === 'horizon' ? 'horizon' : 'omarchy',
				})
				void qc.invalidateQueries({queryKey: ['omarchy-themes']})
				const theme = cur.action.picker?.theme || cur.action.detail || ''
				if (theme) reloadTheme = theme
			}
		} catch (err) {
			if (!alive.current || own.signal.aborted) return
			if (err instanceof ApiError) {
				setItems((bs) => bs?.map((b) => (b.kind === 'card' && b.action.id === actionId ? {...b, action: cardAction({...b.action, id: actionId, status: 'error', error: err.message})} : b)) ?? bs)
			} else {
				setItems((bs) => bs?.map((b) => (b.kind === 'card' && b.action.id === actionId && b.action.status === 'running' ? {...b, action: {...b.action, status: 'pending'}} : b)) ?? bs)
				setTurnError(err instanceof Error ? err.message : 'That step didn’t finish')
			}
		} finally {
			deciding.current.delete(actionId)
			decisionAbort.current.delete(actionId)
			if (alive.current) noteDeciding()
			if (follow) followQueued.current = true
			if (followQueued.current && deciding.current.size === 0 && alive.current) {
				if (reloadAfterRestart) {
					markReopenAssistant()
					setActivity('Waiting for the server to come back…')
					void (async () => {
						await waitForServer()
						if (alive.current) location.reload()
					})()
				} else if (reloadTheme != null) {
					markReopenAssistant()
					void (async () => {
						try {
							await pumpFollow()
						} finally {
							if (!alive.current) return
							await waitForDesktopTheme(reloadTheme)
							if (alive.current) location.reload()
						}
					})()
				} else {
					void pumpFollow()
				}
			}
		}
	}

	const loading = keys.isLoading || (hasKeys && items === null && !keys.isError)
	const column = (
		<div className="assistant glass" role="dialog" aria-modal={onClose ? true : undefined} aria-label="Assistant">
			<header className="assistant-head">
				{onClose && (
					<button type="button" className="round-btn" aria-label="Back" onClick={() => (haptic(6), onClose())}>
						<Icon name="back" size={20} />
					</button>
				)}
				<b>Assistant</b>
				{hasKeys && (
					<button type="button" className="round-btn" aria-label="New session" title="New session" onClick={newSession} disabled={items === null}>
						<Icon name="reset" size={19} />
					</button>
				)}
				<button type="button" className="round-btn" aria-label="Settings" title="Settings" onClick={() => (haptic(6), onSettings())}>
					<Icon name="settings" size={19} />
				</button>
			</header>
			{keys.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(keys.error as Error).message}
				</div>
			)}
			{loading && (
				<div className="assistant-thread">
					<span className="spinner" aria-label="Loading" />
				</div>
			)}
			{keys.isSuccess && !hasKeys && (
				<div className="assistant-thread">
					<div className="empty">
						<span className="big">
							<Icon name="sparkle" size={30} />
						</span>
						<b>Sign in with ChatGPT or add an API key in Settings to talk to the assistant.</b>
						{member && <span>Ask the owner to share a key, or add your own.</span>}
						<button type="button" className="btn primary small" onClick={() => (haptic(6), onSettings())}>
							Settings → Assistant
						</button>
					</div>
				</div>
			)}
			{hasKeys && items && (
				<>
					<div
						className="assistant-thread"
						ref={threadRef}
						onScroll={(e) => {
							const el = e.currentTarget
							stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
						}}
					>
						{items.length === 0 && !turnError && (
							<div className="empty">
								<span className="big">
									<Icon name="sparkle" size={30} />
								</span>
								<b>Ask about this server</b>
								<span>Usage, apps, machines, and the Local swarm.</span>
							</div>
						)}
						{(items.length > 0 || activity || turnError) && (
							<div className="assistant-thread-end">
								{items.map((b) =>
									b.kind === 'card' ? (
										<ActionCard key={b.id} action={b.action} onDecide={(id, path, extra) => void decide(id, path, extra)} />
									) : (
										<div key={b.id} className={`bubble ${b.role}${b.streaming ? ' live' : ''}`}>
											{b.role === 'assistant' ? <BubbleMarkdown text={b.content} /> : b.content}
											{b.streaming && <span className="cursor" aria-hidden="true" />}
										</div>
									),
								)}
								{activity && <p className="assistant-activity">{activity}</p>}
								{turnError && (
									<div className="error" role="alert">
										<Icon name="alert" size={18} />
										{turnError}
									</div>
								)}
							</div>
						)}
					</div>
					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault()
							void send()
						}}
					>
						<textarea
							ref={inputRef}
							rows={1}
							value={draft}
							placeholder="Message"
							aria-label="Message"
							enterKeyHint="send"
							disabled={decidingCount > 0}
							onChange={(e) => {
								setDraft(e.target.value)
								fit(e.target)
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault()
									void send()
								}
							}}
						/>
						<button type="submit" className="btn primary small" disabled={decidingCount > 0 || !draft.trim()}>
							Send
						</button>
					</form>
				</>
			)}
		</div>
	)
	if (!onClose) return column
	return createPortal(
		<div ref={screenRef} className="assistant-screen">
			{column}
		</div>,
		portalRoot,
	)
}
