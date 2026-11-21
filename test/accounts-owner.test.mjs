// Owner account validation and live reload when created out of process.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

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

test('an empty openAccounts instance picks up an owner created in another process (#616)', async (t) => {
	const dir = await tempDir(t)
	const live = await openAccounts(dir)
	assert.equal(live.hasOwner(), false)

	const cli = await openAccounts(dir)
	await cli.createOwner({name: 'bob', password: 'correct horse'})

	assert.equal(live.hasOwner(), true)
	assert.equal(live.listAccounts()[0].name, 'bob')
	assert.equal(live.getUser('owner')?.name, 'bob')
	const login = await live.loginNative({userId: 'owner', password: 'correct horse', client: {id: 't'}})
	assert.equal(login.accountId, 'owner')
})

test('after factory reset, openAccounts picks up a newly created owner (#616)', async (t) => {
	const dir = await tempDir(t)
	const live = await openAccounts(dir)
	await live.createOwner({name: 'bob', password: 'correct horse'})
	await live.reset()
	assert.equal(live.hasOwner(), false)

	const cli = await openAccounts(dir)
	await cli.createOwner({name: 'alice', password: 'new password'})

	assert.equal(live.hasOwner(), true)
	assert.equal(live.listAccounts()[0].name, 'alice')
	const login = await live.loginNative({userId: 'owner', password: 'new password', client: {id: 't'}})
	assert.equal(login.accountId, 'owner')
})

test('running omarchyd sees an owner created while it is already running (#616)', async (t) => {
	const root = await tempDir(t)
	const dataDir = join(root, 'data')
	const d = await startOmarchyd({
		port: 0,
		dataDir,
		home: root,
		updaterOptions: {autoCheck: false},
		appOptions: {systemApps: null, run: async () => ''},
		machineOptions: {run: async () => ''},
	})
	try {
		const beforeInfo = await (await fetch(`${d.url}/trpc/system.discoveryInfo`)).json()
		assert.equal(beforeInfo.result.data.onboarded, false)
		const beforeList = await (await fetch(`${d.url}/trpc/user.listAccounts`)).json()
		assert.deepEqual(beforeList.result.data, [])

		const cli = await openAccounts(dataDir)
		await cli.createOwner({name: 'bob', password: 'correct horse'})

		const afterInfo = await (await fetch(`${d.url}/trpc/system.discoveryInfo`)).json()
		assert.equal(afterInfo.result.data.onboarded, true)
		const afterList = await (await fetch(`${d.url}/trpc/user.listAccounts`)).json()
		assert.equal(afterList.result.data[0].name, 'bob')

		const login = await fetch(`${d.url}/trpc/user.loginNative`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}}),
		})
		assert.equal(login.status, 200)
	} finally {
		await d.close()
	}
})
