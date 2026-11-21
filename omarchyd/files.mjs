// Files: the web app's /Home is the owner's real home folder, and /Trash is the freedesktop trash
// (~/.local/share/Trash) that Omarchy's own file manager uses, so browser and desktop agree.
// Every path is resolved and checked to stay inside those folders, symlinks included.
import {createReadStream, createWriteStream} from 'node:fs'
import {cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join, resolve as pathResolve, sep} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {randomBytes} from 'node:crypto'

import {RpcError} from './rpc.mjs'

const MIME = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
	mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
	mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
	pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', iso: 'application/x-iso9660-image',
	txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', sh: 'text/x-shellscript', py: 'text/x-python', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', conf: 'text/plain', ini: 'text/plain',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
	ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
}
const typeFor = (name) => MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
// Shown inline when viewed; everything else is sent as a download.
const INLINE = /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf|text\/plain)/
const STAT_CONCURRENCY = 16

async function mapPool(items, n, fn) {
	const out = new Array(items.length)
	let i = 0
	await Promise.all(
		Array.from({length: Math.min(n, items.length)}, async () => {
			while (i < items.length) {
				const idx = i++
				out[idx] = await fn(items[idx], idx)
			}
		}),
	)
	return out
}

export function createFiles({home, dataDir}) {
	const trashRoot = join(home, '.local/share/Trash')
	const trashFiles = join(trashRoot, 'files')
	const trashInfo = join(trashRoot, 'info')
	const favoritesFile = join(dataDir, 'favorites.json')
	let homeReal = null
	const roots = async () => (homeReal ??= await realpath(home))
	// Keys and the rest of omarchyd state live under dataDir, often inside Home. Never serve that tree.
	const realCache = new Map()
	async function cachedReal(target) {
		if (realCache.has(target)) return realCache.get(target)
		try {
			const real = await realpath(target)
			realCache.set(target, real)
			return real
		} catch {
			return null
		}
	}
	const privateRoots = typeof dataDir === 'string' ? [dataDir, join(dataDir, 'assistant')] : []

	// Virtual path -> real path, refusing anything outside /Home or /Trash.
	async function resolve(virtual, {mustExist = true} = {}) {
		if (typeof virtual !== 'string' || !virtual.startsWith('/') || virtual.includes('\0')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const parts = virtual.split('/').filter(Boolean)
		if (parts.some((p) => p === '..' || p === '.')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const [top, ...rest] = parts
		const base = top === 'Home' ? await roots() : top === 'Trash' ? trashFiles : null
		if (!base) throw new RpcError('NOT_FOUND', '[does-not-exist]')
		const real = join(base, ...rest)
		// Follow symlinks for what exists, and make sure we're still inside the base.
		const check = mustExist ? real : dirname(real)
		let resolved
		try {
			resolved = await realpath(check)
		} catch {
			throw new RpcError('NOT_FOUND', '[does-not-exist]')
		}
		const baseReal = top === 'Home' ? base : await realpath(base).catch(() => base)
		if (resolved !== baseReal && !resolved.startsWith(baseReal + sep)) throw new RpcError('FORBIDDEN', '[outside-home]')
		const homeRoot = await roots()
		for (const target of privateRoots) {
			const blocked = await cachedReal(target)
			if (!blocked || blocked === homeRoot || homeRoot.startsWith(blocked + sep)) continue
			if (resolved === blocked || resolved.startsWith(blocked + sep)) throw new RpcError('FORBIDDEN', '[outside-home]')
		}
		return {real, top, base}
	}
	// Trash lives inside Home, so it's checked first.
	const toVirtual = async (real) => {
		const h = await roots()
		const t = join(h, '.local/share/Trash/files')
		if (real === t || real.startsWith(t + sep)) return `/Trash${real.slice(t.length)}`
		if (real === trashFiles || real.startsWith(trashFiles + sep)) return `/Trash${real.slice(trashFiles.length)}`
		if (real === h || real.startsWith(h + sep)) return `/Home${real.slice(h.length)}`
		return null
	}

	async function entry(virtual, real, st) {
		st ??= await stat(real)
		const dir = st.isDirectory()
		const inTrash = virtual.startsWith('/Trash/')
		const name = virtual === '/Home' ? 'Home' : virtual === '/Trash' ? 'Trash' : basename(virtual)
		const type = dir ? 'directory' : typeFor(name)
		const top = virtual === '/Home' || virtual === '/Trash'
		return {
			name,
			path: virtual,
			type,
			...(dir ? {} : {size: st.size}),
			modified: st.mtimeMs,
			operations: top ? (virtual === '/Home' ? ['writable'] : []) : inTrash ? ['restore', 'delete'] : ['copy', 'move', 'rename', 'trash', 'favorite', 'writable'],
		}
	}
	const visible = (name) => !name.startsWith('.')

	async function list({path, sortBy = 'name', sortOrder = 'ascending', limit} = {}) {
		if (path === '/Trash') {
			const h = await roots()
			let near = join(h, '.local/share/Trash/files')
			while (near !== h && near !== dirname(near) && !(await lstat(near).then(() => true, () => false))) near = dirname(near)
			const nearReal = await realpath(near).catch(() => '')
			if (nearReal === h || nearReal.startsWith(h + sep)) await mkdir(trashFiles, {recursive: true})
		}
		const {real} = await resolve(path)
		const st = await stat(real)
		if (!st.isDirectory()) throw new RpcError('BAD_REQUEST', '[not-a-directory]')
		const dirents = (await readdir(real, {withFileTypes: true})).filter((d) => visible(d.name))
		const totalFiles = dirents.length
		const cap = Number.isInteger(limit) && limit > 0 ? limit : null
		const dirFirst = (a, b) => Number(!!b.dir) - Number(!!a.dir)
		const textCmp = (a, b, key) => String(a[key]).localeCompare(String(b[key]), undefined, {numeric: true, sensitivity: 'base'})
		const key = sortBy === 'modified' ? 'modified' : sortBy === 'size' ? 'size' : sortBy === 'type' ? 'type' : 'name'
		const toEntry = async (name) => {
			const r = join(real, name)
			const s = await stat(r).catch(() => null) // broken symlinks are skipped
			return s ? await entry(`${path}/${name}`, r, s) : null
		}

		let files
		let countable
		const order = sortOrder === 'descending' ? -1 : 1
		if (key === 'modified' || key === 'size') {
			// mtime/size sort needs every entry's stat; we still honour limit after sorting.
			const rows = (await mapPool(dirents, STAT_CONCURRENCY, (d) => toEntry(d.name))).filter(Boolean)
			rows.sort((a, b) => dirFirst({dir: a.type === 'directory'}, {dir: b.type === 'directory'}) || order * ((a[key] ?? 0) - (b[key] ?? 0)) || textCmp(a, b, 'name'))
			countable = rows.length
			files = cap ? rows.slice(0, cap) : rows
		} else {
			// Name/type: sort from dirents (cheap), slice, then stat only the page.
			// A link to a folder sorts with the folders (as it did when every entry was stat'ed).
			const isDir = async (d) => d.isDirectory() || (d.isSymbolicLink() && (await stat(join(real, d.name)).then((s) => s.isDirectory(), () => false)))
			const rows = await mapPool(dirents, STAT_CONCURRENCY, async (d) => {
				const dir = await isDir(d)
				return {name: d.name, dir, type: dir ? 'directory' : typeFor(d.name)}
			})
			rows.sort((a, b) => dirFirst(a, b) || order * textCmp(a, b, key === 'type' ? 'type' : 'name') || textCmp(a, b, 'name'))
			countable = rows.length
			const page = cap ? rows.slice(0, cap) : rows
			files = (await mapPool(page, STAT_CONCURRENCY, (row) => toEntry(row.name))).filter(Boolean)
		}
		return {...(await entry(path, real, st)), files, hasMore: cap != null && countable > cap, totalFiles}
	}

	// A free name next to the original: "Report (2).pdf".
	async function freeName(dir, name) {
		const ext = extname(name)
		const stem = ext ? name.slice(0, -ext.length) : name
		for (let n = 1; ; n++) {
			const candidate = join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
			try {
				await lstat(candidate)
			} catch {
				return candidate
			}
		}
	}
	const validName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..'
	// Storage registers this so a renamed, moved, or trashed folder takes its network share with it.
	// Copy leaves the share on the original. `to` is null when the folder was trashed.
	let follow = async () => {}

	async function createDirectory({path}) {
		if (!validName(basename(path))) throw new RpcError('BAD_REQUEST', '[invalid-name]')
		const {real} = await resolve(path, {mustExist: false})
		await mkdir(real).catch((e) => {
			if (e.code === 'EEXIST') throw new RpcError('CONFLICT', '[already-exists]')
			throw e
		})
		return path
	}
	async function renameItem({path, newName}) {
		if (!validName(newName)) throw new RpcError('BAD_REQUEST', '[invalid-name]')
		const {real, base} = await resolve(path)
		if (real === base) throw new RpcError('BAD_REQUEST', '[cannot-rename]')
		const target = join(dirname(real), newName)
		if (await lstat(target).then(() => true, () => false)) throw new RpcError('CONFLICT', '[already-exists]')
		await rename(real, target)
		const next = await toVirtual(target)
		await follow(path, next)
		return next
	}
	async function moveOrCopy({path, toDirectory, collision = 'keep-both'}, copy) {
		const {real, base} = await resolve(path)
		if (real === base) throw new RpcError('BAD_REQUEST', '[cannot-move]')
		const {real: dest} = await resolve(toDirectory)
		if (dest === real || dest.startsWith(real + sep)) throw new RpcError('BAD_REQUEST', '[subdir-of-self]')
		let target = join(dest, basename(real))
		// Only replace of this same file returns early. A directory symlink to the parent still
		// names that file once both paths are real; a hard link in another folder does not.
		if (collision === 'replace') {
			const targetReal = await realpath(target).catch(() => null)
			if (targetReal !== null && targetReal === (await realpath(real))) return toVirtual(real)
		}
		if (await lstat(target).then(() => true, () => false)) {
			if (collision === 'error') throw new RpcError('CONFLICT', '[already-exists]')
			if (collision === 'replace') await rm(target, {recursive: true, force: true})
			else target = await freeName(dest, basename(real))
		}
		if (copy) await cp(real, target, {recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true})
		else
			await rename(real, target).catch(async (e) => {
				if (e.code !== 'EXDEV') throw e
				await cp(real, target, {recursive: true, verbatimSymlinks: true})
				await rm(real, {recursive: true, force: true})
			})
		const next = await toVirtual(target)
		if (!copy) await follow(path, next)
		return next
	}

	// Trash the freedesktop way: the item in Trash/files, a .trashinfo with where it came from.
	async function trash({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Home' || path === '/Home') throw new RpcError('BAD_REQUEST', '[cannot-trash]')
		await mkdir(trashFiles, {recursive: true})
		await mkdir(trashInfo, {recursive: true})
		const target = await freeName(trashFiles, basename(real))
		const info = `[Trash Info]\nPath=${encodeURI(real)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`
		await writeFile(join(trashInfo, `${basename(target)}.trashinfo`), info)
		await rename(real, target).catch(async (e) => {
			if (e.code !== 'EXDEV') throw e
			await cp(real, target, {recursive: true, verbatimSymlinks: true})
			await rm(real, {recursive: true, force: true})
		})
		const next = await toVirtual(target)
		await follow(path, null)
		return next
	}
	async function restore({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash') throw new RpcError('BAD_REQUEST', '[not-in-trash]')
		// Only a direct child of Trash/files has its own .trashinfo. A nested file can share a
		// basename with another trashed item, and must not read or remove that item's info.
		const ownInfo = dirname(real) === trashFiles
		const infoFile = join(trashInfo, `${basename(real)}.trashinfo`)
		const original = ownInfo ? /^Path=(.*)$/m.exec(await readFile(infoFile, 'utf8').catch(() => ''))?.[1] : undefined
		const h = await roots()
		// The .trashinfo can be written by anything that can write to the Trash, so where it says the
		// item came from is only trusted inside Home: normalised (no "../" tricks) and, once its folder
		// exists, checked again with symlinks followed.
		let dest = null
		try {
			dest = original ? pathResolve(decodeURI(original)) : null
		} catch {
			dest = null
		}
		const inside = (p) => p === h || p.startsWith(h + sep)
		if (!dest || !inside(dest) || dest === h) dest = join(h, basename(real))
		// Its nearest existing folder must really be inside Home (a symlinked folder could point out).
		let near = dirname(dest)
		while (near !== h && !(await lstat(near).then(() => true, () => false))) near = dirname(near)
		if (!inside(await realpath(near).catch(() => ''))) dest = join(h, basename(real))
		await mkdir(dirname(dest), {recursive: true})
		if (await lstat(dest).then(() => true, () => false)) dest = await freeName(dirname(dest), basename(dest))
		await rename(real, dest)
		if (ownInfo) await rm(infoFile, {force: true})
		return toVirtual(dest)
	}
	async function deleteItem({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash' || path === '/Trash') throw new RpcError('BAD_REQUEST', '[only-from-trash]')
		await rm(real, {recursive: true, force: true})
		if (dirname(real) === trashFiles) await rm(join(trashInfo, `${basename(real)}.trashinfo`), {force: true})
		return true
	}
	async function emptyTrash() {
		for (const n of await readdir(trashFiles).catch(() => [])) await rm(join(trashFiles, n), {recursive: true, force: true})
		for (const n of await readdir(trashInfo).catch(() => [])) await rm(join(trashInfo, n), {force: true})
		return true
	}

	// Walk Home (skipping hidden folders) for search and recents, with a hard cap.
	async function walk(visit, {limit = 20000} = {}) {
		const h = await roots()
		const queue = [h]
		let seen = 0
		while (queue.length && seen < limit) {
			const dir = queue.shift()
			const items = await readdir(dir, {withFileTypes: true}).catch(() => [])
			for (const d of items) {
				if (!visible(d.name) || d.name === 'node_modules') continue
				seen++
				const r = join(dir, d.name)
				if (d.isDirectory()) queue.push(r)
				if (d.isDirectory() || d.isFile()) await visit(r, d)
			}
		}
	}
	async function search({query}) {
		const q = String(query ?? '').trim().normalize('NFC').toLowerCase()
		if (!q) return []
		const out = []
		await walk(async (r, d) => {
			if (out.length < 50 && d.name.normalize('NFC').toLowerCase().includes(q)) out.push(r)
		})
		return Promise.all(out.map(async (r) => entry(await toVirtual(r), r)))
	}
	async function recents() {
		const found = []
		await walk(async (r, d) => {
			if (!d.isFile()) return
			const s = await stat(r).catch(() => null)
			if (s) found.push({r, s})
		})
		found.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
		return Promise.all(found.slice(0, 30).map(async ({r, s}) => entry(await toVirtual(r), r, s)))
	}

	const readFavorites = async () => JSON.parse(await readFile(favoritesFile, 'utf8').catch(() => '[]'))
	async function favorites() {
		const keep = []
		for (const p of await readFavorites()) if (await resolve(p).then(() => true, () => false)) keep.push(p)
		return keep
	}
	async function setFavorite(path, on) {
		await resolve(path)
		const set = new Set(await readFavorites())
		on ? set.add(path) : set.delete(path)
		await writeFile(favoritesFile, JSON.stringify([...set]), {mode: 0o600})
		return true
	}

	// ---- HTTP: view, download, upload -------------------------------------------------------
	async function serveFile(req, res, url, kind) {
		const paths = url.searchParams.getAll('path')
		if (paths.length !== 1) return endPlain(res, 501, 'Downloading several items or a folder isn’t supported yet')
		let real
		try {
			;({real} = await resolve(paths[0]))
		} catch {
			return endPlain(res, 404, 'Not found')
		}
		const st = await stat(real).catch(() => null)
		if (!st) return endPlain(res, 404, 'Not found')
		if (st.isDirectory()) return endPlain(res, 501, 'Downloading a folder isn’t supported yet')
		const name = basename(real)
		const type = typeFor(name)
		const inline = kind === 'view' && INLINE.test(type)
		const headers = {
			'content-type': kind === 'view' && !INLINE.test(type) && !type.startsWith('image/svg') ? 'application/octet-stream' : type,
			'accept-ranges': 'bytes',
			'last-modified': st.mtime.toUTCString(),
			'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
			'x-content-type-options': 'nosniff',
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
		if (range && (range[1] || range[2])) {
			let start = range[1] ? Number(range[1]) : st.size - Number(range[2])
			let end = range[1] && range[2] ? Number(range[2]) : st.size - 1
			start = Math.max(0, start)
			end = Math.min(st.size - 1, end)
			if (start > end) {
				res.writeHead(416, {'content-range': `bytes */${st.size}`})
				return res.end()
			}
			res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1)})
			return pipeline(createReadStream(real, {start, end}), res).catch(() => res.destroy())
		}
		res.writeHead(200, {...headers, 'content-length': String(st.size)})
		return pipeline(createReadStream(real), res).catch(() => res.destroy())
	}
	async function upload(req, res, url) {
		const path = url.searchParams.get('path')
		const collision = url.searchParams.get('collision') ?? 'keep-both'
		let real
		try {
			if (!validName(basename(path ?? ''))) throw new RpcError('BAD_REQUEST', '[invalid-name]')
			;({real} = await resolve(path, {mustExist: false}))
		} catch (e) {
			return endJson(res, e instanceof RpcError && e.code === 'NOT_FOUND' ? 404 : 400, {error: e.message})
		}
		const exists = await lstat(real).then((s) => s, () => null)
		if (exists?.isDirectory()) return endJson(res, 409, {error: '[is-a-directory]'})
		if (exists && collision === 'error') return endJson(res, 409, {error: '[already-exists]'})
		const target = exists && collision !== 'replace' ? await freeName(dirname(real), basename(real)) : real
		// Write to a temporary file first, so a broken upload never leaves half a file behind.
		const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.uploading`)
		try {
			await pipeline(req, createWriteStream(tmp, {flags: 'wx', mode: 0o644}))
			await rename(tmp, target)
		} catch {
			await rm(tmp, {force: true})
			return endJson(res, 500, {error: 'Upload failed'})
		}
		return endJson(res, 200, {path: await toVirtual(target)})
	}

	return {
		procedures: {
			'files.list': {kind: 'query', run: (i) => list(i)},
			'files.search': {kind: 'query', run: (i) => search(i ?? {})},
			'files.recents': {kind: 'query', run: () => recents()},
			'files.favorites': {
				kind: 'query',
				run: async () => {
					const paths = await favorites()
					return (
						await mapPool(paths, STAT_CONCURRENCY, async (p) => {
							try {
								const {real} = await resolve(p)
								return await entry(p, real)
							} catch {
								return null
							}
						})
					).filter(Boolean)
				},
			},
			'files.addFavorite': {kind: 'mutation', run: ({path}) => setFavorite(path, true)},
			'files.removeFavorite': {kind: 'mutation', run: ({path}) => setFavorite(path, false)},
			'files.createDirectory': {kind: 'mutation', run: (i) => createDirectory(i)},
			'files.rename': {kind: 'mutation', run: (i) => renameItem(i)},
			'files.copy': {kind: 'mutation', run: (i) => moveOrCopy(i, true)},
			'files.move': {kind: 'mutation', run: (i) => moveOrCopy(i, false)},
			'files.trash': {kind: 'mutation', run: (i) => trash(i)},
			'files.restore': {kind: 'mutation', run: (i) => restore(i)},
			'files.delete': {kind: 'mutation', run: (i) => deleteItem(i)},
			'files.emptyTrash': {kind: 'mutation', run: () => emptyTrash()},
			'files.operationProgress': {kind: 'query', run: () => []},
			'files.externalDevices': {kind: 'query', run: () => []},
		},
		serveFile,
		upload,
		resolve,
		followShares(fn) {
			if (typeof fn === 'function') follow = fn
		},
	}
}

function endPlain(res, status, text) {
	res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'})
	res.end(text)
}
function endJson(res, status, body) {
	res.writeHead(status, {'content-type': 'application/json'})
	res.end(JSON.stringify(body))
}
