// Checks one scenario's people against one phase's expectations. Pure: no I/O.
import { FIELDS, comparable, lglFields, vgFields } from '../src/lgl-vg/fields.js'
import { resolveDate } from './scenario.js'

const PLAIN = ['lastGiftDate', 'donor', 'addressee', 'salutation']
const holdKey = (h) => `${h.field}|${h.reason}|${h.state ?? 'open'}`

// vgPersons: one person or two, as GET /persons?projection=detail returns them
//   (the donor row, when linked, is p.donor = { lglConstituentId, lastGiftDate }).
// lglConstituent: harness/lgl-write.js getConstituent(id), or null when gone. For
//   expect.lgl.lastGiftDate and .donor the constituent is read as a plain object
//   (c.lastGiftDate, c.donor), which the runner may set from the gifts it made.
// holds: this scenario's rows from /sync/holds. decisions: the pass's rows for them
//   (expect.writes, .lglWrites, .deferred and .records count outcomes write-vg, write-lgl, deferred and record).
// expect.lgl.addressee and .salutation compare plainly; expect.lglEntries { <kind>: { current, total } }
//   counts the entries on the constituent's lists as getConstituent read them back (current: not not_current).
// passStartedAt: ISO string; a hold with firstSeenAt >= it was opened in this pass.
// phaseIndex is 0-based; one past the scenario's phases is checked as undisturbed.
// passExitCode: the pass's exit code; with expect.passFails a zero exit is the failure.
// today ('YYYY-MM-DD'): resolves a relative date ('-5d') in an expected lastGiftDate or deceased date.
// constituentIds: scenario name -> its LGL constituent id, for expect.vg.donorOf (the scenario whose
//   constituent the person must be linked to).
export function checkScenario ({ scenario, phaseIndex, vgPersons, lglConstituent, holds = [], decisions = [], passStartedAt, passExitCode, today, constituentIds = {} }) {
  if (!passStartedAt) throw new Error('checkScenario needs passStartedAt (an ISO string)')
  const when = (v) => {
    if (typeof v !== 'string' || !/^[+-]\d+[dy]$/.test(v)) return v
    if (!today) throw new Error(`checkScenario needs today to resolve ${v}`)
    return resolveDate(v, today)
  }
  const dated = (field, v) => {
    if (field === 'lastGiftDate') return when(v)
    if (field === 'deceased' && v && typeof v === 'object') return { ...v, date: when(v.date) }
    return v
  }
  const phase = phaseIndex + 1
  const failures = []
  const fail = (what, expected, found) => failures.push({ phase, what, expected, found })
  const writes = decisions.filter((d) => d.outcome === 'write-vg').length

  if (phaseIndex >= scenario.phases.length) {
    if (writes) fail('undisturbed: writes', 0, writes)
    for (const h of holds) {
      if ((h.state ?? 'open') !== 'open') continue
      if (!h.firstSeenAt) fail('undisturbed: hold without firstSeenAt', 'firstSeenAt', `${h.field} ${h.reason}`)
      else if (h.firstSeenAt >= passStartedAt) fail('undisturbed: new hold', 'none', `${h.field} ${h.reason}`)
    }
    return failures
  }

  const expect = scenario.phases[phaseIndex].expect
  if (!expect) return failures
  const persons = [].concat(vgPersons ?? [])

  if (expect.vg !== undefined) {
    if (!Array.isArray(expect.vg) && !persons.length) fail('vg', 'a person', 'missing')
    const per = Array.isArray(expect.vg) ? expect.vg : persons.map(() => expect.vg)
    per.forEach((exp, i) => {
      const prefix = persons.length > 1 || Array.isArray(expect.vg) ? `vg[${i}]` : 'vg'
      const p = persons[i]
      if (!p) { fail(prefix, 'a person', 'missing'); return }
      const have = vgFields(p)
      for (const [field, want] of Object.entries(exp)) {
        if (field === 'donor') compare(`${prefix}.donor`, want, p.donor != null)
        else if (field === 'donorOf') {
          const id = constituentIds[want]
          if (id === undefined) fail(`${prefix}.donorOf`, 'a scenario in this run', want)
          else compare(`${prefix}.donorOf`, `${want} (${id})`, p.donor ? `${Object.keys(constituentIds).find((k) => String(constituentIds[k]) === String(p.donor.lglConstituentId)) ?? '?'} (${p.donor.lglConstituentId})` : 'none')
        }
        else if (field === 'lastGiftDate') compare(`${prefix}.lastGiftDate`, dated(field, want), p.donor?.lastGiftDate ?? null)
        else compareField(`${prefix}.${field}`, field, dated(field, want), have[field])
      }
    })
  }

  if (expect.lgl !== undefined) {
    const { deleted, ...fields } = expect.lgl
    if (deleted) {
      if (lglConstituent) fail('lgl.deleted', true, false)
    } else if (!lglConstituent) {
      fail('lgl', 'a constituent', 'missing')
    }
    if (lglConstituent) {
      const have = lglFields(lglConstituent).values
      for (const [field, want] of Object.entries(fields)) {
        if (PLAIN.includes(field)) compare(`lgl.${field}`, dated(field, want), lglConstituent[field] ?? null)
        else compareField(`lgl.${field}`, field, dated(field, want), have[field])
      }
    }
  }

  if (expect.lglEntries !== undefined) {
    if (!lglConstituent) fail('lglEntries', 'a constituent', 'missing')
    else {
      for (const [kind, want] of Object.entries(expect.lglEntries)) {
        const list = lglConstituent[kind] ?? []
        if (want.current !== undefined) compare(`lglEntries.${kind}.current`, want.current, list.filter((e) => !e.not_current).length)
        if (want.total !== undefined) compare(`lglEntries.${kind}.total`, want.total, list.length)
      }
    }
  }

  if (expect.holds !== undefined) {
    const wanted = expect.holds.map(holdKey).sort()
    const states = new Set(['open', ...expect.holds.map((h) => h.state ?? 'open')])
    const found = holds.filter((h) => states.has(h.state ?? 'open')).map(holdKey).sort()
    if (wanted.join('\n') !== found.join('\n')) fail('holds', wanted, found)
  }
  if (expect.passFails === true && passExitCode === 0) fail('pass exit', 'non-zero', 0)
  if (expect.writes !== undefined) compare('writes', expect.writes, writes)
  if (expect.records !== undefined) compare('records', expect.records, decisions.filter((d) => d.outcome === 'record').length)
  if (expect.lglWrites !== undefined) compare('lglWrites', expect.lglWrites, decisions.filter((d) => d.outcome === 'write-lgl').length)
  if (expect.deferred !== undefined) compare('deferred', expect.deferred, decisions.filter((d) => d.outcome === 'deferred').length)

  return failures

  function compare (what, want, found) {
    if (want !== found) fail(what, want, found)
  }
  function compareField (what, field, want, found) {
    if (!FIELDS.includes(field)) { fail(what, 'a known field', field); return }
    const a = comparable(field, want)
    const b = comparable(field, found)
    if (a !== b) fail(what, want, found ?? null)
  }
}
