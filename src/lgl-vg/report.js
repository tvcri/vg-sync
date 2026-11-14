// The step 1 report: how linked donors' fields compare between LGL and VG today,
// and what matching would do with unlinked donors. Pure; takes the pulled data, returns counts and detail lines.
import { classifyDonors } from './donors.js'
import { FIELDS, lglFields, vgFields, comparable } from './fields.js'
import { compareField } from './compare.js'
import { matchUnlinked } from './match.js'

const COUPLE_SKIPPED = new Set(['firstName', 'lastName', 'suffix', 'nickname', 'deceased'])
const COUNTERS = ['first-match', 'never-agreed', 'unclean', 'ambiguous', 'couple-skipped']

export function buildReport({ constituents, gifts, persons, config, today }) {
  const donorInfo = classifyDonors(constituents, gifts, {
    membershipFundId: config.lgl.membershipFundId,
    paypalPaymentTypeId: config.lgl.paypalPaymentTypeId,
  })
  const byId = new Map(constituents.map((c) => [String(c.id), c]))
  const linkedPersons = persons.filter((p) => p.donor)

  const peopleOf = new Map() // constituent id (string) -> number of VG people linking to it
  for (const p of linkedPersons) {
    const k = String(p.donor.lglConstituentId)
    peopleOf.set(k, (peopleOf.get(k) ?? 0) + 1)
  }

  const fields = Object.fromEntries(FIELDS.map((f) => [f, Object.fromEntries(COUNTERS.map((k) => [k, 0]))]))
  const counts = {
    constituents: constituents.length, gifts: gifts.length,
    personDonors: 0, vgPersons: persons.length, linkedPairs: 0, couples: 0,
    linkedMissingInLgl: 0, linkedNoLongerDonor: 0, unlinkedDonors: 0,
  }
  const lastGiftDate = { same: 0, differs: 0 }
  const details = []

  for (const info of donorInfo.values()) if (info.isDonor) counts.personDonors++
  // a couple only counts when its constituent was pulled
  counts.couples = [...peopleOf].filter(([k, n]) => n >= 2 && byId.has(k)).length

  for (const p of linkedPersons) {
    const key = String(p.donor.lglConstituentId)
    const c = byId.get(key)
    if (!c) {
      counts.linkedMissingInLgl++
      details.push({ kind: 'linked-missing', personId: p.personId, constituentId: key })
      continue
    }
    counts.linkedPairs++
    const info = donorInfo.get(c.id)
    if (!info.isDonor) {
      counts.linkedNoLongerDonor++
      details.push({ kind: 'linked-no-longer-donor', personId: p.personId, constituentId: c.id })
    }
    const isCouple = peopleOf.get(key) >= 2
    const lgl = lglFields(c)
    const vg = vgFields(p)
    for (const f of FIELDS) {
      const tally = fields[f]
      if (isCouple && COUPLE_SKIPPED.has(f)) { tally['couple-skipped']++; continue }
      const problem = lgl.problems[f]
      if (problem) {
        tally[problem]++
        details.push({ kind: 'field', personId: p.personId, constituentId: c.id, field: f, lgl: null, vg: vg[f] })
        continue
      }
      const result = compareField(comparable(f, lgl.values[f]), comparable(f, vg[f]), undefined)
      tally[result]++
      if (result === 'never-agreed') {
        details.push({ kind: 'field', personId: p.personId, constituentId: c.id, field: f, lgl: lgl.values[f], vg: vg[f] })
      }
    }
    const lglDate = info.lastGiftDate ?? null
    const vgDate = p.donor.lastGiftDate ?? null
    if (lglDate === vgDate) lastGiftDate.same++
    else {
      lastGiftDate.differs++
      details.push({ kind: 'lastGiftDate', personId: p.personId, constituentId: c.id, lgl: lglDate, vg: vgDate })
    }
  }

  const unlinkedDonors = constituents
    .filter((c) => donorInfo.get(c.id).isDonor && !peopleOf.has(String(c.id)))
    .map((c) => ({ constituent: c, lastGiftDate: donorInfo.get(c.id).lastGiftDate }))
  counts.unlinkedDonors = unlinkedDonors.length
  const unlinked = { link: 0, create: 0, hold: {} }
  for (const d of matchUnlinked(unlinkedDonors, persons, { today, horizonYears: config.createHorizonYears })) {
    if (d.outcome === 'hold') unlinked.hold[d.reason] = (unlinked.hold[d.reason] ?? 0) + 1
    else unlinked[d.outcome]++
    details.push({ kind: 'unlinked', constituentId: d.constituentId, outcome: d.outcome, reason: d.reason, personId: d.personId ?? null })
  }

  return { summary: { counts, fields, lastGiftDate, unlinked }, details }
}
