// Pure helpers for desktop icon keyboard shortcuts and selection clearing.
export type ClosestTarget = {closest?: (selector: string) => unknown} | null | undefined
export type IconKeyEvent = {key: string; ctrlKey: boolean; metaKey: boolean; altKey?: boolean}
export type DesktopIconAction = {type: 'select-all'} | {type: 'open'; keys: string[]} | {type: 'remove'; keys: string[]}

export function isDesktopSurfaceFocused(activeElement: ClosestTarget): boolean {
	return Boolean(activeElement?.closest?.('.desk-surface'))
}

export function shouldClearDesktopSelection(target: ClosestTarget): boolean {
	if (!target?.closest) return false
	if (target.closest('.desk-surface') || target.closest('.ctx-menu')) return false
	return Boolean(target.closest('.win, .desk-dock, .desk-top, .ov-layer'))
}

export function desktopIconKeyAction(e: IconKeyEvent, activeElement: ClosestTarget, selected: ReadonlySet<string>): DesktopIconAction | null {
	if (!isDesktopSurfaceFocused(activeElement)) return null
	if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.altKey) return {type: 'select-all'}
	if (!selected.size) return null
	if (e.key === 'Enter') return {type: 'open', keys: [...selected]}
	if (e.key === 'Delete' || e.key === 'Backspace') return {type: 'remove', keys: [...selected]}
	return null
}
