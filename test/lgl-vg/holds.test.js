import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWNED_REASONS, reconcileHolds } from '../../src/lgl-vg/holds.js'

const want = (o = {}) => ({
  lglConstituentId: '101', personId: '7', field: 'email', reason: 'both-changed',
  fingerprint: 'f1', detail: { a: 1 }, ...o,
})
const have = (o = {}) => ({
  holdId: 'h1', lglConstituentId: '101', personId: '7', field: 'email', reason: 'both-changed',
  detail: { a: 1 }, fingerprint: 'f1', state: 'open', dismissalKind: null, ...o,
})

test('OWNED_REASONS lists the cases, guards and records', () => {
  const all = ['never-agreed', 'both-changed', 'lgl-cleared', 'vg-cleared', 'unclean', 'ambiguous', 'couple',
    'lost-nickname', 'deceased-removed', 'phones-no-slot', 'vg-refused', 'lgl-missing', 'no-longer-donor']
  assert.deepEqual([...OWNED_REASONS].sort(), all.sort())
})

test('desired with no existing opens a new hold with only the new keys', () => {
  const r = reconcileHolds([want()], [])
  assert.deepEqual(r.open, [{ lglConstituentId: '101', personId: '7', field: 'email', reason: 'both-changed', fingerprint: 'f1', detail: { a: 1 } }])
  assert.deepEqual(r.patch, [])
  assert.equal(r.counts.opened, 1)
})

test('open hold, same fingerprint, is marked seen', () => {
  const r = reconcileHolds([want()], [have()])
  assert.deepEqual(r.patch, [{ holdId: 'h1', seen: true }])
  assert.deepEqual(r.open, [])
  assert.equal(r.counts.seen, 1)
})

test('open hold, new fingerprint, is refreshed', () => {
  const r = reconcileHolds([want({ fingerprint: 'f2', detail: { a: 2 } })], [have()])
  assert.deepEqual(r.patch, [{ holdId: 'h1', seen: true, fingerprint: 'f2', detail: { a: 2 } }])
  assert.equal(r.counts.changed, 1)
})

test('dismissed hold, same fingerprint, is left alone', () => {
  const r = reconcileHolds([want()], [have({ state: 'dismissed' })])
  assert.deepEqual(r.patch, [])
  assert.deepEqual(r.open, [])
  assert.equal(r.counts.stillDismissed, 1)
})

test('dismissed hold, new fingerprint, is reopened', () => {
  const r = reconcileHolds([want({ fingerprint: 'f2', detail: { a: 2 } })], [have({ state: 'dismissed' })])
  assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'open', fingerprint: 'f2', detail: { a: 2 } }])
  assert.equal(r.counts.reopened, 1)
})

test('owned open hold no longer desired is closed', () => {
  const r = reconcileHolds([], [have()])
  assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'closed' }])
  assert.equal(r.counts.closed, 1)
})

test('dismissed hold no longer desired is left alone', () => {
  const r = reconcileHolds([], [have({ state: 'dismissed' })])
  assert.deepEqual(r.patch, [])
})

test('not-owned holds are never touched', () => {
  const r = reconcileHolds([], [
    have({ holdId: 'b', reason: 'already-linked-elsewhere' }), // a matching reason on a person: nobody's
    have({ holdId: 'c', personId: null }), // a field case with no person: nobody's
    have({ holdId: 'd', personId: null, reason: 'import-skip', state: 'dismissed', dismissalKind: 'staff' }),
    have({ holdId: 'e', personId: null, reason: 'some-later-step' }),
  ])
  assert.deepEqual(r.patch, [])
  assert.equal(r.counts.closed, 0)
})

test('step 4 closes its own: unlinked-donor holds with no person, import holds, and its person notices', () => {
  const r = reconcileHolds([], [
    have({ holdId: 'a', personId: null, field: null, reason: 'name-only' }),
    have({ holdId: 'b', personId: null, field: null, reason: 'import-hold' }),
    have({ holdId: 'c', personId: null, field: null, reason: 'vg-refused' }),
    have({ holdId: 'd', field: null, reason: 'unlinked' }),
    have({ holdId: 'e', field: null, reason: 'create-unfinished' }),
  ])
  assert.deepEqual(r.patch.map((p) => [p.holdId, p.state]), [['a', 'closed'], ['b', 'closed'], ['c', 'closed'], ['d', 'closed'], ['e', 'closed']])
})

test('two desired holds with the same key open once', () => {
  const r = reconcileHolds([want(), want()], [])
  assert.equal(r.open.length, 1)
})

test('null field keys as empty', () => {
  const r = reconcileHolds([want({ field: null, reason: 'couple' })], [have({ field: null, reason: 'couple' })])
  assert.deepEqual(r.patch, [{ holdId: 'h1', seen: true }])
})
