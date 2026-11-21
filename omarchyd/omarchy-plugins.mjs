// Omarchy plugins in the App Store: browse the Omarchy plugin registry (plugins.omarchy.org) and
// install plugins the way `omarchy plugin add` does, with two differences that make it safer:
//   - only listings the registry marks verified for the exact commit it checked, with no newer
//     unchecked commit upstream, are shown; and
//   - the plugin is installed at that verified commit, not whatever its repository holds today
//     (Omarchy's own command clones the latest code, which the registry hasn't checked).
// Verification is the registry's automated check of that commit (and maintainer review where
// needed), not a security audit: plugins still run as unsandboxed code in your desktop shell, so
// installing asks the owner to confirm.
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {readFile, readdir, rename, rm, mkdir} from 'node:fs/promises'
import {join} from 'node:path'

export const CATALOG_URLS = ['https://plugins.omarchy.org/catalog.json', 'https://raw.githubusercontent.com/omacom/omarchy-plugin-marketplace/main/site/catalog.json']
export const SITE = 'https://plugins.omarchy.org'
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[0-9a-f]{40}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const execRun = (cmd, args, opts = {}) =>
	new Promise((resolve, reject) =>
		execFile(cmd, args, {timeout: 120_000, maxBuffer: 8 << 20, ...opts}, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').pop())) : resolve(String(out)))),
	)

// What the store shows from one registry entry, or null when it isn't offered here.
export function toListing(p) {
	if (!p || p.sourceType !== 'community' || !p.installAvailable) return null
	if (p.verificationStatus !== 'verified' || p.verificationCoverage !== 'snapshot-verified') return null
	if (p.repositoryLayout !== 'root-plugin' || !REPO.test(String(p.repo)) || !SHA.test(String(p.listingValidatedCommit)) || !ID.test(String(p.id)) || p.id.includes('..')) return null
	const img = (path) => (typeof path === 'string' && /^assets\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..') ? `${SITE}/${path}` : null)
	return {
		id: p.id,
		name: String(p.name ?? p.id).slice(0, 80),
		description: String(p.description ?? '').slice(0, 600),
		author: String(p.author ?? '').slice(0, 80),
		category: String(p.category ?? 'Other').slice(0, 40),
		tags: Array.isArray(p.tags) ? p.tags.slice(0, 5).map((t) => String(t).slice(0, 30)) : [],
		kind: String(p.kind ?? '').slice(0, 40),
		version: String(p.version ?? '').slice(0, 30),
		stars: Number(p.stars) || 0,
		repo: p.repo,
		commit: p.listingValidatedCommit,
		image: img(p.previewThumbnail),
		page: `${SITE}/plugin.html?id=${encodeURIComponent(p.id)}`,
		addedAt: String(p.listedAt ?? p.addedAt ?? ''),
	}
}

export function createOmarchyPlugins({home, theme, run = execRun, fetchImpl = fetch, catalogUrls = CATALOG_URLS}) {
	const DIR = join(home, '.config', 'omarchy', 'plugins')
	let cache = null // {at, list}
	let loading = null
	const jobs = new Map() // id -> {state: 'installing'|'removing'|'error', error?}

	async function load({refresh = false} = {}) {
		if (cache && !refresh && Date.now() - cache.at < 60 * 60_000) return cache.list
		loading ??= (async () => {
			let lastError = null
			for (const url of catalogUrls) {
				try {
					const r = await fetchImpl(url, {signal: AbortSignal.timeout(60_000), headers: {accept: 'application/json'}})
					if (!r.ok) throw new Error(`${r.status}`)
					const body = await r.json()
					const list = (Array.isArray(body?.plugins) ? body.plugins : []).map(toListing).filter(Boolean)
					if (!list.length) throw new Error('empty')
					cache = {at: Date.now(), list}
					return list
				} catch (e) {
					lastError = e
				}
			}
			if (cache) return cache.list
			throw Object.assign(new Error(`Couldn’t reach the Omarchy plugin registry (${lastError?.message ?? 'no answer'}). Try again in a moment.`), {code: 'BAD_GATEWAY'})
		})().finally(() => (loading = null))
		return loading
	}

	// Plugins in ~/.config/omarchy/plugins (by the id in their manifest).
	async function installed() {
		const out = new Set()
		for (const e of await readdir(DIR, {withFileTypes: true}).catch(() => [])) {
			if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue
			const m = await readFile(join(DIR, e.name, 'manifest.json'), 'utf8')
				.then((t) => JSON.parse(t))
				.catch(() => null)
			if (m?.id) out.add(String(m.id))
			out.add(e.name)
		}
		return out
	}

	async function list(input = {}) {
		const all = await load({refresh: input?.refresh === true})
		const mine = await installed()
		const q = String(input?.q ?? '').trim().toLowerCase().slice(0, 80)
		const category = String(input?.category ?? '')
		const sort = input?.sort === 'new' ? 'new' : 'stars'
		let rows = all.filter((p) => (!category || p.category === category) && (!q || `${p.name} ${p.description} ${p.author} ${p.tags.join(' ')}`.toLowerCase().includes(q)))
		if (input?.installedOnly) rows = rows.filter((p) => mine.has(p.id))
		rows = [...rows].sort((a, b) => (sort === 'new' ? b.addedAt.localeCompare(a.addedAt) : b.stars - a.stars) || a.name.localeCompare(b.name))
		const offset = Math.max(0, Math.floor(Number(input?.offset) || 0))
		const limit = Math.min(60, Math.max(1, Math.floor(Number(input?.limit) || 30)))
		const categories = [...new Set(all.map((p) => p.category))].sort()
		return {
			total: rows.length,
			categories,
			available: !!(await theme.findCommand('omarchy-plugin-validate')),
			plugins: rows.slice(offset, offset + limit).map((p) => ({...p, installed: mine.has(p.id), job: jobs.get(p.id) ?? null})),
		}
	}

	const git = (args, cwd) => run('git', args, {cwd, env: {...process.env, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes'}})

	async function doInstall(p) {
		await mkdir(DIR, {recursive: true})
		// The same URL check Omarchy's own `plugin add` runs (no git options or transport helpers).
		if (await theme.findCommand('omarchy-git-url-check')) await theme.runCommand('omarchy-git-url-check', [`${p.repo}.git`])
		const stage = join(DIR, `.add.tmp.${randomBytes(6).toString('hex')}`)
		try {
			await mkdir(stage)
			await git(['init', '-q'], stage)
			// Exactly the commit the registry verified.
			await git(['fetch', '-q', '--depth', '1', '--', `${p.repo}.git`, p.commit], stage)
			await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', p.commit], stage)
			const head = (await git(['rev-parse', 'HEAD'], stage)).trim()
			if (head !== p.commit) throw new Error('The plugin’s code didn’t match the verified version, so it wasn’t installed.')
			await theme.runCommand('omarchy-plugin-validate', [stage])
			const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'))
			if (manifest?.id !== p.id) throw new Error('The plugin’s manifest doesn’t match its listing, so it wasn’t installed.')
			const target = join(DIR, p.id)
			if ((await installed()).has(p.id)) throw new Error(`${p.name} is already installed.`)
			await rename(stage, target)
		} finally {
			await rm(stage, {recursive: true, force: true})
		}
		await theme.runCommand('omarchy-shell', ['shell', 'rescanPlugins']).catch(() => {})
		// Omarchy may take a moment to discover it after the rescan.
		let lastError = null
		for (let i = 0; i < 20; i++) {
			try {
				await theme.runCommand('omarchy-plugin-enable', [p.id])
				return
			} catch (e) {
				lastError = e
				await new Promise((r) => setTimeout(r, 250))
			}
		}
		throw new Error(`${p.name} was added but couldn’t be turned on (${lastError?.message}). Turn it on from the Omarchy menu → Plugins.`)
	}

	const job = (id, state, work) => {
		jobs.set(id, {state})
		work.then(
			() => jobs.delete(id),
			(e) => {
				jobs.set(id, {state: 'error', error: e.message})
				setTimeout(() => jobs.get(id)?.state === 'error' && jobs.delete(id), 5 * 60_000).unref?.()
			},
		)
	}

	async function install(input) {
		const id = String(input?.id ?? '')
		const p = (await load()).find((x) => x.id === id)
		if (!p) throw Object.assign(new Error('That plugin isn’t in the verified list'), {code: 'NOT_FOUND'})
		if (!(await theme.findCommand('omarchy-plugin-validate'))) throw Object.assign(new Error('This server’s Omarchy doesn’t have plugins yet. Update Omarchy first.'), {code: 'PRECONDITION_FAILED'})
		if (jobs.get(id) && jobs.get(id).state !== 'error') return true
		if ((await installed()).has(id)) throw Object.assign(new Error(`${p.name} is already installed`), {code: 'CONFLICT'})
		job(id, 'installing', doInstall(p))
		return true
	}

	async function remove(input) {
		const id = String(input?.id ?? '')
		if (!ID.test(id) || id.includes('..')) throw Object.assign(new Error('Unknown plugin'), {code: 'BAD_REQUEST'})
		// Only plugins added to your own plugins folder (never Omarchy's built-in ones).
		if (!(await installed()).has(id)) throw Object.assign(new Error('That plugin isn’t installed'), {code: 'NOT_FOUND'})
		job(id, 'removing', theme.runCommand('omarchy-plugin-remove', [id, '--yes']))
		return true
	}

	return {list, install, remove, refresh: () => load({refresh: true}).then((l) => l.length), find: async (id) => (await load()).find((p) => p.id === id) ?? null}
}
