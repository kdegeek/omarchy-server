import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()

async function makeStore(root, name, apps) {
	const origin = join(root, `${name}.git`)
	const work = join(root, `${name}-work`)
	git(root, 'init', '-q', '--bare', '-b', 'main', origin)
	git(root, 'clone', '-q', origin, work)
	await writeFile(join(work, 'omarchy-app-store.yml'), `id: ${name}\nname: ${name}\n`)
	for (const {id, port = 31001, version = '1.0'} of apps) {
		await mkdir(join(work, id), {recursive: true})
		await writeFile(join(work, id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\nversion: "${version}"\nport: ${port}\nweb:\n  service: web\n  port: 80\n`)
		await writeFile(join(work, id, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	}
	git(work, 'add', '-A')
	git(work, 'commit', '-qm', 'init')
	git(work, 'push', '-q', 'origin', 'HEAD:main')
	return {origin, work, url: `file://${origin}`}
}

const storeFolderName = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16)

test('removing a store during a refresh drops it from the registry and rejects installs from it', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-sync-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const storeA = await makeStore(root, 'store-a', [{id: 'aa', port: 31001}])
	const storeB = await makeStore(root, 'store-b', [{id: 'bb', port: 31002}])
	const data = join(root, 'data')
	const dirB = join(data, 'apps', 'stores', storeFolderName(storeB.url))

	let pauseFetchB = false
	let onBStarted
	const bStarted = new Promise((r) => (onBStarted = r))
	let releaseB
	const gateB = new Promise((r) => (releaseB = r))

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (pauseFetchB && args[0] === '-C' && args[1] === dirB && args[2] === 'fetch') {
				pauseFetchB = false
				onBStarted()
				await gateB
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		if (cmd === 'docker-compose' && args[0] === 'version') return 'Docker Compose version v2.30.0'
		return ''
	}

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())

	await apps.procedures['appStore.addRepository'].run({url: storeA.url})
	await apps.procedures['appStore.addRepository'].run({url: storeB.url})

	pauseFetchB = true
	const refreshing = apps.procedures['appStore.refresh'].run()
	await bStarted
	await apps.procedures['appStore.removeRepository'].run({url: storeA.url})
	releaseB()
	await refreshing

	const reg = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(reg.map((s) => s.url), [storeB.url])
	await assert.rejects(apps.procedures['apps.install'].run({appId: 'aa'}), (e) => e.code === 'NOT_FOUND' && /isn’t in your stores/.test(e.message))
})

test('removing a store while its own sync is running leaves no leftover store folder', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-sync-own-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const storeA = await makeStore(root, 'store-a', [{id: 'aa', port: 31001}])
	const data = join(root, 'data')
	const hashA = storeFolderName(storeA.url)
	const dirA = join(data, 'apps', 'stores', hashA)

	let pauseCloneA = false
	let onCloneStarted
	const cloneStarted = new Promise((r) => (onCloneStarted = r))
	let releaseClone
	const gateClone = new Promise((r) => (releaseClone = r))

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (pauseCloneA && args[0] === 'clone' && args.includes(dirA)) {
				pauseCloneA = false
				onCloneStarted()
				await gateClone
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: storeA.url}], systemApps: null, run})
	t.after(() => apps.close())

	pauseCloneA = true
	const regPromise = apps.procedures['appStore.registry'].run()
	await cloneStarted
	await apps.procedures['appStore.removeRepository'].run({url: storeA.url})
	releaseClone()

	const reg = await regPromise
	assert.deepEqual(reg, [])
	const entries = await readdir(join(data, 'apps', 'stores'))
	assert.equal(entries.includes(hashA), false)
})

test('overlapping registry reads wait for the in-flight clone instead of cloning or resetting mid-sync', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-overlap-clone-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const store = await makeStore(root, 'store-a', [
		{id: 'one', port: 31001},
		{id: 'two', port: 31002},
		{id: 'three', port: 31003},
	])
	const gitCalls = []
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			gitCalls.push(args)
			if (args[0] === 'clone') await new Promise((r) => setTimeout(r, 80))
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: store.url}], systemApps: null, run})
	t.after(() => apps.close())

	const p1 = apps.procedures['appStore.registry'].run()
	await new Promise((r) => setTimeout(r, 20))
	const p2 = apps.procedures['appStore.registry'].run()
	const [a, b] = await Promise.all([p1, p2])

	assert.equal(gitCalls.length, 1)
	assert.equal(gitCalls[0][0], 'clone')
	assert.deepEqual(a[0].apps.map((x) => x.id).sort(), ['one', 'three', 'two'])
	assert.deepEqual(b[0].apps.map((x) => x.id).sort(), ['one', 'three', 'two'])
})

test('overlapping refresh and registry reads share one fetch on an existing clone', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-overlap-fetch-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const store = await makeStore(root, 'store-a', [{id: 'one', port: 31001}])
	const data = join(root, 'data')
	const syncRun = async (cmd, args, opts = {}) => (cmd === 'git' ? execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString() : '')

	const first = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: store.url}], systemApps: null, run: syncRun})
	await first.procedures['appStore.registry'].run()
	first.close()

	await mkdir(join(store.work, 'two'), {recursive: true})
	await writeFile(join(store.work, 'two', 'omarchy-app.yml'), 'manifestVersion: 1\nid: two\nname: two\nversion: "1.0"\nport: 31002\n')
	await writeFile(join(store.work, 'two', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	git(store.work, 'add', '-A')
	git(store.work, 'commit', '-qm', 'two')
	git(store.work, 'push', '-q', 'origin', 'HEAD:main')

	const stateFile = join(data, 'apps', 'apps.json')
	const st = JSON.parse(await readFile(stateFile, 'utf8'))
	for (const s of st.stores) s.syncedAt = 0
	await writeFile(stateFile, JSON.stringify(st))

	let pauseFetch = true
	let onFetchStarted
	const fetchStarted = new Promise((r) => (onFetchStarted = r))
	let releaseFetch
	const gateFetch = new Promise((r) => (releaseFetch = r))
	const fetchCalls = []

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (args[2] === 'fetch') {
				fetchCalls.push(args)
				if (pauseFetch) {
					pauseFetch = false
					onFetchStarted()
					await gateFetch
				}
			}
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const second = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: store.url}], systemApps: null, run})
	t.after(() => second.close())

	const p1 = second.procedures['appStore.refresh'].run()
	await fetchStarted
	const p2 = second.procedures['appStore.registry'].run()
	releaseFetch()
	const [count, reg] = await Promise.all([p1, p2])

	assert.equal(fetchCalls.length, 1)
	assert.equal(count, 2)
	assert.deepEqual(reg[0].apps.map((x) => x.id).sort(), ['one', 'two'])
})

test('failed first store sync is not cached for an hour so retrying online succeeds', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-offline-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const store = await makeStore(root, 'store-a', [{id: 'one', port: 31001}])
	let offline = true
	let gitCalls = 0
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			gitCalls++
			if (offline) throw new Error('git: Could not resolve host')
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: store.url}], systemApps: null, run})
	t.after(() => apps.close())

	assert.deepEqual(await apps.procedures['appStore.registry'].run(), [])
	assert.equal(gitCalls, 1)

	offline = false
	const reg = await apps.procedures['appStore.registry'].run()
	assert.equal(reg.length, 1)
	assert.deepEqual(reg[0].apps.map((x) => x.id), ['one'])
	assert.equal(gitCalls, 2)

	const cached = await apps.procedures['appStore.registry'].run()
	assert.equal(cached.length, 1)
	assert.equal(gitCalls, 2)
})

test('appStore.refresh reports store download errors instead of succeeding silently', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'appstore-refresh-err-')))
	t.after(() => rm(root, {recursive: true, force: true}))

	const storeA = await makeStore(root, 'store-a', [{id: 'one', port: 31001}])
	const storeB = await makeStore(root, 'store-b', [{id: 'two', port: 31002}])
	const data = join(root, 'data')
	const dirB = join(data, 'apps', 'stores', storeFolderName(storeB.url))

	let failAll = false
	let failB = false
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'git') {
			if (failAll) throw new Error('git: fatal: unable to access https://example.test: Could not resolve host')
			if (failB && args[0] === '-C' && args[1] === dirB) throw new Error('git: fatal: unable to access store-b: Could not resolve host')
			return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		}
		return ''
	}

	const apps = createApps({dataDir: data, home: join(root, 'home'), allowFileStores: true, defaultStores: [], systemApps: null, run})
	t.after(() => apps.close())

	await apps.procedures['appStore.addRepository'].run({url: storeA.url})
	await apps.procedures['appStore.addRepository'].run({url: storeB.url})
	assert.equal(await apps.procedures['appStore.refresh'].run(), 2)

	const before = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	const syncedBefore = before.stores.map((s) => s.syncedAt)

	failAll = true
	await assert.rejects(
		apps.procedures['appStore.refresh'].run(),
		(e) => e.code === 'BAD_GATEWAY' && /Couldn’t reach .*store-a.*store-b.*Could not resolve host/.test(e.message),
	)
	const after = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8'))
	assert.deepEqual(after.stores.map((s) => s.syncedAt), syncedBefore)

	failAll = false
	failB = true
	await mkdir(join(storeA.work, 'newbie'), {recursive: true})
	await writeFile(join(storeA.work, 'newbie', 'omarchy-app.yml'), 'manifestVersion: 1\nid: newbie\nname: newbie\nversion: "1.0"\nport: 31003\n')
	await writeFile(join(storeA.work, 'newbie', 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	git(storeA.work, 'add', '-A')
	git(storeA.work, 'commit', '-qm', 'newbie')
	git(storeA.work, 'push', '-q', 'origin', 'HEAD:main')

	await assert.rejects(
		apps.procedures['appStore.refresh'].run(),
		(e) => e.code === 'BAD_GATEWAY' && /Couldn’t reach store-b: .*Could not resolve host/.test(e.message),
	)
	const reg = await apps.procedures['appStore.registry'].run()
	assert.deepEqual(reg[0].apps.map((a) => a.id).sort(), ['newbie', 'one'])
})
