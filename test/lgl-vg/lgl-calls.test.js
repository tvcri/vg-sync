import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLglCalls, formatCall } from '../../src/lgl-vg/lgl-calls.js'

const con = (o = {}) => ({
  id: 101, first_name: 'Jane', last_name: 'Doe', nick_name: null, suffix: null,
  addressee: 'Jane Doe', salutation: 'Jane',
  is_deceased: false, deceased_date: null, is_org: false,
  email_addresses: [{ id: 11, address: 'jane@example.org', is_preferred: true, not_current: false }],
  street_addresses: [{ id: 12, street: '12 Elm St', city: 'Zzyzxford', state: 'RI', zip5: '00901', is_preferred: true, not_current: false }],
  phone_numbers: [],
  ...o,
})
const w = (o = {}) => ({
  kind: 'lgl', constituentId: '101', personIds: ['7'], field: 'firstName', case: 'to-lgl',
  value: null, expect: null, fingerprint: 'f', merge: false, ...o,
})
const ph = (id, number, type, o = {}) => ({
  id, number, normalized_number: number.replace(/\D/g, ''), phone_type_name: type, is_preferred: false, not_current: false, ...o,
})
const ifDefault = { addresseeSetting: 'if-default' }
const elm = { street: '1 Elm St', unit: 'Apt 2', city: 'Zzyzxford', state: 'RI', zip: '00901' }

test('a name write sends only the changed key, and empties addressee and salutation when they are LGL\'s default', () => {
  const r = buildLglCalls(w({ field: 'firstName', value: 'Janet' }), con({ addressee: 'Jane Doe', salutation: 'Jane' }), ifDefault)
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { first_name: 'Janet', addressee: '', salutation: '' }, step: 'set' }])
  assert.equal(r.addressee, 'rebuilt')
})

test('the last name and suffix also run the addressee rule', () => {
  const last = buildLglCalls(w({ field: 'lastName', value: 'Roe' }), con(), ifDefault)
  assert.deepEqual(last.calls[0].body, { last_name: 'Roe', addressee: '', salutation: '' })
  const suffix = buildLglCalls(w({ field: 'suffix', value: 'Jr.' }), con({ suffix: 'Sr.', addressee: 'Jane Doe Sr' }), ifDefault)
  assert.deepEqual(suffix.calls[0].body, { suffix: 'Jr.', addressee: '', salutation: '' })
  assert.equal(suffix.addressee, 'rebuilt')
})

test('a hand-written addressee is left and reported', () => {
  const r = buildLglCalls(w({ field: 'firstName', value: 'Janet' }), con({ addressee: 'Mrs. Jane Doe' }), ifDefault)
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { first_name: 'Janet' }, step: 'set' }])
  assert.equal(r.addressee, 'left')
})

test('lgl-addressee never leaves them and reports nothing', () => {
  const r = buildLglCalls(w({ field: 'firstName', value: 'Janet' }), con(), { addresseeSetting: 'never' })
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { first_name: 'Janet' }, step: 'set' }])
  assert.equal(r.addressee, null)
})

test('the first name is sent without its (Nick) part', () => {
  const r = buildLglCalls(w({ field: 'firstName', value: 'Jane (Jay)' }), con({ first_name: 'Janie', addressee: 'Janie Doe', salutation: 'Janie' }), ifDefault)
  assert.deepEqual(r.calls[0].body, { first_name: 'Jane', addressee: '', salutation: '' })
})

test('a nickname write needs no addressee rule', () => {
  const r = buildLglCalls(w({ field: 'nickname', value: 'Jay' }), con(), ifDefault)
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { nick_name: 'Jay' }, step: 'set' }])
  assert.equal(r.addressee, null)
})

test('deceased sends the mark and its date', () => {
  const r = buildLglCalls(w({ field: 'deceased', value: { flag: true, date: '2026-10-01' } }), con(), ifDefault)
  assert.deepEqual(r.calls, [{ method: 'PATCH', path: '/constituents/101', body: { is_deceased: true, deceased_date: '2026-10-01' }, step: 'set' }])
  assert.equal(r.addressee, null)
})

test('a deceased mark is never removed', () => {
  assert.throws(() => buildLglCalls(w({ field: 'deceased', value: { flag: false, date: null } }), con({ is_deceased: true }), ifDefault), /never removed/)
})

test('a new address is added preferred, then the old one retired', () => {
  const r = buildLglCalls(w({ field: 'address', value: elm }), con(), ifDefault)
  assert.deepEqual(r.calls, [
    {
      method: 'POST', path: '/constituents/101/street_addresses',
      body: { street: '1 Elm St\nApt 2', city: 'Zzyzxford', state: 'RI', postal_code: '00901', street_type_name: 'Home', is_preferred: true },
      step: 'add', entryKind: 'street_addresses', oldEntryId: 12,
    },
    { method: 'PATCH', path: '/street_addresses/12', body: { not_current: true }, step: 'retire', entryKind: 'street_addresses', oldEntryId: 12 },
  ])
  assert.equal(r.addressee, null)
})

test('an address with no unit is sent as one street line', () => {
  const r = buildLglCalls(w({ field: 'address', value: { ...elm, unit: null } }), con(), ifDefault)
  assert.equal(r.calls[0].body.street, '1 Elm St')
})

test('VG\'s address already on file as a not-current entry is revived, not added', () => {
  const c = con({
    street_addresses: [
      { id: 12, street: '12 Elm St', city: 'Zzyzxford', state: 'RI', zip5: '00901', is_preferred: true, not_current: false },
      { id: 13, street: '1 Elm Street\nApartment 2', city: 'Zzyzxford', state: 'Rhode Island', postal_code: '00901-1234', is_preferred: false, not_current: true },
    ],
  })
  const r = buildLglCalls(w({ field: 'address', value: elm }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'PATCH', path: '/street_addresses/13', body: { not_current: false, is_preferred: true }, step: 'revive', entryKind: 'street_addresses', oldEntryId: 12 },
    { method: 'PATCH', path: '/street_addresses/12', body: { not_current: true }, step: 'retire', entryKind: 'street_addresses', oldEntryId: 12 },
  ])
})

test('an address with no current entry in LGL is added and nothing is retired', () => {
  const c = con({ street_addresses: [{ id: 12, street: '12 Elm St', city: 'Zzyzxford', state: 'RI', zip5: '00901', is_preferred: false, not_current: true }] })
  const r = buildLglCalls(w({ field: 'address', value: elm }), c, ifDefault)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].step, 'add')
  assert.equal(r.calls[0].oldEntryId, null)
  assert.equal(r.calls[0].body.is_preferred, true)
})

test('only the entry read as LGL\'s value is retired', () => {
  const c = con({
    phone_numbers: [
      ph(30, '401-555-0130', 'Work'),
      ph(31, '401-555-0131', 'Home', { is_preferred: true }),
      ph(32, '401-555-0132', 'Home'),
    ],
  })
  const r = buildLglCalls(w({ field: 'phones', value: { phone: '401-555-0140', cell: null } }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'POST', path: '/constituents/101/phone_numbers', body: { number: '401-555-0140', phone_type_name: 'Home', is_preferred: true }, step: 'add', entryKind: 'phone_numbers', oldEntryId: 31 },
    { method: 'PATCH', path: '/phone_numbers/31', body: { not_current: true }, step: 'retire', entryKind: 'phone_numbers', oldEntryId: 31 },
  ])
})

test('a slot VG has no number for, or the same number in, is not written', () => {
  const c = con({ phone_numbers: [ph(31, '401-555-0131', 'Home', { is_preferred: true }), ph(33, '401-555-0133', 'Mobile')] })
  const r = buildLglCalls(w({ field: 'phones', value: { phone: '(401) 555-0131', cell: null } }), c, ifDefault)
  assert.deepEqual(r.calls, [])
})

test('a cell write adds a Mobile entry; it is preferred only if the old cell held the mark or no phone does', () => {
  const cell = (phones) => buildLglCalls(w({ field: 'phones', value: { phone: null, cell: '401-555-0150' } }), con({ phone_numbers: phones }), ifDefault).calls

  // Home preferred, Mobile current not preferred
  const a = cell([ph(31, '401-555-0131', 'Home', { is_preferred: true }), ph(33, '401-555-0133', 'Mobile')])
  assert.deepEqual(a, [
    { method: 'POST', path: '/constituents/101/phone_numbers', body: { number: '401-555-0150', phone_type_name: 'Mobile', is_preferred: false }, step: 'add', entryKind: 'phone_numbers', oldEntryId: 33 },
    { method: 'PATCH', path: '/phone_numbers/33', body: { not_current: true }, step: 'retire', entryKind: 'phone_numbers', oldEntryId: 33 },
  ])

  // Mobile preferred
  const b = cell([ph(31, '401-555-0131', 'Home'), ph(33, '401-555-0133', 'Mobile', { is_preferred: true })])
  assert.equal(b[0].body.is_preferred, true)
  assert.equal(b[0].body.phone_type_name, 'Mobile')
  assert.equal(b[1].path, '/phone_numbers/33')

  // no phones
  const c = cell([])
  assert.deepEqual(c, [
    { method: 'POST', path: '/constituents/101/phone_numbers', body: { number: '401-555-0150', phone_type_name: 'Mobile', is_preferred: true }, step: 'add', entryKind: 'phone_numbers', oldEntryId: null },
  ])
})

test('when both slots are new to a record with no phones, only the first is sent preferred', () => {
  const r = buildLglCalls(w({ field: 'phones', value: { phone: '401-555-0140', cell: '401-555-0150' } }), con(), ifDefault)
  assert.deepEqual(r.calls.map((x) => [x.body.phone_type_name, x.body.is_preferred]), [['Home', true], ['Mobile', false]])
})

test('a not-current phone of the same type group is revived with the preferred rule; one of the other group is not', () => {
  const c = con({
    phone_numbers: [
      ph(31, '401-555-0131', 'Home', { is_preferred: true }),
      ph(33, '401-555-0133', 'Mobile'),
      ph(34, '401-555-0150', 'Home', { not_current: true }),
      ph(35, '(401) 555-0150', 'Cell', { not_current: true }),
    ],
  })
  const r = buildLglCalls(w({ field: 'phones', value: { phone: null, cell: '401-555-0150' } }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'PATCH', path: '/phone_numbers/35', body: { not_current: false, is_preferred: false }, step: 'revive', entryKind: 'phone_numbers', oldEntryId: 33 },
    { method: 'PATCH', path: '/phone_numbers/33', body: { not_current: true }, step: 'retire', entryKind: 'phone_numbers', oldEntryId: 33 },
  ])
})

test('merge adds VG-only numbers and retires nothing', () => {
  const c = con({ phone_numbers: [ph(31, '401-555-0131', 'Home', { is_preferred: true })] })
  // VG's cell holds a number LGL lacks (no current Mobile in LGL); VG's phone is LGL's Home number, already on file
  const r = buildLglCalls(w({ field: 'phones', case: 'merge', merge: true, value: { phone: '401-555-0131', cell: '401-555-0150' } }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'POST', path: '/constituents/101/phone_numbers', body: { number: '401-555-0150', phone_type_name: 'Mobile', is_preferred: false }, step: 'add', entryKind: 'phone_numbers', oldEntryId: null },
  ])
})

test('merge leaves a VG-only number out when LGL has a current entry of that type', () => {
  // LGL's only current Home number is unmarked (the mark is on the Mobile); VG's phone is a different number
  const c = con({ phone_numbers: [ph(31, '401-555-0131', 'Home'), ph(33, '401-555-0133', 'Mobile', { is_preferred: true })] })
  const r = buildLglCalls(w({ field: 'phones', case: 'merge', merge: true, value: { phone: '401-555-0140', cell: '401-555-0133' } }), c, ifDefault)
  assert.deepEqual(r.calls, [])
  // a not-current entry of the type does not count: the number is added
  const d = con({ phone_numbers: [ph(31, '401-555-0131', 'Home', { not_current: true }), ph(33, '401-555-0133', 'Mobile', { is_preferred: true })] })
  const s = buildLglCalls(w({ field: 'phones', case: 'merge', merge: true, value: { phone: '401-555-0140', cell: '401-555-0133' } }), d, ifDefault)
  assert.deepEqual(s.calls.map((x) => [x.step, x.body.number, x.body.is_preferred]), [['add', '401-555-0140', false]])
})

test('an email equal in other capitals is revived, not added', () => {
  const c = con({
    email_addresses: [
      { id: 11, address: 'jane@example.org', is_preferred: true, not_current: false },
      { id: 14, address: 'Janet.Doe@Example.org', is_preferred: false, not_current: true },
    ],
  })
  const r = buildLglCalls(w({ field: 'email', value: 'janet.doe@example.org' }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'PATCH', path: '/email_addresses/14', body: { not_current: false, is_preferred: true }, step: 'revive', entryKind: 'email_addresses', oldEntryId: 11 },
    { method: 'PATCH', path: '/email_addresses/11', body: { not_current: true }, step: 'retire', entryKind: 'email_addresses', oldEntryId: 11 },
  ])
})

test('a new email is added as a Home entry', () => {
  const r = buildLglCalls(w({ field: 'email', value: 'janet.doe@example.org' }), con(), ifDefault)
  assert.deepEqual(r.calls[0].body, { address: 'janet.doe@example.org', email_type_name: 'Home', is_preferred: true })
  assert.equal(r.calls[1].path, '/email_addresses/11')
})

test('repairing an unclean phone slot retires the unclean entry and leaves the clean slot alone', () => {
  const c = con({ phone_numbers: [ph(31, '401-555-0131', 'Home', { is_preferred: true }), ph(33, '555', 'Mobile')] })
  const r = buildLglCalls(w({ field: 'phones', value: { phone: '401-555-0131', cell: '401-555-0150' } }), c, ifDefault)
  assert.deepEqual(r.calls, [
    { method: 'POST', path: '/constituents/101/phone_numbers', body: { number: '401-555-0150', phone_type_name: 'Mobile', is_preferred: false }, step: 'add', entryKind: 'phone_numbers', oldEntryId: 33 },
    { method: 'PATCH', path: '/phone_numbers/33', body: { not_current: true }, step: 'retire', entryKind: 'phone_numbers', oldEntryId: 33 },
  ])
})

test('repairing an unclean address retires the unclean entry', () => {
  const c = con({ street_addresses: [{ id: 12, street: '12 Elm St', city: '', state: 'RI', zip5: '00901', is_preferred: true, not_current: false }] })
  const r = buildLglCalls(w({ field: 'address', value: elm }), c, ifDefault)
  assert.deepEqual(r.calls.map((x) => [x.step, x.path]), [['add', '/constituents/101/street_addresses'], ['retire', '/street_addresses/12']])
  assert.equal(r.calls[0].oldEntryId, 12)
})

test('a write without constituentId throws', () => {
  assert.throws(() => buildLglCalls(w({ constituentId: undefined, field: 'firstName', value: 'Janet' }), con(), ifDefault), /no constituentId/)
  assert.throws(() => buildLglCalls(w({ constituentId: null, field: 'email', value: 'janet.doe@example.org' }), con(), ifDefault), /no constituentId/)
})

test('formatCall prints method, path and JSON body', () => {
  assert.equal(formatCall({ method: 'PATCH', path: '/street_addresses/12', body: { not_current: true }, step: 'retire' }), 'LGL PATCH /street_addresses/12 {"not_current":true}')
  assert.equal(formatCall({ method: 'POST', path: '/constituents/101/email_addresses', body: { address: 'jane@example.org' }, step: 'add' }), 'LGL POST /constituents/101/email_addresses {"address":"jane@example.org"}')
})
