// Files screen helpers: batch action toast handling, name prompts, keyboard/drag guards,
// upload folder walking, favorites paths, photo sync matching, and readable kind labels.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import * as helpers from '../web/src/filesHelpers.ts'

const filesSource = () => readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')

describe('files screen: #112 batch error handling', () => {
	test('runFileBatch collects succeeded and failed paths without aborting', async () => {
		const calls = []
		const res = await helpers.runFileBatch(['/Home/a.txt', '/Home/b.txt', '/Home/c.txt'], async (p) => {
			calls.push(p)
			if (p === '/Home/b.txt') throw new Error('[cannot-trash]')
		})
		assert.deepEqual(calls, ['/Home/a.txt', '/Home/b.txt', '/Home/c.txt'])
		assert.deepEqual(res.succeeded, ['/Home/a.txt', '/Home/c.txt'])
		assert.deepEqual(res.failed, ['/Home/b.txt'])
	})

	test('batchToastMessage returns null when every item fails so the error toast remains visible', () => {
		for (const action of ['trash', 'delete', 'restore']) {
			assert.equal(helpers.batchToastMessage(action, 1, {succeeded: [], failed: ['/Home/a.txt']}), null)
			assert.equal(helpers.batchToastMessage(action, 3, {succeeded: [], failed: ['/a', '/b', '/c']}), null)
		}
	})

	test('batchToastMessage formats full and partial success counts', () => {
		assert.deepEqual(helpers.batchToastMessage('trash', 1, {succeeded: ['/a'], failed: []}), {
			text: 'Moved to Trash',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('trash', 3, {succeeded: ['/a', '/b', '/c'], failed: []}), {
			text: '3 items moved to Trash',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('trash', 3, {succeeded: ['/a', '/c'], failed: ['/b']}), {
			text: 'Moved 2 of 3 items to Trash (1 failed)',
			error: true,
		})

		assert.deepEqual(helpers.batchToastMessage('delete', 1, {succeeded: ['/a'], failed: []}), {
			text: 'Deleted',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('delete', 3, {succeeded: ['/a', '/b', '/c'], failed: []}), {
			text: '3 items deleted',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('delete', 3, {succeeded: ['/a', '/c'], failed: ['/b']}), {
			text: 'Deleted 2 of 3 items (1 failed)',
			error: true,
		})

		assert.deepEqual(helpers.batchToastMessage('restore', 1, {succeeded: ['/a'], failed: []}), {
			text: 'Restored',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('restore', 3, {succeeded: ['/a', '/b', '/c'], failed: []}), {
			text: '3 items restored',
			error: false,
		})
		assert.deepEqual(helpers.batchToastMessage('restore', 3, {succeeded: ['/a', '/c'], failed: ['/b']}), {
			text: 'Restored 2 of 3 items (1 failed)',
			error: true,
		})
	})

	test('Files.tsx uses runFileBatch and batchToastMessage for trashItems, deleteForever and restore', async () => {
		const src = await filesSource()
		assert.match(src, /const res = await runFileBatch\(paths, run\)/)
		assert.match(src, /const msg = batchToastMessage\(action, paths\.length, res\)/)
		assert.match(src, /if \(msg\) toast\(msg\.text, msg\.error\)/)
		assert.match(src, /finishBatch\("trash", paths, \(p\) => act\("files\.trash"/)
		assert.match(src, /finishBatch\("delete", paths, \(p\) => act\("files\.delete"/)
		assert.match(src, /finishBatch\("restore", paths, \(p\) =>\s*act\("files\.restore"/)
	})
})

describe('files screen: #441 new folder NamePrompt submit state', () => {
	test('allows submitting suggested New folder name without editing when requireChange is false', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'New folder', initial: 'New folder', requireChange: false, busy: false}),
			true,
		)
	})

	test('requires a changed trimmed name when requireChange is true', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: ' notes.txt ', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes2.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			true,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: ' notes.txt ', requireChange: true, busy: false}),
			true,
		)
	})

	test('rejects invalid names and busy submissions', () => {
		for (const bad of ['', '   ', 'a/b', '.', '..']) {
			assert.equal(
				helpers.canSubmitNamePrompt({name: bad, initial: 'New folder', requireChange: false, busy: false}),
				false,
				bad,
			)
		}
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'Docs', initial: 'New folder', requireChange: false, busy: true}),
			false,
		)
	})

	test('Files.tsx passes requireChange only for rename and uses canSubmitNamePrompt', async () => {
		const src = await filesSource()
		assert.match(src, /requireChange=\{prompt\.kind === "rename"\}/)
		assert.match(src, /canSubmitNamePrompt\(\{ name, initial, requireChange, busy \}\)/)
		assert.doesNotMatch(src, /disabled=\{!valid \|\| busy \|\| name === initial\}/)
	})
})

describe('files screen: #491 clear selection when search changes', () => {
	test('nextSearchSelection clears selection when query text changes and preserves empty set', () => {
		const sel = new Set(['/Home/a.txt', '/Home/b.txt'])
		assert.equal(helpers.nextSearchSelection(sel, '', 'a').size, 0)
		assert.equal(helpers.nextSearchSelection(sel, 'a', 'ab').size, 0)
		assert.equal(helpers.nextSearchSelection(sel, 'a', '').size, 0)
		const empty = new Set()
		assert.equal(helpers.nextSearchSelection(empty, '', 'a'), empty)
		assert.equal(helpers.nextSearchSelection(sel, 'a', 'a'), sel)
	})

	test('Files.tsx clears selected items when q changes', async () => {
		const src = await filesSource()
		assert.match(src, /setSelected\(\(s\) => nextSearchSelection\(s, prevQ\.current, q\)\)/)
		assert.match(src, /setSelected\(\(s\) => nextSearchSelection\(s, q, next\)\)/)
	})
})

describe('files screen: #113 favorites preserve FileEntry metadata', () => {
	test('favoritePath extracts path from both FileEntry objects and strings', () => {
		assert.equal(helpers.favoritePath('/Home/Docs'), '/Home/Docs')
		assert.equal(
			helpers.favoritePath({
				name: 'a.pdf',
				path: '/Home/a.pdf',
				type: 'application/pdf',
				size: 123,
				modified: 1000,
				operations: ['favorite'],
			}),
			'/Home/a.pdf',
		)
	})

	test('Files.tsx queries FavoriteItem[] and keeps FileEntry objects in ::favorites', async () => {
		const src = await filesSource()
		assert.match(src, /query<FavoriteItem\[\]>\("files\.favorites"\)/)
		assert.match(src, /favSet = useMemo\(\(\) => new Set\(\(favorites\.data \?\? \[\]\)\.map\(favoritePath\)\), \[favorites\.data\]\)/)
		assert.match(src, /typeof p === "string" \? \{/)
	})
})
