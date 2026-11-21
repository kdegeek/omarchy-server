import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

test('Store does not define Item inside its render body', async () => {
	const src = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	const storeStart = src.indexOf('export function Store(')
	const storeEnd = src.indexOf('// ---- community app stores')
	assert.ok(storeStart >= 0 && storeEnd > storeStart)
	const storeBody = src.slice(storeStart, storeEnd)
	assert.doesNotMatch(storeBody, /\b(?:const|function)\s+Item\b/)
	assert.match(src, /\nfunction StoreItem\(/)
	assert.match(storeBody, /<StoreItem\b/)
})
