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
    fetched = byId([...created, ...updated]) // a submission in both is processed once
  } else {
    ran = 'full'
    fetched = byId(await jotform.listAll())
  }

  // Deletion guard, before any write: a short full read must not delete reports.
  if (ran === 'full' && fetched.size < (config.minFullPercent / 100) * stored.size) {
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

  // 3. Every fetched submission, parsed afresh.
  const decided = []
  for (const [id, sub] of fetched) {
    const s = stored.get(id) ?? null
    const unedited = s && rowFromStored(s) !== null && (s.jotformUpdatedAt ?? null) === (sub.updated_at || null) && s.submittedAt === sub.created_at
    decided.push(decide(parseSubmission(sub, villagesByName), s, unedited ? s : null))
  }

  // 4. Stored reports not fetched: deleted on a full pass; on a change pass, re-matched from storage when
  // held or when a name now has a remembered answer. Legacy rows (rowFromStored null) are left alone.
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

  const puts = decided.filter((d) => d.stored === null || rowsDiffer(d.row, d.stored))
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

  // 5. Writes, in order: rows, deletions, holds. A 422 on one row (VG refuses a person or village) is
  // counted and skipped; any other error ends the pass.
  const failedInserts = new Set()
  if (config.writeVg) {
    for (const d of puts) {
      try {
        await vg.putSubmission(d.row.id, d.row)
      } catch (err) {
        if (err?.status !== 422) throw err
        counts.failed++
        if (d.stored === null) failedInserts.add(d.row.id)
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

  // 6. Holds from every report's current decision; a report VG refused to insert has no row to hold.
  const current = decided.filter((d) => !failedInserts.has(d.row.id))
  for (const d of current) if (HELD.includes(d.row.held)) counts.held[d.row.held]++
  const holds = collectHolds(current, { priorReasons })
  counts.openHolds = holds.length
  if (config.writeVg) await vg.putHolds(holds)

  stdout(formatPassLine(counts))
  return counts
}

export function formatPassLine (c) {
  return `JOTFORM OK ${c.kind} fetched=${c.fetched} inserted=${c.inserted} updated=${c.updated} unchanged=${c.unchanged} ` +
    `deleted=${c.deleted} failed=${c.failed} held_name=${c.held.name} held_date=${c.held.date} ` +
    `held_ignored=${c.held.ignored} held_unreadable=${c.held.unreadable} open_holds=${c.openHolds} wrote=${c.wrote}`
}
