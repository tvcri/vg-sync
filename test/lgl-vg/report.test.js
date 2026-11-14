import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from '../../src/lgl-vg/report.js'

const config = { lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 }, createHorizonYears: 5 }
const today = '2026-11-11'
const addr = (street, o = {}) => ({ street, city: 'Providence', state: 'RI', zip5: '02903', postal_code: '02903', is_preferred: true, not_current: false, ...o })
const cons = (id, first, last, o = {}) => ({
  id, first_name: first, last_name: last, nick_name: null, suffix: null, is_deceased: false, is_org: false,
  email_addresses: [], street_addresses: [], phone_numbers: [], ...o,
})
const gift = (id, constituent_id, received_date) => ({ id, constituent_id, received_date, gift_type_id: 1, fund_id: 9, payment_type_id: 1 })
const person = (personId, first, last, donor, { email = null, street = null } = {}) => ({
  personId, deceased: false, email, phone: null, donor,
  detail: {
    firstName: first, lastName: last, suffix: null, nickname: null, street, unit: null,
    city: street && 'Providence', state: street && 'RI', zip: street && '02903', deceasedDate: null,
  },
})

const constituents = [
  cons(1, 'Jane', 'Doe', { email_addresses: [{ address: 'jane@example.org', is_preferred: true, not_current: false }], street_addresses: [addr('12 Elm St')] }),
  cons(2, 'John', 'Roe', { street_addresses: [addr('5 Oak Ave')] }),
  cons(3, 'Pat', 'Lee', { street_addresses: [addr('7 Pine St', { city: '123' })] }),
  cons(4, 'Sam', 'Poe'),
]
const gifts = [gift(1, 1, '2025-06-01'), gift(2, 1, '2024-01-01'), gift(3, 2, '2025-03-03'), gift(4, 4, '2026-01-01')]
const persons = [
  person(10, 'Jane', 'Doe', { lglConstituentId: '1', lastGiftDate: '2025-06-01' }, { email: 'Jane@Example.org', street: '14 Elm St' }),
  person(20, 'Johnny', 'Roe', { lglConstituentId: '2', lastGiftDate: null }, { street: '5 Oak Avenue' }),
  person(21, 'Joan', 'Roe', { lglConstituentId: '2', lastGiftDate: null }, { street: '9 Oak Ave' }),
  person(30, 'Pat', 'Lee', { lglConstituentId: '3', lastGiftDate: null }),
  person(40, 'Ann', 'Gone', { lglConstituentId: '99', lastGiftDate: null }),
]
const run = () => buildReport({ constituents, gifts, persons, config, today })
const detailsOf = (r, kind) => r.details.filter((d) => d.kind === kind)

test('counts linked pairs, couples and unlinked donors', () => {
  assert.deepEqual(run().summary.counts, {
    constituents: 4, gifts: 4, personDonors: 3, vgPersons: 5, linkedPairs: 4, couples: 1,
    linkedMissingInLgl: 1, linkedNoLongerDonor: 1, unlinkedDonors: 1,
  })
  assert.deepEqual(run().summary.unlinked, { link: 0, create: 1, hold: {} })
  assert.deepEqual(detailsOf(run(), 'unlinked'), [{ kind: 'unlinked', constituentId: 4, outcome: 'create', reason: 'new', personId: null }])
})

test('a matching field is first-match; a differing one is never-agreed and appears in details with both values', () => {
  const r = run()
  assert.equal(r.summary.fields.email['first-match'], 4)
  assert.deepEqual(r.summary.fields.firstName, { 'first-match': 2, 'never-agreed': 0, unclean: 0, ambiguous: 0, 'couple-skipped': 2 })
  const d = detailsOf(r, 'field').find((x) => x.personId === 10 && x.field === 'address')
  assert.deepEqual(d, {
    kind: 'field', personId: 10, constituentId: 1, field: 'address',
    lgl: { street: '12 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' },
    vg: { street: '14 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' },
  })
})

test('a couple skips names and deceased for both partners and compares address for each', () => {
  const r = run()
  for (const f of ['lastName', 'suffix', 'nickname', 'deceased']) assert.equal(r.summary.fields[f]['couple-skipped'], 2, f)
  const fieldDetails = detailsOf(r, 'field').filter((x) => x.constituentId === 2)
  assert.deepEqual(fieldDetails.map((x) => [x.personId, x.field]), [[21, 'address']])
  assert.equal(r.summary.fields.address['first-match'], 1)
})

test('an unclean LGL address is counted as unclean and not compared', () => {
  const r = run()
  assert.equal(r.summary.fields.address.unclean, 1)
  const d = detailsOf(r, 'field').find((x) => x.personId === 30)
  assert.deepEqual(d, { kind: 'field', personId: 30, constituentId: 3, field: 'address', lgl: null, vg: null })
})

test('a donor row pointing at a constituent not in the pull is counted and listed, and compared nowhere', () => {
  const r = run()
  assert.deepEqual(detailsOf(r, 'linked-missing'), [{ kind: 'linked-missing', personId: 40, constituentId: '99' }])
  assert.equal(detailsOf(r, 'field').some((x) => x.personId === 40), false)
  assert.equal(r.summary.counts.linkedMissingInLgl, 1)
})

test('a linked constituent that is no longer a donor is counted and still compared', () => {
  const r = run()
  assert.deepEqual(detailsOf(r, 'linked-no-longer-donor'), [{ kind: 'linked-no-longer-donor', personId: 30, constituentId: 3 }])
  assert.equal(r.summary.fields.email['first-match'], 4)
})

test('last gift date differences are counted and listed', () => {
  const r = run()
  assert.deepEqual(r.summary.lastGiftDate, { same: 2, differs: 2 })
  assert.deepEqual(detailsOf(r, 'lastGiftDate').map((x) => [x.personId, x.lgl, x.vg]), [[20, '2025-03-03', null], [21, '2025-03-03', null]])
})

test('constituent ids compare as strings: VG "17" links to LGL 17', () => {
  const r = buildReport({
    constituents: [cons(17, 'Jane', 'Doe')], gifts: [gift(1, 17, '2025-01-01')],
    persons: [person(1, 'Jane', 'Doe', { lglConstituentId: '17', lastGiftDate: '2025-01-01' })], config, today,
  })
  assert.equal(r.summary.counts.linkedPairs, 1)
  assert.equal(r.summary.counts.unlinkedDonors, 0)
})

test('summary contains no names, emails, addresses or phone numbers', () => {
  const text = JSON.stringify(run().summary)
  for (const s of ['Jane', 'Doe', 'Roe', 'Poe', 'Lee', 'example.org', 'Elm', 'Oak', 'Pine', '401-555']) assert.equal(text.includes(s), false, s)
})
