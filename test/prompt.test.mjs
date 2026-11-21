// The terminal password prompt: typed one key at a time, or pasted with its Enter in one go.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {takeLine} from '../omarchyd/prompt.mjs'

test('a password pasted together with its Enter is taken without the Enter', () => {
	assert.deepEqual(takeLine('', 'correct horse\r'), {done: true, value: 'correct horse', rest: ''})
	assert.deepEqual(takeLine('', 'correct horse\r\n'), {done: true, value: 'correct horse', rest: ''})
})

test('two passwords pasted at once: the second is kept for the next question', () => {
	const a = takeLine('', 'pw one\rpw one\r')
	assert.deepEqual(a, {done: true, value: 'pw one', rest: 'pw one\r'})
	assert.deepEqual(takeLine('', a.rest), {done: true, value: 'pw one', rest: ''})
})

test('typed a key at a time, with backspace and Ctrl+C', () => {
	let r = {value: ''}
	for (const k of ['a', 'b', 'x', '\u007f', 'c']) r = takeLine(r.value, k)
	assert.deepEqual(r, {done: false, value: 'abc'})
	assert.deepEqual(takeLine(r.value, '\r'), {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('abc', '\u0003'), {interrupted: true})
	assert.deepEqual(takeLine('', 'pässwörd\r').value, 'pässwörd')
	assert.equal(takeLine('', 'a\u001bb\r').value, 'ab', 'other control characters are ignored')
})

test('arrow, Home, End, Delete, and function key escape sequences are ignored', () => {
	let r = {value: ''}
	for (const k of ['a', 'b', 'c', '\u001b[D', '\u001b[3~', '\r']) r = takeLine(r.value, k)
	assert.deepEqual(r, {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('', 'ab\u001b[Hc\r'), {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('', 'a\u001b[1;5Db\u001b[Fc\r'), {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('', 'a\u001bOHb\u001bOPc\r'), {done: true, value: 'abc', rest: ''})
	assert.deepEqual(takeLine('', 'ab\u001b[\r'), {done: true, value: 'ab', rest: ''})
	assert.deepEqual(takeLine('', 'ab\u001b[\u0003'), {interrupted: true})
})
