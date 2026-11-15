import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  RECORD_REASONS, mergeLglChanges, lglCursorAfter, vgTouched, planCheck, breakerPeople, foundChange,
} from '../../src/lgl-vg/check-plan.js'
import { reconcileHolds } from '../../src/lgl-vg/holds.js'
import { unlinkedFingerprint } from '../../src/lgl-vg/match.js'
import { parsePolicy } from '../../src/lgl-vg/policy.js'
import { FIELDS, lglFields } from '../../src/lgl-vg/fields.js'

const policy = parsePolicy(readFileSync(new URL('../../policy.json', import.meta.url), 'utf8'))
const config = { lgl: { membershipFundId: 5, paypalPaymentTypeId: 2 }, createHorizonYears: 5 }
const today = '2026-11-15'

const con = (id, o = {}) => ({
  id, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  is_deceased: false, deceased_date: null, is_org: false,
  email_addresses: [{ id: id * 10 + 1, address: 'jane@example.org', is_preferred: true }],
  street_addresses: [{ id: id * 10 + 2, street: '12 Elm St', city: 'Springfield', state: 'RI', zip5: '99999', is_preferred: true }],
  phone_numbers: [],
  updated_at: '2026-11-15T10:00:00Z',
  ...o,
})
const per = (personId, { donor = null, email = 'jane@example.org', ...detail } = {}) => ({
  personId: String(personId), deceased: false, email, phone: { phone: null, cell: null }, donor,
  detail: {
    firstName: 'Jane', lastName: 'Doe', suffix: null, nickname: null,
    street: '12 Elm St', unit: null, city: 'Springfield', state: 'RI', zip: '99999', deceasedDate: null, ...detail,
  },
})
const linkTo = (cid, lastGiftDate = '2026-06-01') => ({ lglConstituentId: String(cid), lastGiftDate })
const gift = (cid, date = '2026-06-01', id = cid * 100) => ({ id, constituent_id: cid, received_date: date, gift_type_id: 1, fund_id: 9, payment_type_id: 1 })
const hold = (o) => ({ holdId: '1', personId: null, field: null, fingerprint: 'f', detail: null, state: 'open', dismissalKind: null, ...o })
// memory rows saying every field was agreed at the constituent's current LGL values
const agreedAt = (c, personId) => FIELDS.map((field) => ({
  personId: String(personId), field, lglConstituentId: String(c.id), value: lglFields(c).values[field], lglEntryId: null, agreedAt: '2026-11-01T00:00:00Z',
}))

const cacheOf = (constituents, gifts = constituents.map((c) => gift(c.id))) => ({
  constituents: new Map(constituents.map((c) => [String(c.id), c])),
  gifts: new Map(gifts.map((g) => [String(g.id), g])),
})
const check = ({ touched, cache, persons = [], memory = [], holds = [] }) =>
  planCheck({ touched: new Set(touched), cache, persons, memory, holds, policy, config, today })

// --- mergeLglChanges ---

test('an unchanged gift touches nothing', () => {
  const cache = cacheOf([con(101)])
  const { touched, cache: next } = mergeLglChanges(cache, { gifts: [{ ...gift(101) }] })
  assert.deepEqual([...touched], [])
  assert.deepEqual(next.gifts.get('10100'), gift(101))
})

test('a changed gift touches its constituent', () => {
  const cache = cacheOf([con(101), con(102)])
  const changed = mergeLglChanges(cache, { gifts: [gift(101, '2026-11-14')] })
  assert.deepEqual([...changed.touched], ['101'])
  assert.equal(changed.cache.gifts.get('10100').received_date, '2026-11-14')
  const added = mergeLglChanges(cache, { gifts: [gift(102, '2026-11-14', 999)] })
  assert.deepEqual([...added.touched], ['102'])
  assert.equal(added.cache.gifts.size, 3)
})

test('a constituent new to the cache or with a newer updated_at is touched and replaces its entry', () => {
  const cache = cacheOf([con(101)])
  const fresh = con(101, { first_name: 'Janet', updated_at: '2026-11-15T10:05:00Z' })
  const { touched, cache: next } = mergeLglChanges(cache, { constituents: [fresh, con(103)] })
  assert.deepEqual([...touched].sort(), ['101', '103'])
  assert.equal(next.constituents.get('101').first_name, 'Janet')
  assert.equal(next.constituents.size, 2)
})

test('an unchanged constituent returned again touches nothing', () => {
  // the cached copy may have another shape (read by the VG check's getConstituent): only updated_at is compared
  const cached = { ...con(101), extra: 'from a single read' }
  const cache = cacheOf([cached])
  const { touched, cache: next } = mergeLglChanges(cache, { constituents: [con(101)] })
  assert.deepEqual([...touched], [])
  assert.equal(next.constituents.size, 1)
  // the same instant spelled with milliseconds is the same
  assert.deepEqual([...mergeLglChanges(cache, { constituents: [con(101, { updated_at: '2026-11-15T10:00:00.000Z' })] }).touched], [])
})

test('a constituent with a newer updated_at is touched', () => {
  const cache = cacheOf([con(101)])
  const { touched } = mergeLglChanges(cache, { constituents: [con(101, { updated_at: '2026-11-15T10:00:01Z' })] })
  assert.deepEqual([...touched], ['101'])
})

test('mergeLglChanges does not mutate the cache', () => {
  const cache = cacheOf([con(101)])
  const before = { constituents: new Map(cache.constituents), gifts: new Map(cache.gifts) }
  const { cache: next } = mergeLglChanges(cache, { constituents: [con(101, { first_name: 'Janet' }), con(102)], gifts: [gift(101, '2026-11-14'), gift(102)] })
  assert.deepEqual(cache, before)
  assert.notEqual(next.constituents, cache.constituents)
  assert.notEqual(next.gifts, cache.gifts)
})

test('mergeLglChanges treats a missing cache as empty', () => {
  const { touched, cache } = mergeLglChanges(null, { constituents: [con(101)], gifts: [gift(101)] })
  assert.deepEqual([...touched], ['101'])
  assert.deepEqual([cache.constituents.size, cache.gifts.size], [1, 1])
})

// --- lglCursorAfter ---

test('lglCursorAfter never moves backward', () => {
  const cursor = '2026-11-15T10:00:00.000Z'
  assert.equal(lglCursorAfter(cursor, [con(101, { updated_at: '2026-11-15T09:00:00Z' })]), cursor)
  assert.equal(lglCursorAfter(cursor, []), cursor)
  assert.equal(lglCursorAfter(cursor, [con(101, { updated_at: '2026-11-15T11:00:00Z' }), con(102, { updated_at: '2026-11-15T10:30:00Z' })]), '2026-11-15T11:00:00Z')
  assert.equal(lglCursorAfter(null, [con(101, { updated_at: '2026-11-15T11:00:00Z' })]), '2026-11-15T11:00:00Z')
  assert.equal(lglCursorAfter(null, []), null)
  assert.equal(lglCursorAfter(cursor, [con(101, { updated_at: 'garbage' })]), cursor)
})

// --- vgTouched ---

test('vgTouched ignores people with no donor link', () => {
  const persons = [per(7, { donor: linkTo(101) }), per(8), per(9, { donor: linkTo(101) })]
  const changes = [{ personId: '7', changes: [] }, { personId: '8', changes: [] }, { personId: '9', changes: [] }, { personId: '7', changes: [] }]
  const { touched, unlinked } = vgTouched(changes, persons)
  assert.deepEqual([...touched], ['101'])
  assert.equal(unlinked, 1)
})

// --- planCheck ---

test('a couple\'s partner is planned with the touched constituent', () => {
  const persons = [per(7, { donor: linkTo(101) }), per(8, { donor: linkTo(101) }), per(9, { donor: linkTo(102) })]
  const cache = cacheOf([con(101), con(102)])
  const p = check({ touched: ['101'], cache, persons })
  assert.deepEqual([...new Set(p.agree.map((r) => r.personId))].sort(), ['7', '8'])
  assert.equal(p.counts.couples, 1)
  assert.ok(p.decisions.every((d) => d.constituentId === '101'))
})

test('holds on untouched constituents are not passed as existing', () => {
  const persons = [per(7, { donor: linkTo(101) })]
  const cache = cacheOf([con(101), con(201, { first_name: 'Ann', last_name: 'Roe' })])
  const touchedHold = hold({ holdId: '1', lglConstituentId: '101', personId: '7', field: 'email', reason: 'both-changed' })
  const untouched = [
    hold({ holdId: '2', lglConstituentId: '201', reason: 'name-only' }),
    hold({ holdId: '3', lglConstituentId: '102', personId: '9', field: 'email', reason: 'both-changed' }),
  ]
  const p = check({ touched: ['101'], cache, persons, holds: [touchedHold, ...untouched] })
  assert.deepEqual(p.existingHolds.map((h) => h.holdId), ['1'])
  const { patch } = reconcileHolds([...p.holds, ...p.unlinked.holds], p.existingHolds)
  assert.ok(patch.every((x) => x.holdId === '1'))
})

test('record-level holds on a touched constituent are left alone', () => {
  const persons = [per(7, { donor: linkTo(101) })]
  const cache = cacheOf([con(101)], []) // no gifts: no longer a donor
  const open = hold({ holdId: '5', lglConstituentId: '101', personId: '7', reason: 'no-longer-donor' })
  const p = check({ touched: ['101'], cache, persons, memory: agreedAt(con(101), 7), holds: [open] })
  assert.ok(RECORD_REASONS.has('no-longer-donor'))
  assert.deepEqual(p.existingHolds, [])
  assert.equal(p.holds.some((h) => RECORD_REASONS.has(h.reason)), false)
  assert.equal(p.decisions.some((d) => d.kind === 'record'), false)
  const r = reconcileHolds([...p.holds, ...p.unlinked.holds], p.existingHolds)
  assert.equal(r.counts.closed, 0)
  assert.deepEqual(r.patch, [])
  assert.deepEqual([p.counts.lglMissing, p.counts.noLongerDonor], [0, 0])
})

test('a check never unlinks', () => {
  const persons = [per(7, { donor: linkTo(101) })]
  const p = check({ touched: ['101'], cache: cacheOf([con(102)]), persons })
  assert.deepEqual([p.unlinks, p.unlinked.unlinks], [[], []])
  assert.equal(p.holds.some((h) => h.reason === 'lgl-missing'), false)
  assert.equal(p.decisions.some((d) => d.kind === 'record'), false)
  assert.equal(p.unlinked.decisions.some((d) => d.action === 'unlink'), false)
  assert.deepEqual([p.counts.lglMissing, p.counts.noLongerDonor], [0, 0])
})

test('a duplicate in LGL is held even when only one of the two is touched', () => {
  const persons = [per(7)]
  const cache = cacheOf([con(201), con(202)])
  const p = check({ touched: ['201'], cache, persons })
  assert.deepEqual(p.unlinked.holds.map((h) => [h.lglConstituentId, h.reason]), [['201', 'duplicate-in-lgl']])
  assert.deepEqual([p.unlinked.links, p.unlinked.creates], [[], []])
  const ids = (q) => [...q.decisions, ...q.holds, ...q.links, ...q.creates].map((x) => x.constituentId ?? x.lglConstituentId)
  assert.deepEqual([...new Set(ids(p.unlinked))], ['201'])
  assert.deepEqual([p.decisions, p.holds], [[], []])
  // the replan applyPlan calls is cut the same way
  const again = p.replan(persons)
  assert.deepEqual(again.holds.map((h) => [h.lglConstituentId, h.reason]), [['201', 'duplicate-in-lgl']])
  assert.deepEqual([...new Set(ids(again))], ['201'])
})

test('a look-alike of a dismissed donor is held, not created', () => {
  const persons = [per(7, { firstName: 'Ann', lastName: 'Roe', email: 'ann@example.org', street: '1 Oak St', zip: '11111' })]
  const cache = cacheOf([con(201), con(202, { email_addresses: [{ id: 1, address: 'j2@example.org', is_preferred: true }] })])
  const dismissed = hold({ lglConstituentId: '201', reason: 'before-horizon', state: 'dismissed', dismissalKind: 'staff' })
  const p = check({ touched: ['202'], cache, persons, holds: [dismissed] })
  assert.deepEqual(p.unlinked.creates, [])
  assert.deepEqual(p.unlinked.holds.map((h) => [h.lglConstituentId, h.reason]), [['202', 'duplicate-in-lgl']])
})

test('breakerPeople leaves out gift-date-only people', () => {
  const c = con(101)
  const persons = [per(7, { donor: linkTo(101, '2026-01-05') })]
  const p = check({ touched: ['101'], cache: cacheOf([c]), persons, memory: agreedAt(c, 7) })
  assert.deepEqual(p.writes.map((w) => w.kind), ['donor'])
  assert.equal(breakerPeople(p), 0)
  assert.equal(foundChange(p), true)

  const renamed = con(101, { first_name: 'Janet' })
  const q = check({ touched: ['101'], cache: cacheOf([renamed]), persons, memory: agreedAt(c, 7) })
  assert.equal(breakerPeople(q), 1)

  // a link counts, and a create counts once per constituent
  const r = check({ touched: ['201', '301'], cache: cacheOf([con(201), con(301, { first_name: 'Ann', last_name: 'Roe', email_addresses: [], street_addresses: [] })]), persons: [per(8)] })
  assert.deepEqual([r.unlinked.links.length, r.unlinked.creates.length], [1, 1])
  assert.equal(breakerPeople(r), 2)
})

test('foundChange is false for an all-same plan', () => {
  const c = con(101)
  const persons = [per(7, { donor: linkTo(101) })]
  const p = check({ touched: ['101'], cache: cacheOf([c]), persons, memory: agreedAt(c, 7) })
  assert.deepEqual([p.decisions, p.writes, p.agree, p.holds, p.unlinked.decisions], [[], [], [], [], []])
  assert.equal(foundChange(p), false)
  assert.equal(breakerPeople(p), 0)
})

test('an unchanged open hold is not a change', () => {
  const persons = [per(7, { email: 'other@example.org' })] // name only: held
  const cache = cacheOf([con(201)])
  const fp = unlinkedFingerprint('name-only', ['7'], '2026-06-01')
  const same = check({ touched: ['201'], cache, persons, holds: [hold({ lglConstituentId: '201', reason: 'name-only', fingerprint: fp })] })
  assert.deepEqual(same.unlinked.holds.map((h) => h.reason), ['name-only'])
  assert.equal(foundChange(same), false)
  // the same hold with new facts is changed, and a hold not yet open is opened
  const changed = check({ touched: ['201'], cache, persons, holds: [hold({ lglConstituentId: '201', reason: 'name-only', fingerprint: 'old' })] })
  assert.equal(foundChange(changed), true)
  assert.equal(foundChange(check({ touched: ['201'], cache, persons })), true)
  // an open owned hold the plan no longer wants (no longer a donor) is closed
  const closing = check({ touched: ['201'], cache: cacheOf([con(201)], []), persons, holds: [hold({ lglConstituentId: '201', reason: 'name-only', fingerprint: fp })] })
  assert.deepEqual([closing.unlinked.decisions, closing.unlinked.holds, closing.unlinked.links], [[], [], []])
  assert.equal(foundChange(closing), true)
})

test('a skipped donor is not a change', () => {
  const persons = [per(7, { email: 'other@example.org' })]
  const dismissed = hold({ lglConstituentId: '201', reason: 'name-only', state: 'dismissed', dismissalKind: 'staff' })
  const p = check({ touched: ['201'], cache: cacheOf([con(201)]), persons, holds: [dismissed] })
  assert.deepEqual(p.unlinked.decisions.map((d) => d.outcome), ['skip'])
  assert.equal(foundChange(p), false)
})
