import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkScenario } from '../../harness/expect.js'

const person = (over = {}) => ({
  detail: { firstName: 'Jane', lastName: 'Doe', street: '12 Elm Street', city: 'Warwick', state: 'RI', zip: '02886' },
  email: null, phone: { phone: '401-555-0101', cell: null }, deceased: false, donor: { lglConstituentId: 1, lastGiftDate: '2026-10-01' },
  ...over,
})
const T = '2026-11-13T10:00:00Z'
const scen = (phases) => ({ name: 's', phases })
const run = (phases, extra = {}, phaseIndex = 0) =>
  checkScenario({ scenario: scen(phases), phaseIndex, vgPersons: [person()], lglConstituent: null, holds: [], decisions: [], passStartedAt: '2026-11-13T10:00:00Z', ...extra })

test('address compares in comparable form', () => {
  const addr = { street: '12 Elm St', city: 'Warwick', state: 'RI', zip: '02886' }
  assert.deepEqual(run([{ expect: { vg: { address: addr } } }]), [])
})

test('phones mismatch names vg.phones', () => {
  const f = run([{ expect: { vg: { phones: { phone: '401-555-0102', cell: null } } } }])
  assert.equal(f.length, 1)
  assert.equal(f[0].what, 'vg.phones')
  assert.equal(f[0].phase, 1)
})

test('donor and lastGiftDate are plain values', () => {
  assert.deepEqual(run([{ expect: { vg: { donor: true, lastGiftDate: '2026-10-01' } } }]), [])
  assert.equal(run([{ expect: { vg: { lastGiftDate: '2026-10-02' } } }])[0].what, 'vg.lastGiftDate')
})

test('couple: array of two', () => {
  const f = checkScenario({
    scenario: scen([{ expect: { vg: [{ firstName: 'Jane' }, { firstName: 'John' }] } }]), phaseIndex: 0,
    vgPersons: [person(), person()], lglConstituent: null, passStartedAt: T,
  })
  assert.deepEqual(f.map((x) => x.what), ['vg[1].firstName'])
})

test('lgl fields and deleted', () => {
  const c = { first_name: 'Jane', last_name: 'Doe', street_addresses: [], email_addresses: [], phone_numbers: [] }
  const sc = scen([{ expect: { lgl: { firstName: 'Jane' } } }, { expect: { lgl: { deleted: true } } }])
  assert.deepEqual(checkScenario({ scenario: sc, phaseIndex: 0, vgPersons: [], lglConstituent: c, passStartedAt: T }), [])
  assert.equal(checkScenario({ scenario: sc, phaseIndex: 1, vgPersons: [], lglConstituent: c, passStartedAt: T })[0].what, 'lgl.deleted')
  assert.deepEqual(checkScenario({ scenario: sc, phaseIndex: 1, vgPersons: [], lglConstituent: null, passStartedAt: T }), [])
})

test('holds must match exactly, order-free', () => {
  const h = (field, reason, state = 'open') => ({ field, reason, state })
  const exp = [{ phases: [{ expect: { holds: [{ field: 'a', reason: 'x' }, { field: 'b', reason: 'y' }] } }] }][0].phases
  assert.deepEqual(run(exp, { holds: [h('b', 'y'), h('a', 'x')] }), [])
  assert.equal(run(exp, { holds: [h('a', 'x'), h('b', 'y'), h('c', 'z')] })[0].what, 'holds')
  assert.equal(run(exp, { holds: [h('a', 'x')] }).length, 1)
  assert.deepEqual(run(exp, { holds: [h('a', 'x'), h('b', 'y'), h('c', 'z', 'closed')] }), [])
  const dis = [{ expect: { holds: [{ field: 'a', reason: 'x', state: 'dismissed' }] } }]
  assert.deepEqual(run(dis, { holds: [h('a', 'x', 'dismissed')] }), [])
  assert.equal(run(dis, { holds: [h('a', 'x')] }).length, 1)
  assert.deepEqual(run([{ expect: { holds: [] } }], { holds: [] }), [])
})

test('writes and deferred count decision rows', () => {
  const d = [{ outcome: 'write-vg' }, { outcome: 'deferred' }, { outcome: 'deferred' }, { outcome: 'record' }]
  assert.deepEqual(run([{ expect: { writes: 1, deferred: 2 } }], { decisions: d }), [])
  const f = run([{ expect: { writes: 0, deferred: 0 } }], { decisions: d })
  assert.deepEqual(f.map((x) => [x.what, x.expected, x.found]), [['writes', 0, 1], ['deferred', 0, 2]])
})

test('a phase beyond the scenario is undisturbed', () => {
  const phases = [{ expect: {} }, { expect: {} }]
  assert.deepEqual(run(phases, {}, 2), [])
  const f = run(phases, { decisions: [{ outcome: 'write-vg' }] }, 2)
  assert.equal(f.length, 1)
  assert.equal(f[0].phase, 3)
  const hold = { field: 'a', reason: 'x', state: 'open', firstSeenAt: '2026-11-13T10:05:00Z' }
  assert.equal(run(phases, { holds: [hold], passStartedAt: '2026-11-13T10:00:00Z' }, 2).length, 1)
  assert.deepEqual(run(phases, { holds: [{ ...hold, firstSeenAt: '2026-11-12T10:00:00Z' }], passStartedAt: '2026-11-13T10:00:00Z' }, 2), [])
})

test('an object expect.vg with no person fails', () => {
  const f = run([{ expect: { vg: { firstName: 'Jane' } } }], { vgPersons: [] })
  assert.deepEqual(f.map((x) => [x.what, x.found]), [['vg', 'missing']])
  assert.equal(run([{ expect: { vg: { firstName: 'Jane' } } }], { vgPersons: undefined }).length, 1)
})

test('passStartedAt is required', () => {
  assert.throws(() => run([{ expect: {} }], { passStartedAt: undefined }), /passStartedAt/)
})

test('an open hold without firstSeenAt fails the undisturbed check', () => {
  const f = run([{ expect: {} }], { holds: [{ field: 'a', reason: 'x', state: 'open' }] }, 1)
  assert.equal(f.length, 1)
  assert.match(f[0].what, /firstSeenAt/)
})

test('passFails: a zero exit is the failure, a non-zero exit passes', () => {
  const phases = [{ expect: { passFails: true } }]
  assert.deepEqual(run(phases, { passExitCode: 1 }), [])
  const f = run(phases, { passExitCode: 0 })
  assert.deepEqual(f.map((x) => [x.what, x.expected, x.found]), [['pass exit', 'non-zero', 0]])
})

test('relative dates in expect resolve against today', () => {
  const today = '2026-11-13'
  const p = person({ deceased: true, detail: { ...person().detail, deceasedDate: '2026-08-15' }, donor: { lglConstituentId: 1, lastGiftDate: '2026-11-08' } })
  const check = (exp) => checkScenario({ scenario: scen([{ expect: exp }]), phaseIndex: 0, vgPersons: [p], lglConstituent: null, passStartedAt: T, today })
  assert.deepEqual(check({ vg: { lastGiftDate: '-5d', deceased: { flag: true, date: '-90d' } } }), [])
  assert.equal(check({ vg: { lastGiftDate: '-6d' } })[0].what, 'vg.lastGiftDate')
  assert.throws(() => checkScenario({ scenario: scen([{ expect: { vg: { lastGiftDate: '-5d' } } }]), phaseIndex: 0, vgPersons: [p], lglConstituent: null, passStartedAt: T }), /today/)
})

test('records counts the pass\'s record decisions', () => {
  const decisions = [{ outcome: 'record' }, { outcome: 'record' }, { outcome: 'write-vg' }]
  assert.deepEqual(run([{ expect: { records: 2 } }], { decisions }), [])
  assert.deepEqual(run([{ expect: { records: 0 } }], { decisions }).map((x) => [x.what, x.expected, x.found]), [['records', 0, 2]])
})
