import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedScenarios, applyEdit, wipeLgl } from '../../harness/seed.js'

const env = { LGL_MEMBERSHIP_FUND_ID: 'F-M', LGL_PAYPAL_PAYMENT_TYPE_ID: 'P-PP', LGL_GIFT_TYPE_ID: 'GT', LGL_ORDINARY_FUND_ID: 'F-O', LGL_ORDINARY_PAYMENT_TYPE_ID: 'P-CK' }
const TODAY = '2026-11-13'
// Never the real out/harness-state.json: a test run must not clobber a saved harness run.
const stateFile = join(mkdtempSync(join(tmpdir(), 'vg-sync-seed-')), 'state.json')

function fakes({ entries = {} } = {}) {
  const calls = []
  let n = 100
  const rec = (name, ...args) => calls.push([name, ...args])
  const lglWriter = {
    createConstituent: async (b) => { rec('createConstituent', b); return { id: ++n } },
    updateConstituent: async (...a) => rec('updateConstituent', ...a),
    deleteConstituent: async (...a) => rec('deleteConstituent', ...a),
    addEntry: async (...a) => { rec('addEntry', ...a); return { id: 1 } },
    updateEntry: async (...a) => rec('updateEntry', ...a),
    listEntries: async (id, k) => entries[k] ?? [],
    addGift: async (...a) => { rec('addGift', ...a); return { id: 1 } },
    listHarnessConstituents: async () => [{ id: 7 }, { id: 8 }],
  }
  let p = 0
  const vgStaff = {
    createPerson: async (b) => { rec('createPerson', b); return { personId: String(++p) } },
    patchPerson: async (...a) => rec('patchPerson', ...a),
    putDonor: async (...a) => rec('putDonor', ...a),
    listHolds: async () => [{ holdId: '55', personId: '1', field: 'phone', reason: 'unclean' }],
    dismissHold: async (...a) => rec('dismissHold', ...a),
  }
  return { calls, lglWriter, vgStaff }
}
const names = (calls) => calls.map((c) => c[0])

test('one scenario: constituent, entries, gifts, person, donor', async () => {
  const { calls, lglWriter, vgStaff } = fakes()
  const s = {
    name: 'a', vg: { firstName: 'Jane', deceased: true, deceasedDate: '-10d' },
    lgl: { first_name: 'Jane', phone_numbers: [{ number: '401-555-0100', type: 'Mobile' }], email_addresses: [{ address: 'j@example.org' }] },
    gifts: [{ date: '-30d', amount: 10 }, { date: '-5d', amount: 20 }],
  }
  const state = await seedScenarios([s], { lglWriter, vgStaff, env, today: TODAY, stateFile })
  assert.deepEqual(names(calls), ['createConstituent', 'addEntry', 'addEntry', 'addGift', 'addGift', 'createPerson', 'patchPerson', 'putDonor'])
  assert.deepEqual(calls[1].slice(2), ['email_addresses', { address: 'j@example.org' }])
  assert.deepEqual(calls[2][3], { number: '401-555-0100', phone_type_name: 'Mobile' })
  assert.deepEqual(calls[6], ['patchPerson', '1', { deceased: true, deceasedDate: '2026-11-03' }])
  assert.deepEqual(calls[7], ['putDonor', '1', { lglConstituentId: 101, lastGiftDate: '2026-11-08' }])
  assert.deepEqual(state.scenarios.a, { constituentId: 101, personIds: ['1'] })
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).scenarios.a, state.scenarios.a)
})

test('a couple creates two persons and two donor rows with one constituent id', async () => {
  const { calls, lglWriter, vgStaff } = fakes()
  await seedScenarios([{ name: 'c', couple: true, vg: [{ firstName: 'A' }, { firstName: 'B' }], lgl: {} }], { lglWriter, vgStaff, env, today: TODAY, stateFile })
  assert.equal(calls.filter((c) => c[0] === 'createPerson').length, 2)
  const donors = calls.filter((c) => c[0] === 'putDonor')
  assert.equal(donors.length, 2)
  assert.equal(donors[0][2].lglConstituentId, donors[1][2].lglConstituentId)
  assert.equal(donors[0][2].lastGiftDate, null)
})

test('link: false makes no donor row', async () => {
  const { calls, lglWriter, vgStaff } = fakes()
  await seedScenarios([{ name: 'n', link: false, vg: { firstName: 'A' }, lgl: {} }], { lglWriter, vgStaff, env, today: TODAY, stateFile })
  assert.ok(!names(calls).includes('putDonor'))
})

test('a dues gift uses the stand-in fund and payment type and is not countable', async () => {
  const { calls, lglWriter, vgStaff } = fakes()
  await seedScenarios([{ name: 'd', vg: { firstName: 'A' }, lgl: {}, gifts: [{ date: '-2d', amount: 50, dues: true }, { date: '-1y', amount: 5 }] }], { lglWriter, vgStaff, env, today: TODAY, stateFile })
  const [dues, plain] = calls.filter((c) => c[0] === 'addGift')
  assert.equal(dues[2].fund_id, 'F-M')
  assert.equal(dues[2].payment_type_id, 'P-PP')
  assert.equal(dues[2].received_date, '2026-11-11')
  assert.equal(plain[2].fund_id, 'F-O')
  assert.equal(plain[2].payment_type_id, 'P-CK')
  assert.equal(calls.find((c) => c[0] === 'putDonor')[2].lastGiftDate, '2025-11-13')
})

test('wipeLgl deletes every harness constituent', async () => {
  const { calls, lglWriter } = fakes()
  assert.equal(await wipeLgl({ lglWriter }), 2)
  assert.deepEqual(calls, [['deleteConstituent', 7], ['deleteConstituent', 8]])
})

test('applyEdit entries.phone_numbers updates the preferred phone, or adds one', async () => {
  const entry = { id: 9, is_preferred: true }
  let f = fakes({ entries: { phone_numbers: [{ id: 8 }, entry] } })
  await applyEdit({ lgl: { entries: { phone_numbers: { number: '401-555-0111', type: 'Work' } } } }, { constituentId: 5, personIds: ['1'] }, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['updateEntry', 5, 'phone_numbers', 9, { number: '401-555-0111', phone_type_name: 'Work' }]])
  f = fakes()
  await applyEdit({ lgl: { entries: { phone_numbers: { number: '401-555-0111' } } } }, { constituentId: 5, personIds: ['1'] }, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['addEntry', 5, 'phone_numbers', { is_preferred: true, number: '401-555-0111' }]])
})

test('applyEdit: vg to the other partner, lgl fields, delete, dismiss', async () => {
  const st = { constituentId: 5, personIds: ['1', '2'] }
  let f = fakes()
  await applyEdit({ vg: { person: 1, firstName: 'Z' }, lgl: { last_name: 'Q', is_deceased: true, deceased_date: '-1d', gifts: [{ date: '-1d', amount: 1 }] } }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls[0], ['patchPerson', '2', { firstName: 'Z' }])
  assert.deepEqual(f.calls[1], ['updateConstituent', 5, { last_name: 'Q', is_deceased: true, deceased_date: '2026-11-12' }])
  assert.equal(f.calls[2][0], 'addGift')
  f = fakes()
  await applyEdit({ lgl: { delete: true } }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['deleteConstituent', 5]])
  f = fakes()
  await applyEdit({ dismiss: { field: 'phone', reason: 'unclean', dismissalKind: 'accept' } }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['dismissHold', '55', { dismissalKind: 'accept' }]])
  await assert.rejects(applyEdit({ dismiss: { field: 'x', reason: 'y', dismissalKind: 'k' } }, st, { ...f, env, today: TODAY }), /no open hold/)
})

test('applyEdit vg.lastGiftDate sets the donor row\'s date (resolved), alone or with person fields', async () => {
  const st = { constituentId: 5, personIds: ['1', '2'] }
  let f = fakes()
  await applyEdit({ vg: { lastGiftDate: '-400d' } }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['putDonor', '1', { lglConstituentId: 5, lastGiftDate: '2025-10-09' }]])
  f = fakes()
  await applyEdit({ vg: { person: 1, firstName: 'Z', lastGiftDate: null } }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['patchPerson', '2', { firstName: 'Z' }], ['putDonor', '2', { lglConstituentId: 5, lastGiftDate: null }]])
})

test('empty id overrides fall back to the lookup', async () => {
  const { calls, lglWriter, vgStaff } = fakes()
  lglWriter.request = async (m, path) => ({
    items: path.startsWith('/gift_types') ? [{ id: 'GT-LOOKED', name: 'Gift' }]
      : path.startsWith('/funds') ? [{ id: 'F-LOOKED', name: 'General' }]
      : [{ id: 'P-LOOKED', name: 'Check' }],
  })
  const blank = { ...env, LGL_GIFT_TYPE_ID: '', LGL_ORDINARY_FUND_ID: '', LGL_ORDINARY_PAYMENT_TYPE_ID: '' }
  await seedScenarios([{ name: 'g', vg: { firstName: 'A' }, lgl: {}, gifts: [{ date: '-2d', amount: 5 }] }], { lglWriter, vgStaff, env: blank, today: TODAY, stateFile })
  const gift = calls.find((c) => c[0] === 'addGift')
  assert.match(JSON.stringify(gift), /GT-LOOKED/)
  assert.match(JSON.stringify(gift), /F-LOOKED/)
  assert.match(JSON.stringify(gift), /P-LOOKED/)
})

test('applyEdit vg as a list edits each partner in one phase', async () => {
  const st = { constituentId: 5, personIds: ['1', '2'] }
  const f = fakes()
  await applyEdit({ vg: [{ street: '1 A St' }, { person: 1, street: '1 A St' }] }, st, { ...f, env, today: TODAY })
  assert.deepEqual(f.calls, [['patchPerson', '1', { street: '1 A St' }], ['patchPerson', '2', { street: '1 A St' }]])
})

test('applyEdit syncLog appends written rows for the person and field, one per invented run', async () => {
  const st = { constituentId: 5, personIds: ['1', '2'] }
  const f = fakes()
  const rows = []
  f.vgStaff.appendSyncLog = async (r) => { rows.push(...r); return { appended: r.length } }
  await applyEdit({ syncLog: { field: 'email', runs: 3 } }, st, { ...f, env, today: TODAY })
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map((r) => r.runId)).size, 3)
  for (const r of rows) {
    assert.equal(r.lglConstituentId, '5')
    assert.equal(r.personId, '1')
    assert.equal(r.field, 'email')
    assert.equal(r.outcome, 'written')
    assert.match(r.runId, /^\d+$/)
    assert.equal(typeof r.request.method, 'string')
  }
  await assert.rejects(applyEdit({ syncLog: { field: 'email', runs: 0 } }, st, { ...f, env, today: TODAY }), /runs/)
})
