// Omarchy plugins in the App Store: only verified listings, installed at the verified commit.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createOmarchyPlugins, toListing} from '../omarchyd/omarchy-plugins.mjs'

const SHA = 'a'.repeat(40)
const entry = (over = {}) => ({
	id: 'acme.weather',
	name: 'Weather',
	description: 'Weather in the bar',
	author: 'acme',
	category: 'Widgets',
	tags: ['bar'],
	kind: 'Bar widget',
	stars: 5,
	repo: 'https://github.com/acme/omarchy-weather',
	sourceType: 'community',
	verificationStatus: 'verified',
	verificationCoverage: 'snapshot-verified',
	repositoryLayout: 'root-plugin',
	installAvailable: true,
	listingValidatedCommit: SHA,
	previewThumbnail: 'assets/img/plugins/w-card.webp',
	listedAt: '2026-11-01T00:00:00Z',
	...over,
})

test('only verified, installable, single-plugin listings from GitHub are offered', () => {
	assert.equal(toListing(entry()).image, 'https://plugins.omarchy.org/assets/img/plugins/w-card.webp')
	assert.equal(toListing(entry()).commit, SHA)
	for (const bad of [
		{verificationStatus: 'unverified'},
		{verificationCoverage: 'update-unverified'},
		{sourceType: 'builtin'},
		{installAvailable: false},
		{repositoryLayout: 'suite'},
		{repo: 'https://evil.example/acme/x'},
		{repo: 'https://github.com/acme/x --upload-pack=sh'},
		{listingValidatedCommit: 'main'},
		{id: '../x'},
	])
		assert.equal(toListing(entry(bad)), null, JSON.stringify(bad))
	assert.equal(toListing(entry({previewThumbnail: '../../x.png'})).image, null)
})

describe('installing a plugin', () => {
	let home, calls, cmds, plugins, headOverride, manifestId
	before(async () => {
		home = await mkdtemp(join(os.tmpdir(), 'omarchy-plugins-'))
	})
	after(() => rm(home, {recursive: true, force: true}))
	const setup = (catalog = [entry(), entry({id: 'acme.clock', name: 'Clock', description: 'A clock', stars: 9, category: 'Productivity', listingValidatedCommit: 'b'.repeat(40), repo: 'https://github.com/acme/clock'}), entry({id: 'acme.bad', verificationStatus: 'unverified'})]) => {
		calls = []
		cmds = []
		headOverride = null
		manifestId = null
		let checkedOut = null
		const run = async (cmd, args, opts) => {
			calls.push([cmd, ...args])
			if (args[0] === '-c' && args.includes('checkout')) {
				checkedOut = args.at(-1)
				await writeFile(join(opts.cwd, 'manifest.json'), JSON.stringify({id: manifestId ?? (checkedOut === SHA ? 'acme.weather' : 'acme.clock')}))
			}
			if (args[0] === 'rev-parse') return `${headOverride ?? checkedOut}\n`
			return ''
		}
		const theme = {
			findCommand: async (name) => `/usr/bin/${name}`,
			runCommand: async (name, args) => cmds.push([name, ...args]),
		}
		plugins = createOmarchyPlugins({home, theme, run, fetchImpl: async () => ({ok: true, json: async () => ({plugins: catalog})}), catalogUrls: ['https://x/catalog.json']})
	}
	const wait = async (fn) => {
		for (let i = 0; i < 200; i++) {
			if (await fn()) return
			await new Promise((r) => setTimeout(r, 10))
		}
		throw new Error('timed out')
	}

	test('lists verified plugins, by stars, with search and categories', async () => {
		setup()
		const page = await plugins.list({})
		assert.deepEqual(page.plugins.map((p) => p.id), ['acme.clock', 'acme.weather'])
		assert.deepEqual(page.categories, ['Productivity', 'Widgets'])
		assert.equal(page.available, true)
		assert.deepEqual((await plugins.list({q: 'weather'})).plugins.map((p) => p.id), ['acme.weather'])
		assert.deepEqual((await plugins.list({category: 'Productivity'})).plugins.map((p) => p.id), ['acme.clock'])
	})

	test('installs the verified commit, validates it, then turns it on in the desktop session', async () => {
		setup()
		await plugins.install({id: 'acme.weather'})
		await wait(async () => (await plugins.list({})).plugins.find((p) => p.id === 'acme.weather').installed)
		const fetchCall = calls.find((c) => c[1] === 'fetch')
		assert.deepEqual(fetchCall.slice(-2), ['https://github.com/acme/omarchy-weather.git', SHA], 'fetches exactly the verified commit')
		assert.ok(calls.some((c) => c.includes('checkout') && c.at(-1) === SHA))
		assert.deepEqual(cmds.map((c) => c[0]), ['omarchy-git-url-check', 'omarchy-plugin-validate', 'omarchy-shell', 'omarchy-plugin-enable'])
		assert.deepEqual(cmds.at(-1), ['omarchy-plugin-enable', 'acme.weather'])
		assert.equal(JSON.parse(await readFile(join(home, '.config/omarchy/plugins/acme.weather/manifest.json'), 'utf8')).id, 'acme.weather')
		await assert.rejects(plugins.install({id: 'acme.weather'}), /already installed/)
	})

	test('refuses unlisted or unverified plugins, a different commit, or a manifest that doesn’t match', async () => {
		setup()
		await assert.rejects(plugins.install({id: 'acme.bad'}), /verified list/)
		await assert.rejects(plugins.install({id: 'nope'}), /verified list/)
		headOverride = 'c'.repeat(40)
		await plugins.install({id: 'acme.clock'})
		await wait(async () => (await plugins.list({})).plugins.find((p) => p.id === 'acme.clock').job?.state === 'error')
		assert.match((await plugins.list({})).plugins.find((p) => p.id === 'acme.clock').job.error, /didn’t match the verified version/)
		await assert.rejects(stat(join(home, '.config/omarchy/plugins/acme.clock')))
		setup()
		manifestId = 'someone.else'
		await plugins.install({id: 'acme.clock'})
		await wait(async () => (await plugins.list({})).plugins.find((p) => p.id === 'acme.clock').job?.state === 'error')
		assert.match((await plugins.list({})).plugins.find((p) => p.id === 'acme.clock').job.error, /manifest doesn’t match/)
		await assert.rejects(stat(join(home, '.config/omarchy/plugins/acme.clock')))
	})

	test('remove goes through Omarchy’s own command, for installed plugins only', async () => {
		setup()
		await assert.rejects(plugins.remove({id: 'acme.clock'}), /isn’t installed/)
		await assert.rejects(plugins.remove({id: '../etc'}), /Unknown plugin/)
		await plugins.remove({id: 'acme.weather'})
		await wait(async () => cmds.length > 0)
		assert.deepEqual(cmds[0], ['omarchy-plugin-remove', 'acme.weather', '--yes'])
	})

	test('a server whose Omarchy has no plugin commands says so', async () => {
		setup()
		const p2 = createOmarchyPlugins({home, theme: {findCommand: async () => null, runCommand: async () => {}}, fetchImpl: async () => ({ok: true, json: async () => ({plugins: [entry({id: 'acme.x'})]})}), catalogUrls: ['x']})
		assert.equal((await p2.list({})).available, false)
		await assert.rejects(p2.install({id: 'acme.x'}), /doesn’t support plugins|doesn’t have plugins/)
	})

	test('an invalid manifest.json in one plugin folder does not break list, install, or remove', async (t) => {
		const scratchHome = await mkdtemp(join(os.tmpdir(), 'omarchy-plugins-bad-'))
		t.after(() => rm(scratchHome, {recursive: true, force: true}))
		const pluginsDir = join(scratchHome, '.config', 'omarchy', 'plugins')
		await mkdir(join(pluginsDir, 'good'), {recursive: true})
		await mkdir(join(pluginsDir, 'bad'), {recursive: true})
		await writeFile(join(pluginsDir, 'good', 'manifest.json'), '{"id":"good"}')
		await writeFile(join(pluginsDir, 'bad', 'manifest.json'), '{"id":"bad",}')

		const ran = []
		const p = createOmarchyPlugins({
			home: scratchHome,
			theme: {
				findCommand: async (name) => `/usr/bin/${name}`,
				runCommand: async (name, args) => ran.push([name, ...args]),
			},
			fetchImpl: async () => ({ok: true, json: async () => ({plugins: [entry({id: 'good'})]})}),
			catalogUrls: ['https://x/catalog.json'],
		})

		const page = await p.list({})
		assert.equal(page.plugins[0].installed, true)
		await p.remove({id: 'good'})
		await p.remove({id: 'bad'})
		await wait(async () => ran.length >= 2)
		assert.deepEqual(ran, [
			['omarchy-plugin-remove', 'good', '--yes'],
			['omarchy-plugin-remove', 'bad', '--yes'],
		])
	})
})
