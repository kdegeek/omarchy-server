// Desktop machine-start tracking: keep transitional states, open console on running, drop failed/stopped/deleted machines.
import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {addStartingMachine, reconcileStartingMachines} from '../web/src/desktop/machineStart.ts'

describe('desktop machine start tracking', () => {
	test('keeps a newly queued machine across stale pre-start snapshots', () => {
		const starting = addStartingMachine([], 'vm-1', 1000)
		const res = reconcileStartingMachines(starting, [{id: 'vm-1', state: 'stopped'}], 1000)
		assert.deepEqual(res, {ready: [], dropped: [], remaining: [{id: 'vm-1', state: undefined, since: 1000}].map(({id, since}) => ({id, since}))})
	})

	test('keeps transitional states after refetch', () => {
		const starting = addStartingMachine([], 'vm-1', 1000)
		for (const state of ['starting', 'restarting', 'installing']) {
			const res = reconcileStartingMachines(starting, [{id: 'vm-1', state}], 2000)
			assert.deepEqual(res, {ready: [], dropped: [], remaining: [{id: 'vm-1', since: 1000}]})
		}
	})

	test('moves running machine to ready even before listUpdatedAt advances', () => {
		const starting = addStartingMachine([], 'vm-1', 1000)
		const res = reconcileStartingMachines(starting, [{id: 'vm-1', state: 'running'}], 1000)
		assert.deepEqual(res, {ready: ['vm-1'], dropped: [], remaining: []})
	})

	test('drops machines in error, stopped, suspended, hibernated, stopping, or missing after refetch', () => {
		const starting = addStartingMachine([], 'vm-1', 1000)
		for (const state of ['error', 'stopped', 'suspended', 'hibernated', 'stopping']) {
			const res = reconcileStartingMachines(starting, [{id: 'vm-1', state}], 2000)
			assert.deepEqual(res, {ready: [], dropped: ['vm-1'], remaining: []}, `state ${state} must be dropped`)
		}
		const missing = reconcileStartingMachines(starting, [], 2000)
		assert.deepEqual(missing, {ready: [], dropped: ['vm-1'], remaining: []})
	})

	test('addStartingMachine deduplicates by id and updates since', () => {
		let list = addStartingMachine([], 'vm-1', 1000)
		list = addStartingMachine(list, 'vm-2', 1100)
		list = addStartingMachine(list, 'vm-1', 1500)
		assert.deepEqual(list, [{id: 'vm-2', since: 1100}, {id: 'vm-1', since: 1500}])
	})
})
