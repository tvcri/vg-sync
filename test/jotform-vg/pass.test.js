import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPass, cursorMinus } from '../../src/jotform-vg/pass.js'
import { createJotformReader } from '../../src/jotform-vg/jotform.js'
import { createMockJotformFetch } from '../../src/jotform-vg/jotform-mock.js'
import { submission } from './fixtures/submissions.js'

// Invented people only.
const persons = [
  { personId: 101, detail: { firstName: 'Jane', lastName: 'Doe' }, email: 'jane.doe@example.org', village: { villageId: 7 }, memberStatus: null, volunteerStatus: 'Active' },
  { personId: 102, detail: { firstName: 'John', lastName: 'Roe' }, email: null, village: { villageId: 7 }, memberStatus: 'Active', volunteerStatus: null },
  { personId: 103, detail: { firstName: 'Mary', lastName: 'Major' }, email: null, village: { villageId: 7 }, memberStatus: 'Active', volunteerStatus: null }
]
const villages = [{ villageId: 7, name: 'Aquidneck Island' }, { villageId: 8, name: 'Bristol' }]
const config = (o = {}) => ({ writeVg: true, overlapMinutes: 120, minFullPercent: 90, dateAheadDays: 1, dateBehindDays: 90, ...o })

const sid = (n) => `50000000000000000${String(n).padStart(2, '0')}`
const sub = (n, o = {}) => submission({ id: sid(n), created_at: `2026-11-${String(n).padStart(2, '0')} 09:30:00`, updated_at: null, ...o })
const member = (first, last) => ({ 3: { answer: { first, last } } })

function jotformOver (state) {
  const mockFetch = createMockJotformFetch({ state })
  const calls = []
  const spy = async (url, init) => { calls.push(new URL(url).searchParams.get('filter')); return mockFetch(url, init) }
  const reader = createJotformReader({ apiKey: 'k', formId: '1', fetchImpl: spy, baseUrl: 'https://mock.api.jotform.com' })
  reader.calls = calls
  return reader
}

// An in-memory VG with the client's methods.
function fakeVg ({ rows = [], nameMatches = [], people = persons, failPut = null, failDelete = null } = {}) {
  const db = new Map(rows.map((r) => [String(r.id), { dateDecision: null, ...structuredClone(r) }]))
  nameMatches = structuredClone(nameMatches)
  people = structuredClone(people)
  const calls = { put: [], del: [], holds: [] }
  let open = []
  return {
    db, calls, nameMatches, people,
    setFailPut (f) { failPut = f },
    listPersons: async () => people,
    listVillages: async () => villages,
    listNameMatches: async () => nameMatches,
    listOpenHolds: async () => open,
    async getState () {
      let cursor = null
      for (const r of db.values()) for (const v of [r.submittedAt, r.jotformUpdatedAt]) if (v && (cursor === null || v > cursor)) cursor = v
      return { cursor, count: db.size }
    },
    listSubmissions: async () => [...db.values()].map((r) => structuredClone(r)),
    async putSubmission (id, row) {
      calls.put.push(id)
      const err = failPut?.(id, row)
      if (err) throw err
      const prev = db.get(id)
      db.set(id, { ...structuredClone(row), activityTypes: row.activityTypes?.length ? [...row.activityTypes] : null, dateDecision: prev?.dateDecision ?? null })
      return db.get(id)
    },
    async deleteSubmission (id) {
      calls.del.push(id)
      const err = failDelete?.(id)
      if (err) throw err
      db.delete(id)
    },
    async putHolds (holds) {
      calls.holds.push(holds)
      open = holds.map((h, i) => ({ holdId: String(i + 1), ...structuredClone(h), state: 'open' }))
      return { opened: holds.length, updated: 0, closed: 0 }
    }
  }
}

const reset = (vg) => { vg.calls.put = []; vg.calls.del = []; vg.calls.holds = [] }

async function pass (kind, jotform, vg, cfg = config()) {
  const lines = []
  const counts = await runPass(kind, { jotform, vg, config: cfg, stdout: (l) => lines.push(l) })
  return { counts, lines }
}

// A row as the July prototype left it: matched persons, no typed names, no match columns, never edited.
function legacy (n) {
  return {
    id: sid(n), submittedAt: `2026-11-${String(n).padStart(2, '0')} 09:30:00`, jotformUpdatedAt: null, villageId: '7', villageName: 'Aquidneck Island',
    volunteerPersonId: '101', rawVolunteerName: null, volunteerFirst: null, volunteerLast: null, volunteerEmail: null,
    memberPersonId: '102', rawMemberName: null, memberFirst: null, memberLast: null, visitDate: '2026-11-01',
    timeSpentMinutes: 45, contactType: 'Phone call', activityTypes: null, activityOther: null, notes: 'Old.', reportingTag: null,
    volunteerMatch: null, memberMatch: null, held: null, dateDecision: null
  }
}

test('cursorMinus is naive civil arithmetic on the wall-clock string', () => {
  assert.equal(cursorMinus('2026-11-01 01:00:00', 120), '2026-10-31 23:00:00')
  assert.equal(cursorMinus('2026-03-08 03:30:00', 120), '2026-03-08 01:30:00')
  assert.equal(cursorMinus('2026-01-01 00:30:00', 120), '2025-12-31 22:30:00')
  assert.throws(() => cursorMinus('soon', 5))
})

test('first full pass over 3 submissions inserts 3 and logs counts only', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2), sub(3)] })
  const vg = fakeVg()
  const { counts, lines } = await pass('full', jf, vg)
  assert.equal(counts.fetched, 3)
  assert.equal(counts.inserted, 3)
  assert.equal(counts.failed, 0)
  assert.equal(vg.db.size, 3)
  assert.equal(vg.db.get(sid(1)).volunteerPersonId, '101')
  assert.equal(vg.db.get(sid(1)).memberMatch, 'name-village')
  assert.deepEqual(vg.calls.holds, [[]])
  assert.deepEqual(lines, ['JOTFORM OK full fetched=3 inserted=3 updated=0 unchanged=0 deleted=0 failed=0 held_name=0 held_date=0 held_ignored=0 held_unreadable=0 open_holds=0 wrote=true'])
  // A second full pass changes nothing.
  reset(vg)
  const again = await pass('full', jf, vg)
  assert.equal(again.counts.unchanged, 3)
  assert.deepEqual(vg.calls.put, [])
})

test('go-live: legacy rows are re-sent by the first full pass; those JotForm no longer lists are deleted', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2), sub(3)] })
  const vg = fakeVg({ rows: [legacy(1), legacy(2), legacy(3), legacy(4)] })
  const { counts } = await pass('full', jf, vg, config({ minFullPercent: 50 }))
  assert.equal(counts.updated, 3)
  assert.equal(counts.deleted, 1)
  assert.deepEqual(vg.calls.put.sort(), [sid(1), sid(2), sid(3)])
  assert.deepEqual(vg.calls.del, [sid(4)])
  assert.equal(vg.db.get(sid(1)).memberFirst, 'John')
  assert.equal(vg.db.get(sid(1)).volunteerMatch, 'email')
})

test('a change pass leaves legacy rows untouched', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(20)] })
  const vg = fakeVg({ rows: [legacy(1), legacy(20)] })
  const before = structuredClone(vg.db.get(sid(1)))
  const { counts } = await pass('change', jf, vg)
  // Cursor 2026-11-20 09:30 less 2 hours: only #20 is fetched (and re-parsed); #1 is not re-decided.
  assert.equal(counts.kind, 'change')
  assert.equal(counts.fetched, 1)
  assert.deepEqual(vg.calls.put, [sid(20)])
  assert.deepEqual(vg.db.get(sid(1)), before)
})

test('a change pass after one edit updates 1; unchanged rows are not re-sent', async () => {
  const state = { submissions: [sub(1), sub(2), sub(3)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  jf.calls.length = 0
  state.submissions[0] = sub(1, { updated_at: '2026-11-10 12:00:00', answers: { 5: { answer: '60' } } })
  const { counts, lines } = await pass('change', jf, vg)
  assert.equal(counts.updated, 1)
  assert.equal(counts.inserted, 0)
  assert.deepEqual(vg.calls.put, [sid(1)])
  assert.equal(vg.db.get(sid(1)).timeSpentMinutes, 60)
  assert.match(lines[0], /^JOTFORM OK change /)
  // The window starts at the cursor (2026-11-03 09:30) less 2 hours.
  assert.deepEqual(jf.calls, ['{"created_at:gt":"2026-11-03 07:30:00"}', '{"updated_at:gt":"2026-11-03 07:30:00"}'])
})

test('a submission created and edited inside the window is PUT once', async () => {
  const state = { submissions: [sub(1)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  state.submissions.push(sub(2, { created_at: '2026-11-01 10:00:00', updated_at: '2026-11-01 10:30:00' }))
  const { counts } = await pass('change', jf, vg)
  assert.equal(counts.fetched, 2) // #1 again from the overlap, #2 from both lists
  assert.deepEqual(vg.calls.put, [sid(2)])
  assert.equal(counts.inserted, 1)
})

test('a change pass with no cursor runs as full', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2)] })
  const vg = fakeVg()
  const { counts, lines } = await pass('change', jf, vg)
  assert.equal(counts.kind, 'full')
  assert.equal(counts.inserted, 2)
  assert.deepEqual(jf.calls, [null])
  assert.match(lines[0], /^JOTFORM OK full /)
})

test('a full pass after a deletion deletes 1', async () => {
  const state = { submissions: Array.from({ length: 10 }, (_, i) => sub(i + 1)) }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  state.submissions.splice(4, 1)
  const { counts } = await pass('full', jf, vg)
  assert.equal(counts.deleted, 1)
  assert.deepEqual(vg.calls.del, [sid(5)])
  assert.deepEqual(vg.calls.put, [])
})

test('a full read of 1 of 10 stored throws before any write', async () => {
  const state = { submissions: Array.from({ length: 10 }, (_, i) => sub(i + 1)) }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  state.submissions.splice(1)
  state.submissions[0] = sub(1, { updated_at: '2026-11-20 12:00:00', answers: { 5: { answer: '99' } } })
  await assert.rejects(pass('full', jf, vg), { message: 'full read returned 1 of 10 stored; nothing deleted' })
  assert.deepEqual(vg.calls, { put: [], del: [], holds: [] })
  assert.equal(vg.db.size, 10)
})

test('a held name is released by a remembered answer on the next change pass', async () => {
  const state = { submissions: [sub(1, { answers: member('Pat', 'Smith') }), sub(20)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  const first = await pass('full', jf, vg)
  assert.equal(first.counts.held.name, 1)
  assert.equal(vg.db.get(sid(1)).held, 'name')
  assert.deepEqual(vg.calls.holds[0].map((h) => [h.kind, h.role, h.nameKey, h.villageId]), [['name', 'member', 'pat smith', '7']])
  reset(vg)

  // No answer yet: the held row is re-decided from storage, unchanged, and its hold is sent again.
  await pass('change', jf, vg)
  assert.deepEqual(vg.calls.put, [])
  assert.equal(vg.calls.holds[0].length, 1)
  reset(vg)

  vg.nameMatches.push({ role: 'member', nameKey: 'pat smith', villageId: '7', personId: '103', ignore: false })
  const { counts } = await pass('change', jf, vg)
  assert.equal(counts.fetched, 1) // #1 is outside the window: re-matched from storage
  assert.deepEqual(vg.calls.put, [sid(1)])
  const row = vg.db.get(sid(1))
  assert.equal(row.held, null)
  assert.equal(row.memberPersonId, '103')
  assert.equal(row.memberMatch, 'remembered')
  assert.deepEqual(vg.calls.holds, [[]])
  assert.equal(counts.openHolds, 0)
})

test('a remembered answer reaches a counting report stored outside the window', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(20)] })
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  vg.nameMatches.push({ role: 'member', nameKey: 'john roe', villageId: '7', personId: '103', ignore: false })
  await pass('change', jf, vg)
  assert.deepEqual(vg.calls.put.sort(), [sid(1), sid(20)])
  assert.equal(vg.db.get(sid(1)).memberPersonId, '103')
})

test('a newcomer with the same name does not pull an unedited counting report back into the holds', async () => {
  const jf = jotformOver({ submissions: [sub(1)] })
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  vg.people.push({ personId: 104, detail: { firstName: 'John', lastName: 'Roe' }, email: null, village: { villageId: 7 }, memberStatus: 'Active', volunteerStatus: null })
  const { counts } = await pass('full', jf, vg)
  assert.deepEqual(vg.calls.put, [])
  assert.equal(counts.held.name, 0)
  assert.equal(vg.db.get(sid(1)).memberPersonId, '102')
})

test('a real unreadable reason survives passes that re-decide the row from storage', async () => {
  const jf = jotformOver({ submissions: [sub(1, { answers: { 10: { answer: 'Nowhere' } } }), sub(20)] })
  const vg = fakeVg()
  await pass('full', jf, vg)
  const reason = (holds) => holds.find((h) => h.kind === 'unreadable')?.detail.reason
  assert.equal(reason(vg.calls.holds[0]), 'village')
  reset(vg)
  const { counts } = await pass('change', jf, vg)
  assert.equal(counts.held.unreadable, 1)
  assert.deepEqual(vg.calls.put, [])
  assert.equal(reason(vg.calls.holds[0]), 'village')
  reset(vg)
  await pass('change', jf, vg)
  assert.equal(reason(vg.calls.holds[0]), 'village')
})

test('a 422 on one PUT does not stop the others or the holds write', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2, { answers: { 6: { answer: '' } } }), sub(3)] })
  const vg = fakeVg({ failPut: (id) => (id === sid(1) ? Object.assign(new Error('VG PUT → 422'), { status: 422 }) : null) })
  const { counts, lines } = await pass('full', jf, vg)
  assert.equal(counts.failed, 1)
  assert.equal(counts.inserted, 2)
  assert.deepEqual(vg.calls.put, [sid(1), sid(2), sid(3)])
  assert.equal(vg.calls.holds.length, 1)
  assert.deepEqual(vg.calls.holds[0].map((h) => h.kind), ['unreadable'])
  assert.match(lines[0], / failed=1 /)
  assert.doesNotMatch(lines[0], /5000000000/)
})

test('any other VG error on a PUT ends the pass', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2)] })
  const vg = fakeVg({ failPut: () => Object.assign(new Error('VG PUT → 500'), { status: 500 }) })
  await assert.rejects(pass('full', jf, vg), /500/)
  assert.deepEqual(vg.calls.holds, [])
})

test('writeVg false sends nothing and still returns the counts', async () => {
  const jf = jotformOver({ submissions: [sub(1), sub(2), sub(3, { answers: member('Pat', 'Smith') })] })
  const vg = fakeVg({ rows: [legacy(9)] })
  const { counts, lines } = await pass('full', jf, vg, config({ writeVg: false, minFullPercent: 0 }))
  assert.deepEqual(vg.calls, { put: [], del: [], holds: [] })
  assert.equal(counts.inserted, 3)
  assert.equal(counts.deleted, 1)
  assert.equal(counts.held.name, 1)
  assert.equal(counts.openHolds, 1)
  assert.equal(counts.wrote, false)
  assert.match(lines[0], / wrote=false$/)
})

test('a staff date decision stays with the report through a re-parse', async () => {
  const state = { submissions: [sub(1, { answers: { 4: { answer: { datetime: '2026-12-25 00:00:00' } } } })] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  assert.equal(vg.db.get(sid(1)).held, 'date')
  assert.deepEqual(vg.calls.holds[0].map((h) => h.kind), ['date'])
  reset(vg)
  vg.db.get(sid(1)).dateDecision = 'accept'
  await pass('full', jf, vg)
  assert.equal(vg.db.get(sid(1)).held, null)
  assert.deepEqual(vg.calls.holds, [[]])
})

const newcomer = { personId: 104, detail: { firstName: 'John', lastName: 'Roe' }, email: null, village: { villageId: 7 }, memberStatus: 'Active', volunteerStatus: null }
const err = (status) => Object.assign(new Error(`VG → ${status}`), { status })

test('an edited report is re-matched fresh: a newcomer with the same name now holds it', async () => {
  const state = { submissions: [sub(1)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  vg.people.push(newcomer)
  state.submissions[0] = sub(1, { updated_at: '2026-11-05 08:00:00' })
  const { counts } = await pass('full', jf, vg)
  assert.equal(counts.held.name, 1)
  assert.equal(vg.db.get(sid(1)).held, 'name')
  assert.equal(vg.db.get(sid(1)).memberPersonId, null)
  assert.deepEqual(vg.calls.holds[0][0].detail.candidates, ['102', '104'])
})

test('a person gone from VG is not kept: the report is re-matched', async () => {
  const jf = jotformOver({ submissions: [sub(1)] })
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  vg.people.splice(vg.people.findIndex((p) => p.personId === 102), 1)
  await pass('full', jf, vg)
  assert.deepEqual(vg.calls.put, [sid(1)])
  assert.equal(vg.db.get(sid(1)).held, 'name')
  assert.equal(vg.db.get(sid(1)).memberPersonId, null)
})

test('an ignore answer overrides a kept person', async () => {
  const jf = jotformOver({ submissions: [sub(1)] })
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  vg.nameMatches.push({ role: 'member', nameKey: 'john roe', villageId: '7', personId: null, ignore: true })
  const { counts } = await pass('full', jf, vg)
  assert.equal(counts.held.ignored, 1)
  assert.equal(vg.db.get(sid(1)).held, 'ignored')
  assert.equal(vg.db.get(sid(1)).memberPersonId, null)
})

test('writes go oldest first, so a failed write is not left behind the cursor', async () => {
  const state = { submissions: [sub(1)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  // The lower id is the newer report; the older one (#12) gets a 500.
  state.submissions.push(sub(10, { created_at: '2026-11-15 09:30:00' }), sub(12, { created_at: '2026-11-10 09:30:00' }))
  vg.setFailPut((id) => (id === sid(12) ? err(500) : null))
  await assert.rejects(pass('change', jf, vg), /500/)
  assert.deepEqual(vg.calls.put, [sid(12)])
  reset(vg)
  vg.setFailPut(null)
  const { counts } = await pass('change', jf, vg)
  assert.equal(counts.inserted, 2)
  assert.deepEqual(vg.calls.put, [sid(12), sid(10)])
})

test('a refused update keeps the hold of the row VG still holds', async () => {
  const state = { submissions: [sub(1, { answers: member('Pat', 'Smith') })] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  // Edited to a known member, but VG refuses the write: VG still holds the row for the name.
  state.submissions[0] = sub(1, { updated_at: '2026-11-04 08:00:00' })
  vg.setFailPut(() => err(422))
  const { counts } = await pass('full', jf, vg)
  assert.equal(counts.failed, 1)
  assert.equal(counts.updated, 0)
  assert.equal(counts.held.name, 1)
  assert.deepEqual(vg.calls.holds[0].map((h) => [h.kind, h.nameKey]), [['name', 'pat smith']])
})

test('a refused update of a legacy row sends no hold for it', async () => {
  const jf = jotformOver({ submissions: [sub(1, { answers: member('Pat', 'Smith') })] })
  const vg = fakeVg({ rows: [legacy(1)], failPut: () => err(422) })
  const { counts } = await pass('full', jf, vg)
  assert.equal(counts.failed, 1)
  assert.equal(counts.held.name, 0)
  assert.deepEqual(vg.calls.holds, [[]])
})

test('a DELETE error ends the pass before the holds are sent', async () => {
  const state = { submissions: Array.from({ length: 10 }, (_, i) => sub(i + 1)) }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  state.submissions.splice(4, 1)
  const failing = fakeVg({ rows: [...vg.db.values()], failDelete: () => err(500) })
  await assert.rejects(pass('full', jf, failing), /500/)
  assert.deepEqual(failing.calls.holds, [])
})

test('a full pass refuses to delete more than the share it may miss', async () => {
  // 10 listed for 10 stored passes the read guard, but none of the 10 stored is listed: 10 > 10% of 10.
  const jf = jotformOver({ submissions: Array.from({ length: 10 }, (_, i) => sub(i + 1)) })
  const vg = fakeVg({ rows: Array.from({ length: 10 }, (_, i) => legacy(i + 11)) })
  await assert.rejects(pass('full', jf, vg), { message: 'full read would delete 10 of 10 stored; nothing deleted' })
  assert.deepEqual(vg.calls, { put: [], del: [], holds: [] })
})

test('a submission in both lists is kept as the copy with the later updated_at', async () => {
  const state = { submissions: [sub(1)] }
  const jf = jotformOver(state)
  const vg = fakeVg()
  await pass('full', jf, vg)
  reset(vg)
  // The created list is read first; the submission is edited before the updated list is read.
  const edited = sub(2, { created_at: '2026-11-01 10:00:00', updated_at: '2026-11-01 11:00:00', answers: { 5: { answer: '75' } } })
  const original = sub(2, { created_at: '2026-11-01 10:00:00' })
  const reader = {
    listSince: async (field) => (field === 'created_at' ? [original] : [edited]),
    listAll: async () => { throw new Error('not used') }
  }
  await pass('change', reader, vg)
  assert.equal(vg.db.get(sid(2)).timeSpentMinutes, 75)
  assert.equal(vg.db.get(sid(2)).jotformUpdatedAt, '2026-11-01 11:00:00')
})
