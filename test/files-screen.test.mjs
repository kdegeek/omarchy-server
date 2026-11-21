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

describe('files screen: #189 Enter key on row action buttons', () => {
	test('shouldActivateRowOnKey only activates when Enter originates on the row itself', () => {
		const row = {}
		const childBtn = {}
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: row, currentTarget: row}), true)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: childBtn, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: ' ', target: row, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Escape', target: row, currentTarget: row}), false)
	})

	test('Files.tsx guards row onKeyDown with shouldActivateRowOnKey', async () => {
		const src = await filesSource()
		assert.match(src, /onKeyDown=\{\(e\) => shouldActivateRowOnKey\(e\) && activate\(f\)\}/)
	})
})

describe('files screen: #195 ShareSheet access radios stay mounted and grouped', () => {
	test('ShareAccessChoice lives at module scope with a shared radio name from useId()', async () => {
		const src = await filesSource()
		const shareStart = src.indexOf('export function ShareSheet(')
		assert.ok(shareStart > 0)
		const beforeShare = src.slice(0, shareStart)
		const insideShare = src.slice(shareStart)

		assert.match(beforeShare, /function ShareAccessChoice\(/)
		assert.match(beforeShare, /<input type="radio" name=\{name\}/)
		assert.doesNotMatch(insideShare, /const Choice\s*=/)
		assert.match(insideShare, /const accessRadioName = useId\(\)/)
		const matches = insideShare.match(/<ShareAccessChoice[\s\S]*?name=\{accessRadioName\}/g) ?? []
		assert.equal(matches.length, 2)
	})
})

describe('files screen: #196 ShareSheet password error and retry', () => {
	test('sharePasswordLabel shows Tap to show, loading ellipsis, password, or error with retry hint', () => {
		assert.equal(helpers.sharePasswordLabel({data: undefined, isFetching: false, error: null}), 'Tap to show')
		assert.equal(helpers.sharePasswordLabel({data: undefined, isFetching: true, error: new Error('old')}), '…')
		assert.equal(helpers.sharePasswordLabel({data: 's3cr3t', isFetching: false, error: null}), 's3cr3t')
		assert.equal(
			helpers.sharePasswordLabel({data: undefined, isFetching: false, error: new Error('Helper unavailable')}),
			'Helper unavailable · Tap to retry',
		)
		assert.equal(
			helpers.sharePasswordLabel({data: undefined, isFetching: false, error: new Error('')}),
			'Couldn’t load password · Tap to retry',
		)
	})

	test('sharePasswordAction copies when loaded, refetches when already revealed, and reveals first time', () => {
		assert.equal(helpers.sharePasswordAction({data: 'pw', reveal: true}), 'copy')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: true, isFetching: false}), 'refetch')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: true, isFetching: true}), 'noop')
		assert.equal(helpers.sharePasswordAction({data: undefined, reveal: false, isFetching: false}), 'reveal')
	})

	test('Files.tsx uses sharePasswordAction, pw.refetch(), and sharePasswordLabel in ShareSheet', async () => {
		const src = await filesSource()
		assert.match(src, /sharePasswordAction\(\{ data: pw\.data, reveal, isFetching: pw\.isFetching \}\)/)
		assert.match(src, /!pw\.data && pw\.error && !pw\.isFetching/)
		assert.match(src, /pw\.refetch\(\)/)
		assert.match(src, /sharePasswordLabel\(\{ data: pw\.data, isFetching: pw\.isFetching, error: pw\.error \}\)/)
	})
})

describe('files screen: #197 refresh Recents after uploads', () => {
	test('UPLOAD_REFRESH_KEYS invalidates both files.list and files.recents', () => {
		assert.deepEqual(helpers.UPLOAD_REFRESH_KEYS, [['files.list'], ['files.recents']])
	})

	test('Files.tsx invalidates UPLOAD_REFRESH_KEYS when uploads finish', async () => {
		const src = await filesSource()
		assert.match(src, /for \(const key of UPLOAD_REFRESH_KEYS\)\s*qc\.invalidateQueries\(\{ queryKey: \[...key\] \}\)/)
	})
})

describe('files screen: #489 Sync photos recognizes keep-both copies', () => {
	test('stripCopySuffix strips (2)+ before the extension or end of name', () => {
		assert.equal(helpers.stripCopySuffix('IMG_0001 (2).jpg'), 'IMG_0001.jpg')
		assert.equal(helpers.stripCopySuffix('IMG_0001 (12).HEIC'), 'IMG_0001.HEIC')
		assert.equal(helpers.stripCopySuffix('Photo (2)'), 'Photo')
		assert.equal(helpers.stripCopySuffix('clip (final) (3).mp4'), 'clip (final).mp4')
		assert.equal(helpers.stripCopySuffix('IMG_0001 (1).jpg'), 'IMG_0001 (1).jpg')
		assert.equal(helpers.stripCopySuffix('IMG_0001.jpg'), 'IMG_0001.jpg')
	})

	test('filterUnsyncedPhotos treats keep-both copies with matching size as already synced', () => {
		const existing = [
			{name: 'IMG_0001.jpg', path: '/Home/Photos/IMG_0001.jpg', type: 'image/jpeg', size: 1000, modified: 1, operations: []},
			{name: 'IMG_0001 (2).jpg', path: '/Home/Photos/IMG_0001 (2).jpg', type: 'image/jpeg', size: 2000, modified: 2, operations: []},
			{name: 'Album', path: '/Home/Photos/Album', type: 'directory', modified: 3, operations: []},
		]
		assert.deepEqual(helpers.filterUnsyncedPhotos([{name: 'IMG_0001.jpg', size: 2000}], existing), [])
		assert.deepEqual(helpers.filterUnsyncedPhotos([{name: 'IMG_0001 (2).jpg', size: 2000}], existing), [])
		const brandNew = {name: 'IMG_0001.jpg', size: 3000}
		assert.deepEqual(helpers.filterUnsyncedPhotos([brandNew], existing), [brandNew])
	})

	test('Files.tsx uses filterUnsyncedPhotos in photoInput onChange', async () => {
		const src = await filesSource()
		assert.match(src, /const fresh = filterUnsyncedPhotos\(picked, listing\.data\?\.files \?\? \[\]\);/)
	})
})
