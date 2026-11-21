// Files backend fixes: folder-first sort, favorite metadata, empty Trash, and Unicode NFC search.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'

describe('files: #97 folders stay before files in descending sort', () => {
	test('sorting by modified, size, or name descending keeps folders first', async (t) => {
		const scratch = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-sort-')))
		t.after(() => rm(scratch, {recursive: true, force: true}))
		const h = join(scratch, 'home')
		const d = join(scratch, 'data')
		await mkdir(join(h, 'Alpha'), {recursive: true})
		await mkdir(join(h, 'Beta'), {recursive: true})
		await mkdir(d, {recursive: true})
		await writeFile(join(h, 'new.txt'), 'a')
		await writeFile(join(h, 'old.txt'), 'abcd')
		const t0 = new Date('2026-01-01T00:00:00Z')
		await utimes(join(h, 'old.txt'), t0, new Date(t0.getTime() + 10_000))
		await utimes(join(h, 'Alpha'), t0, new Date(t0.getTime() + 20_000))
		await utimes(join(h, 'Beta'), t0, new Date(t0.getTime() + 30_000))
		await utimes(join(h, 'new.txt'), t0, new Date(t0.getTime() + 40_000))

		const f = createFiles({home: h, dataDir: d})
		const run = (name, input) => f.procedures[name].run(input)

		const byModifiedDesc = await run('files.list', {path: '/Home', sortBy: 'modified', sortOrder: 'descending'})
		assert.deepEqual(byModifiedDesc.files.map((x) => x.name), ['Beta', 'Alpha', 'new.txt', 'old.txt'])

		const bySizeDesc = await run('files.list', {path: '/Home', sortBy: 'size', sortOrder: 'descending'})
		assert.deepEqual(bySizeDesc.files.map((x) => x.name), ['Alpha', 'Beta', 'old.txt', 'new.txt'])

		const byNameDesc = await run('files.list', {path: '/Home', sortBy: 'name', sortOrder: 'descending'})
		assert.deepEqual(byNameDesc.files.map((x) => x.name), ['Beta', 'Alpha', 'old.txt', 'new.txt'])

		const byNameAsc = await run('files.list', {path: '/Home', sortBy: 'name', sortOrder: 'ascending'})
		assert.deepEqual(byNameAsc.files.map((x) => x.name), ['Alpha', 'Beta', 'new.txt', 'old.txt'])

		const pagedModifiedDesc = await run('files.list', {path: '/Home', sortBy: 'modified', sortOrder: 'descending', limit: 2})
		assert.deepEqual(pagedModifiedDesc.files.map((x) => x.name), ['Beta', 'Alpha'])
	})
})
