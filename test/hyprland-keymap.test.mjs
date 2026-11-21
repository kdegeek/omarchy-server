import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

import {actionOf, isRepeatableAction, resolveHyprKey, shouldRunAction} from '../web/src/desktop/hyprland/keymap.ts'

const e = (code, extra = {}) => ({code, key: extra.key ?? code, metaKey: extra.meta ?? false, altKey: !!extra.alt, shiftKey: !!extra.shift, ctrlKey: !!extra.ctrl, ...extra})
const superE = (code, extra = {}) => e(code, {meta: true, ...extra})

describe('hyprland keymap', () => {
	test('v1 chords', () => {
		assert.deepEqual(actionOf(e('ScrollLock')), {type: 'grab-toggle'})
		assert.deepEqual(actionOf(superE('F12')), {type: 'grab-toggle'})
		assert.deepEqual(actionOf(superE('Enter')), {type: 'terminal'})
		assert.deepEqual(actionOf(superE('KeyF', {shift: true})), {type: 'files'})
		assert.deepEqual(actionOf(superE('Space', {alt: true})), {type: 'apps'})
		assert.deepEqual(actionOf(superE('Space')), {type: 'launcher'})
		assert.deepEqual(actionOf(superE('Escape')), {type: 'system-menu'})
		assert.deepEqual(actionOf(superE('KeyK')), {type: 'cheatsheet'})
		assert.deepEqual(actionOf(superE('KeyQ')), {type: 'close'})
		assert.deepEqual(actionOf(superE('KeyW')), {type: 'close'})
		assert.deepEqual(actionOf(superE('KeyF')), {type: 'fullscreen'})
		assert.deepEqual(actionOf(superE('KeyT')), {type: 'float'})
		assert.deepEqual(actionOf(superE('KeyJ')), {type: 'split'})
		assert.deepEqual(actionOf(superE('KeyM')), {type: 'minimize'})
		assert.deepEqual(actionOf(superE('KeyM', {shift: true})), {type: 'restore'})
		assert.deepEqual(actionOf(superE('ArrowLeft')), {type: 'focus', dir: 'left'})
		assert.deepEqual(actionOf(superE('ArrowRight', {shift: true})), {type: 'swap', dir: 'right'})
		assert.deepEqual(actionOf(superE('Digit1')), {type: 'workspace', n: 1})
		assert.deepEqual(actionOf(superE('Digit9', {shift: true})), {type: 'move-workspace', n: 9})
		assert.deepEqual(actionOf(superE('Tab')), {type: 'workspace-next'})
		assert.deepEqual(actionOf(superE('Tab', {shift: true})), {type: 'workspace-prev'})
	})

	test('Digit1 with Shift is move-workspace, not a punctuation key', () => {
		assert.deepEqual(actionOf(superE('Digit1', {shift: true, key: '!'})), {type: 'move-workspace', n: 1})
	})

	test('console-focused Super+Q is not close; Scroll Lock and Super+F12 still grab', () => {
		assert.equal(actionOf(superE('KeyQ'), {consoleFocused: true}), null)
		assert.deepEqual(actionOf(e('ScrollLock'), {consoleFocused: true}), {type: 'grab-toggle'})
		assert.deepEqual(actionOf(superE('F12'), {consoleFocused: true}), {type: 'grab-toggle'})
	})

	test('keys without Super do nothing except Scroll Lock', () => {
		assert.equal(actionOf(e('Enter')), null)
		assert.equal(actionOf(e('KeyQ')), null)
	})

	test('resolveHyprKey distinguishes Super+Escape from plain Escape and handles console/grab', () => {
		assert.deepEqual(resolveHyprKey(superE('Escape'), {consoleFocused: false}), {kind: 'action', action: {type: 'system-menu'}})
		assert.equal(resolveHyprKey(e('Escape'), {consoleFocused: false}), null)
		assert.deepEqual(resolveHyprKey(superE('Escape'), {consoleFocused: true}), {kind: 'console-forward'})
		assert.deepEqual(resolveHyprKey(e('ScrollLock'), {consoleFocused: false}), {kind: 'grab-toggle'})
		assert.deepEqual(resolveHyprKey(superE('F12'), {consoleFocused: true}), {kind: 'grab-toggle'})
	})

	test('Desktop keydown runs Hyprland key resolution before generic Escape cleanup', () => {
		const src = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
		const hyprIdx = src.indexOf('resolveHyprKey(')
		const escIdx = src.indexOf("if (e.key === 'Escape')")
		assert.ok(hyprIdx !== -1, 'Desktop.tsx must use resolveHyprKey')
		assert.ok(escIdx !== -1, 'Desktop.tsx must retain generic Escape handler')
		assert.ok(hyprIdx < escIdx, 'Hyprland shortcuts must be handled before generic Escape cleanup')
	})

	test('key repeat is ignored for one-shot actions and allowed for focus/swap navigation', () => {
		const oneShot = [
			{type: 'terminal'},
			{type: 'close'},
			{type: 'system-menu'},
			{type: 'launcher'},
			{type: 'cheatsheet'},
			{type: 'fullscreen'},
			{type: 'float'},
			{type: 'split'},
			{type: 'minimize'},
			{type: 'restore'},
			{type: 'grab-toggle'},
			{type: 'files'},
			{type: 'apps'},
			{type: 'workspace', n: 2},
			{type: 'move-workspace', n: 2},
			{type: 'workspace-next'},
			{type: 'workspace-prev'},
		]
		for (const act of oneShot) {
			assert.equal(isRepeatableAction(act), false, `${act.type} should not repeat`)
			assert.equal(shouldRunAction(act, false), true, `${act.type} runs on initial press`)
			assert.equal(shouldRunAction(act, true), false, `${act.type} ignores repeat`)
		}
		for (const act of [{type: 'focus', dir: 'left'}, {type: 'swap', dir: 'right'}]) {
			assert.equal(isRepeatableAction(act), true, `${act.type} may repeat`)
			assert.equal(shouldRunAction(act, false), true)
			assert.equal(shouldRunAction(act, true), true)
		}
		assert.equal(shouldRunAction(null, false), false)
		assert.equal(shouldRunAction(null, true), false)
		assert.deepEqual(resolveHyprKey(superE('Enter', {repeat: true}), {consoleFocused: false}), {kind: 'action', action: {type: 'terminal'}})
		assert.deepEqual(resolveHyprKey(superE('KeyQ', {repeat: true}), {consoleFocused: true}), {kind: 'console-forward'})
	})
})
