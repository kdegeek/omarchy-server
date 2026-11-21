// Owner account validation and live reload when created out of process.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'

async function tempDir(t) {
	const dir = await mkdtemp(join(os.tmpdir(), 'accounts-owner-'))
	t.after(() => rm(dir, {recursive: true, force: true}))
	return dir
}

test('createOwner rejects whitespace-only names and trims surrounding spaces (#481)', async (t) => {
	const dir = await tempDir(t)
	const accounts = await openAccounts(dir)
	for (const bad of ['   ', '\t ', '']) {
		await assert.rejects(() => accounts.createOwner({name: bad, password: 'longenough'}), /Use 1-40 letters, numbers/)
	}
	assert.deepEqual(accounts.listAccounts(), [])
	assert.equal(accounts.hasOwner(), false)

	await accounts.createOwner({name: '  Chris  ', password: 'longenough'})
	assert.equal(accounts.hasOwner(), true)
	assert.equal(accounts.listAccounts()[0].name, 'Chris')
})
