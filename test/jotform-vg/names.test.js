import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameKey, NICKNAMES, firstNamesAgree, nameMatches } from '../../src/jotform-vg/names.js'

const jane = { firstName: 'Jane', lastName: 'Doe', nickname: null }

test('nameKey folds accents, case, punctuation and spacing', () => {
  assert.equal(nameKey("  Zoë  O'Brien-Smith "), 'zoe o brien smith')
  assert.equal(nameKey(null), '')
  assert.equal(nameKey(undefined), '')
})

test('NICKNAMES is an array of groups of name keys', () => {
  assert.ok(NICKNAMES.length >= 30)
  for (const g of NICKNAMES) {
    assert.ok(Array.isArray(g) && g.length >= 2)
    for (const k of g) assert.equal(k, nameKey(k))
  }
})

test('a nickname matches its formal name', () => {
  assert.ok(nameMatches({ first: 'Bill', last: 'Doe' }, { firstName: 'William', lastName: 'Doe' }))
  assert.ok(nameMatches({ first: 'Betsy', last: 'Doe' }, { firstName: 'Elizabeth', lastName: 'Doe' }))
})

test('typed first and last swapped still match', () => {
  assert.ok(nameMatches({ first: 'Doe', last: 'Jane' }, jane))
})

test('a different last name does not match', () => {
  assert.ok(!nameMatches({ first: 'Jane', last: 'Roe' }, jane))
  assert.ok(!nameMatches({ first: 'Jim', last: 'Doe' }, jane))
})

test('the nickname stored in VG matches', () => {
  const p = { firstName: 'Susan', lastName: 'Doe', nickname: 'Sunny' }
  assert.ok(nameMatches({ first: 'Sunny', last: 'Doe' }, p))
  assert.ok(nameMatches({ first: 'Susan', last: 'Doe' }, p))
})

test('empty, blank and multi-word VG nicknames are handled', () => {
  assert.ok(!nameMatches({ first: 'Sunny', last: 'Doe' }, { ...jane, nickname: '' }))
  assert.ok(!nameMatches({ first: 'Sunny', last: 'Doe' }, { ...jane, nickname: '   ' }))
  const p = { ...jane, nickname: 'Janie Bean' }
  assert.ok(nameMatches({ first: 'Janie Bean', last: 'Doe' }, p))
  assert.ok(nameMatches({ first: 'Janie', last: 'Doe' }, p))
})

test('first word of the typed first name agrees', () => {
  assert.ok(nameMatches({ first: 'Jane A.', last: 'Doe' }, jane))
  assert.ok(nameMatches({ first: 'Mary Ellen', last: 'Doe' }, { firstName: 'Mary', lastName: 'Doe' }))
  assert.ok(nameMatches({ first: 'Bill R', last: 'Doe' }, { firstName: 'William', lastName: 'Doe' }))
  assert.ok(!nameMatches({ first: 'Joan A.', last: 'Doe' }, jane))
})

test('one generational suffix is ignored on either side', () => {
  assert.ok(nameMatches({ first: 'Jane', last: 'Doe Jr.' }, jane))
  assert.ok(nameMatches({ first: 'Jane', last: 'Doe' }, { ...jane, lastName: 'Doe III' }))
  assert.ok(nameMatches({ first: 'Doe Sr', last: 'Jane' }, jane))
  assert.ok(!nameMatches({ first: 'Jane', last: 'Roe Jr' }, jane))
})

test('multi-word last names compare by whole key', () => {
  const p = { firstName: 'Zoe', lastName: "O'Brien-Smith" }
  assert.ok(nameMatches({ first: 'Zoë', last: 'O’Brien Smith' }, p))
  assert.ok(!nameMatches({ first: 'Zoe', last: 'OBrien Smith' }, p))
})

test('a nickname shared across groups agrees with every group', () => {
  assert.ok(NICKNAMES.filter((g) => g.includes('al')).length >= 2)
  assert.ok(firstNamesAgree('al', { firstName: 'Albert' }))
  assert.ok(firstNamesAgree('al', { firstName: 'Alfred' }))
  assert.ok(!firstNamesAgree('albert', { firstName: 'Alfred' }))
})

test('firstNamesAgree: equal keys and missing names', () => {
  assert.ok(firstNamesAgree('jane', jane))
  assert.ok(!firstNamesAgree('', jane))
  assert.ok(!firstNamesAgree('jane', { firstName: null }))
})

test('no match when a part is missing', () => {
  assert.ok(!nameMatches({ first: '', last: '' }, jane))
  assert.ok(!nameMatches({ first: 'Jane', last: '' }, jane))
})
