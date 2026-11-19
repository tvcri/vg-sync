import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planUnlinked, createBody, sameName, unlinkedNotice } from '../../src/lgl-vg/unlinked.js'
import { unlinkedFingerprint } from '../../src/lgl-vg/match.js'

const config = { lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 }, createHorizonYears: 5 }
const today = '2026-11-14'

const con = (id, o = {}) => ({
  id, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  is_deceased: false, deceased_date: null, is_org: false,
  email_addresses: [{ id: id * 10 + 1, address: 'jane@example.org', is_preferred: true }],
  street_addresses: [{ id: id * 10 + 2, street: '12 Elm St', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }],
  phone_numbers: [{ id: id * 10 + 3, number: '(401) 555-0101', phone_type_name: 'Home', is_preferred: true }],
  ...o,
})
const per = (personId, { donor = null, email = 'jane@example.org', ...detail } = {}) => ({
  personId: String(personId), deceased: false, email, phone: { phone: null, cell: null }, donor,
  detail: { firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null, street: null, unit: null, city: null, state: null, zip: null, deceasedDate: null, ...detail },
})
const gift = (cid, date = '2026-06-01') => ({ id: cid * 100, constituent_id: cid, received_date: date, gift_type_id: 1, fund_id: 9, payment_type_id: 1 })
const hold = (o) => ({ holdId: '1', personId: null, field: null, fingerprint: 'f', detail: null, state: 'open', dismissalKind: null, ...o })

const run = ({ constituents = [con(201)], gifts, persons = [], holds = [], unlinking = [] } = {}) => planUnlinked({
  constituents, gifts: gifts ?? constituents.map((c) => gift(c.id)), persons, holds, unlinking, config, today,
})

test('exactly one person matches on email and name: link, with LGL\'s last gift date', () => {
  const p = run({ persons: [per(7)] })
  assert.deepEqual(p.links, [{ personId: '7', constituentId: '201', lastGiftDate: '2026-06-01', fingerprint: unlinkedFingerprint('link', ['7'], '2026-06-01') }])
  assert.deepEqual([p.creates, p.holds, p.follows, p.unlinks], [[], [], [], []])
  assert.deepEqual(p.decisions, [{ kind: 'unlinked', constituentId: '201', personId: '7', action: 'link', outcome: 'write-vg' }])
})

test('a linked constituent and a non-donor are not matched', () => {
  const p = run({
    constituents: [con(201), con(202)], gifts: [gift(201)],
    persons: [per(7, { donor: { lglConstituentId: '201', lastGiftDate: null } })],
  })
  assert.deepEqual([p.decisions, p.counts.unlinkedDonors], [[], 0])
})

test('nobody shares email, name or house: create, with the cleaned body and a memory row per clean field', () => {
  const c = con(201, { first_name: 'JANE', phone_numbers: [{ id: 1, number: '401-555-0102', phone_type_name: 'Mobile' }] })
  const p = run({ constituents: [c], persons: [per(7, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org' })] })
  assert.equal(p.creates.length, 1)
  const w = p.creates[0]
  assert.deepEqual(w.body, {
    firstName: 'Jane', lastName: 'Doe', email: 'jane@example.org',
    street: '12 Elm St', city: 'Springfield', state: 'RI', zip: '99999', cell: '401-555-0102',
  })
  assert.deepEqual(w.address, { street: '12 Elm St', city: 'Springfield', state: 'RI', zip: '99999' })
  assert.deepEqual(w.agree.map((r) => r.field), ['firstName', 'lastName', 'suffix', 'nickname', 'address', 'email', 'phones', 'deceased'])
  assert.deepEqual(w.agree.find((r) => r.field === 'suffix'), { field: 'suffix', lglConstituentId: '201', value: null, lglEntryId: null })
  assert.equal(w.agree.find((r) => r.field === 'email').lglEntryId, '2011')
  assert.deepEqual(w.agree.find((r) => r.field === 'phones').value, { phone: null, cell: '401-555-0102' })
  assert.equal(w.lastGiftDate, '2026-06-01')
})

test('createBody leaves an unclean field out of the body and out of memory', () => {
  const c = con(201, { email_addresses: [{ id: 1, address: 'jane@', is_preferred: true }] })
  const { body, agree } = createBody(c)
  assert.equal(body.email, undefined)
  assert.equal(agree.some((r) => r.field === 'email'), false)
})

test('holds carry reason, candidates and a fingerprint from the facts', () => {
  const p = run({ persons: [per(7, { email: 'other@example.org' })] })
  assert.deepEqual(p.holds, [{
    lglConstituentId: '201', personId: null, field: null, reason: 'name-only',
    fingerprint: unlinkedFingerprint('name-only', ['7'], '2026-06-01'),
    detail: { candidates: ['7'], lastGiftDate: '2026-06-01', lgl: LGL },
  }])
  assert.deepEqual([p.links, p.creates], [[], []])
  assert.equal(p.counts.hold['name-only'], 1)
})

test('the design\'s duplicate rules: a couple name, two donors to one person, two look-alike donors are all held', () => {
  assert.equal(run({ constituents: [con(201, { first_name: 'Pat and Lee' })] }).holds[0].reason, 'couple-name')
  const two = run({ constituents: [con(201), con(202)], persons: [per(7)] })
  assert.deepEqual(two.holds.map((h) => h.reason), ['duplicate-in-lgl', 'duplicate-in-lgl'])
  const alike = run({ constituents: [con(201), con(202, { email_addresses: [{ id: 9, address: 'j2@example.org', is_preferred: true }] })] })
  assert.deepEqual([alike.creates.length, alike.holds.map((h) => h.reason)], [0, ['duplicate-in-lgl', 'duplicate-in-lgl']])
})

test('deceased, before the horizon, no last name: held, never created', () => {
  assert.equal(run({ constituents: [con(201, { is_deceased: true })] }).holds[0].reason, 'deceased-in-lgl')
  assert.equal(run({ gifts: [gift(201, '2019-01-01')] }).holds[0].reason, 'before-horizon')
  assert.equal(run({ constituents: [con(201, { last_name: '' })] }).holds[0].reason, 'no-last-name')
})

test('a staff dismissal leaves the donor alone: no link, no create, no new hold', () => {
  const p = run({ persons: [per(7)], holds: [hold({ lglConstituentId: '201', reason: 'import-skip', state: 'dismissed', dismissalKind: 'staff' })] })
  assert.deepEqual([p.links, p.creates, p.holds.map((h) => h.reason)], [[], [], ['import-skip']])
  assert.deepEqual(p.decisions.map((d) => [d.outcome, d.note]), [['skip', 'left-alone']])
})

test('a rule dismissal is not a reason to leave alone: matching runs and desires the same hold', () => {
  const fp = unlinkedFingerprint('before-horizon', [], '2019-01-01')
  const p = run({ gifts: [gift(201, '2019-01-01')], holds: [hold({ lglConstituentId: '201', reason: 'before-horizon', fingerprint: fp, state: 'dismissed', dismissalKind: 'rule' })] })
  assert.deepEqual(p.holds.map((h) => [h.reason, h.fingerprint]), [['before-horizon', fp]])
})

test('an open import hold leaves the donor alone and is desired again; it is not desired once the donor is linked', () => {
  const h = hold({ holdId: '4', lglConstituentId: '201', reason: 'import-hold', fingerprint: 'imp', detail: { importReason: 'x' } })
  const p = run({ persons: [per(7)], holds: [h] })
  assert.deepEqual([p.links, p.holds], [[], [{ lglConstituentId: '201', personId: null, field: null, reason: 'import-hold', fingerprint: 'imp', detail: { importReason: 'x', lgl: LGL } }]])
  const linked = run({ persons: [per(7, { donor: { lglConstituentId: '201', lastGiftDate: null } })], holds: [h] })
  assert.deepEqual(linked.holds, [])
})

test('a refused create or link is held as vg-refused while the facts are unchanged', () => {
  const fp = unlinkedFingerprint('create', [], '2026-06-01')
  const p = run({ holds: [hold({ lglConstituentId: '201', reason: 'vg-refused', fingerprint: fp, state: 'dismissed', dismissalKind: 'rule' })] })
  assert.deepEqual([p.creates, p.holds.map((h) => h.reason)], [[], ['vg-refused']])
  const changed = run({ gifts: [gift(201, '2026-07-01')], holds: [hold({ lglConstituentId: '201', reason: 'vg-refused', fingerprint: fp })] })
  assert.equal(changed.creates.length, 1)
})

test('an unfinished create is finished when the person still has no donor row and the same name', () => {
  const h = hold({ holdId: '9', lglConstituentId: '201', personId: '7', reason: 'create-unfinished', fingerprint: 'cu' })
  const p = run({ persons: [per(7)], holds: [h] })
  assert.deepEqual(p.finishes.map((f) => [f.holdId, f.personId, f.constituentId, f.lastGiftDate]), [['9', '7', '201', '2026-06-01']])
  assert.deepEqual([p.links, p.creates, p.holds], [[], [], []])

  const renamed = run({ persons: [per(7, { firstName: 'Ann' })], holds: [h] })
  assert.deepEqual([renamed.finishes, renamed.creates, renamed.holds.map((x) => x.reason)], [[], [], ['create-unfinished']])

  const done = run({ persons: [per(7, { donor: { lglConstituentId: '201', lastGiftDate: null } })], holds: [h] })
  assert.deepEqual([done.finishes, done.holds], [[], []])
})

test('a person unlinked from a gone constituent: unlinked, or followed to the one unlinked donor that matches', () => {
  const was = per(7, { donor: { lglConstituentId: '150', lastGiftDate: null } })
  const unlinking = [{ personId: '7', constituentId: '150', reason: 'lgl-missing' }]
  const follow = run({ persons: [was], unlinking })
  assert.deepEqual(follow.follows.map((f) => [f.personId, f.constituentId, f.from]), [['7', '201', '150']])
  assert.deepEqual([follow.links, follow.unlinks], [[], []])
  assert.deepEqual(follow.decisions.map((d) => [d.action, d.outcome]), [['follow', 'write-vg']])

  const gone = run({ constituents: [con(201, { email_addresses: [] , first_name: 'Ann' })], persons: [was], unlinking })
  assert.deepEqual(gone.unlinks, [{ personId: '7', constituentId: '150', reason: 'lgl-missing' }])
  assert.deepEqual(gone.decisions.filter((d) => d.action === 'unlink').map((d) => [d.personId, d.outcome]), [['7', 'write-vg']])
})

test('an unlinked notice stays desired while its person has no donor row', () => {
  const n = { holdId: '3', state: 'open', ...unlinkedNotice({ personId: '7', constituentId: '150', reason: 'lgl-missing' }) }
  const p = run({ constituents: [], persons: [per(7)], holds: [n] })
  assert.deepEqual(p.holds.map((h) => [h.reason, h.personId]), [['unlinked', '7']])
  const relinked = run({ persons: [per(7)], holds: [n] })
  assert.deepEqual([relinked.links.length, relinked.holds], [1, []])
})

test('sameName compares in comparable form and refuses an empty name', () => {
  assert.equal(sameName(con(1, { first_name: 'JANE' }), per(7)), true)
  assert.equal(sameName(con(1, { first_name: 'Janet' }), per(7)), false)
  assert.equal(sameName(con(1, { first_name: null }), per(7, { firstName: null })), false)
})

// --- staff resolutions (a hold with no person, resolved in VG) ---
const LGL = { name: 'Jane Doe', email: 'jane@example.org', address: '12 Elm St, Springfield, RI 99999', lastGiftDate: '2026-06-01' }
const resolved = (resolution, o = {}) => hold({ holdId: '40', lglConstituentId: '201', reason: 'name-only', fingerprint: 'nf', resolution, ...o })
const failedHold = (p) => p.holds.filter((h) => h.reason === 'resolution-failed')
const ids = (list) => list.map((h) => h.holdId)

test('every unlinked-donor hold says who the donor is in detail.lgl', () => {
  const p = run({ persons: [per(7, { email: 'other@example.org' })] })
  assert.deepEqual(p.holds[0].detail, { candidates: ['7'], lastGiftDate: '2026-06-01', lgl: LGL })
  const c = con(201, { suffix: 'Jr.', email_addresses: [], street_addresses: [{ id: 1, street: '3 Oak Rd\nApt 2', city: 'Springfield', state: 'RI', postal_code: '99999-1234', is_preferred: true }] })
  assert.deepEqual(run({ constituents: [c], persons: [per(7)] }).holds[0].detail.lgl,
    { name: 'Jane Doe Jr.', email: null, address: '3 Oak Rd, Apt 2, Springfield, RI 99999-1234', lastGiftDate: '2026-06-01' })
})

test('an open import hold and a staff dismissal are desired again with detail.lgl, keeping their fingerprints', () => {
  const imp = hold({ holdId: '4', lglConstituentId: '201', reason: 'import-hold', fingerprint: 'imp', detail: { importReason: 'x' } })
  assert.deepEqual(run({ persons: [per(7)], holds: [imp] }).holds[0].detail, { importReason: 'x', lgl: LGL })
  const skip = hold({ holdId: '5', lglConstituentId: '201', reason: 'import-skip', fingerprint: 'sk', state: 'dismissed', dismissalKind: 'staff' })
  const p = run({ persons: [per(7)], holds: [skip] })
  assert.deepEqual(p.holds, [{ lglConstituentId: '201', personId: null, field: null, reason: 'import-skip', fingerprint: 'sk', detail: { lgl: LGL } }])
  assert.deepEqual([p.links, p.creates], [[], []])
})

test('a resolved link is carried out instead of matching: the hold travels with the write', () => {
  const h = resolved({ kind: 'link', personId: '8' })
  // matching alone would hold this donor (name-only on person 7)
  const p = run({ persons: [per(7, { email: 'other@example.org' }), per(8, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org' })], holds: [h] })
  assert.deepEqual(p.links, [{ personId: '8', constituentId: '201', lastGiftDate: '2026-06-01', fingerprint: unlinkedFingerprint('link', ['8'], '2026-06-01'), hold: h }])
  assert.deepEqual([p.holds, p.close, p.creates], [[], [], []])
  assert.deepEqual(p.decisions, [{ kind: 'unlinked', constituentId: '201', personId: '8', action: 'link', outcome: 'write-vg', note: 'resolution' }])
  assert.equal(p.counts.resolution.link, 1)
})

test('a resolved create builds the person from LGL\'s record, even where matching would hold', () => {
  const h = resolved({ kind: 'create' }, { reason: 'import-skip', fingerprint: 'sk' }) // a staff Skip reopened by a resolution
  const p = run({ persons: [per(7, { email: 'other@example.org' })], holds: [h] })
  assert.equal(p.creates.length, 1)
  assert.deepEqual([p.creates[0].constituentId, p.creates[0].hold, p.creates[0].body.lastName], ['201', h, 'Doe'])
  assert.deepEqual([p.holds, p.close], [[], []])
})

test('a resolution with no resolution field (VG before its migration) is no resolution', () => {
  const h = hold({ lglConstituentId: '201', reason: 'name-only', fingerprint: unlinkedFingerprint('name-only', ['7'], '2026-06-01') })
  const p = run({ persons: [per(7, { email: 'other@example.org' })], holds: [h] })
  assert.deepEqual([p.links, p.holds.map((x) => x.reason)], [[], ['name-only']])
})

const failsWith = (p, message) => {
  assert.deepEqual(ids(p.close), ['40'])
  assert.deepEqual([p.links, p.creates], [[], []])
  const [f] = failedHold(p)
  assert.deepEqual([f.lglConstituentId, f.personId, f.field, f.detail.message], ['201', null, null, message])
  return f
}

test('a resolution whose person is gone fails: the hold closes and resolution-failed opens', () => {
  const r = { kind: 'link', personId: '8' }
  const f = failsWith(run({ persons: [per(7, { email: 'other@example.org' })], holds: [resolved(r)] }), 'The VG person chosen for this donor no longer exists.')
  assert.deepEqual(f.detail, { resolution: r, message: 'The VG person chosen for this donor no longer exists.', lgl: LGL })
})

test('a resolution to a person now linked to another donor fails, naming the person', () => {
  const p = run({ persons: [per(8, { firstName: 'Ann', lastName: 'Roe', donor: { lglConstituentId: '300', lastGiftDate: null } })], holds: [resolved({ kind: 'link', personId: '8' })] })
  failsWith(p, 'Roe, Ann is already linked to another LGL donor.')
})

test('a resolution for a donor gone from LGL, or no longer a donor, fails', () => {
  failsWith(run({ constituents: [], holds: [resolved({ kind: 'create' })] }), 'This donor is no longer in LGL.')
  failsWith(run({ gifts: [], holds: [resolved({ kind: 'create' })] }), 'This LGL record is no longer a donor.')
})

test('a resolution whose donor is now linked: to the chosen person it is done, to anyone else it fails', () => {
  const linked = (id) => per(id, { firstName: 'Ann', lastName: 'Roe', donor: { lglConstituentId: '201', lastGiftDate: null } })
  const done = run({ persons: [linked(8)], holds: [resolved({ kind: 'link', personId: '8' })] })
  assert.deepEqual([ids(done.close), failedHold(done), done.links], [['40'], [], []])
  assert.equal(done.counts.resolution.done, 1)
  const created = run({ persons: [linked(9)], holds: [resolved({ kind: 'create' })] })
  assert.deepEqual([ids(created.close), failedHold(created), created.creates], [['40'], [], []])
  failsWith(run({ persons: [linked(9)], holds: [resolved({ kind: 'link', personId: '8' })] }), 'This LGL donor is already linked to Roe, Ann in VG.')
})

test('an unreadable resolution fails', () => {
  failsWith(run({ holds: [resolved({ kind: 'merge' })] }), 'The answer recorded for this donor could not be read.')
  failsWith(run({ holds: [resolved({ kind: 'link' })] }), 'The answer recorded for this donor could not be read.')
})

test('two donors resolved to the same person both fail', () => {
  const p = run({
    constituents: [con(201), con(202, { first_name: 'Ann' })],
    persons: [per(8, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org' })],
    holds: [resolved({ kind: 'link', personId: '8' }), resolved({ kind: 'link', personId: '8' }, { holdId: '41', lglConstituentId: '202' })],
  })
  assert.deepEqual([ids(p.close), p.links], [['40', '41'], []])
  assert.deepEqual(failedHold(p).map((h) => h.detail.message), ['Roe, Ann was chosen for two LGL donors; choose again.', 'Roe, Ann was chosen for two LGL donors; choose again.'])
})

test('matching never links a second donor to a person a resolution is linking', () => {
  const p = run({
    constituents: [con(201), con(202, { first_name: 'Ann', last_name: 'Roe', email_addresses: [{ id: 9, address: 'ann@example.org', is_preferred: true }] })],
    persons: [per(8, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org' })],
    holds: [resolved({ kind: 'link', personId: '8' })],
  })
  assert.deepEqual(p.links.map((w) => w.constituentId), ['201'])
  assert.deepEqual(p.holds.map((h) => [h.lglConstituentId, h.reason, h.detail.candidates]), [['202', 'already-linked-elsewhere', ['8']]])
})

test('an open resolution-failed hold keeps its donor out of matching and stays open until the donor is linked', () => {
  const f = hold({ holdId: '50', lglConstituentId: '201', reason: 'resolution-failed', fingerprint: 'rf', detail: { resolution: { kind: 'create' }, message: 'm' } })
  const p = run({ persons: [per(7)], holds: [f] })
  assert.deepEqual([p.links, p.holds.map((h) => [h.reason, h.fingerprint, h.detail.message])], [[], [['resolution-failed', 'rf', 'm']]])
  assert.deepEqual(run({ persons: [per(7, { donor: { lglConstituentId: '201', lastGiftDate: null } })], holds: [f] }).holds, [])
})

test('a resolved resolution-failed hold that fails again is closed, and a new one is desired', () => {
  const p = run({ holds: [resolved({ kind: 'link', personId: '8' }, { reason: 'resolution-failed' })] })
  assert.deepEqual(ids(p.close), ['40'])
  assert.equal(failedHold(p).length, 1)
})

test('of two resolved holds on one donor, the latest resolution is carried out and the other closes', () => {
  const older = resolved({ kind: 'create' }, { holdId: '40', resolvedAt: '2026-11-17T10:00:00.000Z' })
  const newer = resolved({ kind: 'link', personId: '8' }, { holdId: '41', reason: 'import-hold', resolvedAt: '2026-11-17T11:00:00.000Z' })
  const p = run({ persons: [per(8, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org' })], holds: [older, newer] })
  assert.deepEqual([p.links.map((w) => w.hold.holdId), p.creates, ids(p.close)], [['41'], [], ['40']])
})

test('a person created from LGL with more numbers than VG has slots gets two, and the memory records those two', () => {
  const c = con(201, { phone_numbers: [
    { id: 1, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true },
    { id: 2, number: '401-555-0102', phone_type_name: 'Mobile' },
    { id: 3, number: '401-555-0103', phone_type_name: 'Work' },
  ] })
  const { body, agree } = createBody(c)
  assert.deepEqual([body.phone, body.cell], ['401-555-0101', '401-555-0102'])
  assert.deepEqual(agree.find((r) => r.field === 'phones').value, { phone: '401-555-0101', cell: '401-555-0102' })
})
