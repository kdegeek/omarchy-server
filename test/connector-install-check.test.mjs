// connector/install.sh syntax check must not need or write __pycache__ directories.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {X509Certificate} from 'node:crypto'
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {ensureTls} from '../omarchyd/tls.mjs'

const SCRIPT = fileURLToPath(new URL('../connector/install.sh', import.meta.url))

async function setupEnv(t, {agentCode, helperCode, readOnlyCache = true}) {
	const root = await mkdtemp(join(os.tmpdir(), 'connector-install-check-'))
	const tmpDir = join(root, 'tmp')
	const home = join(root, 'home')
	const dataHome = join(root, 'data')
	const configHome = join(root, 'config')
	const binDir = join(root, 'bin')
	const fixtures = join(root, 'fixtures')
	const tlsDir = join(root, 'tls')
	const cachePrefix = join(root, 'pycache-prefix')
	const tmpCache = join(tmpDir, '__pycache__')
	const dataCache = join(dataHome, 'omarchy-connector', '__pycache__')

	await Promise.all([
		mkdir(tmpDir, {recursive: true}),
		mkdir(join(dataHome, 'omarchy-connector'), {recursive: true}),
		mkdir(home, {recursive: true}),
		mkdir(configHome, {recursive: true}),
		mkdir(binDir, {recursive: true}),
		mkdir(fixtures, {recursive: true}),
		mkdir(tlsDir, {recursive: true}),
		mkdir(cachePrefix, {recursive: true}),
	])
	if (readOnlyCache) {
		await Promise.all([mkdir(tmpCache, {recursive: true}), mkdir(dataCache, {recursive: true})])
	}

	await ensureTls({dir: tlsDir})
	const caPem = await readFile(join(tlsDir, 'ca.crt'), 'utf8')
	const caFp = new X509Certificate(caPem).fingerprint256.replace(/:/g, '').toLowerCase()
	await writeFile(join(fixtures, 'ca.crt'), caPem)
	await writeFile(join(fixtures, 'agent.py'), agentCode)
	await writeFile(join(fixtures, 'helper.py'), helperCode)

	const makeStub = async (name, body) => {
		const p = join(binDir, name)
		await writeFile(p, `#!/bin/sh\n${body}`)
		await chmod(p, 0o755)
	}
	await makeStub('uname', 'if [ "$1" = "-s" ]; then echo Linux; else /usr/bin/uname "$@"; fi\n')
	await makeStub('systemctl', 'exit 0\n')
	await makeStub('sudo', 'exit 0\n')
	await makeStub('loginctl', 'echo Linger=yes\n')
	for (const tool of ['smartctl', 'mkfs.ext4', 'mkfs.exfat', 'mkfs.btrfs', 'hdparm']) {
		await makeStub(tool, 'exit 0\n')
	}
	await makeStub(
		'curl',
		`url=""
out=""
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift 2 ;;
		https://*|http://*) url="$1"; shift ;;
		*) shift ;;
	esac
done
case "$url" in
	*/api/tls/ca.crt) cp "${fixtures}/ca.crt" "$out" ;;
	*/connector/agent.py) cp "${fixtures}/agent.py" "$out" ;;
	*/connector/helper.py) cp "${fixtures}/helper.py" "$out" ;;
	*) exit 1 ;;
esac
`,
	)

	if (readOnlyCache) {
		await chmod(tmpCache, 0o555)
		await chmod(dataCache, 0o555)
	}
	t.after(async () => {
		await chmod(tmpCache, 0o755).catch(() => {})
		await chmod(dataCache, 0o755).catch(() => {})
		await rm(root, {recursive: true, force: true})
	})

	const run = () =>
		spawnSync(
			'bash',
			[SCRIPT, '--server', 'https://127.0.0.1:7780', '--ca', caFp, '--token', 'testtoken', '--allow', 'storage'],
			{
				env: {
					PATH: `${binDir}:/usr/bin:/bin`,
					HOME: home,
					USER: process.env.USER || 'tester',
					TMPDIR: tmpDir,
					XDG_DATA_HOME: dataHome,
					XDG_CONFIG_HOME: configHome,
					PYTHONPYCACHEPREFIX: cachePrefix,
				},
				encoding: 'utf8',
				timeout: 20000,
			},
		)

	return {run, tmpDir, tmpCache, dataHome, dataCache, cachePrefix}
}

const VALID_AGENT = `# ’ utf-8 comment
import sys
if sys.argv[1:2] == ['enroll']:
    print('test-pc')
`
const VALID_HELPER = 'def ok():\n    return True\n'

async function collectFiles(dir) {
	const out = []
	for (const entry of await readdir(dir, {withFileTypes: true})) {
		const p = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...(await collectFiles(p)))
		else out.push(p)
	}
	return out
}

test('install succeeds with read-only __pycache__ dirs and writes no script bytecode', async (t) => {
	const {run, tmpCache, dataCache, cachePrefix} = await setupEnv(t, {agentCode: VALID_AGENT, helperCode: VALID_HELPER})
	const r = run()
	const out = `${r.stdout}${r.stderr}`
	assert.equal(r.status, 0, out)
	assert.match(out, /Done\./)
	assert.deepEqual(await readdir(tmpCache), [])
	assert.deepEqual(await readdir(dataCache), [])
	const cached = await collectFiles(cachePrefix)
	assert.deepEqual(cached.filter((p) => /agent|helper/.test(p)), [])
})

test('install writes no __pycache__ bytecode files in writable dirs', async (t) => {
	const {run, tmpDir, dataHome, cachePrefix} = await setupEnv(t, {agentCode: VALID_AGENT, helperCode: VALID_HELPER, readOnlyCache: false})
	const r = run()
	const out = `${r.stdout}${r.stderr}`
	assert.equal(r.status, 0, out)
	assert.equal((await readdir(tmpDir)).includes('__pycache__'), false)
	assert.equal((await readdir(join(dataHome, 'omarchy-connector'))).includes('__pycache__'), false)
	const cached = await collectFiles(cachePrefix)
	assert.deepEqual(cached.filter((p) => /agent|helper/.test(p)), [])
})

test('install rejects broken syntax in downloaded agent.py', async (t) => {
	const {run} = await setupEnv(t, {agentCode: 'def broken(:\n', helperCode: VALID_HELPER})
	const r = run()
	const out = `${r.stdout}${r.stderr}`
	assert.equal(r.status, 1, out)
	assert.match(out, /The downloaded connector didn't check out\./)
})

test('install rejects broken syntax in downloaded helper.py', async (t) => {
	const {run} = await setupEnv(t, {agentCode: VALID_AGENT, helperCode: 'def broken(:\n'})
	const r = run()
	const out = `${r.stdout}${r.stderr}`
	assert.equal(r.status, 1, out)
	assert.match(out, /The downloaded storage helper didn't check out\./)
})
