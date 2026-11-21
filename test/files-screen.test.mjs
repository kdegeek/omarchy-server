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
