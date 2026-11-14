import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS } from '../../src/lgl-vg/fields.js'

const text = readFileSync(new URL('../../policy.json', import.meta.url), 'utf8')
const CASES = ['same', 'first-match', 'converged', 'lgl-changed', 'vg-changed', 'lgl-cleared', 'vg-cleared', 'both-changed', 'never-agreed']
const make = (o) => JSON.stringify({ fields: {}, records: {}, settings: {}, ...o })

test('the real policy.json answers the customer decisions', () => {
  const p = parsePolicy(text)
  assert.equal(p.fieldAction('phones', 'never-agreed'), 'merge')
  assert.equal(p.fieldAction('nickname', 'never-agreed'), 'hold')
  assert.equal(p.fieldAction('deceased', 'never-agreed'), 'toward-deceased')
  assert.equal(p.fieldAction('email', 'never-agreed'), 'to-lgl-else-hold')
  assert.equal(p.fieldAction('address', 'never-agreed'), 'to-lgl')
  for (const f of FIELDS) {
    assert.equal(p.fieldAction(f, 'lgl-changed'), 'to-vg')
    assert.equal(p.fieldAction(f, 'vg-changed'), 'to-lgl')
    assert.equal(p.fieldAction(f, 'both-changed'), 'to-lgl')
  }
  assert.equal(p.record('lgl-missing'), 'unlink')
  assert.equal(p.record('no-longer-donor'), 'hold')
  assert.equal(p.setting('lgl-addressee'), 'if-default')
  assert.equal(p.setting('couple-lgl-changed'), 'to-vg')
})

test('a case with no row is hold', () => {
  const p = parsePolicy(text)
  assert.equal(p.fieldAction('address', 'lgl-cleared'), 'hold')
  assert.equal(p.fieldAction('address', 'vg-cleared'), 'hold')
  assert.equal(p.fieldAction('address', 'same'), 'hold')
})

test('a field missing from fields is hold for every case', () => {
  const p = parsePolicy(make({ fields: { firstName: { 'lgl-changed': 'to-vg' } } }))
  for (const k of CASES) assert.equal(p.fieldAction('lastName', k), 'hold')
})

test('parsePolicy names the bad value', () => {
  assert.throws(() => parsePolicy(make({ fields: { firstName: { 'lgl-changed': 'copy' } } })), /copy/)
  assert.throws(() => parsePolicy(make({ fields: { middleName: { 'lgl-changed': 'to-vg' } } })), /middleName/)
  assert.throws(() => parsePolicy(make({ fields: { firstName: { 'lgl-moved': 'to-vg' } } })), /lgl-moved/)
  assert.throws(() => parsePolicy(make({ records: { 'lgl-missing': 'to-vg' } })), /to-vg/)
  assert.throws(() => parsePolicy(make({ records: { 'lgl-vanished': 'hold' } })), /lgl-vanished/)
  assert.throws(() => parsePolicy('{not json'), /JSON/)
})

test('hash is the sha256 of the text and sensitive to whitespace', () => {
  const a = parsePolicy(text)
  assert.match(a.hash, /^[0-9a-f]{64}$/)
  assert.equal(a.hash, createHash('sha256').update(text).digest('hex'))
  assert.notEqual(parsePolicy(text + '\n').hash, a.hash)
})
