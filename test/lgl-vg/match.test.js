import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchUnlinked } from '../../src/lgl-vg/match.js'

const OPT = { today: '2026-11-11', horizonYears: 5 }
const cons = (o = {}) => ({
  id: 1, first_name: 'Jane', last_name: 'Doe', nick_name: null, is_deceased: false, is_org: false,
  email_addresses: [], street_addresses: [], ...o,
})
const email = (address, o = {}) => ({ address, is_preferred: true, not_current: false, ...o })
const street = (s, zip, o = {}) => ({ street: s, postal_code: zip, zip5: zip.slice(0, 5), is_preferred: true, not_current: false, ...o })
const donor = (o = {}, lastGiftDate = '2025-01-01') => ({ constituent: cons(o), lastGiftDate })
const person = (o = {}, d = {}) => ({
  personId: 100, deceased: false, email: null, phone: null, donor: null,
  detail: { firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null, street: null, unit: null, city: null, state: null, zip: null, deceasedDate: null, ...d },
  ...o,
})
const one = (donors, persons = [], opt = OPT) => matchUnlinked(donors, persons, opt)[0]

test('anonymous', () => {
  assert.deepEqual(one([donor({ first_name: 'Anonymous' })]), { constituentId: 1, outcome: 'hold', reason: 'anonymous' })
  assert.equal(one([donor({ last_name: 'anonymous donor' })]).reason, 'anonymous')
})
test('an "is_anon" donor with a real name is not treated as anonymous', () => {
  assert.equal(one([donor({ is_anon: true })]).outcome, 'create')
})
test('deceased-in-lgl', () => assert.equal(one([donor({ is_deceased: true })]).reason, 'deceased-in-lgl'))
test('couple-name', () => {
  assert.equal(one([donor({ first_name: 'Jane and John' })]).reason, 'couple-name')
  assert.equal(one([donor({ last_name: 'Doe & Roe' })]).reason, 'couple-name')
})
test('already-linked-elsewhere', () => {
  const p = person({ email: 'jane@example.org', donor: { lglConstituentId: 999, lastGiftDate: null } })
  assert.equal(one([donor({ email_addresses: [email('jane@example.org')] })], [p]).reason, 'already-linked-elsewhere')
})
test('email-and-name links, even when the person is already linked to this constituent', () => {
  const p = person({ email: 'Jane@Example.org', donor: { lglConstituentId: '1', lastGiftDate: null } })
  assert.deepEqual(one([donor({ email_addresses: [email('jane@example.org')] })], [p]),
    { constituentId: 1, outcome: 'link', reason: 'email-and-name', personId: 100 })
})
test('multiple-matches', () => {
  const ps = [person({ personId: 1, email: 'j@example.org' }), person({ personId: 2, email: 'j@example.org' })]
  assert.equal(one([donor({ email_addresses: [email('j@example.org')] })], ps).reason, 'multiple-matches')
})
test('shared-email-different-name', () => {
  const p = person({ email: 'j@example.org' }, { firstName: 'John' })
  assert.equal(one([donor({ email_addresses: [email('j@example.org')] })], [p]).reason, 'shared-email-different-name')
})
test('a shared household email with a different name is held, not linked', () => {
  const p = person({ email: 'house@example.org' }, { firstName: 'Rick', lastName: 'Roe' })
  const r = one([donor({ email_addresses: [email('house@example.org')] })], [p])
  assert.equal(r.outcome, 'hold')
  assert.equal(r.personId, undefined)
})
test('name-only', () => assert.equal(one([donor()], [person()]).reason, 'name-only'))
test('same-address-last-name', () => {
  const p = person({}, { firstName: 'Joan', street: '12 Elm Street', zip: '02903' })
  const d = donor({ first_name: 'Jim', street_addresses: [street('12 Elm St', '02903-1234')] })
  assert.equal(one([d], [p]).reason, 'same-address-last-name')
})
test('no-last-name', () => assert.equal(one([donor({ last_name: '' })]).reason, 'no-last-name'))
test('before-horizon', () => {
  assert.equal(one([donor({}, null)]).reason, 'before-horizon')
  assert.equal(one([donor({}, '2015-01-01')]).reason, 'before-horizon')
})
test('new', () => assert.deepEqual(one([donor()]), { constituentId: 1, outcome: 'create', reason: 'new' }))

test('matches the VG parenthetical nickname: LGL "Bob Doe" links to VG "Robert (Bob)" with the same email', () => {
  const p = person({ email: 'bob@example.org' }, { firstName: 'Robert (Bob)' })
  const r = one([donor({ first_name: 'Bob', email_addresses: [email('bob@example.org')] })], [p])
  assert.equal(r.outcome, 'link')
})
test('matches the VG nickname field', () => {
  const p = person({ email: 'bob@example.org' }, { firstName: 'Robert', nickname: 'Bob' })
  const r = one([donor({ first_name: 'Bob', email_addresses: [email('bob@example.org')] })], [p])
  assert.equal(r.outcome, 'link')
})
test('a not_current email is not used for matching', () => {
  const p = person({ email: 'jane@example.org' })
  const r = one([donor({ email_addresses: [email('jane@example.org', { not_current: true })] })], [p])
  assert.equal(r.reason, 'name-only')
})
test('two LGL donors that link to the same VG person are both held as duplicate-in-lgl', () => {
  const p = person({ email: 'jane@example.org' })
  const e = [email('jane@example.org')]
  const r = matchUnlinked([donor({ id: 1, email_addresses: e }), donor({ id: 2, email_addresses: e })], [p], OPT)
  assert.deepEqual(r.map((d) => [d.outcome, d.reason, d.personId]), [['hold', 'duplicate-in-lgl', undefined], ['hold', 'duplicate-in-lgl', undefined]])
})
test('two new LGL donors with the same name are both held as duplicate-in-lgl', () => {
  const r = matchUnlinked([donor({ id: 1 }), donor({ id: 2 })], [], OPT)
  assert.deepEqual(r.map((d) => d.reason), ['duplicate-in-lgl', 'duplicate-in-lgl'])
})
test('near-duplicate new donors (last names one edit apart, same zip) are held', () => {
  const z = [street('1 Elm St', '02903')]
  const r = matchUnlinked([donor({ id: 1, last_name: 'Dow', street_addresses: z }), donor({ id: 2, last_name: 'Doe', street_addresses: z }), donor({ id: 3, first_name: 'Zed', last_name: 'Doe', street_addresses: z })], [], OPT)
  assert.deepEqual(r.map((d) => d.reason), ['duplicate-in-lgl', 'duplicate-in-lgl', 'new'])
})
test('a donor exactly on the horizon is created; one day older is held', () => {
  assert.equal(one([donor({}, '2021-11-11')]).outcome, 'create')
  assert.equal(one([donor({}, '2021-11-10')]).reason, 'before-horizon')
})
test('Feb 29 today uses Feb 28 as the cutoff', () => {
  const o = { today: '2028-02-29', horizonYears: 5 }
  assert.equal(one([donor({}, '2023-02-28')], [], o).outcome, 'create')
  assert.equal(one([donor({}, '2023-02-27')], [], o).reason, 'before-horizon')
})
test('inputs are not mutated', () => {
  const ds = [donor()], ps = [person()]
  const snap = JSON.stringify([ds, ps])
  matchUnlinked(ds, ps, OPT)
  assert.equal(JSON.stringify([ds, ps]), snap)
})

const z = [street('1 Elm St', '02903')]
test('same last name, nickname-compatible first names, same zip: both held as duplicate-in-lgl', () => {
  const r = matchUnlinked([donor({ id: 1, first_name: 'Bob', street_addresses: z }), donor({ id: 2, first_name: 'Robert', street_addresses: z })], [], OPT)
  assert.deepEqual(r.map((d) => d.reason), ['duplicate-in-lgl', 'duplicate-in-lgl'])
})
test('Jane Doe and Jane M Doe at the same zip are both held as duplicate-in-lgl', () => {
  const r = matchUnlinked([donor({ id: 1, street_addresses: z }), donor({ id: 2, first_name: 'Jane M', street_addresses: z })], [], OPT)
  assert.deepEqual(r.map((d) => d.reason), ['duplicate-in-lgl', 'duplicate-in-lgl'])
})
test('Jane Doe and John Doe at the same zip are both created', () => {
  const r = matchUnlinked([donor({ id: 1, street_addresses: z }), donor({ id: 2, first_name: 'John', street_addresses: z })], [], OPT)
  assert.deepEqual(r.map((d) => d.outcome), ['create', 'create'])
})
test('no last name is held before matching, even with an email shared with a person with no last name', () => {
  const p = person({ email: 'x@example.org' }, { firstName: 'Jane', lastName: '' })
  const r = one([donor({ last_name: '', email_addresses: [email('x@example.org')] })], [p])
  assert.deepEqual(r, { constituentId: 1, outcome: 'hold', reason: 'no-last-name' })
})
test('two different emails resolving to two different VG people with the same name are held as multiple-matches', () => {
  const ps = [person({ personId: 1, email: 'a@example.org' }), person({ personId: 2, email: 'b@example.org' })]
  const r = one([donor({ email_addresses: [email('a@example.org'), email('b@example.org', { is_preferred: false })] })], ps)
  assert.equal(r.reason, 'multiple-matches')
})

test('a new donor that looks like a donor who links is held; the link stays', () => {
  const p = person({ email: 'a@example.org' })
  const jane = donor({ id: 1, email_addresses: [email('a@example.org')], street_addresses: [street('1 Oak St', '02903')] })
  const jayne = donor({ id: 2, first_name: 'Jayne', email_addresses: [email('b@example.org')], street_addresses: [street('9 Pine St', '02903')] })
  const r = matchUnlinked([jane, jayne], [p], OPT)
  assert.deepEqual(r.map((d) => [d.outcome, d.reason]), [['link', 'email-and-name'], ['hold', 'duplicate-in-lgl']])
})
test('a new donor that looks like a held donor is held duplicate-in-lgl; the held donor keeps its reason', () => {
  const p = person({ email: 'a@example.org' }, { firstName: 'John' })
  const a = donor({ id: 1, email_addresses: [email('a@example.org')], street_addresses: [street('1 Oak St', '02903')] })
  const b = donor({ id: 2, first_name: 'Jayne', email_addresses: [email('b@example.org')], street_addresses: [street('9 Pine St', '02903')] })
  const r = matchUnlinked([a, b], [p], OPT)
  assert.deepEqual(r.map((d) => d.reason), ['shared-email-different-name', 'duplicate-in-lgl'])
})
test('a hyphen in a last name matches the same name written with a space', () => {
  const p = person({ email: 'a@example.org' }, { lastName: 'Doe Smith' })
  const r = one([donor({ last_name: 'Doe-Smith', email_addresses: [email('a@example.org')] })], [p])
  assert.equal(r.outcome, 'link')
})
