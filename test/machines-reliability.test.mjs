// Reliability fixes for omarchyd machines and machine settings UI.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, statfs, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

async function makeEnv(t, {machines = [], run, kvm = false, files = null} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-rel-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'a'.repeat(64), sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const kvmDevice = join(root, 'kvm')
	if (kvm) await writeFile(kvmDevice, '')
	await mkdir(join(dataDir, 'machines', 'vms'), {recursive: true})
	if (machines.length) {
		await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines}, null, 2))
	}
	const open = (overrides = {}) =>
		createMachines({
			dataDir,
			catalogUrl: `file://${catalog}`,
			fetchImpl: async () => {
				throw new Error('no network in test')
			},
			run: overrides.run ?? run ?? (async () => ''),
			kvmDevice,
			files: overrides.files ?? files,
			statsIntervalMs: 60_000,
			watchIdleMs: 1,
		})
	return {root, dataDir, kvmDevice, open}
}

function makeMachineRecord(dataDir, overrides = {}) {
	const id = overrides.id ?? 'a1b2c3d4'
	const dir = join(dataDir, 'machines', 'vms', id)
	return {
		id,
		vmid: 100,
		name: 'Box',
		osId: 'testos-amd64',
		sockets: 1,
		cores: 2,
		cpuType: 'host',
		memoryMb: 1024,
		memoryGb: 1,
		diskSizeGb: 20,
		mac: '52:54:00:11:22:33',
		portForwards: [],
		createdAt: 1760000000000,
		boot: ['disk0'],
		options: {},
		cloudInit: {username: 'chris', hostname: 'box', sshKeys: []},
		layout: {
			firmware: 'bios',
			machineType: 'q35',
			nic: 'virtio',
			video: 'vga',
			disks: [
				{id: 'disk0', file: join(dir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 20},
				{id: 'seed', role: 'seed', file: join(dir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'},
			],
		},
		...overrides,
	}
}

test('#201: port forwarding tracks ports across all machines and resets form only on success', async () => {
	const {PORT_MAX, PORT_MIN, nextFreePort, takenPorts} = await import('../web/src/machines/portForwardingState.ts')
	assert.equal(PORT_MIN, 40_000)
	assert.equal(PORT_MAX, 49_999)

	const machineA = {id: 'aaaa1111', portForwards: [{id: 'f1', protocol: 'tcp', hostPort: 42222, guestPort: 22}]}
	const machineB = {id: 'bbbb2222', portForwards: [{id: 'f2', protocol: 'tcp', hostPort: 49999, guestPort: 80}]}

	const taken = takenPorts([machineA, machineB], machineB)
	assert.equal(taken.has('tcp:42222'), true)
	assert.equal(taken.has('tcp:49999'), true)
	assert.equal(nextFreePort(42222, taken, 'tcp'), 42223)
	assert.equal(nextFreePort(49999, taken, 'tcp'), PORT_MIN)

	const src = await readFile(new URL('../web/src/machines/PortForwarding.tsx', import.meta.url), 'utf8')
	assert.match(src, /useMachines\(/)
	assert.match(src, /takenPorts\(/)
	const addBlock = src.match(/const add = \([\s\S]*?\n\t\}/)?.[0] ?? ''
	assert.match(addBlock, /onSuccess|\(\) => \{[\s\S]*setAdding\(false\)/, 'add() must close form only in onSuccess')
})

test('#208: flipping an Options switch leaves open Name and Start order editors intact', async () => {
	const src = await readFile(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')
	const block = src.match(/export function OptionsPanel[\s\S]*?\n\}\nconst bootName/)?.[0] ?? ''
	assert.ok(block.length > 0, 'OptionsPanel found')
	const flagBlock = block.match(/const flag = [\s\S]*?\n\t\)/)?.[0] ?? ''
	assert.ok(flagBlock.length > 0, 'flag helper found')
	assert.equal(/\bset\(/.test(flagBlock), false, 'flag must not call row-closing set()')
	assert.equal(/setOpen\(/.test(flagBlock), false, 'flag must not call setOpen')
	assert.match(flagBlock, /action\.mutate\(/)
	assert.match(block, /if \(open === 'name'\)\s*setName\(d\.name\)/)
	assert.match(block, /if \(open === 'order'\)/)
	assert.match(block, /set\([^\n]*'Renamed'/)
	assert.match(block, /set\([^\n]*'Start order saved'/)
})

test('#315: deleteSnapshot propagates qemu-img failures and only ignores missing snapshot errors', async (t) => {
	const id = 'a1b2c3d4'
	let disk1Fail = true
	let disk0Missing = false
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh' && args.includes('list')) return ' Id   Name   State\n------------------\n'
			if (cmd === 'qemu-img' && args[0] === 'snapshot' && args[1] === '-d') {
				const file = args[3]
				if (file.endsWith('disk.qcow2') && disk0Missing) {
					throw new Error("qemu-img snapshot: Could not delete snapshot 'two': (Can't find the snapshot)")
				}
				if (file.endsWith('disk1.qcow2') && disk1Fail) {
					throw new Error('qemu-img snapshot: Could not open disk1.qcow2: Permission denied')
				}
				return ''
			}
			return ''
		},
	})
	const dir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(dir, {recursive: true})
	await writeFile(join(dir, 'disk.qcow2'), 'd0')
	await writeFile(join(dir, 'disk1.qcow2'), 'd1')
	const rec = makeMachineRecord(env.dataDir, {
		id,
		snapshots: [{name: 'two', description: '', createdAt: 1, config: {sockets: 1, cores: 2, memoryMb: 1024, cpuType: 'host', layout: {firmware: 'bios', machineType: 'q35', video: 'vga', nic: 'virtio'}, disks: ['disk0', 'disk1']}}],
	})
	rec.layout.disks.push({id: 'disk1', file: join(dir, 'disk1.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open()
	await m.ready

	await assert.rejects(() => m.procedures['machines.deleteSnapshot'].run({id, name: 'two'}), /Permission denied/)
	const afterFail = await m.procedures['machines.details'].run({id})
	assert.equal(afterFail.snapshots.length, 1)
	assert.equal(afterFail.snapshots[0].name, 'two')
	assert.equal(afterFail.tasks[0].type, 'delete-snapshot')
	assert.equal(afterFail.tasks[0].status, 'error')

	disk0Missing = true
	disk1Fail = false
	assert.equal(await m.procedures['machines.deleteSnapshot'].run({id, name: 'two'}), true)
	const afterRetry = await m.procedures['machines.details'].run({id})
	assert.deepEqual(afterRetry.snapshots, [])
	assert.equal(afterRetry.tasks[0].type, 'delete-snapshot')
	assert.equal(afterRetry.tasks[0].status, 'ok')
})

test('#317: Omarchy installer machines do not expose Cloud-Init and updateCloudInit refuses them', async (t) => {
	const omId = '11112222'
	const cloudId = '33334444'
	const xorrisoCalls = []
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh' && args.includes('list')) return ' Id   Name   State\n------------------\n'
			if (cmd === 'xorriso') {
				xorrisoCalls.push(args)
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
			}
			return ''
		},
	})
	const omDir = join(env.dataDir, 'machines', 'vms', omId)
	const cloudDir = join(env.dataDir, 'machines', 'vms', cloudId)
	await mkdir(omDir, {recursive: true})
	await mkdir(cloudDir, {recursive: true})
	await writeFile(join(omDir, 'disk.qcow2'), 'om-disk')
	await writeFile(join(cloudDir, 'disk.qcow2'), 'cl-disk')

	const legacyCloudId = '55556666'
	const legacyDir = join(env.dataDir, 'machines', 'vms', legacyCloudId)
	await mkdir(legacyDir, {recursive: true})
	await writeFile(join(legacyDir, 'disk.qcow2'), 'lg-disk')
	const legacyCloudRec = makeMachineRecord(env.dataDir, {
		id: legacyCloudId,
		vmid: 102,
		name: 'LegacyUbuntu',
		osId: 'ubuntu-24.04-amd64',
		layout: {
			firmware: 'efi',
			machineType: 'q35',
			nic: 'virtio',
			video: 'vga',
			disks: [
				{id: 'disk0', file: join(legacyDir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 40},
				{id: 'seed', role: 'seed', file: join(legacyDir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'},
			],
		},
	})
	delete legacyCloudRec.cloudInit
	const omRec = makeMachineRecord(env.dataDir, {
		id: omId,
		vmid: 100,
		name: 'OmarchyVM',
		osId: 'omarchy-4.0.4-amd64',
		cloudInit: undefined,
		boot: ['disk0', 'cd0'],
		layout: {
			firmware: 'efi',
			machineType: 'q35',
			nic: 'virtio',
			video: 'vga',
			disks: [
				{id: 'disk0', file: join(omDir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 40},
				{id: 'cd0', file: join(env.dataDir, 'machines/images/omarchy-4.0.4-amd64.iso'), device: 'cdrom', bus: 'sata', format: 'raw'},
				{id: 'seed', role: 'seed', file: join(omDir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'},
			],
		},
	})
	delete omRec.cloudInit
	const cloudRec = makeMachineRecord(env.dataDir, {id: cloudId, vmid: 101, name: 'CloudVM'})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [omRec, cloudRec, legacyCloudRec]}))

	const m = env.open()
	await m.ready

	const omDetails = await m.procedures['machines.details'].run({id: omId})
	assert.equal(omDetails.cloudInit, null)
	assert.equal(omDetails.hardware.disks.find((d) => d.id === 'seed').role, 'installer')

	await assert.rejects(
		() => m.procedures['machines.updateCloudInit'].run({id: omId, username: 'chris'}),
		(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && /doesn’t use cloud-init/.test(err.message),
	)
	assert.equal(xorrisoCalls.length, 0, 'xorriso must not overwrite Omarchy installer seed.iso')

	const cloudDetails = await m.procedures['machines.details'].run({id: cloudId})
	assert.equal(cloudDetails.cloudInit.username, 'chris')
	assert.equal(await m.procedures['machines.updateCloudInit'].run({id: cloudId, username: 'alex'}), true)
	assert.equal(xorrisoCalls.length, 1)

	const legacyDetails = await m.procedures['machines.details'].run({id: legacyCloudId})
	assert.ok(legacyDetails.cloudInit, 'pre-0.9.0 cloud-init VM without cloudInit field should keep cloud-init')
	assert.equal(legacyDetails.hardware.disks.find((d) => d.id === 'seed').role, 'seed')

	const apiSrc = await readFile(new URL('../web/src/machines/api.ts', import.meta.url), 'utf8')
	assert.match(apiSrc, /role:\s*'seed'\s*\|\s*'answer'\s*\|\s*'installer'\s*\|\s*null/)
	assert.match(apiSrc, /driveName[\s\S]*'installer'[\s\S]*'Installer configuration'/)
	const panelsSrc = await readFile(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')
	assert.match(panelsSrc, /drive\.role === 'installer'/)
})

test('#659: tasks left running when omarchyd restarted are marked error on startup', async (t) => {
	const id = 'a1b2c3d4'
	const env = await makeEnv(t, {
		run: async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? ' Id   Name   State\n------------------\n' : ''),
	})
	const rec = makeMachineRecord(env.dataDir, {
		id,
		tasks: [
			{id: 't2', type: 'backup', detail: '100-box-20261120-000000', status: 'running', startedAt: 1760000002000},
			{id: 't1', type: 'start', status: 'ok', startedAt: 1760000000000, endedAt: 1760000001000},
		],
	})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open()
	await m.ready

	const tasks = await m.procedures['machines.tasks'].run()
	const det = await m.procedures['machines.details'].run({id})
	for (const list of [tasks, det.tasks]) {
		const backupTask = list.find((x) => x.id === 't2')
		assert.equal(backupTask.status, 'error')
		assert.equal(typeof backupTask.endedAt, 'number')
		assert.equal(backupTask.message, 'Interrupted by a restart')
		const okTask = list.find((x) => x.id === 't1')
		assert.equal(okTask.status, 'ok')
		assert.equal(okTask.endedAt, 1760000001000)
	}
	const saved = JSON.parse(await readFile(join(env.dataDir, 'machines', 'machines.json'), 'utf8'))
	assert.equal(saved.machines[0].tasks.find((x) => x.id === 't2').status, 'error')
})

test('#663: Start and pending Restart redefine the domain so missing definitions and KVM changes take effect', async (t) => {
	const id = 'a1b2c3d4'
	const errId = 'e1e2e3e4'
	const doms = new Map()
	const definedXml = []
	const definedFor = []
	const env = await makeEnv(t, {
		kvm: false,
		run: async (cmd, args) => {
			if (cmd !== 'virsh') return ''
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'list') {
				return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
			}
			if (a[0] === 'define') {
				const xmlText = await readFile(a[1], 'utf8')
				definedXml.push(xmlText)
				const name = /<name>(.+?)<\/name>/.exec(xmlText)[1]
				definedFor.push(name)
				if (!doms.has(name)) doms.set(name, 'shut off')
				return ''
			}
			if (a[0] === 'start') {
				if (!doms.has(a[1])) throw new Error(`virsh start: error: failed to get domain '${a[1]}'`)
				doms.set(a[1], 'running')
				return ''
			}
			if (a[0] === 'shutdown' || a[0] === 'destroy') {
				doms.set(a[1], 'shut off')
				return ''
			}
			return ''
		},
	})
	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	const errDir = join(env.dataDir, 'machines', 'vms', errId)
	await mkdir(vmDir, {recursive: true})
	await mkdir(errDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	await writeFile(join(errDir, 'disk.qcow2'), 'd1')
	const rec = makeMachineRecord(env.dataDir, {id, vmid: 100, name: 'Box'})
	const errRec = makeMachineRecord(env.dataDir, {id: errId, vmid: 101, name: 'Recover', state: 'error', errorMessage: 'define failed'})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec, errRec]}))

	const m = env.open()
	await m.ready

	// 1. Missing domain in libvirt is defined on Start before virsh start.
	assert.equal(await m.procedures['machines.start'].run({id}), true)
	assert.equal(doms.get(`omarchy-${id}`), 'running')
	assert.match(definedXml.at(-1), /<domain type='qemu'>/)

	// 2. Stale KVM setting updates to kvm on next Start once /dev/kvm becomes available.
	await m.procedures['machines.forceStop'].run({id})
	await m.procedures['machines.updateOptions'].run({id, notes: 'while no kvm'})
	assert.match(definedXml.at(-1), /<domain type='qemu'>/)
	await writeFile(env.kvmDevice, '')
	await m.procedures['machines.start'].run({id})
	assert.match(definedXml.at(-1), /<domain type='kvm'>/)

	// 3. Pending Restart also redefines before virsh start.
	await m.procedures['machines.updateOptions'].run({id, agent: true})
	const beforeRestart = definedXml.length
	await m.procedures['machines.restart'].run({id})
	assert.equal(definedXml.length, beforeRestart + 1)
	assert.match(definedXml.at(-1), /<domain type='kvm'>/)

	// 4. Error machine with own disk defines exactly once on Start.
	const errBefore = definedFor.filter((n) => n === `omarchy-${errId}`).length
	await m.procedures['machines.start'].run({id: errId})
	assert.equal(definedFor.filter((n) => n === `omarchy-${errId}`).length, errBefore + 1)
})





test('#200: port forwards added while running are marked pending until restart and UI warns instead of opening immediately', async (t) => {
	const id = 'a1b2c3d4'
	const doms = new Map()
	let ignoreShutdown = false
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd !== 'virsh') return ''
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'list') {
				return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
			}
			if (a[0] === 'define') {
				const xmlText = await readFile(a[1], 'utf8')
				const name = /<name>(.+?)<\/name>/.exec(xmlText)[1]
				if (!doms.has(name)) doms.set(name, 'shut off')
				return ''
			}
			if (a[0] === 'start') {
				doms.set(a[1], 'running')
				return ''
			}
			if (a[0] === 'shutdown') {
				if (!ignoreShutdown) doms.set(a[1], 'shut off')
				return ''
			}
			if (a[0] === 'destroy') {
				doms.set(a[1], 'shut off')
				return ''
			}
			return ''
		},
	})
	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	const rec = makeMachineRecord(env.dataDir, {
		id,
		portForwards: [{id: 'f1', protocol: 'tcp', hostPort: 42222, guestPort: 22}],
	})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const untilRunning = async () => {
		const end = Date.now() + 5000
		for (;;) {
			const x = (await m.procedures['machines.list'].run()).find((v) => v.id === id)
			if (x?.state === 'running') return x
			if (Date.now() > end) throw new Error(`did not reach running (got ${x?.state})`)
			await new Promise((r) => setTimeout(r, 50))
		}
	}

	const m = env.open()
	await m.ready
	await m.procedures['machines.start'].run({id})
	await untilRunning()

	await m.procedures['machines.updateSettings'].run({
		id,
		portForwards: [
			{id: 'f1', protocol: 'tcp', hostPort: 42222, guestPort: 22},
			{id: 'f2', protocol: 'tcp', hostPort: 48080, guestPort: 80},
		],
	})

	const listed = (await m.procedures['machines.list'].run()).find((x) => x.id === id)
	const det = await m.procedures['machines.details'].run({id})
	for (const view of [listed, det]) {
		assert.equal(view.pending, true)
		assert.equal(view.portForwards.find((f) => f.id === 'f1').pending, undefined)
		assert.equal(view.portForwards.find((f) => f.id === 'f2').pending, true)
	}

	ignoreShutdown = true
	await m.procedures['machines.stop'].run({id})
	const stillRunning = await untilRunning()
	assert.equal(stillRunning.state, 'running')
	assert.equal(stillRunning.portForwards.find((f) => f.id === 'f2').pending, true)
	ignoreShutdown = false
	await m.procedures['machines.forceStop'].run({id})
	await m.procedures['machines.start'].run({id})
	await untilRunning()
	await m.procedures['machines.updateSettings'].run({
		id,
		portForwards: [
			{id: 'f1', protocol: 'tcp', hostPort: 42222, guestPort: 22},
			{id: 'f2', protocol: 'tcp', hostPort: 48080, guestPort: 80},
		],
	})
	await m.procedures['machines.restart'].run({id})
	const afterRestart = await untilRunning()
	assert.equal(afterRestart.pending, undefined)
	assert.equal(afterRestart.portForwards.find((f) => f.id === 'f2').pending, undefined)

	const {forwardAddMessage, forwardRemoveMessage} = await import('../web/src/machines/portForwardingState.ts')
	assert.match(forwardAddMessage('Box', 'my.host', 48080, true), /applies the next time Box starts/)
	assert.match(forwardAddMessage('Box', 'my.host', 48080, false), /when it starts/)
	assert.match(forwardRemoveMessage('Box', 48080, true), /applies the next time Box starts/)
	assert.equal(forwardRemoveMessage('Box', 48080, false), 'Removed port 48080')

	const pfSrc = await readFile(new URL('../web/src/machines/PortForwarding.tsx', import.meta.url), 'utf8')
	assert.match(pfSrc, /<PendingBanner d=\{m\} \/>/)
	assert.match(pfSrc, /f\.pending/)
	assert.match(pfSrc, /After restart/)
})

test('#306: control characters in notes or name never break later settings changes and failed defines roll back', async (t) => {
	const id = 'a1b2c3d4'
	let failNextDefine = false
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd !== 'virsh') return ''
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
			if (a[0] === 'define') {
				if (failNextDefine) {
					failNextDefine = false
					throw new Error('virsh define: simulated failure')
				}
				const xmlText = await readFile(a[1], 'utf8')
				// XML 1.0 forbids control characters except tab, LF, CR.
				if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xmlText)) {
					throw new Error('virsh define: XML error: not well-formed (invalid token)')
				}
				return ''
			}
			return ''
		},
	})
	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [makeMachineRecord(env.dataDir, {id})]}))

	const m = env.open()
	await m.ready

	// 1. ANSI ESC control characters in notes are stripped so XML stays valid and later edits work.
	assert.equal(await m.procedures['machines.updateOptions'].run({id, notes: 'log \x1b[31mred\x1b[0m'}), true)
	const afterNotes = await m.procedures['machines.details'].run({id})
	assert.equal(afterNotes.options.notes, 'log [31mred[0m')
	assert.equal(await m.procedures['machines.updateOptions'].run({id, onBoot: true}), true)
	assert.ok((await m.procedures['machines.addDisk'].run({id, sizeGb: 2})).diskId)

	// 2. Control characters in name are rejected cleanly without corrupting the stored name.
	await assert.rejects(
		() => m.procedures['machines.updateOptions'].run({id, name: 'bad\x1bname'}),
		(err) => err instanceof RpcError && err.code === 'BAD_REQUEST',
	)
	assert.equal((await m.procedures['machines.details'].run({id})).name, 'Box')
	assert.equal(await m.procedures['machines.updateOptions'].run({id, notes: 'clean'}), true)

	// 3. Exported NAME_CONTROL_CHARS helper detects control chars in machine names.
	const {NAME_CONTROL_CHARS} = await import('../omarchyd/machines.mjs')
	assert.equal(NAME_CONTROL_CHARS.test('bad\x00name'), true)
	assert.equal(NAME_CONTROL_CHARS.test('Good Name-1'), false)

	// 4. Failed define rolls back in-memory and saved state for updateOptions and updateHardware.
	failNextDefine = true
	await assert.rejects(() => m.procedures['machines.updateOptions'].run({id, name: 'WillFail'}), /simulated failure/)
	assert.equal((await m.procedures['machines.details'].run({id})).name, 'Box')

	failNextDefine = true
	await assert.rejects(() => m.procedures['machines.updateHardware'].run({id, memoryMb: 2048}), /simulated failure/)
	assert.equal((await m.procedures['machines.details'].run({id})).hardware.memoryMb, 1024)
	const saved = JSON.parse(await readFile(join(env.dataDir, 'machines', 'machines.json'), 'utf8'))
	assert.equal(saved.machines[0].name, 'Box')
	assert.equal(saved.machines[0].memoryMb, 1024)
})

test('#312: hardware, options, and drive changes are rejected while a backup is running', async (t) => {
	const id = 'a1b2c3d4'
	let releaseConvert = null
	let convertStarted = null
	const convertWait = new Promise((r) => (convertStarted = r))
	const convertDone = new Promise((r) => (releaseConvert = r))
	t.after(() => releaseConvert?.())

	const definedXml = []
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
				if (a[0] === 'define') {
					definedXml.push(await readFile(a[1], 'utf8'))
					return ''
				}
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				convertStarted()
				await convertDone
				await writeFile(args.at(-1), 'backup-copy')
				return ''
			}
			return ''
		},
	})
	const homeDir = join(env.root, 'home')
	await mkdir(homeDir, {recursive: true})
	await writeFile(join(homeDir, 'boot.iso'), 'iso')
	const files = {resolve: async (p) => ({real: p === '/Home' ? homeDir : join(homeDir, p.replace(/^\/Home\/?/, ''))})}

	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	const rec = makeMachineRecord(env.dataDir, {id})
	rec.layout.disks.push({id: 'cd0', file: '', device: 'cdrom', bus: 'sata', format: 'raw'})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open({files})
	await m.ready

	await m.procedures['machines.backup'].run({id})
	await convertWait

	const busyCalls = [
		() => m.procedures['machines.updateHardware'].run({id, memoryMb: 2048}),
		() => m.procedures['machines.addDisk'].run({id, sizeGb: 5}),
		() => m.procedures['machines.updateOptions'].run({id, notes: 'during backup'}),
		() => m.procedures['machines.updateSettings'].run({id, portForwards: [{protocol: 'tcp', hostPort: 42222, guestPort: 22}]}),
		() => m.procedures['machines.setBootOrder'].run({id, order: ['disk0', 'net']}),
		() => m.procedures['machines.updateDisk'].run({id, diskId: 'disk0', cache: 'writeback'}),
		() => m.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 25}),
		() => m.procedures['machines.setMedia'].run({id, diskId: 'cd0', iso: 'local:/Home/boot.iso'}),
	]
	for (const fn of busyCalls) {
		await assert.rejects(fn, (err) => err instanceof RpcError && err.code === 'CONFLICT' && /is busy/.test(err.message))
	}
	assert.equal(definedXml.length, 0)
	const detWhileBusy = await m.procedures['machines.details'].run({id})
	assert.equal(detWhileBusy.hardware.memoryMb, 1024)
	assert.equal(detWhileBusy.hardware.disks.length, 3)

	releaseConvert()
	const end = Date.now() + 5000
	while ((await m.procedures['machines.backups'].run({id})).length === 0) {
		if (Date.now() > end) throw new Error('backup did not finish')
		await new Promise((r) => setTimeout(r, 20))
	}

	assert.equal(await m.procedures['machines.updateHardware'].run({id, memoryMb: 2048}), true)
	assert.equal(definedXml.length, 1)
	assert.match(definedXml[0], /<memory unit='MiB'>2048<\/memory>/)
})

test('#314: ejecting CD/DVD media from a running machine reports QEMU errors and preserves media', async (t) => {
	const id = 'a1b2c3d4'
	let failEject = true
	let lastXml = ''
	const doms = new Map([[`omarchy-${id}`, 'running']])
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd !== 'virsh') return ''
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === 'list') {
				return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
			}
			if (a[0] === 'define') {
				lastXml = await readFile(a[1], 'utf8')
				return ''
			}
			if (a[0] === 'change-media' && a.includes('--eject') && failEject) {
				throw new Error("virsh change-media: error: internal error: unable to execute QEMU command 'eject': Device 'sata0-0-0' is locked and force was not specified")
			}
			return ''
		},
	})
	const homeDir = join(env.root, 'home')
	await mkdir(homeDir, {recursive: true})
	const isoPath = join(homeDir, 'boot.iso')
	await writeFile(isoPath, 'iso')
	const files = {resolve: async (p) => ({real: p === '/Home' ? homeDir : join(homeDir, p.replace(/^\/Home\/?/, ''))})}

	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	const rec = makeMachineRecord(env.dataDir, {id})
	rec.layout.disks.push({id: 'cd0', file: isoPath, device: 'cdrom', bus: 'sata', format: 'raw'})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open({files})
	await m.ready

	await assert.rejects(() => m.procedures['machines.setMedia'].run({id, diskId: 'cd0', iso: null}), /locked/)
	const afterFail = await m.procedures['machines.details'].run({id})
	assert.equal(afterFail.hardware.disks.find((d) => d.id === 'cd0').media, 'Home/boot.iso')
	assert.equal(afterFail.tasks[0].type, 'eject-media')
	assert.equal(afterFail.tasks[0].status, 'error')

	failEject = false
	assert.equal(await m.procedures['machines.setMedia'].run({id, diskId: 'cd0', iso: null}), true)
	const afterOk = await m.procedures['machines.details'].run({id})
	assert.equal(afterOk.hardware.disks.find((d) => d.id === 'cd0').media, null)
	assert.equal(lastXml.includes('boot.iso'), false)
})

test('#605: live backup requires space for two copies and cleans up each live copy after conversion', async (t) => {
	const id = 'a1b2c3d4'
	const doms = new Map([[`omarchy-${id}`, 'running']])
	let disk0GoneDuringDisk1Convert = false
	let usedBytes = 0
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'list') {
					return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
				}
				if (a[0] === 'backup-begin') {
					const bx = await readFile(a[3], 'utf8')
					for (const [, f] of bx.matchAll(/<target file='([^']+)'/g)) await writeFile(f, 'live-copy')
					return ''
				}
				if (a[0] === 'domjobinfo') return a.includes('--completed') ? 'Job type: Completed\n' : 'Job type: None\n'
				if (a[0] === 'destroy') {
					doms.set(a[1], 'shut off')
					return ''
				}
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') {
				return JSON.stringify({'virtual-size': usedBytes, 'actual-size': usedBytes})
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				const src = args.at(-2)
				const dst = args.at(-1)
				if (src.endsWith('disk1.qcow2') && src.includes('.live')) {
					disk0GoneDuringDisk1Convert = !(await stat(src.replace('disk1.qcow2', 'disk0.qcow2')).then(() => true, () => false))
				}
				await writeFile(dst, 'compressed')
				return ''
			}
			return ''
		},
	})
	const homeDir = join(env.root, 'home')
	await mkdir(homeDir, {recursive: true})
	const files = {resolve: async (p) => ({real: p === '/Home' ? homeDir : join(homeDir, p.replace(/^\/Home\/?/, ''))})}

	const fs = await statfs(homeDir)
	const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3
	const needGb = Math.max(1, Math.round(freeGb * 0.65 * 10) / 10)
	usedBytes = Math.round(needGb * 1024 ** 3)

	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	await writeFile(join(vmDir, 'disk1.qcow2'), 'd1')
	const rec = makeMachineRecord(env.dataDir, {id})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open({files})
	await m.ready

	// Running machine has ~65% of freeGb used: 1x fits, 2x does not.
	await assert.rejects(
		() => m.procedures['machines.backup'].run({id}),
		(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && err.message.includes(`about ${Math.ceil(needGb * 2)} GB`),
	)

	// Stopped machine with the same disk size only needs 1x and succeeds.
	await m.procedures['machines.forceStop'].run({id})
	const {backupId: stoppedBackup} = await m.procedures['machines.backup'].run({id})
	const end = Date.now() + 5000
	while (!(await m.procedures['machines.backups'].run({id})).some((b) => b.id === stoppedBackup)) {
		if (Date.now() > end) throw new Error('stopped backup did not finish')
		await new Promise((r) => setTimeout(r, 20))
	}

	// Verify per-disk live cleanup for a small 2-disk running backup.
	usedBytes = Math.round(0.1 * 1024 ** 3)
	rec.layout.disks.push({id: 'disk1', file: join(vmDir, 'disk1.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))
	const m2 = env.open({files})
	await m2.ready
	await m2.procedures['machines.start'].run({id})
	doms.set(`omarchy-${id}`, 'running')
	const {backupId: liveBackup} = await m2.procedures['machines.backup'].run({id})
	const end2 = Date.now() + 5000
	while (!(await m2.procedures['machines.backups'].run({id})).some((b) => b.id === liveBackup)) {
		if (Date.now() > end2) throw new Error('live backup did not finish')
		await new Promise((r) => setTimeout(r, 20))
	}
	assert.equal(disk0GoneDuringDisk1Convert, true)
})

test('#648: pre-0.4.0 machines without layout get backfilled at startup and all hardware/drive actions work', async (t) => {
	const id = 'a1b2c3d4'
	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'create') {
				await writeFile(args[3], 'blank')
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await writeFile(args.at(-1), 'converted')
			}
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
			}
			return ''
		},
	})
	const homeDir = join(env.root, 'home')
	await mkdir(homeDir, {recursive: true})
	await writeFile(join(homeDir, 'boot.iso'), 'iso')
	const files = {resolve: async (p) => ({real: p === '/Home' ? homeDir : join(homeDir, p.replace(/^\/Home\/?/, ''))})}

	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'old-disk')
	await writeFile(
		join(env.dataDir, 'machines', 'machines.json'),
		JSON.stringify({machines: [{id, name: 'old-debian', osId: 'debian-12', cores: 2, memoryGb: 2, diskSizeGb: 20, portForwards: [], createdAt: 1760000000000}]}),
	)

	const m = env.open({files})
	await m.ready

	const det = await m.procedures['machines.details'].run({id})
	assert.deepEqual(
		det.hardware.disks.map((d) => [d.id, d.role, d.target]),
		[
			['disk0', null, 'vda'],
			['seed', 'seed', 'sda'],
		],
	)
	assert.equal(det.hardware.disks[0].sizeGb, 20)
	assert.deepEqual(det.boot, ['disk0'])
	assert.equal(det.cloudInit.hostname, 'old-debian')

	assert.equal(await m.procedures['machines.updateHardware'].run({id, memoryMb: 2048}), true)
	const {diskId: d1} = await m.procedures['machines.addDisk'].run({id, sizeGb: 5})
	const {diskId: cd0} = await m.procedures['machines.addCdrom'].run({id})
	assert.equal(await m.procedures['machines.setBootOrder'].run({id, order: [cd0, 'disk0']}), true)
	assert.equal(await m.procedures['machines.snapshot'].run({id, name: 'snap1'}), true)
	assert.equal(await m.procedures['machines.updateDisk'].run({id, diskId: d1, cache: 'writeback'}), true)
	assert.equal(await m.procedures['machines.resizeDisk'].run({id, diskId: d1, sizeGb: 8}), true)
	assert.equal(await m.procedures['machines.updateCloudInit'].run({id, username: 'chris'}), true)
	assert.equal(await m.procedures['machines.setMedia'].run({id, diskId: cd0, iso: 'local:/Home/boot.iso'}), true)
	assert.equal(await m.procedures['machines.removeDisk'].run({id, diskId: cd0}), true)

	const {id: copyId} = await m.procedures['machines.clone'].run({id, name: 'old-debian-copy'})
	const endClone = Date.now() + 5000
	for (;;) {
		const c = (await m.procedures['machines.list'].run()).find((x) => x.id === copyId)
		if (c?.state === 'stopped') break
		if (c?.state === 'error') throw new Error(`clone failed: ${c.errorMessage}`)
		if (Date.now() > endClone) throw new Error('clone timed out')
		await new Promise((r) => setTimeout(r, 20))
	}

	const {backupId} = await m.procedures['machines.backup'].run({id})
	const endBackup = Date.now() + 5000
	while (!(await m.procedures['machines.backups'].run({id})).some((b) => b.id === backupId)) {
		if (Date.now() > endBackup) throw new Error('backup timed out')
		await new Promise((r) => setTimeout(r, 20))
	}
})

test('#660: interrupted backup folders are cleaned up on startup and deletable via deleteBackup', async (t) => {
	const id = 'a1b2c3d4'
	let releaseConvert = null
	let convertStarted = null
	const convertWait = new Promise((r) => (convertStarted = r))
	const convertHold = new Promise((r) => (releaseConvert = r))
	t.after(() => releaseConvert?.())

	const env = await makeEnv(t, {
		run: async (cmd, args) => {
			if (cmd === 'virsh' && args.includes('list')) return ' Id   Name   State\n------------------\n'
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				convertStarted()
				await convertHold
				throw new Error('aborted')
			}
			return ''
		},
	})
	const homeDir = join(env.root, 'home')
	const backupsDir = join(homeDir, 'Backups', 'Machines')
	await mkdir(backupsDir, {recursive: true})
	const files = {resolve: async (p) => ({real: p === '/Home' ? homeDir : join(homeDir, p.replace(/^\/Home\/?/, ''))})}

	// Completed backup and unrelated folder must survive startup cleanup.
	const completedDir = join(backupsDir, '100-box-20261119-010101')
	await mkdir(completedDir, {recursive: true})
	await writeFile(join(completedDir, 'machine.json'), JSON.stringify({format: 1, sourceId: id, createdAt: 1, machine: {name: 'Box', vmid: 100}}))
	const notesDir = join(backupsDir, 'my-notes')
	await mkdir(notesDir, {recursive: true})
	await writeFile(join(notesDir, 'readme.txt'), 'keep me')
	// An incomplete folder without machine.json can be removed explicitly via deleteBackup.
	const manualIncomplete = join(backupsDir, 'incomplete-1')
	await mkdir(manualIncomplete, {recursive: true})
	await writeFile(join(manualIncomplete, 'disk0.qcow2'), 'part')

	const vmDir = join(env.dataDir, 'machines', 'vms', id)
	await mkdir(vmDir, {recursive: true})
	await writeFile(join(vmDir, 'disk.qcow2'), 'd0')
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [makeMachineRecord(env.dataDir, {id})]}))

	const m1 = env.open({files})
	await m1.ready

	const {backupId: liveBackupId} = await m1.procedures['machines.backup'].run({id})
	await convertWait

	// Active running backup cannot be deleted by deleteBackup.
	await assert.rejects(
		() => m1.procedures['machines.deleteBackup'].run({backupId: liveBackupId}),
		(err) => err instanceof RpcError && err.code === 'CONFLICT',
	)
	// Explicit deleteBackup works on an incomplete folder without machine.json, and still rejects missing ones.
	assert.equal(await m1.procedures['machines.deleteBackup'].run({backupId: 'incomplete-1'}), true)
	await assert.rejects(() => stat(manualIncomplete))
	await assert.rejects(
		() => m1.procedures['machines.deleteBackup'].run({backupId: 'does-not-exist'}),
		(err) => err instanceof RpcError && err.code === 'NOT_FOUND',
	)

	// Simulate omarchyd restart while liveBackupId folder exists without machine.json.
	const m2 = env.open({files})
	await m2.ready

	await assert.rejects(() => stat(join(backupsDir, liveBackupId)))
	assert.equal(await stat(completedDir).then((s) => s.isDirectory()), true)
	assert.equal(await readFile(join(notesDir, 'readme.txt'), 'utf8'), 'keep me')

	releaseConvert()
	await new Promise((r) => setTimeout(r, 30))
})












