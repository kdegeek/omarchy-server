// Desktop icon keyboard shortcuts only run while the desktop surface is focused.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {desktopIconKeyAction, isDesktopSurfaceFocused, shouldClearDesktopSelection} from '../web/src/desktop/desktopIcons.ts'

const elIn = (...selectors) => ({
	closest(selector) {
		const parts = selector.split(',').map((s) => s.trim())
		return parts.some((p) => selectors.includes(p)) ? {} : null
	},
})

const key = (k, extra = {}) => ({key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra})

describe('desktop icon shortcuts', () => {
	test('ignores shortcuts when focus is null, document.body, or inside a window', () => {
		const sel = new Set(['folder:/Home', 'folder:/Trash'])
		for (const active of [null, elIn('body'), elIn('.win')]) {
			assert.equal(isDesktopSurfaceFocused(active), false)
			assert.equal(desktopIconKeyAction(key('a', {ctrlKey: true}), active, sel), null)
			assert.equal(desktopIconKeyAction(key('a', {metaKey: true}), active, sel), null)
			assert.equal(desktopIconKeyAction(key('Enter'), active, sel), null)
			assert.equal(desktopIconKeyAction(key('Delete'), active, sel), null)
			assert.equal(desktopIconKeyAction(key('Backspace'), active, sel), null)
		}
	})

	test('runs select-all, open, and remove only when .desk-surface has focus', () => {
		const surface = elIn('.desk-surface')
		assert.equal(isDesktopSurfaceFocused(surface), true)
		assert.deepEqual(desktopIconKeyAction(key('a', {ctrlKey: true}), surface, new Set()), {type: 'select-all'})
		assert.deepEqual(desktopIconKeyAction(key('a', {metaKey: true}), surface, new Set()), {type: 'select-all'})
		assert.equal(desktopIconKeyAction(key('Enter'), surface, new Set()), null)
		assert.equal(desktopIconKeyAction(key('Delete'), surface, new Set()), null)
		assert.equal(desktopIconKeyAction(key('Backspace'), surface, new Set()), null)

		const sel = new Set(['folder:/Home', 'folder:/Trash'])
		assert.deepEqual(desktopIconKeyAction(key('Enter'), surface, sel), {type: 'open', keys: ['folder:/Home', 'folder:/Trash']})
		assert.deepEqual(desktopIconKeyAction(key('Delete'), surface, sel), {type: 'remove', keys: ['folder:/Home', 'folder:/Trash']})
		assert.deepEqual(desktopIconKeyAction(key('Backspace'), surface, sel), {type: 'remove', keys: ['folder:/Home', 'folder:/Trash']})
	})

	test('clears desktop selection when pointer or focus moves into a window, dock, or top bar', () => {
		assert.equal(shouldClearDesktopSelection(elIn('.win')), true)
		assert.equal(shouldClearDesktopSelection(elIn('.desk-dock')), true)
		assert.equal(shouldClearDesktopSelection(elIn('.desk-top')), true)
		assert.equal(shouldClearDesktopSelection(elIn('.desk-surface')), false)
		assert.equal(shouldClearDesktopSelection(elIn('.ctx-menu')), false)
		assert.equal(shouldClearDesktopSelection(null), false)
	})
})
