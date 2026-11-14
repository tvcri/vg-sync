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

// --- unlinked donors ---
// A VG fake with a mutable roster: createPerson adds a person, putDonor and deleteDonor change links.
function roster({ people = [], createErr = null, donorErr = null } = {}) {
  const calls = []
  const byId = new Map(people.map((p) => [String(p.personId), p]))
  let next = 500
  const rec = (name, fn) => async (...a) => { calls.push([name, ...a]); return fn ? fn(...a) : undefined }
  return {
    calls, byId,
    getLinkedPersons: rec('getLinkedPersons', (cid) => [...byId.values()].filter((p) => String(p.donor?.lglConstituentId) === String(cid))),
    listPersons: rec('listPersons', () => [...byId.values()]),
    createPerson: rec('createPerson', (body) => {
      if (createErr) throw Object.assign(new Error('refused'), { status: createErr })
      const p = person({ personId: String(next++), donor: null, email: body.email ?? null })
      byId.set(p.personId, p)
      return p
    }),
    putDonor: rec('putDonor', (id, body) => {
      if (donorErr) throw Object.assign(new Error('refused'), { status: donorErr })
      byId.get(String(id)).donor = { lglConstituentId: body.lglConstituentId, lastGiftDate: body.lastGiftDate }
    }),
    deleteDonor: rec('deleteDonor', (id) => { byId.get(String(id)).donor = null; return null }),
    geocodeTown: rec('geocodeTown', () => ({ town: 'Springfield' })),
    putSyncFields: rec('putSyncFields', (rows) => rows.length),
    createSyncHolds: rec('createSyncHolds', (items) => items.map((h, i) => ({ holdId: `n${i}`, ...h }))),
    patchSyncHolds: rec('patchSyncHolds', (items) => items.length),
  }
}
const up = (o = {}) => ({ links: [], follows: [], unlinks: [], creates: [], finishes: [], holds: [], ...o })
const createW = { constituentId: '201', lastGiftDate: '2026-06-01', fingerprint: 'fc', body: { lastName: 'Doe', firstName: 'Jane', street: '12 Elm St', city: 'Springfield', state: 'RI', zip: '99999' }, address: { street: '12 Elm St', city: 'Springfield', state: 'RI', zip: '99999' }, agree: [{ field: 'lastName', lglConstituentId: '201', value: 'Doe', lglEntryId: null }] }
const same = (u) => () => u // replan: the fresh read changes nothing

test('a create: town, POST, create-unfinished hold, memory for the new person, donor row, then the hold closes', async () => {
  const vg = roster()
  const u = up({ creates: [createW] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: same(u) })
  assert.deepEqual(names(vg), ['listPersons', 'geocodeTown', 'createPerson', 'createSyncHolds', 'putSyncFields', 'putDonor', 'patchSyncHolds'])
  assert.equal(vg.calls[2][1].town, 'Springfield')
  assert.deepEqual(vg.calls[3][1].map((h) => [h.reason, h.personId, h.lglConstituentId]), [['create-unfinished', '500', '201']])
  assert.deepEqual(vg.calls[4][1], [{ personId: '500', field: 'lastName', lglConstituentId: '201', value: 'Doe', lglEntryId: null }])
  assert.deepEqual(vg.calls[5].slice(1), ['500', { lglConstituentId: '201', lastGiftDate: '2026-06-01' }])
  assert.deepEqual(vg.calls[6][1], [{ holdId: 'n0', state: 'closed' }])
  assert.equal(r.counts.unlinked.created, 1)
})

test('a donor row refused after the create leaves the create-unfinished hold open', async () => {
  const vg = roster({ donorErr: 422 })
  const u = up({ creates: [createW] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: same(u) })
  assert.equal(names(vg).filter((n) => n === 'patchSyncHolds').length, 0)
  assert.equal(r.counts.unlinked.refused, 1)
  const opened = vg.calls.filter((c) => c[0] === 'createSyncHolds').flatMap((c) => c[1]).map((h) => h.reason)
  assert.deepEqual(opened, ['create-unfinished', 'vg-refused'])
})

test('a refused create opens a vg-refused hold on the constituent and the pass carries on', async () => {
  const vg = roster({ createErr: 400 })
  const u = up({ creates: [createW] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: same(u) })
  const opened = vg.calls.filter((c) => c[0] === 'createSyncHolds').flatMap((c) => c[1])
  assert.deepEqual(opened.map((h) => [h.reason, h.lglConstituentId, h.personId, h.fingerprint]), [['vg-refused', '201', null, 'fc']])
  assert.equal(r.counts.unlinked.refused, 1)
})

test('a create or link the fresh plan no longer makes is skipped as stale', async () => {
  const vg = roster({ people: [person({ personId: '7', donor: null })] })
  const u = up({ creates: [createW], links: [{ personId: '7', constituentId: '202', lastGiftDate: null, fingerprint: 'fl' }] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: () => up() })
  assert.deepEqual(names(vg), ['listPersons'])
  assert.equal(r.counts.unlinked.stale, 2)
})

test('a link writes the donor row', async () => {
  const vg = roster({ people: [person({ personId: '7', donor: null })] })
  const u = up({ links: [{ personId: '7', constituentId: '202', lastGiftDate: '2026-06-01', fingerprint: 'fl' }] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: same(u) })
  assert.deepEqual(vg.byId.get('7').donor, { lglConstituentId: '202', lastGiftDate: '2026-06-01' })
  assert.equal(r.counts.unlinked.linked, 1)
})

test('an unlink deletes the donor row and opens an unlinked notice; a follow repoints it; both re-read first', async () => {
  const vg = roster({ people: [person({ personId: '7' }), person({ personId: '8', donor: { lglConstituentId: '150', lastGiftDate: null } })] })
  const u = up({
    unlinks: [{ personId: '7', constituentId: '101', reason: 'lgl-missing' }],
    follows: [{ personId: '8', constituentId: '201', from: '150', lastGiftDate: '2026-06-01', fingerprint: 'ff' }],
  })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, replan: same(u) })
  assert.equal(vg.byId.get('7').donor, null)
  assert.deepEqual(vg.byId.get('8').donor, { lglConstituentId: '201', lastGiftDate: '2026-06-01' })
  const opened = vg.calls.filter((c) => c[0] === 'createSyncHolds').flatMap((c) => c[1])
  assert.deepEqual(opened.map((h) => [h.reason, h.personId, h.lglConstituentId, h.detail]), [['unlinked', '7', '101', { why: 'lgl-missing' }]])
  assert.deepEqual([r.counts.unlinked.unlinked, r.counts.unlinked.followed], [1, 1])
  assert.equal(names(vg).includes('listPersons'), false) // nothing to link or create: no fresh read
})

test('an unlink whose person was relinked since the read is stale', async () => {
  const vg = roster({ people: [person({ personId: '7', donor: { lglConstituentId: '999', lastGiftDate: null } })] })
  const r = await applyPlan({ ...emptyPlan, unlinked: up({ unlinks: [{ personId: '7', constituentId: '101', reason: 'lgl-missing' }] }) }, { vg })
  assert.equal(names(vg).includes('deleteDonor'), false)
  assert.equal(r.counts.unlinked.stale, 1)
})

test('a finish writes the donor row and lets its create-unfinished hold close', async () => {
  const h = { holdId: '9', lglConstituentId: '201', personId: '7', field: null, reason: 'create-unfinished', fingerprint: 'cu', detail: null, state: 'open' }
  const vg = roster({ people: [person({ personId: '7', donor: null })] })
  const u = up({ finishes: [{ holdId: '9', personId: '7', constituentId: '201', lastGiftDate: '2026-06-01', hold: h }] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, existingHolds: [h], replan: same(u) })
  assert.equal(r.counts.unlinked.finished, 1)
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'patchSyncHolds').flatMap((c) => c[1]), [{ holdId: '9', state: 'closed' }])
})

test('a follow whose new record was linked to someone since the read is stale', async () => {
  const vg = roster({ people: [person({ personId: '8', donor: { lglConstituentId: '150', lastGiftDate: null } }), person({ personId: '9', donor: { lglConstituentId: '201', lastGiftDate: null } })] })
  const r = await applyPlan({ ...emptyPlan, unlinked: up({ follows: [{ personId: '8', constituentId: '201', from: '150', lastGiftDate: null, fingerprint: 'ff' }] }) }, { vg })
  assert.equal(names(vg).includes('putDonor'), false)
  assert.equal(r.counts.unlinked.stale, 1)
})

test('a refused finish keeps its create-unfinished hold open and opens no other', async () => {
  const h = { holdId: '9', lglConstituentId: '201', personId: '7', field: null, reason: 'create-unfinished', fingerprint: 'cu', detail: null, state: 'open' }
  const vg = roster({ people: [person({ personId: '7', donor: null })], donorErr: 422 })
  const u = up({ finishes: [{ holdId: '9', personId: '7', constituentId: '201', lastGiftDate: null, hold: h }] })
  const r = await applyPlan({ ...emptyPlan, unlinked: u }, { vg, existingHolds: [h], replan: () => u })
  assert.equal(r.counts.unlinked.refused, 1)
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'createSyncHolds'), [])
  assert.deepEqual(vg.calls.filter((c) => c[0] === 'patchSyncHolds').flatMap((c) => c[1]), [{ holdId: '9', seen: true }])
})
