// Pure helpers for the Files screen so browser-side rules are easy to test in Node.
import type {FileEntry} from './api'

export type BatchAction = 'trash' | 'delete' | 'restore'
export type BatchResult = {succeeded: string[]; failed: string[]}

/** Run an async file action across paths without stopping on individual failures. */
export async function runFileBatch(paths: string[], run: (path: string) => Promise<unknown>): Promise<BatchResult> {
	const succeeded: string[] = []
	const failed: string[] = []
	for (const p of paths) {
		try {
			await run(p)
			succeeded.push(p)
		} catch {
			failed.push(p)
		}
	}
	return {succeeded, failed}
}

const BATCH_FULL: Record<BatchAction, {one: string; many: (n: number) => string}> = {
	trash: {one: 'Moved to Trash', many: (n) => `${n} items moved to Trash`},
	delete: {one: 'Deleted', many: (n) => `${n} items deleted`},
	restore: {one: 'Restored', many: (n) => `${n} items restored`},
}

const BATCH_PARTIAL: Record<BatchAction, (ok: number, total: number, bad: number) => string> = {
	trash: (ok, total, bad) => `Moved ${ok} of ${total} items to Trash (${bad} failed)`,
	delete: (ok, total, bad) => `Deleted ${ok} of ${total} items (${bad} failed)`,
	restore: (ok, total, bad) => `Restored ${ok} of ${total} items (${bad} failed)`,
}

/** Build the summary toast for a batch file action, or null when nothing succeeded. */
export function batchToastMessage(action: BatchAction, total: number, result: BatchResult): {text: string; error: boolean} | null {
	const ok = result.succeeded.length
	const bad = result.failed.length
	if (ok === 0) return null
	if (bad === 0) {
		const copy = BATCH_FULL[action]
		return {text: total === 1 ? copy.one : copy.many(total), error: false}
	}
	return {text: BATCH_PARTIAL[action](ok, total, bad), error: true}
}

/** Check whether a file or folder name is non-empty and free of path separators or dots-only segments. */
export function isValidItemName(name: string): boolean {
	const trimmed = name.trim()
	return trimmed !== '' && !trimmed.includes('/') && trimmed !== '.' && trimmed !== '..'
}

/** Return true when the name prompt form can submit (only rename requires a changed name). */
export function canSubmitNamePrompt({
	name,
	initial,
	requireChange,
	busy,
}: {
	name: string
	initial: string
	requireChange?: boolean
	busy: boolean
}): boolean {
	if (busy || !isValidItemName(name)) return false
	if (requireChange && name.trim() === initial) return false
	return true
}

/** Clear selected paths whenever the search text changes so hidden items cannot stay selected. */
export function nextSearchSelection(selected: Set<string>, prevQuery: string, nextQuery: string): Set<string> {
	if (prevQuery === nextQuery || selected.size === 0) return selected
	return new Set()
}

export type FavoriteItem = FileEntry | string

/** Extract the virtual path from either a FileEntry or a legacy favorite path string. */
export function favoritePath(item: FavoriteItem): string {
	return typeof item === 'string' ? item : item.path
}

/** Activate a file row only when Enter is pressed directly on the row, not a child action button. */
export function shouldActivateRowOnKey(e: {key: string; target: unknown; currentTarget: unknown}): boolean {
	return e.key === 'Enter' && e.target === e.currentTarget
}

/** Label for the share password row across idle, loading, loaded, and failed states. */
export function sharePasswordLabel({
	data,
	isFetching,
	error,
}: {
	data: string | undefined
	isFetching: boolean
	error: Error | null | undefined
}): string {
	if (data) return data
	if (isFetching) return '…'
	if (error) return `${error.message || 'Couldn’t load password'} · Tap to retry`
	return 'Tap to show'
}

/** Decide what tapping the share password row should do next. */
export function sharePasswordAction({
	data,
	reveal,
	isFetching,
}: {
	data: string | undefined
	reveal: boolean
	isFetching?: boolean
}): 'copy' | 'noop' | 'refetch' | 'reveal' {
	if (data) return 'copy'
	if (isFetching) return 'noop'
	return reveal ? 'refetch' : 'reveal'
}

/** Query keys invalidated once an upload batch finishes so both listings and Recents update. */
export const UPLOAD_REFRESH_KEYS = [['files.list'], ['files.recents']] as const

const COPY_SUFFIX_RE = / \(([2-9]|[1-9]\d+)\)$/

/** Remove a keep-both "(2)" suffix from a filename so collision copies still match originals. */
export function stripCopySuffix(name: string): string {
	if (COPY_SUFFIX_RE.test(name)) return name.replace(COPY_SUFFIX_RE, '')
	const dot = name.lastIndexOf('.')
	if (dot <= 0) return name
	return name.slice(0, dot).replace(COPY_SUFFIX_RE, '') + name.slice(dot)
}

/** Return picked photos whose name (or keep-both base name) and size are not already in Photos. */
export function filterUnsyncedPhotos<T extends {name: string; size: number}>(picked: T[], existing: FileEntry[]): T[] {
	const have = new Set<string>()
	for (const f of existing) {
		if (f.type === 'directory') continue
		have.add(`${f.name}:${f.size}`)
		have.add(`${stripCopySuffix(f.name)}:${f.size}`)
	}
	return picked.filter((f) => !have.has(`${f.name}:${f.size}`) && !have.has(`${stripCopySuffix(f.name)}:${f.size}`))
}

export type FileDragEventLike = {
	preventDefault: () => void
	dataTransfer: {types: readonly string[]; dropEffect: 'none' | 'copy' | 'link' | 'move'}
}

/** True when a drag event carries files from the OS. */
export function isFileDrag(e: FileDragEventLike): boolean {
	return e.dataTransfer.types.includes('Files')
}

/** Always prevent browser navigation for file drags; return true only when dropping can upload here. */
export function handleFileDragEnter(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	return canUpload
}

/** Keep dropEffect visual feedback accurate and prevent default browser navigation for file drags. */
export function handleFileDragOver(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	e.dataTransfer.dropEffect = canUpload ? 'copy' : 'none'
	return canUpload
}

/** Always swallow file drops on the Files screen; return true only when uploads are allowed here. */
export function handleFileDrop(e: FileDragEventLike, canUpload: boolean): boolean {
	if (!isFileDrag(e)) return false
	e.preventDefault()
	return canUpload
}

export type UploadFileItem = {file: File; rel?: string}
export type UploadBatch = {files: UploadFileItem[]; dirs: string[]}
export type DropEntryLike = {
	name: string
	isFile: boolean
	isDirectory: boolean
	file?: (ok: (file: File) => void, err: (e: unknown) => void) => void
	createReader?: () => {readEntries: (ok: (entries: DropEntryLike[]) => void, err: (e: unknown) => void) => void}
}
export type FileHandleLike = {
	kind: 'file'
	name: string
	getFile: () => Promise<File>
}
export type DirectoryHandleLike = {
	kind: 'directory'
	name: string
	values: () => AsyncIterable<FileHandleLike | DirectoryHandleLike>
}

/** Collect all unique relative directory paths (including empty folders), sorted shallowest first. */
export function collectUploadDirs(items: readonly UploadFileItem[], extraDirs: readonly string[] = []): string[] {
	const set = new Set<string>()
	const addAncestors = (dirPath: string) => {
		const parts = dirPath.split('/').filter(Boolean)
		for (let i = 0; i < parts.length; i++) set.add(parts.slice(0, i + 1).join('/'))
	}
	for (const it of items) {
		const parts = (it.rel ?? '').split('/').filter(Boolean)
		if (parts.length > 1) addAncestors(parts.slice(0, -1).join('/'))
	}
	for (const d of extraDirs) addAncestors(d)
	return [...set].sort((a, b) => a.split('/').length - b.split('/').length)
}

/** Walk dropped DataTransfer FileSystemEntry items, preserving empty subdirectories. */
export async function readDroppedEntries(entries: readonly DropEntryLike[]): Promise<UploadBatch> {
	const files: UploadFileItem[] = []
	const dirs: string[] = []
	const walk = async (entry: DropEntryLike, prefix: string): Promise<void> => {
		if (entry.isFile && entry.file) {
			const file = await new Promise<File>((res, rej) => entry.file!(res, rej))
			files.push({file, rel: prefix ? `${prefix}/${file.name}` : undefined})
		} else if (entry.isDirectory && entry.createReader) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			dirs.push(path)
			const reader = entry.createReader()
			for (;;) {
				const batch = await new Promise<DropEntryLike[]>((res, rej) => reader.readEntries(res, rej))
				if (!batch.length) break
				for (const child of batch) await walk(child, path)
			}
		}
	}
	for (const e of entries) await walk(e, '')
	return {files, dirs}
}

/** Call window.showDirectoryPicker as a method on win so Chromium does not throw Illegal invocation. */
export function pickDirectoryFromWindow(win: {showDirectoryPicker?: () => Promise<DirectoryHandleLike>}): Promise<DirectoryHandleLike> | null {
	return win.showDirectoryPicker ? win.showDirectoryPicker() : null
}

/** Walk a picked FileSystemDirectoryHandle tree, preserving empty subdirectories. */
export async function readDirectoryHandle(root: DirectoryHandleLike): Promise<UploadBatch> {
	const files: UploadFileItem[] = []
	const dirs: string[] = []
	const walk = async (dir: DirectoryHandleLike, prefix: string): Promise<void> => {
		dirs.push(prefix)
		for await (const child of dir.values()) {
			if (child.kind === 'file') {
				const file = await child.getFile()
				files.push({file, rel: `${prefix}/${file.name}`})
			} else if (child.kind === 'directory') {
				await walk(child, `${prefix}/${child.name}`)
			}
		}
	}
	await walk(root, root.name)
	return {files, dirs}
}

export type {FileEntry}
