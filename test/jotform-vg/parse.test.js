import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSubmission, LIMITS } from '../../src/jotform-vg/parse.js'
import { submission, villagesByName, OUTING } from './fixtures/submissions.js'

const parse = (o) => parseSubmission(submission(o), villagesByName)

test('a complete submission parses every field', () => {
  assert.deepEqual(parse(), {
    id: '5000000000000000001',
    submittedAt: '2026-11-02 09:30:00',
    jotformUpdatedAt: '2026-11-03 10:00:00',
    villageId: '7',
    villageName: 'Aquidneck Island',
    volunteer: { first: 'Jane', last: 'Doe', raw: 'Jane Doe' },
    member: { first: 'John', last: 'Roe', raw: 'John Roe' },
    volunteerEmail: 'jane.doe@example.org',
    visitDate: '2026-11-01',
    timeSpentMinutes: 45,
    contactType: 'Phone call',
    activityTypes: ['pet', 'dining'],
    activityOther: null,
    notes: 'Chatted about the garden.',
    reportingTag: '2026-11-01',
    unreadable: null
  })
})

test('updated_at absent gives null', () => {
  assert.equal(parse({ updated_at: undefined }).jotformUpdatedAt, null)
  assert.equal(parse({ updated_at: '' }).jotformUpdatedAt, null)
})

test('dict-form activities with Other', () => {
  const p = parse({ answers: { 21: { answer: { 0: 'Pet visit', other: 'Baking' } } } })
  assert.deepEqual(p.activityTypes, ['pet', 'other'])
  assert.equal(p.activityOther, 'Baking')
})

test('the Outing option with non-breaking spaces maps', () => {
  assert.deepEqual(parse({ answers: { 21: { answer: [OUTING] } } }).activityTypes, ['outing'])
})

test('village lookup is exact after trimming; unknown is unreadable', () => {
  const ok = parse({ answers: { 10: { answer: '  Bristol ' } } })
  assert.equal(ok.villageId, '8')
  assert.equal(ok.villageName, 'Bristol')
  const bad = parse({ answers: { 10: { answer: 'Atlantis' } } })
  assert.equal(bad.unreadable, 'village')
  assert.equal(bad.villageId, null)
  assert.equal(bad.villageName, 'Atlantis')
  assert.equal(parse({ answers: { 10: { answer: 'aquidneck island' } } }).unreadable, 'village')
  assert.equal(parse({ answers: { 10: undefined } }).unreadable, 'village')
})

test('minutes: digits only', () => {
  const bad = parse({ answers: { 5: { answer: '45 min' } } })
  assert.equal(bad.unreadable, 'time-spent')
  assert.equal(bad.timeSpentMinutes, null)
  const zero = parse({ answers: { 5: { answer: '0' } } })
  assert.equal(zero.unreadable, null)
  assert.equal(zero.timeSpentMinutes, 0)
  assert.equal(parse({ answers: { 5: { answer: ' 30 ' } } }).timeSpentMinutes, 30)
  assert.equal(parse({ answers: { 5: { answer: '' } } }).unreadable, 'time-spent')
  assert.equal(parse({ answers: { 5: undefined } }).unreadable, 'time-spent')
})

test('visit date must be real', () => {
  for (const answer of [{ datetime: '2026-02-30 00:00:00' }, { datetime: 'soon' }, '', undefined]) {
    const p = parse({ answers: { 4: answer === undefined ? undefined : { answer } } })
    assert.equal(p.unreadable, 'visit-date')
    assert.equal(p.visitDate, null)
  }
})

test('contact type missing is unreadable', () => {
  assert.equal(parse({ answers: { 6: { answer: '  ' } } }).unreadable, 'contact-type')
})

test('no email answer gives null', () => {
  assert.equal(parse({ answers: { 23: undefined } }).volunteerEmail, null)
  assert.equal(parse({ answers: { 23: { answer: '   ' } } }).volunteerEmail, null)
})

test('reporting tag: datetime object, string, or null', () => {
  assert.equal(parse({ answers: { 13: { answer: 'sometime' } } }).reportingTag, null)
  assert.equal(parse({ answers: { 13: { answer: '2026-10-31' } } }).reportingTag, '2026-10-31')
  assert.equal(parse({ answers: { 13: { answer: { datetime: 'garbage' } } } }).reportingTag, null)
  assert.equal(parse({ answers: { 13: { answer: '2026-02-30' } } }).reportingTag, null)
  assert.equal(parse({ answers: { 13: { answer: '' } } }).reportingTag, null)
  assert.equal(parse({ answers: { 13: undefined } }).reportingTag, null)
})

test('names with empty parts', () => {
  const p = parse({ answers: { 2: { answer: { first: 'Jane', last: '' } }, 3: undefined } })
  assert.deepEqual(p.volunteer, { first: 'Jane', last: null, raw: 'Jane' })
  assert.deepEqual(p.member, { first: null, last: null, raw: null })
})

test('values over VG column limits are trimmed', () => {
  const long = (n) => 'x'.repeat(n)
  const p = parse({
    answers: {
      2: { answer: { first: long(150), last: long(150) } },
      3: { answer: { first: long(150), last: long(150) } },
      6: { answer: long(80) },
      10: { answer: long(300) },
      21: { answer: { other: long(600) } },
      23: { answer: long(300) }
    }
  })
  assert.equal(p.activityOther.length, 500)
  assert.equal(p.volunteer.first.length, LIMITS.namePart)
  assert.equal(p.volunteer.last.length, 100)
  assert.equal(p.volunteer.raw.length, LIMITS.rawName)
  assert.equal(p.member.raw.length, 200)
  assert.equal(p.volunteerEmail.length, 254)
  assert.equal(p.contactType.length, 50)
  assert.equal(p.villageName.length, 200)
  assert.deepEqual(LIMITS, { activityOther: 500, namePart: 100, rawName: 200, volunteerEmail: 254, contactType: 50, villageName: 200 })
})

test('notes pass through; empty notes are null', () => {
  assert.equal(parse({ answers: { 8: { answer: '' } } }).notes, null)
})

test('a volunteer or member name with no letters is unreadable', () => {
  assert.equal(parse({ answers: { 2: { answer: { first: '', last: '' } } } }).unreadable, 'volunteer-name')
  assert.equal(parse({ answers: { 2: { answer: { first: '.', last: '-' } } } }).unreadable, 'volunteer-name')
  assert.equal(parse({ answers: { 3: { answer: { first: '.', last: '-' } } } }).unreadable, 'member-name')
})
