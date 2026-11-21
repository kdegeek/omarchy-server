// Turning two-factor authentication off and back on must offer a fresh setup key and allow immediate sign-in with it.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {describe, test} from 'node:test'
import {QueryClient} from '@tanstack/query-core'

import {openAccounts, secretFromUri, totpCode} from '../omarchyd/accounts.mjs'
import {TOTP_URI_QUERY_KEY, TOTP_URI_QUERY_OPTIONS, clearTotpSetupUri} from '../web/src/screens/settingsHelpers.ts'

describe('two-factor setup key rotation', () => {
	test('clears the cached setup URI between opens while keeping it stable while open', async (t) => {
		const qc = new QueryClient({defaultOptions: {queries: {gcTime: Infinity, retry: false}}})
		t.after(() => qc.clear())

		let calls = 0
		const queryFn = async () => {
			calls += 1
			return `otpauth://totp/Omarchy%20Server:owner?secret=SECRET${calls}&issuer=Omarchy%20Server`
		}
		const queryKey = [...TOTP_URI_QUERY_KEY, undefined]

		const first = await qc.fetchQuery({queryKey, queryFn, ...TOTP_URI_QUERY_OPTIONS})
		assert.match(first, /SECRET1/)
		assert.equal(calls, 1)

		// Switching away and back while the sheet stays open reuses the cached setup key.
		const whileOpen = await qc.fetchQuery({queryKey, queryFn, ...TOTP_URI_QUERY_OPTIONS})
		assert.equal(whileOpen, first)
		assert.equal(calls, 1)

		// Closing or turning 2FA off/on drops the cached setup key so the next open fetches a fresh one.
		clearTotpSetupUri(qc)
		const second = await qc.fetchQuery({queryKey, queryFn, ...TOTP_URI_QUERY_OPTIONS})
		assert.match(second, /SECRET2/)
		assert.notEqual(second, first)
		assert.equal(calls, 2)
	})

	test('accounts store issues a new secret after disable2fa and allows sign-in with the new secret in the same time step', async (t) => {
		const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-2fa-'))
		t.after(() => rm(dir, {recursive: true, force: true}))

		const accounts = await openAccounts(dir)
		await accounts.createOwner({name: 'owner', password: 'correct-horse-battery'})

		const uri1 = accounts.totpUri('owner')
		const secret1 = secretFromUri(uri1)
		assert.ok(secret1)
		await accounts.enable2fa('owner', {totpUri: uri1, totpToken: totpCode(secret1)})

		// Sign in once so the current 30-second time step is recorded in usedSteps.
		await accounts.loginBrowser({userId: 'owner', password: 'correct-horse-battery', totpToken: totpCode(secret1)})

		// Disable 2FA using another valid code (next/prev step if needed, or step +1? disable2fa uses totpOk which checks -1/0/1).
		await accounts.disable2fa('owner', {totpToken: totpCode(secret1)})
		assert.equal(accounts.is2faEnabled('owner'), false)

		// Re-enable 2FA: server generates a distinct secret, and signing in with the new secret works right away.
		const uri2 = accounts.totpUri('owner')
		const secret2 = secretFromUri(uri2)
		assert.ok(secret2)
		assert.notEqual(uri2, uri1)
		assert.equal(Buffer.compare(secret1, secret2) !== 0, true)

		await accounts.enable2fa('owner', {totpUri: uri2, totpToken: totpCode(secret2)})
		assert.equal(accounts.is2faEnabled('owner'), true)
		await accounts.loginBrowser({userId: 'owner', password: 'correct-horse-battery', totpToken: totpCode(secret2)})
	})
})
