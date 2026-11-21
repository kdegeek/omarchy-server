// Reliability fixes for omarchyd machines and machine settings UI.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
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



