import { test } from 'node:test'
import assert from 'node:assert/strict'
import { questionableDate, decideRow, rowFromStored, rowsDiffer, collectHolds } from '../../src/jotform-vg/decide.js'
import { nameKey } from '../../src/jotform-vg/names.js'

const settings = { aheadDays: 1, behindDays: 90 }
const sub = '2026-11-20 09:00:00'

function parsed (o = {}) {
  return {
    id: '1001', submittedAt: sub, jotformUpdatedAt: null, villageId: '4', villageName: 'Village Four',
    volunteer: { first: 'Jon', last: 'Doe', raw: 'Jon Doe' }, member: { first: 'Ann', last: 'Poe', raw: 'Ann Poe' },
    volunteerEmail: 'jon@example.org', visitDate: '2026-11-19', timeSpentMinutes: 30, contactType: 'Visit',
    activityTypes: ['pet', 'dining'], activityOther: null, notes: 'n', reportingTag: null, unreadable: null, ...o
  }
}
const ok = (id) => ({ personId: id, how: 'name-village' })
const miss = (candidates = []) => ({ personId: null, candidates })

test('questionableDate windows', () => {
  assert.equal(questionableDate('2026-11-21', sub, settings), false)
  assert.equal(questionableDate('2026-11-22', sub, settings), true)
  assert.equal(questionableDate('2026-08-22', sub, { aheadDays: 1, behindDays: 90 }), false)
  assert.equal(questionableDate('2026-08-21', sub, { aheadDays: 1, behindDays: 90 }), true)
})

test('held precedence: unreadable > ignored > name > date', () => {
  const late = { visitDate: '2026-12-30' }
  assert.equal(decideRow(parsed({ ...late, unreadable: 'village' }), { ignore: true }, miss(), null, settings).held, 'unreadable')
  assert.equal(decideRow(parsed(late), { ignore: true }, miss(), null, settings).held, 'ignored')
  assert.equal(decideRow(parsed(late), ok('7'), miss(), null, settings).held, 'name')
  assert.equal(decideRow(parsed(late), ok('7'), ok('8'), null, settings).held, 'date')
  assert.equal(decideRow(parsed(), ok('7'), ok('8'), null, settings).held, null)
})

test('date decisions', () => {
  const p = parsed({ visitDate: '2026-12-30' })
  assert.equal(decideRow(p, ok('7'), ok('8'), 'accept', settings).held, null)
  assert.equal(decideRow(p, ok('7'), ok('8'), 'ignore', settings).held, 'ignored')
})

test('row shape: strings, null ignore columns, no dateDecision', () => {
  const r = decideRow(parsed({ id: 1001, villageId: 4 }), { ignore: true }, { personId: 8, how: 'email' }, null, settings)
  assert.equal(r.id, '1001')
  assert.equal(r.villageId, '4')
  assert.equal(r.volunteerPersonId, null)
  assert.equal(r.volunteerMatch, null)
  assert.equal(r.memberPersonId, '8')
  assert.equal(r.memberMatch, 'email')
  assert.equal(Object.keys(r).length, 24)
  assert.ok(!('dateDecision' in r))
})

test('rowFromStored round-trips the fields matching uses; stored unreadable stays', () => {
  const p = parsed()
  const back = rowFromStored({ ...decideRow(p, ok('7'), ok('8'), null, settings), dateDecision: null })
  for (const k of ['volunteer', 'member', 'volunteerEmail', 'villageId', 'visitDate', 'submittedAt', 'activityTypes']) {
    assert.deepEqual(back[k], p[k], k)
  }
  assert.equal(back.unreadable, null)
  const u = decideRow(parsed({ unreadable: 'village', villageId: null }), miss(), miss(), null, settings)
  assert.equal(rowFromStored(u).unreadable, 'stored')
})

test('rowsDiffer', () => {
  const a = decideRow(parsed(), ok('7'), ok('8'), null, settings)
  assert.equal(rowsDiffer(a, { ...a }), false)
  assert.equal(rowsDiffer(a, { ...a, notes: 'x' }), true)
  assert.equal(rowsDiffer(a, { ...a, activityTypes: ['dining', 'pet'] }), true)
  assert.equal(rowsDiffer(a, { ...a, activityTypes: ['pet', 'dining'] }), false)
  assert.equal(rowsDiffer({ ...a, activityOther: null }, { ...a, activityOther: undefined }), false)
  assert.equal(rowsDiffer(a, { ...a, memberPersonId: 8, id: 1001 }), false)
  // a legacy row with empty match columns and name parts is detected
  assert.equal(rowsDiffer(a, { ...a, volunteerMatch: null, memberMatch: null, volunteerFirst: null, memberFirst: null }), true)
})

function entry (id, o, vr, mr) {
  const p = parsed({ id, ...o })
  return { parsed: p, row: decideRow(p, vr, mr, null, settings), volunteerResult: vr, memberResult: mr }
}

test('three reports from one unmatched name make one name hold', () => {
  const holds = collectHolds([
    entry('1', { visitDate: '2026-11-10', volunteerEmail: null }, miss(['5']), ok('8')),
    entry('2', { visitDate: '2026-11-18', volunteerEmail: 'a@example.org', volunteer: { first: 'Jon', last: 'Doe', raw: 'Jon  Doe' } }, miss(['6']), ok('8')),
    entry('3', { visitDate: '2026-11-02' }, miss(['5']), ok('8'))
  ])
  assert.equal(holds.length, 1)
  const h = holds[0]
  assert.equal(h.kind, 'name')
  assert.equal(h.role, 'volunteer')
  assert.equal(h.nameKey, nameKey('Jon Doe'))
  assert.equal(h.villageId, '4')
  assert.equal(h.rawName, 'Jon Doe')
  assert.deepEqual(h.detail, { candidates: ['5', '6'], reportCount: 3, firstVisit: '2026-11-02', lastVisit: '2026-11-18', email: 'a@example.org' })
})

test('both names unmatched gives two holds; date and unreadable holds; sorted', () => {
  const both = entry('1', {}, miss(), miss())
  const date = entry('2', { visitDate: '2026-12-30' }, ok('7'), ok('8'))
  const bad = entry('3', { unreadable: 'time-spent', timeSpentMinutes: null }, miss(), miss())
  const ign = entry('4', {}, { ignore: true }, miss())
  const holds = collectHolds([both, date, bad, ign])
  assert.deepEqual(holds.map((h) => h.kind + ':' + (h.role ?? h.submissionId)), ['date:2', 'name:member', 'name:volunteer', 'unreadable:3'])
  assert.deepEqual(holds[0].detail, { visitDate: '2026-12-30', submittedAt: sub, rule: 'ahead' })
  assert.deepEqual(holds[3].detail, { reason: 'time-spent' })
  assert.equal(holds[1].detail.email, null)
  const behind = collectHolds([entry('5', { visitDate: '2026-01-01' }, ok('7'), ok('8'))])
  assert.equal(behind[0].detail.rule, 'behind')
})

test('an empty name never makes a name hold', () => {
  const empty = { first: '.', last: '-', raw: '. -' }
  // as parse now reports it: unreadable, so one unreadable hold
  const bad = entry('9', { volunteer: empty, unreadable: 'volunteer-name' }, miss(), ok('8'))
  assert.deepEqual(collectHolds([bad]).map((h) => h.kind), ['unreadable'])
  // guard: even a name-held row with an empty key emits no name hold
  const p = parsed({ id: '10', volunteer: empty })
  const row = decideRow(p, miss(), ok('8'), null, settings)
  assert.equal(row.held, 'name')
  assert.deepEqual(collectHolds([{ parsed: p, row, volunteerResult: miss(), memberResult: ok('8') }]), [])
})
