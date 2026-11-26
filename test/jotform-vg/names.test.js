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

test('a double first name fits a single one, either way, but not a different double', () => {
  const d = (firstName, nickname) => ({ firstName, lastName: 'Doe', nickname })
  assert.ok(nameMatches({ first: 'Mary', last: 'Doe' }, d('Mary Kate')))
  assert.ok(nameMatches({ first: 'Mary Ellen', last: 'Doe' }, d('Mary')))
  assert.ok(!nameMatches({ first: 'Mary Ellen', last: 'Doe' }, d('Mary Kate')))
  assert.ok(nameMatches({ first: 'Mary Kate', last: 'Doe' }, d('Mary Kate')))
  assert.ok(nameMatches({ first: 'Molly', last: 'Doe' }, d('Mary Kate')))
  assert.ok(nameMatches({ first: 'Mary', last: 'Doe' }, d('Zed', 'Mary Kate')))
  assert.ok(!nameMatches({ first: 'Mary Ellen', last: 'Doe' }, d('Zed', 'Mary Kate')))
})

test('one generational suffix is ignored on either side', () => {
  assert.ok(nameMatches({ first: 'Jane', last: 'Doe Jr.' }, jane))
  assert.ok(nameMatches({ first: 'Jane', last: 'Doe' }, { ...jane, lastName: 'Doe III' }))
  assert.ok(nameMatches({ first: 'Doe Sr', last: 'Jane' }, jane))
  assert.ok(!nameMatches({ first: 'Jane', last: 'Roe Jr' }, jane))
})

test('different generational suffixes do not match', () => {
  const john = (lastName) => ({ firstName: 'John', lastName })
  assert.ok(!nameMatches({ first: 'John', last: 'Doe Jr' }, john('Doe Sr')))
  assert.ok(!nameMatches({ first: 'Doe Sr', last: 'John' }, john('Doe Jr')))
  assert.ok(nameMatches({ first: 'John', last: 'Doe Jr' }, john('Doe')))
  assert.ok(nameMatches({ first: 'John', last: 'Doe' }, john('Doe Jr')))
  assert.ok(nameMatches({ first: 'John', last: 'Doe Jr.' }, john('Doe Jr')))
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

test('short forms used by several formal names fit every one of them', () => {
  const fits = (typed, firstName) => nameMatches({ first: typed, last: 'Doe' }, { firstName, lastName: 'Doe' })
  for (const [short, formals] of [
    ['Pat', ['Patrick', 'Patricia']],
    ['Sam', ['Samuel', 'Samantha']],
    ['Sandy', ['Sandra', 'Alexandra', 'Alexander']],
    ['Al', ['Albert', 'Alfred', 'Alan', 'Allen']],
    ['Alex', ['Alexander', 'Alexandra', 'Alexis']],
    ['Charlie', ['Charles', 'Charlotte']],
    ['Danny', ['Daniel', 'Danielle']],
    ['Ed', ['Edward', 'Edwin', 'Edmund']],
    ['Nicky', ['Nicholas', 'Nicole']]
  ]) for (const f of formals) assert.ok(fits(short, f), `${short} fits ${f}`)
  assert.ok(!fits('Patrick', 'Patricia'))
  assert.ok(!fits('Samuel', 'Samantha'))
})

test('table-driven: each ambiguous short form fits every formal name it abbreviates', () => {
  const fits = (typed, firstName) => nameMatches({ first: typed, last: 'Doe' }, { firstName, lastName: 'Doe' })
  for (const [short, formals] of [
    ['pat', ['Patrick', 'Patricia']],
    ['sam', ['Samuel', 'Samantha']],
    ['sandy', ['Sandra', 'Alexandra', 'Alexander']],
    ['alex', ['Alexander', 'Alexandra', 'Alexis']],
    ['al', ['Albert', 'Alfred', 'Alan', 'Allen', 'Alvin']],
    ['nicky', ['Nicholas', 'Nicole']],
    ['stevie', ['Steven', 'Stephen', 'Stephanie']],
    ['bobby', ['Robert', 'Roberta']],
    ['charlie', ['Charles', 'Charlotte', 'Charlene']],
    ['danny', ['Daniel', 'Danielle']],
    ['jerry', ['Gerald', 'Geraldine', 'Gerard', 'Jeremy', 'Jerome']],
    ['ronnie', ['Ronald', 'Veronica']],
    ['freddie', ['Frederick', 'Frederica', 'Alfred']],
    ['ed', ['Edward', 'Edwin', 'Edmund']],
    ['ted', ['Edward', 'Edwin', 'Edmund', 'Theodore']],
    ['kathy', ['Katherine', 'Catherine', 'Kathleen']],
    ['kate', ['Katherine', 'Kathleen', 'Kaitlyn', 'Katrina']],
    ['chris', ['Christopher', 'Christine', 'Christina', 'Kristine', 'Kristen']],
    ['joe', ['Joseph', 'Josephine']],
    ['will', ['William', 'Willard', 'Wilbur']],
    ['wally', ['Walter', 'Wallace']],
    ['margie', ['Margaret', 'Marjorie', 'Margery']],
    ['jo', ['Joan', 'Joanne', 'Joann', 'Josephine']]
  ]) for (const f of formals) assert.ok(fits(short, f), `${short} fits ${f}`)
})

test('distinct formal names do not fit each other; Dora is not a short form', () => {
  const fits = (typed, firstName) => nameMatches({ first: typed, last: 'Doe' }, { firstName, lastName: 'Doe' })
  assert.ok(!fits('Kathleen', 'Katherine'))
  assert.ok(!fits('Edward', 'Edwin'))
  assert.ok(!fits('Theodora', 'Dora'))
  assert.ok(fits('Elisabeth', 'Elizabeth'))
  assert.ok(!fits('Kris', 'Kristen'))
  assert.ok(!fits('Kris', 'Christopher'))
  assert.ok(!fits('Bobbi', 'Roberta'))
  assert.ok(!fits('Elizabeth', 'Eliza'))
})

test('nameKey is capped at 200 characters', () => {
  const k = nameKey('abcdefghi '.repeat(30))
  assert.ok(k.length <= 200)
  assert.equal(k, k.trim())
})
