// Reliability fixes for omarchyd machines and machine settings UI.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

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

