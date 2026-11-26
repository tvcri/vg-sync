import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoster, rememberedKey, buildRemembered, matchPerson } from '../../src/jotform-vg/match.js'

function row (personId, firstName, lastName, o = {}) {
  return {
    personId,
    email: o.email ?? null,
    memberStatus: o.memberStatus ?? null,
    volunteerStatus: o.volunteerStatus ?? null,
    village: o.villageId ? { villageId: o.villageId, name: 'Village ' + o.villageId } : null,
    detail: { firstName, lastName, nickname: o.nickname ?? null }
  }
}

const persons = [
  row('1', 'Jane', 'Doe', { memberStatus: 'Active', villageId: '4', email: ' Shared@Example.org ' }),
  row('2', 'John', 'Doe', { volunteerStatus: 'Active', villageId: '4', email: 'shared@example.org' }),
  row('3', 'Mary', 'Roe', { volunteerStatus: 'Active', villageId: '5', email: 'mary@example.org' }),
  row('4', 'Jane', 'Doe', { memberStatus: 'Active', villageId: '6' }),
  row('5', 'Ann', 'Poe', { memberStatus: 'Dropped', villageId: '4' }),
  row('6', 'Ann', 'Poe', { volunteerStatus: 'Active', villageId: '4' }),
  row('7', 'Sam', 'Moe', { memberStatus: 'Active', villageId: '4' }),
  row('8', 'Sam', 'Moe', { memberStatus: 'Active', villageId: '4' }),
  row('9', 'Zed', 'Loo', { memberStatus: 'Active' }),
  row('10', 'Bill', 'Foo', { memberStatus: 'Active', villageId: '9' })
]
const roster = buildRoster(persons)
const typed = (first, last) => ({ first, last, raw: `${first} ${last}` })
const none = new Map()
const run = (o, rem = none) => matchPerson({ email: null, villageId: '4', ...o }, roster, rem)

test('buildRoster maps rows', () => {
  const p1 = roster.find((p) => p.personId === '1')
  assert.deepEqual(p1, { personId: '1', firstName: 'Jane', lastName: 'Doe', nickname: null, email: 'shared@example.org', villageId: '4', isMember: true, isVolunteer: false })
  const p9 = roster.find((p) => p.personId === '9')
  assert.equal(p9.villageId, null)
  assert.equal(p9.email, null)
})

test('rememberedKey treats unknown village the same four ways', () => {
  const k = rememberedKey('member', 'jane doe', null)
  for (const v of [undefined, '0', 0]) assert.equal(rememberedKey('member', 'jane doe', v), k)
  assert.notEqual(rememberedKey('member', 'jane doe', '4'), k)
  assert.notEqual(rememberedKey('volunteer', 'jane doe', null), k)
})

test('buildRemembered keys by role, key and village', () => {
  const m = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: null, personId: '1', ignore: false }])
  assert.deepEqual(m.get(rememberedKey('member', 'jane doe', 0)), { personId: '1', ignore: false })
})

test('remembered beats everything', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: '4', personId: '4', ignore: false }])
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe') }, rem), { personId: '4', how: 'remembered' })
})

test('remembered ignore returns ignore', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: '4', personId: null, ignore: true }])
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe') }, rem), { ignore: true })
})

test('remembered ignore wins even with a personId that is gone', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: '4', personId: '999', ignore: true }])
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe') }, rem), { ignore: true })
})

test('remembered with unknown village matches a report with no village', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: null, personId: '4', ignore: false }])
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe'), villageId: null }, rem), { personId: '4', how: 'remembered' })
})

test('remembered for another village does not apply', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane doe', villageId: '5', personId: '4', ignore: false }])
  assert.equal(run({ role: 'member', typed: typed('Jane', 'Doe') }, rem).how, 'name-village')
})

test('remembered person missing from roster is no answer; matching goes on', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'ann poe', villageId: '4', personId: '999', ignore: false }])
  assert.deepEqual(run({ role: 'member', typed: typed('Ann', 'Poe') }, rem), { personId: '5', how: 'name-village' })
})

test('remembered works for a half name', () => {
  const rem = buildRemembered([{ role: 'member', nameKey: 'jane', villageId: '4', personId: '1', ignore: false }])
  assert.deepEqual(run({ role: 'member', typed: { first: 'Jane', last: '', raw: 'Jane' } }, rem), { personId: '1', how: 'remembered' })
})

test('email unique and name agrees matches by email despite wrong village', () => {
  assert.deepEqual(run({ role: 'volunteer', typed: typed('Mary', 'Roe'), email: 'mary@example.org', villageId: '4' }), { personId: '3', how: 'email' })
})

test('email is volunteer only', () => {
  const r = run({ role: 'member', typed: typed('Mary', 'Roe'), email: 'mary@example.org', villageId: '5' })
  assert.notEqual(r.how, 'email')
})

test('shared email, name fits one, goes by name-village', () => {
  assert.deepEqual(run({ role: 'volunteer', typed: typed('John', 'Doe'), email: 'shared@example.org' }), { personId: '2', how: 'email' })
  // the member Jane has the same email but is not a volunteer: name steps find nobody
  assert.deepEqual(run({ role: 'volunteer', typed: typed('Jane', 'Doe'), email: 'shared@example.org' }), { personId: null, candidates: [] })
})

test('email of a spouse (name disagrees) is not matched by email; falls to names', () => {
  const r = run({ role: 'volunteer', typed: typed('Mary', 'Roe'), email: 'shared@example.org', villageId: '5' })
  assert.deepEqual(r, { personId: '3', how: 'name-village' })
})

test('email with two name-agreeing people does not decide; names do', () => {
  const people = buildRoster([
    row('11', 'Kim', 'Lee', { volunteerStatus: 'Active', villageId: '4', email: 'k@example.org' }),
    row('12', 'Kim', 'Lee', { volunteerStatus: 'Active', villageId: '5', email: 'k@example.org' })
  ])
  const r = matchPerson({ role: 'volunteer', typed: typed('Kim', 'Lee'), email: 'k@example.org', villageId: '5' }, people, none)
  assert.deepEqual(r, { personId: '12', how: 'name-village' })
})

test('email match is case and space insensitive', () => {
  assert.equal(run({ role: 'volunteer', typed: typed('Mary', 'Roe'), email: '  MARY@Example.org ' }).how, 'email')
})

test('two Jane Does in the form village hold with both', () => {
  const people = buildRoster([row('1', 'Jane', 'Doe', { memberStatus: 'Active', villageId: '4' }), row('4', 'Jane', 'Doe', { memberStatus: 'Active', villageId: '4' }), row('20', 'Jane', 'Doe', { memberStatus: 'Active', villageId: '5' })])
  const r = matchPerson({ role: 'member', typed: typed('Jane', 'Doe'), email: null, villageId: '4' }, people, none)
  assert.deepEqual(r, { personId: null, candidates: ['1', '4'] })
})

test('one Jane Doe elsewhere only is name-elsewhere', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Bill', 'Foo') }), { personId: '10', how: 'name-elsewhere' })
  assert.deepEqual(run({ role: 'member', typed: typed('William', 'Foo') }), { personId: '10', how: 'name-elsewhere' })
})

test('two people elsewhere hold with sorted candidates', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe'), villageId: '7' }), { personId: null, candidates: ['1', '4'] })
})

test('numeric sort is not required, but candidates are sorted and unique strings', () => {
  const r = run({ role: 'member', typed: typed('Sam', 'Moe') })
  assert.deepEqual(r, { personId: null, candidates: ['7', '8'] })
})

test('no match at all holds with no candidates', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Nobody', 'Here') }), { personId: null, candidates: [] })
})

test('a Dropped member still matches', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Ann', 'Poe') }), { personId: '5', how: 'name-village' })
})

test('a volunteer-only person is not a member candidate, and vice versa', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Mary', 'Roe'), villageId: '5' }), { personId: null, candidates: [] })
  assert.deepEqual(run({ role: 'volunteer', typed: typed('Sam', 'Moe') }), { personId: null, candidates: [] })
  assert.deepEqual(run({ role: 'volunteer', typed: typed('Ann', 'Poe') }), { personId: '6', how: 'name-village' })
})

test('a report with no village skips the village step', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Jane', 'Doe'), villageId: null }), { personId: null, candidates: ['1', '4'] })
  assert.deepEqual(run({ role: 'member', typed: typed('Bill', 'Foo'), villageId: null }), { personId: '10', how: 'name-elsewhere' })
})

test('a person with no village is found only elsewhere', () => {
  assert.deepEqual(run({ role: 'member', typed: typed('Zed', 'Loo') }), { personId: '9', how: 'name-elsewhere' })
})

test('half names hold with no candidates', () => {
  assert.deepEqual(run({ role: 'member', typed: { first: 'Jane', last: '', raw: 'Jane' } }), { personId: null, candidates: [] })
  assert.deepEqual(run({ role: 'member', typed: { first: '  ', last: 'Doe', raw: 'Doe' } }), { personId: null, candidates: [] })
  assert.deepEqual(run({ role: 'member', typed: { first: null, last: null, raw: '' } }), { personId: null, candidates: [] })
})
