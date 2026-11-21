// Reading a typed (hidden) line from raw terminal input. Input arrives in chunks, and a pasted
// password often arrives in one chunk together with its Enter (or two passwords at once), so each
// character is looked at in turn and whatever follows the Enter is kept for the next question.
export function takeLine(value, chunk) {
	for (let i = 0; i < chunk.length; i++) {
		const ch = chunk[i]
		if (ch === '\u0003') return {interrupted: true}
		if (ch === '\r' || ch === '\n') {
			// \r\n counts as one Enter.
			const next = ch === '\r' && chunk[i + 1] === '\n' ? i + 2 : i + 1
			return {done: true, value, rest: chunk.slice(next)}
		}
		if (ch === '\u001b') {
			if (chunk[i + 1] === '[') {
				i += 2
				while (i < chunk.length && chunk[i] >= ' ' && chunk[i] <= '?') i++
				if (i < chunk.length && (chunk[i] < '@' || chunk[i] > '~')) i--
			} else if (chunk[i + 1] === 'O' && i + 2 < chunk.length && chunk[i + 2] >= '@' && chunk[i + 2] <= '~') {
				i += 2
			}
			continue
		}
		if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('')
		else if (ch >= ' ' || ch > '\u007f') value += ch
	}
	return {done: false, value}
}
