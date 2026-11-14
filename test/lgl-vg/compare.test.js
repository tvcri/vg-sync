import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareField } from '../../src/lgl-vg/compare.js'

const cases = [
  ['a', 'a', undefined, 'first-match'],
  ['',  '',  undefined, 'first-match'],
  ['a', 'b', undefined, 'never-agreed'],
  ['a', '',  undefined, 'never-agreed'],
  ['a', 'a', 'a', 'same'],
  ['',  '',  '',  'same'],
  ['',  'x', '',  'vg-changed'],
  ['b', 'b', 'a', 'converged'],
  ['b', 'a', 'a', 'lgl-changed'],
  ['a', 'b', 'a', 'vg-changed'],
  ['',  'a', 'a', 'lgl-cleared'],
  ['a', '',  'a', 'vg-cleared'],
  ['b', 'c', 'a', 'both-changed'],
  ['',  'c', 'a', 'both-changed'],
  ['',  '',  'a', 'converged'],
]
for (const [lgl, vg, agreed, want] of cases) {
  test(`lgl=${JSON.stringify(lgl)} vg=${JSON.stringify(vg)} agreed=${JSON.stringify(agreed)} -> ${want}`, () => {
    assert.equal(compareField(lgl, vg, agreed), want)
  })
}
