import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitStreet, formatPhone, stateCode, cleanName } from '../../src/lgl-vg/clean.js'

test('street and unit split the way VG stores them', () => {
  const split = (raw) => { const { street, unit } = splitStreet(raw); return { street, unit } }
  assert.deepEqual(split('12 Main St Apt 3'), { street: '12 Main St', unit: 'Apt 3' })
  assert.deepEqual(split('12 Main St Apt B'), { street: '12 Main St', unit: 'Apt B' })
  assert.deepEqual(split('12 Main St, #4B'), { street: '12 Main St', unit: '#4B' })
  assert.deepEqual(split('12 Main St\nUnit 7'), { street: '12 Main St', unit: 'Unit 7' })
  assert.deepEqual(split('2nd Floor, 25 Broad Street'), { street: '25 Broad Street', unit: '2nd Floor' })
  assert.deepEqual(split('25 Broad Street, Second Floor'), { street: '25 Broad Street', unit: 'Second Floor' })
  assert.deepEqual(split('PO Box 12'), { street: 'PO Box 12', unit: '' })
  assert.deepEqual(split('12 Suite Road'), { street: '12 Suite Road', unit: '' })
})

test('extra address lines are returned in omitted', () => {
  assert.deepEqual(splitStreet('PO Box 12\r\n9 Hill Rd'), { street: 'PO Box 12', unit: '', omitted: ['9 Hill Rd'] })
  assert.deepEqual(splitStreet('C/O Pat Example\r\n9 Hill Rd'), { street: '9 Hill Rd', unit: '', omitted: ['C/O Pat Example'] })
  assert.deepEqual(splitStreet('Pat & Lee\n9 Hill Rd'), { street: '9 Hill Rd', unit: '', omitted: ['Pat & Lee'] })
  assert.deepEqual(splitStreet('The Towers Apt. 12R\n1 Tower Plaza'), { street: '1 Tower Plaza', unit: 'Apt. 12R', omitted: ['The Towers'] })
  assert.deepEqual(splitStreet('Room 5\nCity Hall'), { street: 'City Hall', unit: 'Room 5', omitted: [] })
})

test('phones come out as 401-555-0100, and a short number is null', () => {
  assert.equal(formatPhone({ number: '401.555.0100' }), '401-555-0100')
  assert.equal(formatPhone({ number: '14015550100' }), '401-555-0100')
  assert.equal(formatPhone({ number: '401-555-0100 x12' }), '401-555-0100 x12')
  assert.equal(formatPhone({ number: '555-0100' }), null)
  assert.equal(formatPhone({ number: '' }), null)
})

test('state names and odd cases become USPS codes; anything else is not a state', () => {
  assert.equal(stateCode('Rhode Island'), 'RI')
  assert.equal(stateCode('ri'), 'RI')
  assert.equal(stateCode('R.I.'), 'RI')
  assert.equal(stateCode('massachusetts'), 'MA')
  assert.equal(stateCode('ON'), null)
  assert.equal(stateCode('Ashaway'), null)
})

test('cleanName title-cases a name typed in one case and leaves mixed case alone', () => {
  assert.equal(cleanName('JANE'), 'Jane')
  assert.equal(cleanName('doe'), 'Doe')
  assert.equal(cleanName('McDoe'), 'McDoe')
  assert.equal(cleanName('  Doe ,'), 'Doe')
})
