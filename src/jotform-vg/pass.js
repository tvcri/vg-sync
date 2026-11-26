// One pass of the JotForm → VG sync: read JotForm and VG, decide every report it touches, then write the
// changed rows, the deletions and the complete set of open holds. Dry run (config.writeVg false) computes
// everything and writes nothing. Logs one line of counts; never names, emails, notes or ids.
import { parseSubmission } from './parse.js'
import { nameKey } from './names.js'
import { buildRoster, buildRemembered, matchPerson, rememberedKey } from './match.js'
import { decideRow, rowFromStored, rowsDiffer, collectHolds } from './decide.js'

const HELD = ['name', 'date', 'ignored', 'unreadable']
// How a person was found by a rule; such a match stays until the submission is edited.
const RULE_MATCHES = new Set(['email', 'name-village', 'name-elsewhere'])

// cursor − minutes on a 'YYYY-MM-DD HH:MM:SS' wall-clock string, as if UTC (naive civil arithmetic),
// formatted back the same way. The string is Eastern time; it is never converted.
export function cursorMinus (cursor, minutes) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(cursor))
  const t = m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN
  if (Number.isNaN(t)) throw new Error('VG sync state cursor is not YYYY-MM-DD HH:MM:SS')
  return new Date(t - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

const byId = (list) => {
  const map = new Map()
  for (const s of list) if (!map.has(String(s.id))) map.set(String(s.id), s)
  return map
}

// The created and updated lists merged by id. A submission in both is kept once, as the copy with the
// later updated_at (null lowest), in case it was edited between the two reads.
function mergeFetched (created, updated) {
  const map = new Map()
  for (const s of [...created, ...updated]) {
    const id = String(s.id)
    const had = map.get(id)
    if (!had || (s.updated_at || '') > (had.updated_at || '')) map.set(id, s)
  }
  return map
}

// Ids compared as numbers when they are digits (19-digit strings, so by length first).
function compareIds (a, b) {
  a = String(a)
  b = String(b)
  if (a.length !== b.length && /^\d+$/.test(a) && /^\d+$/.test(b)) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

// Oldest JotForm time first. VG's cursor is the latest time stored, so if a write fails partway, no
// report older than one already written is left behind the next change pass's window.
const rowTime = (row) => row.jotformUpdatedAt ?? row.submittedAt ?? ''
const oldestFirst = (x, y) => (rowTime(x.row) < rowTime(y.row) ? -1 : rowTime(x.row) > rowTime(y.row) ? 1 : compareIds(x.row.id, y.row.id))

export async function runPass (kind, { jotform, vg, config, stdout = console.log }) {
  if (kind !== 'change' && kind !== 'full') throw new Error(`runPass: kind must be change or full, got ${kind}`)

  // 1. Read VG.
  const [persons, villages, nameMatches, storedList, openHolds, state] = await Promise.all([
    vg.listPersons(), vg.listVillages(), vg.listNameMatches(), vg.listSubmissions(), vg.listOpenHolds(),
    kind === 'change' ? vg.getState() : null
  ])
  const roster = buildRoster(persons)
  const rosterIds = new Set(roster.map((p) => p.personId))
  const remembered = buildRemembered(nameMatches)
  const villagesByName = new Map(villages.map((v) => [v.name, String(v.villageId)]))
  const stored = byId(storedList)
  const priorReasons = new Map()
  for (const h of openHolds) {
    if (h.kind === 'unreadable' && h.submissionId != null && h.detail?.reason) priorReasons.set(String(h.submissionId), h.detail.reason)
  }

  // 2. Read JotForm. A change pass with no cursor (VG holds no reports) runs as full.
  let ran = kind
  let fetched
  if (kind === 'change' && state?.cursor != null) {
    const after = cursorMinus(state.cursor, config.overlapMinutes)
    const [created, updated] = await Promise.all([jotform.listSince('created_at', after), jotform.listSince('updated_at', after)])
    fetched = mergeFetched(created, updated) // a submission in both is processed once
  } else {
    ran = 'full'
    fetched = byId(await jotform.listAll())
  }

  // Deletion guard, before any write: a short full read must not delete reports.
  // Integer arithmetic: 0.9 × 10 in floating point is not 9.
  if (ran === 'full' && fetched.size * 100 < config.minFullPercent * stored.size) {
    throw new Error(`full read returned ${fetched.size} of ${stored.size} stored; nothing deleted`)
  }

  const settings = { aheadDays: config.dateAheadDays, behindDays: config.dateBehindDays }

  // A role's match. `keep` is the stored row of an unedited report: a person it found by a rule stays
  // (a newcomer with the same name does not pull a counting report back), unless a remembered answer now
  // says otherwise or the person is gone from VG.
  function resolve (role, parsed, keep) {
    const typed = parsed[role]
    const fresh = matchPerson({ role, typed, email: role === 'volunteer' ? parsed.volunteerEmail : null, villageId: parsed.villageId }, roster, remembered)
    if (keep && fresh.how !== 'remembered' && !fresh.ignore) {
      const pid = keep[`${role}PersonId`]
      const how = keep[`${role}Match`]
      if (pid != null && RULE_MATCHES.has(how) && rosterIds.has(String(pid))) return { personId: String(pid), how }
    }
    return fresh
  }

  function decide (parsed, storedRow, keep) {
    const volunteerResult = resolve('volunteer', parsed, keep)
    const memberResult = resolve('member', parsed, keep)
    const row = decideRow(parsed, volunteerResult, memberResult, storedRow?.dateDecision ?? null, settings)
    return { parsed, row, volunteerResult, memberResult, stored: storedRow ?? null }
  }

  // A stored row as a decision, unchanged: its persons as stored, and for a role it has no person, the
  // candidates a match finds now (for the hold's detail). Null for a legacy row.
  function asStored (s) {
    const parsed = rowFromStored(s)
    if (parsed === null) return null
    const result = (role) => {
      const pid = s[`${role}PersonId`]
      if (pid != null) return { personId: String(pid), how: s[`${role}Match`] ?? null }
      const fresh = matchPerson({ role, typed: parsed[role], email: role === 'volunteer' ? parsed.volunteerEmail : null, villageId: parsed.villageId }, roster, remembered)
      return { personId: null, candidates: fresh.candidates ?? [] }
    }
    return { parsed, row: s, volunteerResult: result('volunteer'), memberResult: result('member'), stored: s }
  }

  // 3. Every fetched submission, parsed afresh.
  const decided = []
  for (const [id, sub] of fetched) {
    const s = stored.get(id) ?? null
    const unedited = s && rowFromStored(s) !== null && (s.jotformUpdatedAt ?? null) === (sub.updated_at || null) && s.submittedAt === sub.created_at
    decided.push(decide(parseSubmission(sub, villagesByName), s, unedited ? s : null))
  }

  // 4. Stored reports not fetched: deleted on a full pass; on a change pass, re-matched from storage when
  // held or when a name now has a remembered answer. Legacy rows (rowFromStored null) are left alone: they
  // are re-parsed only when JotForm lists them, which for most is the first full pass (run at start-up).
  // So a legacy row the prototype left unmatched opens its name hold only at that first full pass.
  const deletions = []
  for (const [id, s] of stored) {
    if (fetched.has(id)) continue
    if (ran === 'full') { deletions.push(id); continue }
    const parsed = rowFromStored(s)
    if (parsed === null) continue
    const hasAnswer = ['volunteer', 'member'].some((role) => remembered.has(rememberedKey(role, nameKey(parsed[role]?.raw), parsed.villageId)))
    if (s.held == null && !hasAnswer) continue
    decided.push(decide(parsed, s, s))
  }

  // Second guard: even when the read looks whole, a full pass deletes no more than the share it may miss.
  if (deletions.length * 100 > (100 - config.minFullPercent) * stored.size) {
    throw new Error(`full read would delete ${deletions.length} of ${stored.size} stored; nothing deleted`)
  }

  const puts = decided.filter((d) => d.stored === null || rowsDiffer(d.row, d.stored)).sort(oldestFirst)
  const counts = {
    kind: ran,
    fetched: fetched.size,
    inserted: 0,
    updated: 0,
    unchanged: decided.length - puts.length,
    deleted: 0,
    failed: 0,
    held: { name: 0, date: 0, ignored: 0, unreadable: 0 },
    openHolds: 0,
    wrote: Boolean(config.writeVg)
  }

  // 5. Writes, in order: rows, deletions, holds. A 400, 413 or 422 on one row (VG refuses the row's
  // shape, size, person or village) is counted and skipped; any other error ends the pass. Skipping
  // matters: PUTs go oldest first, so a row that ended the pass would end every later pass too.
  const failed = new Set()
  if (config.writeVg) {
    for (const d of puts) {
      try {
        await vg.putSubmission(d.row.id, d.row)
      } catch (err) {
        if (err?.token || !ROW_REFUSED.includes(err?.status)) throw err
        counts.failed++
        failed.add(d)
        continue
      }
      if (d.stored === null) counts.inserted++
      else counts.updated++
    }
    for (const id of deletions) {
      await vg.deleteSubmission(id)
      counts.deleted++
    }
  } else {
    for (const d of puts) d.stored === null ? counts.inserted++ : counts.updated++
    counts.deleted = deletions.length
  }

  // 6. Holds from what VG holds for every report: the new decision, or for a refused write the stored
  // row. A refused insert has no row to hold; a refused update of a legacy row is counting in VG.
  const current = []
  for (const d of decided) {
    if (!failed.has(d)) { current.push(d); continue }
    if (d.stored === null) continue
    const kept = asStored(d.stored)
    if (kept) current.push(kept)
  }
  for (const d of current) if (HELD.includes(d.row.held)) counts.held[d.row.held]++
  const holds = collectHolds(current, { priorReasons })
  counts.openHolds = holds.length
  if (config.writeVg) await vg.putHolds(holds)

  stdout(formatPassLine(counts))
  return counts
}

// VG statuses that refuse one row, not the pass: 400 (fails the OpenAPI schema), 413 (too large),
// 422 (a dangling person or village). A Keycloak token error (err.token) is never a row's fault.
const ROW_REFUSED = [400, 413, 422]

export function formatPassLine (c) {
  return `JOTFORM OK ${c.kind} fetched=${c.fetched} inserted=${c.inserted} updated=${c.updated} unchanged=${c.unchanged} ` +
    `deleted=${c.deleted} failed=${c.failed} held_name=${c.held.name} held_date=${c.held.date} ` +
    `held_ignored=${c.held.ignored} held_unreadable=${c.held.unreadable} open_holds=${c.openHolds} wrote=${c.wrote}`
}
