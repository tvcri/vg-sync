// Decides a report's row (what VG stores) and collects the holds staff must settle. Pure: no I/O.
import { nameKey } from './names.js'

const COLUMNS = [
  'id', 'villageId', 'villageName', 'volunteerPersonId', 'rawVolunteerName', 'volunteerFirst', 'volunteerLast',
  'volunteerEmail', 'memberPersonId', 'rawMemberName', 'memberFirst', 'memberLast', 'visitDate',
  'timeSpentMinutes', 'contactType', 'activityTypes', 'activityOther', 'notes', 'reportingTag', 'submittedAt',
  'jotformUpdatedAt', 'volunteerMatch', 'memberMatch', 'held'
]

const dayNumber = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))

// Whole civil days the visit is after the submission (negative: before).
function dayDifference (visitDate, submittedAt) {
  return Math.round((dayNumber(visitDate) - dayNumber(submittedAt)) / 86400000)
}

export function questionableDate (visitDate, submittedAt, { aheadDays, behindDays }) {
  const d = dayDifference(visitDate, submittedAt)
  return d > aheadDays || d < -behindDays
}

const isIgnore = (r) => r?.ignore === true
const personOf = (r) => (r && r.personId != null ? String(r.personId) : null)
const howOf = (r) => (r && r.personId != null ? (r.how ?? null) : null)

export function decideRow (parsed, volunteerMatch, memberMatch, dateDecision, settings) {
  let held = null
  if (parsed.unreadable) held = 'unreadable'
  else if (isIgnore(volunteerMatch) || isIgnore(memberMatch) || dateDecision === 'ignore') held = 'ignored'
  else if (personOf(volunteerMatch) === null || personOf(memberMatch) === null) held = 'name'
  else if (dateDecision == null && questionableDate(parsed.visitDate, parsed.submittedAt, settings)) held = 'date'

  return {
    id: String(parsed.id),
    villageId: parsed.villageId == null ? null : String(parsed.villageId),
    villageName: parsed.villageName ?? null,
    volunteerPersonId: personOf(volunteerMatch),
    rawVolunteerName: parsed.volunteer?.raw ?? null,
    volunteerFirst: parsed.volunteer?.first ?? null,
    volunteerLast: parsed.volunteer?.last ?? null,
    volunteerEmail: parsed.volunteerEmail ?? null,
    memberPersonId: personOf(memberMatch),
    rawMemberName: parsed.member?.raw ?? null,
    memberFirst: parsed.member?.first ?? null,
    memberLast: parsed.member?.last ?? null,
    visitDate: parsed.visitDate ?? null,
    timeSpentMinutes: parsed.timeSpentMinutes ?? null,
    contactType: parsed.contactType ?? null,
    activityTypes: parsed.activityTypes ?? [],
    activityOther: parsed.activityOther ?? null,
    notes: parsed.notes ?? null,
    reportingTag: parsed.reportingTag ?? null,
    submittedAt: parsed.submittedAt,
    jotformUpdatedAt: parsed.jotformUpdatedAt ?? null,
    volunteerMatch: howOf(volunteerMatch),
    memberMatch: howOf(memberMatch),
    held
  }
}

// Rebuilds a Parsed from a stored row, to re-match without JotForm. Whether a report was unreadable cannot
// be recomputed from the row, so a stored 'unreadable' stays unreadable (reason unknown).
// Returns null for a legacy row (the July prototype stored typed names only when they did not match, so a
// matched legacy row has none). Callers must not re-decide such a row from storage; it is re-parsed when
// JotForm next lists it (the go-live full pass). Unreadable rows are exempt: they stay unreadable regardless.
export function rowFromStored (stored) {
  const s = stored
  if (s.held !== 'unreadable' && s.volunteerFirst == null && s.volunteerLast == null && s.memberFirst == null && s.memberLast == null) {
    return null
  }
  return {
    id: String(s.id),
    submittedAt: s.submittedAt,
    jotformUpdatedAt: s.jotformUpdatedAt ?? null,
    villageId: s.villageId == null ? null : String(s.villageId),
    villageName: s.villageName ?? null,
    volunteer: { first: s.volunteerFirst ?? null, last: s.volunteerLast ?? null, raw: s.rawVolunteerName ?? null },
    member: { first: s.memberFirst ?? null, last: s.memberLast ?? null, raw: s.rawMemberName ?? null },
    volunteerEmail: s.volunteerEmail ?? null,
    visitDate: s.visitDate ?? null,
    timeSpentMinutes: s.timeSpentMinutes ?? null,
    contactType: s.contactType ?? null,
    activityTypes: s.activityTypes ?? [],
    activityOther: s.activityOther ?? null,
    notes: s.notes ?? null,
    reportingTag: s.reportingTag ?? null,
    unreadable: s.held === 'unreadable' ? 'stored' : null
  }
}

const norm = (v) => (v === undefined ? null : v)

function sameColumn (col, x, y) {
  x = norm(x)
  y = norm(y)
  if (col === 'activityTypes') {
    const a = x ?? []
    const b = y ?? []
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (col === 'id' || col.endsWith('PersonId') || col === 'villageId') {
    return (x === null ? null : String(x)) === (y === null ? null : String(y))
  }
  return x === y
}

// A stored null activityTypes equals [] on purpose: VG stores no activities as null.
export function rowsDiffer (a, b) {
  return COLUMNS.some((c) => !sameColumn(c, a?.[c], b?.[c]))
}

function compareIds (a, b) {
  a = String(a)
  b = String(b)
  if (a.length !== b.length && /^\d+$/.test(a) && /^\d+$/.test(b)) { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0 }
  return a < b ? -1 : a > b ? 1 : 0
}

const unmatched = (r) => r && !r.ignore && r.personId == null

// Holds for PUT /friends/sync/holds. Name holds come only from reports held for 'name' (an unreadable,
// ignored or date-held report is not waiting on a name). Output is sorted so tests and logs are stable.
// `priorReasons` (Map of submission id to reason, from the open unreadable holds) restores the reason of a
// stored unreadable row, whose reason cannot be recomputed.
export function collectHolds (decided, { priorReasons = new Map() } = {}) {
  const names = new Map()
  const out = []
  // Oldest report first, so the typed spelling and email kept do not depend on input order.
  const ordered = [...decided].sort((x, y) => (x.parsed.submittedAt < y.parsed.submittedAt ? -1 : x.parsed.submittedAt > y.parsed.submittedAt ? 1 : compareIds(x.parsed.id, y.parsed.id)))
  for (const { parsed, row, volunteerResult, memberResult } of ordered) {
    if (row.held === 'name') {
      for (const [role, result, typed] of [['volunteer', volunteerResult, parsed.volunteer], ['member', memberResult, parsed.member]]) {
        if (!unmatched(result)) continue
        const key = nameKey(typed?.raw)
        if (key === '') continue // VG refuses a name hold with no key
        const villageId = parsed.villageId == null ? null : String(parsed.villageId)
        const id = `${role}|${villageId}|${key}`
        let h = names.get(id)
        if (!h) {
          h = {
            kind: 'name', role, nameKey: key, villageId, rawName: typed?.raw ?? '',
            detail: { candidates: new Set(), reportCount: 0, firstVisit: null, lastVisit: null, email: null }
          }
          names.set(id, h)
        }
        for (const c of result.candidates ?? []) h.detail.candidates.add(String(c))
        h.detail.reportCount++
        const v = parsed.visitDate
        if (v != null) {
          if (h.detail.firstVisit === null || v < h.detail.firstVisit) h.detail.firstVisit = v
          if (h.detail.lastVisit === null || v > h.detail.lastVisit) h.detail.lastVisit = v
        }
        if (role === 'volunteer' && h.detail.email === null && parsed.volunteerEmail) h.detail.email = parsed.volunteerEmail
      }
    } else if (row.held === 'date') {
      const rule = dayDifference(parsed.visitDate, parsed.submittedAt) > 0 ? 'ahead' : 'behind'
      out.push({ kind: 'date', submissionId: String(row.id), detail: { visitDate: parsed.visitDate, submittedAt: parsed.submittedAt, rule } })
    } else if (row.held === 'unreadable') {
      out.push({ kind: 'unreadable', submissionId: String(row.id), detail: { reason: parsed.unreadable === 'stored' ? (priorReasons.get(String(row.id)) ?? 'stored') : (parsed.unreadable ?? 'stored') } })
    }
  }
  for (const h of names.values()) {
    h.detail.candidates = [...h.detail.candidates].sort()
    out.push(h)
  }
  const subject = (h) => (h.kind === 'name' ? `${h.role}|${h.villageId ?? ''}|${h.nameKey}` : h.submissionId)
  return out.sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : subject(x) < subject(y) ? -1 : subject(x) > subject(y) ? 1 : 0))
}
