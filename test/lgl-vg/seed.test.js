import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importSeed } from '../../src/lgl-vg/seed.js'
import { unlinkedFingerprint } from '../../src/lgl-vg/match.js'
import { fingerprint } from '../../src/lgl-vg/plan.js'

const act = (lglId, kind, reason, o = {}) => ({ key: lglId, lglId, kind, reason, lastGiftDate: '2019-03-04', ...o })
const none = { persons: [], holds: [] }

test('staff skip, horizon skip, anonymous and import hold each become their hold', () => {
  const { items, counts } = importSeed([
    act('1', 'skip', 'Staff chose Skip'),
    act('2', 'skip', 'Last gift before 2021-11-10; new people only for gifts since'),
    act('3', 'skip', 'Anonymous in LGL'),
    act('4', 'hold', 'Not confirmed on the Work list'),
    act('5', 'link', 'Email and name match'),
    act('6', 'skip', 'No longer an LGL donor'),
  ], none)
  assert.deepEqual(items.map((h) => [h.lglConstituentId, h.reason, h.state, h.dismissalKind ?? null, h.personId, h.field]), [
    ['1', 'import-skip', 'dismissed', 'staff', null, null],
    ['2', 'before-horizon', 'dismissed', 'rule', null, null],
    ['3', 'anonymous', 'dismissed', 'rule', null, null],
    ['4', 'import-hold', 'open', null, null, null],
  ])
  assert.equal(items[0].fingerprint, fingerprint(['import-skip', '1']))
  assert.equal(items[1].fingerprint, unlinkedFingerprint('before-horizon', [], '2019-03-04'))
  assert.deepEqual(items[3].detail, { importReason: 'Not confirmed on the Work list' })
  assert.equal(counts['import-skip'], 1)
})

test('a couple\'s rows: staff skip beats hold beats a rule skip; one hold per constituent', () => {
  const { items } = importSeed([
    act('7', 'skip', 'Last gift before 2021-11-10', { key: '7#1' }),
    act('7', 'hold', 'Not confirmed', { key: '7#2' }),
    act('8', 'hold', 'Not confirmed', { key: '8#1' }),
    act('8', 'skip', 'Staff chose Skip', { key: '8#2' }),
  ], none)
  assert.deepEqual(items.map((h) => [h.lglConstituentId, h.reason]), [['7', 'import-hold'], ['8', 'import-skip']])
})

test('linked today, or already seeded: nothing; an unknown skip reason refuses the whole load', () => {
  const persons = [{ personId: '9', donor: { lglConstituentId: '1', lastGiftDate: null } }]
  const holds = [{ lglConstituentId: '2', personId: null, reason: 'before-horizon', state: 'closed' }]
  const r = importSeed([act('1', 'skip', 'Staff chose Skip'), act('2', 'skip', 'Last gift before x')], { persons, holds })
  assert.deepEqual([r.items, r.counts.linkedToday, r.counts.alreadySeeded], [[], 1, 1])
  assert.throws(() => importSeed([act('1', 'skip', 'Something new')], none), /unknown reason "Something new"/)
})

test('a rule hold a pass opened does not stand in for a staff Skip', () => {
  const holds = [{ lglConstituentId: '1', personId: null, reason: 'before-horizon', state: 'open' }]
  const { items } = importSeed([act('1', 'skip', 'Staff chose Skip')], { persons: [], holds })
  assert.deepEqual(items.map((h) => h.reason), ['import-skip'])
})
