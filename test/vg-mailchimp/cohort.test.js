import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inCohort, isValidEmail, buildCandidates } from '../../src/vg-mailchimp/cohort.js'
import { subscriberHash } from '../../src/vg-mailchimp/mailchimp.js'

const p = (o) => ({ personId: '1', deceased: 0, email: 'jane@example.org', memberStatus: null, volunteerStatus: null, donor: null, detail: { firstName: 'Jane', lastName: 'Doe' }, ...o })

test('inCohort', () => {
  assert.equal(inCohort(p({ memberStatus: 'Active' })), true)
  assert.equal(inCohort(p({ volunteerStatus: 'Active' })), true)
  assert.equal(inCohort(p({ donor: { id: 1 } })), true)
  assert.equal(inCohort(p({ memberStatus: 'Dropped' })), false)
  assert.equal(inCohort(p({ memberStatus: 'Active', deceased: true })), false)
  assert.equal(inCohort(p({ memberStatus: 'Active', deceased: 1 })), false)
  assert.equal(inCohort(p({})), false)
  assert.equal(inCohort(p({ donor: undefined })), false)
})

test('isValidEmail', () => {
  assert.equal(isValidEmail('jane@example.org'), true)
  for (const e of ['jane.example.org', 'jane@example', 'ja ne@example.org', '@example.org', 'a@@b.org', 'a@.org', 'a@org.', '', null])
    assert.equal(isValidEmail(e), false, String(e))
})

test('duplicates merge, lowest id wins names', () => {
  const r = buildCandidates([
    p({ personId: '12', email: ' Jane@Example.org ', memberStatus: 'Active', detail: { firstName: 'Jane', lastName: 'Doe' } }),
    p({ personId: '7', email: 'jane@example.org', memberStatus: 'Active', detail: { firstName: 'John', lastName: 'Roe' } })
  ])
  assert.equal(r.candidates.length, 1)
  assert.deepEqual(r.candidates[0], { email: 'jane@example.org', hash: subscriberHash('jane@example.org'), personIds: ['7', '12'], firstName: 'John', lastName: 'Roe' })
  assert.equal(r.cohortSize, 2)
})

test('left out records, ordering, cohortSize, missing detail', () => {
  const act = { memberStatus: 'Active' }
  const r = buildCandidates([
    p({ ...act, personId: '30', email: 'z@example.org' }),
    p({ ...act, personId: '20', email: '' }),
    p({ ...act, personId: '3', email: 'jane.example.org' }),
    p({ ...act, personId: '4', email: null }),
    p({ ...act, personId: '5', email: 'ja ne@example.org' }),
    p({ ...act, personId: '9', email: ' Bad@x ' }),
    p({ ...act, personId: '10', email: 'a@example.org', detail: undefined }),
    p({ personId: '2', email: 'out@example.org', memberStatus: 'Dropped' })
  ])
  assert.equal(r.cohortSize, 7)
  assert.deepEqual(r.candidates.map(c => c.personIds[0]), ['10', '30'])
  assert.equal(r.candidates[0].firstName, null)
  assert.equal(r.candidates[0].lastName, null)
  assert.deepEqual(r.leftOut, [
    { kind: 'left-out', reason: 'invalid-email', personIds: ['3'], email: 'jane.example.org' },
    { kind: 'left-out', reason: 'no-email', personIds: ['4'], email: null },
    { kind: 'left-out', reason: 'invalid-email', personIds: ['5'], email: 'ja ne@example.org' },
    { kind: 'left-out', reason: 'invalid-email', personIds: ['9'], email: 'bad@x' },
    { kind: 'left-out', reason: 'no-email', personIds: ['20'], email: null }
  ])
})
