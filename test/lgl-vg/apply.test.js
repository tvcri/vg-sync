import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPlan } from '../../src/lgl-vg/apply.js'
import { vgFields, comparable } from '../../src/lgl-vg/fields.js'

// The list-shaped person GET /persons?lglConstituentId=..&projection=detail returns.
const person = (o = {}) => ({
  personId: '7', deceased: false, email: 'jane@example.org', phone: { phone: '401-555-0101', cell: null },
  detail: {
    firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null,
    street: '12 Elm St', unit: null, city: 'Springfield', state: 'XX', zip: '99999', deceasedDate: null,
  },
  donor: { lglConstituentId: '101', lastGiftDate: null }, ...o,
})
const emailC = (p) => comparable('email', vgFields(p).email)

// patchErr: personId -> status for every PATCH to that person, or a function (body) -> status | undefined.
function fake({ people = { 7: person(), 8: person({ personId: '8' }) }, patchErr = {}, town = { town: 'Springfield' } } = {}) {
  const calls = []
  const rec = (name, fn) => async (...a) => { calls.push([name, ...a]); return fn ? fn(...a) : undefined }
  return {
    calls,
    getLinkedPersons: rec('getLinkedPersons', (cid) =>
      Object.values(people).filter((p) => String(p.donor?.lglConstituentId) === String(cid))),
    patchPerson: rec('patchPerson', (id, body) => {
      const rule = patchErr[id]
      const status = typeof rule === 'function' ? rule(body) : rule
      if (status) throw Object.assign(new Error(`bad ${Object.keys(body).join(',')}`), { status })
    }),
    putDonor: rec('putDonor'),
    geocodeTown: rec('geocodeTown', () => town),
    putSyncFields: rec('putSyncFields', (rows) => rows.length),
    createSyncHolds: rec('createSyncHolds'),
    patchSyncHolds: rec('patchSyncHolds'),
  }
}
const names = (vg) => vg.calls.map((c) => c[0])
const agreeRow = (personId, field) => ({ personId, field, lglConstituentId: '101', value: 'x', lglEntryId: null })
const emptyPlan = { agree: [], holds: [], writes: [] }

const donorPlan = (expect) => ({ ...emptyPlan, writes: [{ kind: 'donor', personId: '7', constituentId: '101',
  body: { lglConstituentId: '101', lastGiftDate: '2026-01-02' }, expect, fingerprint: 'fd' }] })

const twoField = (expectEmail) => ({
  ...emptyPlan,
  writes: [{
    kind: 'person', personId: '7', constituentId: '101', address: null,
    fields: {
      firstName: { body: { firstName: 'Janet' }, expect: comparable('firstName', 'Jane'), agree: agreeRow('7', 'firstName'), fingerprint: 'fa' },
      email: { body: { email: 'new@example.org' }, expect: expectEmail, agree: agreeRow('7', 'email'), fingerprint: 'fb' },
    },
  }],
})

test('a field VG changed since the read is stale; the rest is written with its memory', async () => {
  const vg = fake()
  const logged = []
  const r = await applyPlan(twoField('old@example.org'), { vg, existingHolds: [], log: (d) => logged.push(d) })
  assert.deepEqual(vg.calls.find((c) => c[0] === 'patchPerson'), ['patchPerson', '7', { firstName: 'Janet' }])
  assert.equal(r.counts.stale, 1)
  assert.equal(r.counts.written, 1)
  assert.deepEqual(vg.calls.find((c) => c[0] === 'putSyncFields')[1].map((x) => x.field), ['firstName'])
  assert.deepEqual(logged.map((d) => [d.field, d.outcome]), [['email', 'stale'], ['firstName', 'written']])
})

const addrPlan = {
  ...emptyPlan,
  writes: [{
    kind: 'person', personId: '7', constituentId: '101',
    address: { street: '12 Elm St', city: 'Springfield', state: 'XX', zip: '99999' },
    fields: { address: { body: { street: '12 Elm St', zip: '99999' }, expect: comparable('address', vgFields(person()).address), agree: null, fingerprint: 'fa' } },
  }],
}

test('an address write geocodes the street and carries the town', async () => {
  const vg = fake()
  await applyPlan(addrPlan, { vg, existingHolds: [] })
  assert.deepEqual(vg.calls.find((c) => c[0] === 'geocodeTown')[1], addrPlan.writes[0].address)
  assert.deepEqual(vg.calls.find((c) => c[0] === 'patchPerson')[2], { street: '12 Elm St', zip: '99999', town: 'Springfield' })
})

test('an unresolved town is written as null and counted', async () => {
  const vg = fake({ town: { town: null } })
  const logged = []
  const r = await applyPlan(addrPlan, { vg, existingHolds: [], log: (d) => logged.push(d) })
  assert.equal(vg.calls.find((c) => c[0] === 'patchPerson')[2].town, null)
  assert.equal(r.counts.townMissing, 1)
  assert.equal(logged[0].note, 'town not resolved')
})

test('a 422 opens a vg-refused hold, records no memory, and the next write is still made', async () => {
  const vg = fake({ patchErr: { 7: 422 } })
  const plan = twoField(emailC(person()))
  plan.writes.push({ kind: 'person', personId: '8', constituentId: '101', address: null,
    fields: { firstName: { body: { firstName: 'Janet' }, expect: comparable('firstName', 'Jane'), agree: agreeRow('8', 'firstName'), fingerprint: 'fc' } } })
  const r = await applyPlan(plan, { vg, existingHolds: [] })
  assert.equal(r.counts.refused, 2)
  const holds = vg.calls.find((c) => c[0] === 'createSyncHolds')[1]
  assert.deepEqual(holds.map((h) => [h.personId, h.field, h.reason, h.fingerprint, h.detail]), [
    ['7', 'firstName', 'vg-refused', 'fa', { error: 'bad firstName', attempted: { firstName: 'Janet' } }],
    ['7', 'email', 'vg-refused', 'fb', { error: 'bad email', attempted: { email: 'new@example.org' } }],
  ])
  assert.deepEqual(vg.calls.find((c) => c[0] === 'putSyncFields')[1].map((x) => x.personId), ['8'])
  // person 7: the two-field PATCH, then each field alone; person 8: one PATCH
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'patchPerson').map((c) => [c[1], Object.keys(c[2]).join(',')]),
    [['7', 'firstName,email'], ['7', 'firstName'], ['7', 'email'], ['8', 'firstName']])
})

test('a refused two-field PATCH is retried per field: the accepted one is written, only the refused one held', async () => {
  const vg = fake({ patchErr: { 7: (body) => ('email' in body ? 422 : undefined) } })
  const logged = []
  const r = await applyPlan(twoField(emailC(person())), { vg, existingHolds: [], log: (d) => logged.push(d) })
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'patchPerson').map((c) => c[2]),
    [{ firstName: 'Janet', email: 'new@example.org' }, { firstName: 'Janet' }, { email: 'new@example.org' }])
  assert.equal(r.counts.written, 1)
  assert.equal(r.counts.refused, 1)
  assert.deepEqual(vg.calls.find((c) => c[0] === 'putSyncFields')[1].map((x) => x.field), ['firstName'])
  const holds = vg.calls.find((c) => c[0] === 'createSyncHolds')[1]
  assert.deepEqual(holds.map((h) => [h.field, h.reason, h.fingerprint, h.detail]),
    [['email', 'vg-refused', 'fb', { error: 'bad email', attempted: { email: 'new@example.org' } }]])
  assert.deepEqual(logged.map((d) => [d.field, d.outcome]), [['firstName', 'written'], ['email', 'refused']])
})

test('a refused address hold carries the attempted address with its town', async () => {
  const vg = fake({ patchErr: { 7: 400 } })
  await applyPlan(addrPlan, { vg, existingHolds: [] })
  assert.equal(vg.calls.filter((c) => c[0] === 'patchPerson').length, 1) // a single field is not retried
  const h = vg.calls.find((c) => c[0] === 'createSyncHolds')[1][0]
  assert.deepEqual([h.field, h.detail], ['address', { error: 'bad street,zip,town', attempted: { street: '12 Elm St', zip: '99999', town: 'Springfield' } }])
})

test('a person no longer linked to the constituent is stale: nothing is written', async () => {
  const vg = fake({ people: { 7: person({ donor: { lglConstituentId: '202', lastGiftDate: null } }) } })
  const logged = []
  const plan = { ...twoField(emailC(person())), writes: [...twoField(emailC(person())).writes, ...donorPlan(null).writes] }
  const r = await applyPlan(plan, { vg, existingHolds: [], log: (d) => logged.push(d) })
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'getLinkedPersons').map((c) => c[1]), ['101', '101'])
  assert.ok(!names(vg).some((n) => ['patchPerson', 'putDonor', 'geocodeTown', 'putSyncFields', 'createSyncHolds'].includes(n)))
  assert.equal(r.counts.stale, 3)
  assert.deepEqual(logged.map((d) => [d.field, d.outcome]), [['firstName', 'stale'], ['email', 'stale'], ['lastGiftDate', 'stale']])
})

test('a 503 fails the pass before any memory or holds are sent', async () => {
  const vg = fake({ patchErr: { 7: 503 } })
  const plan = { ...twoField(emailC(person())), agree: [agreeRow('9', 'email')], holds: [{ lglConstituentId: '101', personId: '7', field: 'email', reason: 'couple', fingerprint: 'z', detail: {} }] }
  await assert.rejects(applyPlan(plan, { vg, existingHolds: [] }), { status: 503 })
  assert.ok(!names(vg).some((n) => n.startsWith('putSync') || n.endsWith('SyncHolds')))
})

test('a donor write is skipped when the fresh date differs from expect', async () => {
  const vg = fake({ people: { 7: person({ donor: { lglConstituentId: '101', lastGiftDate: '2025-05-05' } }) } })
  const r = await applyPlan(donorPlan(null), { vg, existingHolds: [] })
  assert.ok(!names(vg).includes('putDonor'))
  assert.equal(r.counts.stale, 1)
})

test('a donor write is skipped when the link changed (person absent from the re-read), made otherwise', async () => {
  const vg = fake({ people: { 7: person({ donor: { lglConstituentId: '202', lastGiftDate: null } }) } })
  await applyPlan(donorPlan(null), { vg, existingHolds: [] })
  assert.ok(!names(vg).includes('putDonor'))
  assert.deepEqual(vg.calls.find((c) => c[0] === 'getLinkedPersons'), ['getLinkedPersons', '101'])
  const vg2 = fake()
  const r = await applyPlan(donorPlan(null), { vg: vg2, existingHolds: [] })
  assert.deepEqual(vg2.calls.find((c) => c[0] === 'putDonor'), ['putDonor', '7', { lglConstituentId: '101', lastGiftDate: '2026-01-02' }])
  assert.equal(r.counts.written, 1)
})

test('a refused donor write opens a vg-refused hold on lastGiftDate', async () => {
  const vg = fake()
  vg.putDonor = async () => { throw Object.assign(new Error('no'), { status: 400 }) }
  await applyPlan(donorPlan(null), { vg, existingHolds: [] })
  const h = vg.calls.find((c) => c[0] === 'createSyncHolds')[1][0]
  assert.deepEqual([h.field, h.reason, h.fingerprint, h.lglConstituentId], ['lastGiftDate', 'vg-refused', 'fd', '101'])
  assert.deepEqual(h.detail, { error: 'no', attempted: { lglConstituentId: '101', lastGiftDate: '2026-01-02' } })
})

test('nothing to do sends no sync calls', async () => {
  const vg = fake()
  await applyPlan(emptyPlan, { vg, existingHolds: [] })
  assert.deepEqual(vg.calls, [])
})
