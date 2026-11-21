import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()

async function initStore(root, name, entries) {
	const origin = join(root, `${name}.git`)
	const work = join(root, `${name}-work`)
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await writeFile(join(work, 'omarchy-app-store.yml'), `id: ${name}\nname: ${name}\n`)
	for (const {folder, yml, compose = 'services:\n  web:\n    image: nginx\n'} of entries) {
		await mkdir(join(work, folder), {recursive: true})
		await writeFile(join(work, folder, 'omarchy-app.yml'), yml)
		if (compose !== null) await writeFile(join(work, folder, 'docker-compose.yml'), compose)
	}
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'init')
	git(work, 'push', '-q', 'origin', 'HEAD:main')
	return {origin, work, url: `file://${origin}`}
}

test('string dependencies or gallery in one listing do not hide its store', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-listings-522-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const store = await initStore(root, 'bad-fields', [
		{folder: 'good', yml: 'manifestVersion: 1\nid: good\nname: Good\nport: 31001\n'},
		{folder: 'bad-dep', yml: 'manifestVersion: 1\nid: bad-dep\nname: Bad Dep\nport: 31002\ndependencies: good\n'},
		{folder: 'bad-gallery', yml: 'manifestVersion: 1\nid: bad-gallery\nname: Bad Gallery\nport: 31003\ngallery: shot.png\n'},
	])
	const run = async (cmd, args, opts = {}) => (cmd === 'git' ? execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString() : '')
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())

	await apps.procedures['appStore.addRepository'].run({url: store.url})
	const reg = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(reg[0].apps.map((a) => a.id).sort(), ['bad-dep', 'bad-gallery', 'good'])
	assert.deepEqual(reg[0].apps.find((a) => a.id === 'bad-dep').dependencies, [])
	const detail = await apps.procedures['appStore.app'].run({appId: 'bad-gallery'})
	assert.deepEqual(detail.gallery, [])
})
