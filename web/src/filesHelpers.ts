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

export type {FileEntry}
