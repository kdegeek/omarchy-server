// Track machines started from the desktop so failed or deleted ones stop polling and don't pop consoles later.
export type StartingMachine = {id: string; since: number}

const TRANSITIONAL = new Set(['starting', 'restarting', 'installing'])

export function addStartingMachine(list: StartingMachine[], id: string, since: number): StartingMachine[] {
	return [...list.filter((x) => x.id !== id), {id, since}]
}

export function reconcileStartingMachines(
	starting: ReadonlyArray<StartingMachine>,
	machines: ReadonlyArray<{id: string; state: string}>,
	listUpdatedAt: number,
): {ready: string[]; dropped: string[]; remaining: StartingMachine[]} {
	const ready: string[] = []
	const dropped: string[] = []
	const remaining: StartingMachine[] = []
	for (const entry of starting) {
		const m = machines.find((x) => x.id === entry.id)
		if (m?.state === 'running') {
			ready.push(entry.id)
		} else if (listUpdatedAt <= entry.since) {
			remaining.push(entry)
		} else if (m && TRANSITIONAL.has(m.state)) {
			remaining.push(entry)
		} else {
			dropped.push(entry.id)
		}
	}
	return {ready, dropped, remaining}
}
