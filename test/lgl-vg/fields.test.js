import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIELDS, lglFields, vgFields, comparable, vgPatch, mergePhones, keepsNickname, lglDefaultNames, hasDefaultNames } from '../../src/lgl-vg/fields.js'

const addr = (o = {}) => ({ id: 1, street: '12 Elm Street', city: 'Providence', state: 'RI', postal_code: '02903', is_preferred: true, not_current: false, ...o })
const base = { id: 7, first_name: 'Jane', last_name: 'Doe' }

test('FIELDS lists the eight names in order', () => {
  assert.deepEqual(FIELDS, ['firstName', 'lastName', 'suffix', 'nickname', 'address', 'email', 'phones', 'deceased'])
})

test('a constituent with no lists and null optional fields yields empty values and no problems', () => {
  const r = lglFields({ ...base, suffix: null, nick_name: null, street_addresses: null })
  assert.equal(r.values.firstName, 'Jane')
  assert.equal(r.values.suffix, null)
  assert.equal(r.values.nickname, null)
  for (const f of ['address', 'email']) assert.equal(r.values[f], null)
  assert.deepEqual(r.values.phones, { phone: null, cell: null })
  for (const f of ['address', 'email', 'phone', 'cell']) assert.equal(r.entryIds[f], null)
  assert.deepEqual(r.values.deceased, { flag: false, date: null })
  assert.deepEqual(r.problems, {})
})

test('the preferred current entry is used, and its id recorded', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 1, is_preferred: false }), addr({ id: 2, street: '34 Oak Ave' })] })
  assert.equal(r.values.address.street, '34 Oak Ave')
  assert.equal(r.entryIds.address, 2)
})

test('a not_current preferred entry is ignored', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 1, not_current: true }), addr({ id: 2, street: '34 Oak Ave', is_preferred: false })] })
  assert.equal(r.entryIds.address, 2)
})

test('one current entry with none preferred is used', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 5, is_preferred: false })] })
  assert.equal(r.entryIds.address, 5)
  assert.deepEqual(r.problems, {})
})

test('two current entries with none preferred is ambiguous', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 1, is_preferred: false }), addr({ id: 2, is_preferred: false })] })
  assert.equal(r.problems.address, 'ambiguous')
  assert.equal(r.values.address, null)
  assert.equal(r.entryIds.address, null)
})

test('a spelled-out state and ZIP+4 are cleaned', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ state: 'Rhode Island', zip5: '02903', postal_code: '02903-1234' })] })
  assert.equal(r.values.address.state, 'RI')
  assert.equal(r.values.address.zip, '02903')
  assert.equal(r.values.address.unit, null)
})

test('an address with no city is unclean', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 3, city: '' })] })
  assert.equal(r.values.address, null)
  assert.equal(r.problems.address, 'unclean')
  assert.equal(r.entryIds.address, null)
})

test('an email without a domain is unclean', () => {
  const bad = lglFields({ ...base, email_addresses: [{ id: 1, address: 'jane@example', is_preferred: true }] })
  assert.equal(bad.values.email, null)
  assert.equal(bad.problems.email, 'unclean')
  const ok = lglFields({ ...base, email_addresses: [{ id: 2, address: ' jane@example.org ', is_preferred: true }] })
  assert.equal(ok.values.email, 'jane@example.org')
  assert.equal(ok.entryIds.email, 2)
})

test('mobile goes to cell, other types to phone', () => {
  const r = lglFields({ ...base, phone_numbers: [
    { id: 1, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true },
    { id: 2, number: '401.555.0102', phone_type_name: 'Mobile', is_preferred: true },
    { id: 3, number: '12', phone_type_name: 'Work', is_preferred: false, not_current: true },
  ] })
  assert.deepEqual(r.values.phones, { phone: '401-555-0101', cell: '401-555-0102' })
  assert.deepEqual([r.entryIds.phone, r.entryIds.cell], [1, 2])
  const bad = lglFields({ ...base, phone_numbers: [{ id: 4, number: '555-01', phone_type_name: 'Cell', is_preferred: true }] })
  assert.equal(bad.problems.phones, 'unclean')
  assert.equal(bad.values.phones, null)
  const amb = lglFields({ ...base, phone_numbers: [
    { id: 4, number: '555-01', phone_type_name: 'Cell', is_preferred: true },
    { id: 5, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true },
    { id: 6, number: '401-555-0103', phone_type_name: 'Work', is_preferred: true },
  ] })
  assert.equal(amb.problems.phones, 'ambiguous')
})

test('vgFields maps the API person and turns empty strings into null', () => {
  const v = vgFields({
    personId: 1, deceased: true, email: 'jane@example.org', phone: { phone: '401-555-0100', cell: '' },
    donor: null,
    detail: { firstName: 'Jane', lastName: 'Doe', suffix: '', nickname: '', street: '12 Elm St', unit: '', city: 'Providence', state: 'RI', zip: '02903', deceasedDate: '2026-01-01' },
  })
  assert.equal(v.suffix, null)
  assert.deepEqual(v.phones, { phone: '401-555-0100', cell: null })
  assert.deepEqual(v.address, { street: '12 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' })
  assert.deepEqual(v.deceased, { flag: true, date: '2026-01-01' })
  const none = vgFields({ personId: 2, deceased: false, email: null, phone: null, detail: { firstName: 'A', lastName: 'B', street: '' } })
  assert.equal(none.address, null)
  assert.deepEqual(none.phones, { phone: null, cell: null })
  assert.deepEqual(none.deceased, { flag: false, date: null })
})

test('comparable ignores case, accents, punctuation and street-word spelling', () => {
  const a = { street: '12 Elm Street', unit: 'Apt 2', city: 'Providence', state: 'RI', zip: '02903' }
  const b = { street: '12 ELM ST.', unit: '#2', city: 'providence', state: 'RI', zip: '02903' }
  assert.equal(comparable('address', a), comparable('address', b))
  assert.equal(comparable('firstName', 'Robert (Bob)'), comparable('firstName', 'ROBERT'))
  assert.equal(comparable('lastName', 'Doé'), comparable('lastName', 'doe'))
  assert.equal(comparable('phones', { phone: '(401) 555-0100', cell: null }), comparable('phones', { phone: '401-555-0100', cell: null }))
  assert.equal(comparable('email', ' Jane@Example.org '), 'jane@example.org')
})

test('comparable tells real differences apart', () => {
  assert.notEqual(comparable('address', { street: '12 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' }),
    comparable('address', { street: '14 Elm St', unit: null, city: 'Providence', state: 'RI', zip: '02903' }))
  assert.notEqual(comparable('deceased', { flag: true, date: '2026-01-01' }), comparable('deceased', { flag: true, date: null }))
  assert.equal(comparable('deceased', { flag: false, date: null }), '0')
  assert.equal(comparable('email', null), '')
  assert.equal(comparable('email', undefined), '')
  assert.equal(comparable('address', undefined), '')
})

test('suffix keeps its case and loses only stray punctuation', () => {
  const sfx = (v) => lglFields({ ...base, suffix: v }).values.suffix
  assert.equal(sfx('III'), 'III')
  assert.equal(sfx('MD'), 'MD')
  assert.equal(sfx(' Jr. '), 'Jr.')
  assert.equal(comparable('suffix', 'Jr.'), comparable('suffix', 'JR'))
})

test('more than one preferred current entry is ambiguous', () => {
  const r = lglFields({ ...base, street_addresses: [addr({ id: 1 }), addr({ id: 2, street: '34 Oak Ave' })] })
  assert.equal(r.problems.address, 'ambiguous')
  assert.equal(r.values.address, null)
  assert.equal(r.entryIds.address, null)
})

test('an address with a digit in the city, an unknown state or an invalid ZIP is unclean', () => {
  for (const o of [{ city: 'Provid3nce' }, { state: 'Ashaway' }, { postal_code: '2903' }, { postal_code: '0290A' }]) {
    const r = lglFields({ ...base, street_addresses: [addr(o)] })
    assert.equal(r.values.address, null, JSON.stringify(o))
    assert.equal(r.problems.address, 'unclean', JSON.stringify(o))
  }
})

test('LGL deceased true carries its date', () => {
  const r = lglFields({ ...base, is_deceased: true, deceased_date: '2026-01-01' })
  assert.deepEqual(r.values.deceased, { flag: true, date: '2026-01-01' })
})

test('an empty or blank LGL deceased date is null, so a deceased write sends deceasedDate null', () => {
  for (const deceased_date of ['', '  ']) {
    const r = lglFields({ ...base, is_deceased: true, deceased_date })
    assert.deepEqual(r.values.deceased, { flag: true, date: null }, JSON.stringify(deceased_date))
    assert.deepEqual(vgPatch('deceased', r.values.deceased), { deceased: true, deceasedDate: null })
  }
})

test('comparable for phones drops an extension; hyphens act as spaces', () => {
  const ph = (phone, cell = null) => comparable('phones', { phone, cell })
  assert.equal(ph('401-555-0100 x12'), ph('401-555-0100'))
  assert.equal(ph(null, '401-555-0100 EXT. 7'), ph('(401) 555-0100'))
  assert.equal(ph(null, '401-555-0100 ext9'), '4015550100')
  assert.equal(comparable('lastName', 'Smith-Jones'), comparable('lastName', 'Smith Jones'))
  const a = (street) => comparable('address', { street, unit: null, city: 'Providence', state: 'RI', zip: '02903' })
  assert.notEqual(a('12-14 Elm St'), a('1214 Elm St'))
})

test('comparable for phones treats the two slots as one set', () => {
  const ph = (phone, cell) => comparable('phones', { phone, cell })
  const A = '401-555-0100'
  const B = '401-555-0101'
  assert.equal(ph(A, null), ph(null, A))
  assert.equal(ph(A, B), ph(B, A))
  assert.equal(ph(A, A), ph(A, null))
  assert.notEqual(ph(A, null), ph(A, B))
  assert.equal(comparable('phones', null), '')
  assert.equal(ph(null, null), '')
})

test('comparable address: units, suffixes, directions, ordinals', () => {
  const a = (street, unit = null, city = 'Springfield') => comparable('address', { street, unit, city, state: 'RI', zip: '99999' })
  const same = [
    [['11 Maple Plaza', 'Apt. 7B'], ['11 Maple Plz', 'Apt 7B']],
    [['922 Elm Street', '7B'], ['922 Elm St', 'Apt 7B']],
    [['33 Oak Highway 404'], ['33 Oak Hwy', '#404']],
    [['44 Elm Ave', 'Unit 12N'], ['44 Elm Ave.', 'Unit 12 North']],
    [['44 Elm Ave', 'Unit 13S'], ['44 Elm Avenue', '#13 South']],
    [['55 Elm Wood Ln'], ['55 Elmwood Lane']],
    [['77 Fifth Street'], ['77 5th St']],
    [['88 Eighth St'], ['88 8th St']],
    [['12 Elm St Ste 4'], ['12 Elm St', '#4']],
    [['12 Elm St', 'Apt A'], ['12 Elm St', 'Unit A']],
    [['12 Elm St', 'Unit 2L'], ['12 Elm St', '2L']],
    [['22 Cedar Trail'], ['22 Cedar Trl']],
    [['33 Birch View'], ['33 Birch Vw']],
    [['44 Oak Center'], ['44 Oak Ctr']],
  ]
  for (const [x, y] of same) assert.equal(a(...x), a(...y), JSON.stringify([x, y]))
  assert.equal(a('11 Elm St', null, 'N Springfield'), a('11 Elm St', null, 'North Springfield'))
  const differ = [
    [['66 Mill Dr'], ['66 Mill Road']],
    [['12 E Elm St'], ['12E Elm St']],
    [['12 N Elm St'], ['12N Elm St']],
    [['13 A St'], ['13A St']],
    [['12 Ste Anne St'], ['12 Anne St']],
    [['99 Elm St', 'Apt B21'], ['99 Elm St', 'Apt B32']],
    [['13 Elm St'], ['13A Elm St']],
    [['12 Elm St'], ['14 Elm St']],
    [['44 Elm Ave'], ['44 Elm Ave', 'Apt. 1']],
  ]
  for (const [x, y] of differ) assert.notEqual(a(...x), a(...y), JSON.stringify([x, y]))
  assert.notEqual(a('11 Elm St', null, 'Springfield'), a('11 Elm St', null, 'Shelbyville'))
})

test('an unclean cell keeps the phone entry id; phones is null with a problem', () => {
  const r = lglFields({ ...base, phone_numbers: [
    { id: 1, number: '401-555-0101', phone_type_name: 'Home', is_preferred: true },
    { id: 2, number: '555-01', phone_type_name: 'Cell', is_preferred: true },
  ] })
  assert.equal(r.entryIds.phone, 1)
  assert.equal(r.values.phones, null)
  assert.equal(r.problems.phones, 'unclean')
})

test('comparable phones: {A, B} differs from {A, C}', () => {
  const ph = (phone, cell) => comparable('phones', { phone, cell })
  assert.notEqual(ph('401-555-0100', '401-555-0101'), ph('401-555-0100', '401-555-0102'))
})

test('vgPatch builds the VG properties for one field', () => {
  assert.deepEqual(vgPatch('firstName', 'Jane'), { firstName: 'Jane' })
  assert.deepEqual(vgPatch('email', 'jane@example.com'), { email: 'jane@example.com' })
  assert.deepEqual(vgPatch('phones', { phone: '401-555-0101', cell: null }), { phone: '401-555-0101', cell: null })
  assert.deepEqual(vgPatch('deceased', { flag: true, date: '2026-01-02' }), { deceased: true, deceasedDate: '2026-01-02' })
  assert.deepEqual(vgPatch('deceased', { flag: false, date: '2026-01-02' }), { deceased: false, deceasedDate: null })
  const a = { street: '12 Elm St', unit: 'Apt 3', city: 'Springfield', state: 'RI', zip: '99999' }
  assert.deepEqual(vgPatch('address', { ...a, extra: 1 }), a)
})

test('mergePhones fills an empty VG slot with an LGL number VG lacks', () => {
  assert.deepEqual(
    mergePhones({ phone: '401-555-0101', cell: null }, { phone: null, cell: '401-555-0102' }),
    { value: { phone: '401-555-0101', cell: '401-555-0102' }, placed: 1, unplaced: [], vgOnly: ['401-555-0102'] })
})

test('mergePhones uses the other slot when the LGL label slot is taken', () => {
  const r = mergePhones({ phone: null, cell: '401-555-0103' }, { phone: null, cell: '401-555-0104' })
  assert.deepEqual(r.value, { phone: '401-555-0103', cell: '401-555-0104' })
  assert.equal(r.placed, 1)
})

test('mergePhones leaves a number unplaced when both VG slots are full', () => {
  const vg = { phone: '401-555-0102', cell: '401-555-0104' }
  const r = mergePhones({ phone: '401-555-0101', cell: null }, vg)
  assert.deepEqual(r.value, vg)
  assert.equal(r.placed, 0)
  assert.deepEqual(r.unplaced, ['401-555-0101'])
  assert.deepEqual(r.vgOnly, ['401-555-0102', '401-555-0104'])
})

test('mergePhones treats differently formatted numbers as present', () => {
  const r = mergePhones({ phone: '(401) 555-0101', cell: null }, { phone: null, cell: '401-555-0101 x12' })
  assert.deepEqual(r.value, { phone: null, cell: '401-555-0101 x12' })
  assert.equal(r.placed, 0)
  assert.deepEqual(r.unplaced, [])
  assert.deepEqual(r.vgOnly, [])
})

test('keepsNickname is false only when VG has a parenthesized part LGL lacks', () => {
  assert.equal(keepsNickname('Robert', 'Robert (Bob)'), false)
  assert.equal(keepsNickname('Robert (Bob)', 'Robert (Bob)'), true)
  assert.equal(keepsNickname('Rob', 'Robert'), true)
})

test('a verification rewrite of the unit designator compares the same', () => {
  const vg = { street: '200 E Randolph St', unit: 'Apartment 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }
  const lgl = { street: '200 E Randolph St', unit: 'Fl 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }
  assert.equal(comparable('address', vg), comparable('address', lgl))
})
test('every USPS secondary unit word is dropped before a designator', () => {
  for (const w of ['apt', 'apartment', 'bldg', 'building', 'dept', 'department', 'fl', 'floor', 'frnt', 'front', 'hngr', 'hangar', 'key', 'lbby', 'lobby', 'lot', 'lowr', 'lower', 'ofc', 'office', 'ph', 'penthouse', 'pier', 'rear', 'rm', 'room', 'side', 'slip', 'spc', 'space', 'stop', 'ste', 'suite', 'trlr', 'trailer', 'unit', 'uppr', 'upper']) {
    assert.equal(comparable('address', { street: '1 Elm St', unit: `${w} 5`, city: 'Zzyzxford', state: 'RI', zip: '00901' }),
      comparable('address', { street: '1 Elm St', unit: '# 5', city: 'Zzyzxford', state: 'RI', zip: '00901' }), w)
  }
})
test('a unit word with no designator after it is kept (Rear Lot Rd is a street)', () => {
  assert.notEqual(comparable('address', { street: '1 Rear Lot Rd', unit: null, city: 'Zzyzxford', state: 'RI', zip: '00901' }),
    comparable('address', { street: '1 Rd', unit: null, city: 'Zzyzxford', state: 'RI', zip: '00901' }))
})
test('lglDefaultNames follows the trial account: suffix period dropped, prefix kept, middle and nickname ignored', () => {
  assert.deepEqual(lglDefaultNames({ first_name: 'Jane', last_name: 'Doe' }), { addressee: 'Jane Doe', salutation: 'Jane' })
  assert.deepEqual(lglDefaultNames({ first_name: 'John', last_name: 'Doe', suffix: 'Jr.' }), { addressee: 'John Doe Jr', salutation: 'John' })
  assert.deepEqual(lglDefaultNames({ prefix: 'Dr.', first_name: 'Jane', middle_name: 'Q', nick_name: 'Jay', last_name: 'Doe' }), { addressee: 'Dr. Jane Doe', salutation: 'Jane' })
})
test('hasDefaultNames is true only when both still match the current name', () => {
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Jane Doe', salutation: 'Jane' }), true)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Mrs. Jane Doe', salutation: 'Jane' }), false)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: 'Jane Doe', salutation: 'Dear Friend' }), false)
  assert.equal(hasDefaultNames({ first_name: 'Jane', last_name: 'Doe', addressee: ' Jane  Doe ', salutation: 'Jane' }), true)
})
