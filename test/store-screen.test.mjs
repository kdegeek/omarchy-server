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

test('Store refresh invalidates the catalog on settle and only toasts Up to date on success', async () => {
	const src = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	const block = src.match(/const refresh = useMutation\(\{[\s\S]*?\n\t\}\)/)?.[0] ?? ''
	assert.match(block, /onSuccess:\s*\(\)\s*=>\s*toast\('Up to date'\)/)
	assert.match(block, /onError:\s*\(e\)\s*=>\s*toast\(\(e as Error\)\.message,\s*true\)/)
	assert.match(block, /onSettled:\s*\(\)\s*=>\s*qc\.invalidateQueries\(\{queryKey:\s*\['appStore\.registry'\]\}\)/)
})
