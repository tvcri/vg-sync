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
    detail: { candidates: ['7'], lastGiftDate: '2026-06-01' },
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

test('a staff dismissal leaves the donor alone: no link, no create, no hold', () => {
  const p = run({ persons: [per(7)], holds: [hold({ lglConstituentId: '201', reason: 'import-skip', state: 'dismissed', dismissalKind: 'staff' })] })
  assert.deepEqual([p.links, p.creates, p.holds], [[], [], []])
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
  assert.deepEqual([p.links, p.holds], [[], [{ lglConstituentId: '201', personId: null, field: null, reason: 'import-hold', fingerprint: 'imp', detail: { importReason: 'x' } }]])
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
