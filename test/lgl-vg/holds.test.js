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
    'lost-nickname', 'deceased-removed', 'phones-no-slot', 'vg-refused', 'lgl-missing', 'no-longer-donor',
    'po-box', 'flapping', 'lgl-refused']
  assert.deepEqual([...OWNED_REASONS].sort(), all.sort())
})

test('po-box, flapping and lgl-refused are owned; addressee and lgl-incomplete are not', () => {
  for (const reason of ['po-box', 'flapping', 'lgl-refused']) {
    assert.ok(OWNED_REASONS.has(reason), reason)
    // the plan no longer wants it: reconciliation closes it
    const r = reconcileHolds([], [have({ reason })])
    assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'closed' }], reason)
  }
  // only staff close these: an envelope left hand-written, an LGL entry left current part way
  for (const reason of ['addressee', 'lgl-incomplete']) {
    assert.ok(!OWNED_REASONS.has(reason), reason)
    assert.deepEqual(reconcileHolds([], [have({ reason, field: 'firstName' })]).patch, [], reason)
  }
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

test('open hold, same fingerprint, new detail: seen, and its detail replaced', () => {
  const r = reconcileHolds([want({ detail: { a: 1, lgl: { name: 'Jane Doe' } } })], [have()])
  assert.deepEqual(r.patch, [{ holdId: 'h1', seen: true, detail: { a: 1, lgl: { name: 'Jane Doe' } } }])
  assert.deepEqual([r.counts.seen, r.counts.refreshed], [1, 1])
})

test('a detail that differs only in key order (as MySQL returns JSON) is the same detail', () => {
  const r = reconcileHolds([want({ detail: { b: { y: 1, x: 2 }, a: [1, 2] } })], [have({ detail: { a: [1, 2], b: { x: 2, y: 1 } } })])
  assert.deepEqual(r.patch, [{ holdId: 'h1', seen: true }])
  assert.equal(r.counts.refreshed, 0)
})

test('dismissed hold, same fingerprint, new detail: stays dismissed, detail replaced', () => {
  const r = reconcileHolds([want({ detail: { a: 2 } })], [have({ state: 'dismissed' })])
  assert.deepEqual(r.patch, [{ holdId: 'h1', detail: { a: 2 } }])
  assert.deepEqual([r.counts.stillDismissed, r.counts.refreshed], [1, 1])
})

test('a hold named in close is closed, and a desired hold with its key opens as a new row', () => {
  const k = { personId: null, field: null, reason: 'resolution-failed' }
  const r = reconcileHolds([want({ ...k, fingerprint: 'f2' })], [have({ ...k, resolution: { kind: 'create' } })], { close: ['h1'] })
  assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'closed' }])
  assert.equal(r.open.length, 1)
  assert.deepEqual([r.counts.closed, r.counts.opened], [1, 1])
})

test('close names a hold of any reason, owned or not', () => {
  const r = reconcileHolds([], [have({ personId: null, field: null, reason: 'import-skip' })], { close: ['h1'] })
  assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'closed' }])
})

test('step 4 owns resolution-failed', () => {
  const r = reconcileHolds([], [have({ personId: null, field: null, reason: 'resolution-failed' })])
  assert.deepEqual(r.patch, [{ holdId: 'h1', state: 'closed' }])
})
