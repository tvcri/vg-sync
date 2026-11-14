import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDonors } from '../../src/lgl-vg/donors.js'

const ids = { membershipFundId: 11, paypalPaymentTypeId: 22 }
const person = (id, o = {}) => ({ id, is_org: false, ...o })
const gift = (constituent_id, o = {}) => ({ constituent_id, gift_type_id: 1, fund_id: 5, payment_type_id: 9, received_date: '2026-01-10', ...o })
const dues = (constituent_id, o = {}) => gift(constituent_id, { fund_id: 11, payment_type_id: 22, ...o })
const run = (constituents, gifts) => classifyDonors(constituents, gifts, ids)

test('one ordinary gift makes a donor with that date', () => {
  const r = run([person(1)], [gift(1)])
  assert.deepEqual(r.get(1), { isDonor: true, lastGiftDate: '2026-01-10' })
})

test('dues only (membership fund paid by PayPal) is not a donor', () => {
  const r = run([person(1)], [dues(1)])
  assert.deepEqual(r.get(1), { isDonor: false, lastGiftDate: null })
})

test('PayPal to another fund counts; the membership fund paid by check counts', () => {
  const r = run([person(1), person(2)], [
    gift(1, { payment_type_id: 22 }),
    gift(2, { fund_id: 11 }),
  ])
  assert.equal(r.get(1).isDonor, true)
  assert.equal(r.get(2).isDonor, true)
})

test('pledge, soft credit and peer credit (types 7, 9, 15) never count', () => {
  const r = run([person(1), person(2), person(3)], [
    gift(1, { gift_type_id: 7 }),
    gift(2, { gift_type_id: 9 }),
    gift(3, { gift_type_id: 15 }),
  ])
  for (const id of [1, 2, 3]) assert.deepEqual(r.get(id), { isDonor: false, lastGiftDate: null })
})

test('an organization is never a donor', () => {
  const r = run([person(1, { is_org: true })], [gift(1)])
  assert.equal(r.get(1).isDonor, false)
})

test('an organization with an ordinary gift still reports the last gift date', () => {
  const r = run([person(1, { is_org: true })], [gift(1, { received_date: '2026-01-10' })])
  assert.deepEqual(r.get(1), { isDonor: false, lastGiftDate: '2026-01-10' })
})

test('last gift date is the latest non-dues date; a later dues payment does not move it', () => {
  const r = run([person(1)], [
    gift(1, { received_date: '2025-03-01' }),
    dues(1, { received_date: '2026-02-01' }),
  ])
  assert.deepEqual(r.get(1), { isDonor: true, lastGiftDate: '2025-03-01' })
})

test('a null received_date is ignored; a donor whose only gifts have no date has lastGiftDate null', () => {
  const r = run([person(1), person(2)], [
    gift(1, { received_date: null }),
    gift(1, { received_date: '2024-05-05' }),
    gift(2, { received_date: null }),
  ])
  assert.deepEqual(r.get(1), { isDonor: true, lastGiftDate: '2024-05-05' })
  assert.deepEqual(r.get(2), { isDonor: true, lastGiftDate: null })
})

test('a constituent with no gifts gets { isDonor: false, lastGiftDate: null }', () => {
  const r = run([person(1)], [])
  assert.deepEqual(r.get(1), { isDonor: false, lastGiftDate: null })
})

test('a gift whose constituent is not in the list is ignored', () => {
  const r = run([person(1)], [gift(99)])
  assert.equal(r.size, 1)
  assert.equal(r.has(99), false)
})
