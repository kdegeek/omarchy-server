// Isolation env: OMARCHY_SERVER_SOURCE and OMARCHY_SERVER_APP_STORE. Unset means GitHub.
// A set value that is not an absolute git directory is an error, not a silent fallback.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join, resolve} from 'node:path'
import {after, before, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {fileUrl, localGitDir} from '../omarchyd/local-source.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

async function withEnv(vars, fn) {
	const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
	try {
		for (const [k, v] of Object.entries(vars)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
		return await fn()
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
}

let root
before(async () => (root = await mkdtemp(join(os.tmpdir(), 'omarchyd-local-'))))
after(() => rm(root, {recursive: true, force: true}))

const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'}).toString()

async function initGit(dir) {
	await mkdir(dir, {recursive: true})
	git(['init'], dir)
	git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], dir)
	return dir
}

test('unset or whitespace is GitHub (no local dir)', () => {
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', undefined), undefined)
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', null), undefined)
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', ''), undefined)
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', '   '), undefined)
	assert.equal(localGitDir('OMARCHY_SERVER_APP_STORE', '\t\n'), undefined)
})

test('an absolute git directory is accepted', async () => {
	const dir = await initGit(join(root, 'clone'))
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', dir), resolve(dir))
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', `${dir}/`), resolve(dir))
	assert.equal(localGitDir('OMARCHY_SERVER_SOURCE', `  ${dir}  `), resolve(dir))
})

test('a git worktree (.git file) is accepted', async () => {
	const dir = join(root, 'worktree')
	await mkdir(dir, {recursive: true})
	await writeFile(join(dir, '.git'), 'gitdir: /tmp/somewhere.git\n')
	assert.equal(localGitDir('OMARCHY_SERVER_APP_STORE', dir), resolve(dir))
})

test('a relative path is refused; it does not fall back to GitHub', () => {
	assert.throws(() => localGitDir('OMARCHY_SERVER_SOURCE', 'code/omarchy-server'), (e) => {
		assert.match(e.message, /OMARCHY_SERVER_SOURCE/)
		assert.match(e.message, /code\/omarchy-server/)
		assert.match(e.message, /absolute path/)
		assert.match(e.message, /Unset it to update from GitHub/)
		return true
	})
})

test('a missing path is refused; it does not fall back to GitHub', () => {
	const missing = join(root, 'no-such')
	assert.throws(() => localGitDir('OMARCHY_SERVER_SOURCE', missing), (e) => {
		assert.match(e.message, /OMARCHY_SERVER_SOURCE/)
		assert.match(e.message, /not a git repository/)
		assert.match(e.message, /Unset it to update from GitHub/)
		return true
	})
})

test('a directory without .git is refused', async () => {
	const dir = join(root, 'not-git')
	await mkdir(dir)
	assert.throws(() => localGitDir('OMARCHY_SERVER_SOURCE', dir), /not a git repository/)
})

test('a file is refused', async () => {
	const file = join(root, 'a-file')
	await writeFile(file, 'x')
	assert.throws(() => localGitDir('OMARCHY_SERVER_SOURCE', file), /not a git repository/)
})

test('OMARCHY_SERVER_APP_STORE names the GitHub app store in its error', () => {
	assert.throws(() => localGitDir('OMARCHY_SERVER_APP_STORE', '/nope'), (e) => {
		assert.match(e.message, /OMARCHY_SERVER_APP_STORE/)
		assert.match(e.message, /\/nope/)
		assert.match(e.message, /Unset it to use the GitHub app store/)
		return true
	})
})

test('startOmarchyd refuses an invalid OMARCHY_SERVER_SOURCE instead of updating from GitHub', async () => {
	const dataDir = join(root, 'bad-source-data')
	await mkdir(dataDir, {recursive: true})
	await withEnv({OMARCHY_SERVER_SOURCE: join(root, 'missing-source')}, async () => {
		await assert.rejects(
			() => startOmarchyd({port: 0, dataDir, home: root, updaterOptions: {autoCheck: false}, appOptions: {systemApps: null, run: async () => ''}, machineOptions: {run: async () => ''}}),
			/OMARCHY_SERVER_SOURCE is set to .* but that path is not a git repository/,
		)
	})
})

test('startOmarchyd refuses an invalid OMARCHY_SERVER_APP_STORE instead of using GitHub', async () => {
	const dataDir = join(root, 'bad-store-data')
	await mkdir(dataDir, {recursive: true})
	await withEnv({OMARCHY_SERVER_APP_STORE: join(root, 'missing-store')}, async () => {
		await assert.rejects(
			() => startOmarchyd({port: 0, dataDir, home: root, updaterOptions: {autoCheck: false}, appOptions: {systemApps: null, run: async () => ''}, machineOptions: {run: async () => ''}}),
			/OMARCHY_SERVER_APP_STORE is set to .* but that path is not a git repository/,
		)
	})
})

test('OMARCHY_SERVER_SOURCE makes software update read that clone, not GitHub', async () => {
	const src = await initGit(join(root, 'update-src'))
	const changelog = await (await import('node:fs/promises')).readFile(new URL('../web/src/changelog.ts', import.meta.url), 'utf8')
	await mkdir(join(src, 'web/src'), {recursive: true})
	await writeFile(join(src, 'package.json'), JSON.stringify({version: '99.0.0'}))
	await writeFile(join(src, 'web/src/changelog.ts'), changelog)
	const dataDir = join(root, 'update-data')
	await mkdir(dataDir, {recursive: true})
	const accounts = await openAccounts(dataDir)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	let fetched = 0
	const d = await withEnv({OMARCHY_SERVER_SOURCE: src}, () =>
		startOmarchyd({
			port: 0,
			dataDir,
			home: root,
			updaterOptions: {
				autoCheck: false,
				fetchImpl: async () => {
					fetched++
					return new Response('', {status: 503})
				},
				run: async (cmd, args) => (cmd === 'git' && args.includes('rev-parse') ? (args.includes(src) ? 'srcsha\n' : 'appsha\n') : ''),
				helperPath: join(root, 'no-helper'),
			},
			appOptions: {systemApps: null, run: async () => '', defaultStores: []},
			machineOptions: {run: async () => ''},
		}),
	)
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		const r = await fetch(`${d.url}/trpc/system.checkUpdate`, {headers: {authorization: `Bearer ${login.result.data.accessToken}`}})
		const body = await r.json()
		assert.equal(fetched, 0, 'must not call GitHub')
		assert.equal(body.result.data.available, true)
		assert.equal(body.result.data.version, '99.0.0')
	} finally {
		await d.close()
	}
})

test('OMARCHY_SERVER_APP_STORE is the default catalog and machines catalog', async () => {
	const store = await initGit(join(root, 'app-store'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	await mkdir(join(store, 'machines'), {recursive: true})
	await writeFile(
		join(store, 'machines', 'catalog.json'),
		JSON.stringify({
			version: 1,
			images: [{id: 'local-os', familyId: 'debian', name: 'LocalOS', version: '1', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const dataDir = join(root, 'store-data')
	await mkdir(dataDir, {recursive: true})
	const accounts = await openAccounts(dataDir)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	let fetched = 0
	const d = await withEnv({OMARCHY_SERVER_APP_STORE: store}, () =>
		startOmarchyd({
			port: 0,
			dataDir,
			home: root,
			updaterOptions: {autoCheck: false},
			appOptions: {systemApps: null, run: async () => ''},
			machineOptions: {
				run: async () => '',
				fetchImpl: async () => {
					fetched++
					return new Response('', {status: 503})
				},
			},
		}),
	)
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		const auth = {authorization: `Bearer ${login.result.data.accessToken}`}
		const repos = await (await fetch(`${d.url}/trpc/appStore.repositories`, {headers: auth})).json()
		assert.equal(repos.result.data[0].url, `file://${resolve(store)}`)
		const images = await (await fetch(`${d.url}/trpc/machines.osImages`, {headers: auth})).json()
		assert.equal(fetched, 0, 'must not call GitHub for the machines catalog')
		assert.equal(images.result.data[0].id, 'local-os')
	} finally {
		await d.close()
	}
})

test('fileUrl percent-encodes #, ?, %, and spaces for URLs and git', async () => {
	for (const p of ['/srv/my#store/machines/catalog.json', '/srv/what?/machines/catalog.json', '/srv/100%/machines/catalog.json', '/srv/a%20b/dir with spaces']) {
		assert.equal(fileURLToPath(fileUrl(p)), resolve(p))
	}
	const encodedName = await initGit(join(root, 'a%20b'))
	assert.match(git(['ls-remote', fileUrl(encodedName), 'HEAD'], root), /HEAD/)

	const store = await initGit(join(root, 'my#store?100%'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	await mkdir(join(store, 'machines'), {recursive: true})
	await writeFile(
		join(store, 'machines', 'catalog.json'),
		JSON.stringify({
			version: 1,
			images: [{id: 'special-os', familyId: 'debian', name: 'SpecialOS', version: '1', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const dataDir = join(root, 'special-store-data')
	await mkdir(dataDir, {recursive: true})
	const accounts = await openAccounts(dataDir)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await withEnv({OMARCHY_SERVER_APP_STORE: store}, () =>
		startOmarchyd({
			port: 0,
			dataDir,
			home: root,
			updaterOptions: {autoCheck: false},
			appOptions: {systemApps: null, run: async () => ''},
			machineOptions: {
				run: async () => '',
				fetchImpl: async () => new Response('', {status: 503}),
			},
		}),
	)
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		const auth = {authorization: `Bearer ${login.result.data.accessToken}`}
		const images = await (await fetch(`${d.url}/trpc/machines.osImages`, {headers: auth})).json()
		assert.equal(images.result.data[0].id, 'special-os')
	} finally {
		await d.close()
	}
})
