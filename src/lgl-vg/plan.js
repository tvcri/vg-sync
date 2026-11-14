// The full pass's decisions for linked pairs: each field compared against the sync memory and
// decided by the policy file and the guards; last gift dates; record-level rules.
// Pure; takes the pulled data, memory and open or dismissed refusals, returns writes, memory rows and holds.
import { createHash } from 'node:crypto'
import { classifyDonors } from './donors.js'
import { FIELDS, lglFields, vgFields, comparable, vgPatch, mergePhones, keepsNickname } from './fields.js'
import { compareField } from './compare.js'

const SHARED = new Set(['address', 'email', 'phones'])
const COUPLE_OK_UNIT = new Set(['same', 'first-match', 'converged']) // names and deceased
const COUPLE_BLOCKS_SHARED = new Set(['vg-changed', 'vg-cleared', 'both-changed', 'never-agreed'])
const ENTRY_FIELDS = new Set(['address', 'email'])
// Actions that copy LGL's value to VG: the unclean guard blocks these, and only these.
const COPIES_TO_VG = new Set(['to-vg', 'merge', 'toward-deceased'])

// The case for a field whose LGL value failed cleaning. That value is never equal to a clean
// agreed value, so LGL has changed; what VG did decides the rest.
function uncleanCase(vgC, agreedC) {
  if (agreedC === undefined) return 'never-agreed'
  return vgC === agreedC ? 'lgl-changed' : 'both-changed'
}

export const fingerprint = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)

export function planLinked({ constituents, gifts, persons, memory, refusals, policy, config }) {
  const donorInfo = classifyDonors(constituents, gifts, {
    membershipFundId: config.lgl.membershipFundId,
    paypalPaymentTypeId: config.lgl.paypalPaymentTypeId,
  })
  const byId = new Map(constituents.map((c) => [String(c.id), c]))
  const memo = new Map(memory.map((r) => [`${r.personId}|${r.field}`, r]))
  // An open or dismissed vg-refused hold on this exact write (same key and fingerprint) suppresses it.
  // Re-desiring a dismissed one is harmless: holds.js leaves a dismissed row with the same fingerprint alone.
  const refused = new Map(refusals
    .filter((h) => h.reason === 'vg-refused' && (h.state === 'open' || h.state === 'dismissed'))
    .map((h) => [`${h.lglConstituentId}|${h.personId}|${h.field}|${h.fingerprint}`, h]))

  const groups = new Map() // constituent id (string) -> linked persons
  for (const p of persons.filter((x) => x.donor)) {
    const k = String(p.donor.lglConstituentId)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }

  const decisions = []
  const agree = []
  const holds = []
  const personWrites = new Map() // personId -> Write
  const donorWrites = []
  const fieldCounts = Object.fromEntries(FIELDS.map((f) => [f, {}]))
  const counts = { pairs: 0, couples: 0, lglMissing: 0, noLongerDonor: 0, lastGiftDate: 0 }
  const tally = (f, k) => { fieldCounts[f][k] = (fieldCounts[f][k] ?? 0) + 1 }

  const hold = (d, h) => {
    decisions.push({ ...d, outcome: 'hold', note: h.reason })
    holds.push({ lglConstituentId: d.constituentId, personId: d.personId, field: d.field ?? null, ...h })
  }

  // A to-vg write of `value` for one person's field, unless VG has already refused this exact write.
  // `fp` and `expect` are the field's fingerprint and VG's comparable value as read.
  const write = (d, { value, fp, expect, agreeRow }) => {
    const r = refused.get(`${d.constituentId}|${d.personId}|${d.field}|${fp}`)
    if (r) return hold(d, { reason: 'vg-refused', fingerprint: r.fingerprint, detail: r.detail })
    decisions.push({ ...d, outcome: 'write-vg' })
    let w = personWrites.get(d.personId)
    if (!w) personWrites.set(d.personId, w = { kind: 'person', personId: d.personId, constituentId: d.constituentId, fields: {}, address: null })
    w.fields[d.field] = { body: vgPatch(d.field, value), expect, agree: agreeRow, fingerprint: fp }
    if (d.field === 'address') w.address = { street: value.street, city: value.city, state: value.state, zip: value.zip }
  }

  // unlink: the donor row is removed, or followed to a record that replaced this one; planUnlinked decides which
  const unlinks = []
  const recordRule = (kind, key, people, detail) => {
    const action = policy.record(kind)
    for (const p of people) {
      const d = { kind: 'record', personId: String(p.personId), constituentId: key, action }
      if (action === 'hold') hold(d, { reason: kind, fingerprint: fingerprint([kind, key]), detail })
      else unlinks.push({ personId: String(p.personId), constituentId: key, reason: kind })
    }
  }

  for (const [key, people] of groups) {
    const c = byId.get(key)
    if (!c) { counts.lglMissing += people.length; recordRule('lgl-missing', key, people, {}); continue }
    counts.pairs += people.length
    const isCouple = people.length >= 2
    if (isCouple) counts.couples++
    const info = donorInfo.get(c.id)
    if (!info.isDonor) {
      counts.noLongerDonor += people.length
      recordRule('no-longer-donor', key, people, { lastGiftDate: info.lastGiftDate ?? null })
    }

    const lgl = lglFields(c)
    const vgs = people.map(vgFields)
    for (const f of FIELDS) {
      const lglValue = lgl.values[f]
      const lglC = comparable(f, lglValue)
      const unclean = lgl.problems[f] === 'unclean'
      // An unclean value's comparable form is '', so its fingerprint is built from the raw value instead.
      const lglFp = unclean ? { unclean: lgl.raw[f] } : lglC
      const rows = people.map((p, i) => {
        const personId = String(p.personId)
        const m = memo.get(`${personId}|${f}`)
        const agreed = m && String(m.lglConstituentId) === key ? m : undefined
        const vgC = comparable(f, vgs[i][f])
        const agreedC = agreed ? comparable(f, agreed.value) : undefined
        const problem = lgl.problems[f]
        const kase = problem === 'ambiguous' ? undefined
          : problem === 'unclean' ? uncleanCase(vgC, agreedC)
            : compareField(lglC, vgC, agreedC)
        return {
          vg: vgs[i][f], vgC, kase, fp: fingerprint([lglFp, vgC, agreedC ?? null]),
          d: { kind: 'field', personId, constituentId: key, field: f },
          detail: { lgl: unclean ? lgl.raw[f] : lglValue, vg: vgs[i][f], agreed: agreed ? agreed.value : null },
        }
      })
      // Couples are decided as a unit: can a shared to-vg go ahead, and does anything hold?
      const sharedBlocked = isCouple && SHARED.has(f) && rows.some((r) => COUPLE_BLOCKS_SHARED.has(r.kase))

      for (const r of rows) {
        const { d, kase } = r
        // A malformed LGL value takes priority over any other reason to hold the field.
        const why = (reason) => (unclean ? 'unclean' : reason)
        const held = (reason) => hold({ ...d, case: kase, action: 'hold', lgl: lglValue, vg: r.vg },
          { reason: why(reason), fingerprint: r.fp, detail: { ...r.detail, ...(kase ? { case: kase } : {}) } })
        const problem = lgl.problems[f]
        if (problem === 'ambiguous') { tally(f, problem); held(problem); continue }
        // Guards, Unclean: an unclean LGL value is never copied to VG; a copy from VG that would repair it goes ahead.
        if (problem === 'unclean' && COPIES_TO_VG.has(policy.fieldAction(f, kase))) { tally(f, problem); held(problem); continue }
        tally(f, kase)
        if (kase === 'same') continue
        const agreeRow = {
          personId: d.personId, field: f, lglConstituentId: key, value: lglValue,
          lglEntryId: ENTRY_FIELDS.has(f) && lgl.entryIds[f] != null ? String(lgl.entryIds[f]) : null,
        }
        if (isCouple && (SHARED.has(f) ? sharedBlocked : !COUPLE_OK_UNIT.has(kase))) { held('couple'); continue }
        if (kase === 'first-match' || kase === 'converged') {
          agree.push(agreeRow)
          decisions.push({ ...d, case: kase, action: 'agree', outcome: 'record' })
          continue
        }
        const action = policy.fieldAction(f, kase)
        const dec = { ...d, case: kase, action, lgl: lglValue, vg: r.vg }
        const policyHold = (reason) => hold(dec, { reason: why(reason), fingerprint: r.fp, detail: { ...r.detail, case: kase } })
        const toVg = (value, agreeRow) => write(dec, { value, fp: r.fp, expect: r.vgC, agreeRow })
        // toward-deceased copies only a deceased mark LGL has and VG lacks; the other direction waits
        const copies = action === 'to-vg' || (action === 'toward-deceased' && lglValue.flag && !r.vg.flag)
        if (copies) {
          if (isCouple && SHARED.has(f) && policy.setting('couple-lgl-changed') !== 'to-vg') policyHold('couple')
          else if (f === 'firstName' && !keepsNickname(lglValue, r.vg)) policyHold('lost-nickname')
          else if (f === 'deceased' && !lglValue.flag && r.vg.flag) policyHold('deceased-removed')
          else toVg(lglValue, agreeRow)
        } else if (action === 'toward-deceased') decisions.push({ ...dec, outcome: 'deferred' })
        else if (action === 'merge') {
          const m = mergePhones(lglValue, r.vg)
          if (m.unplaced.length) policyHold('phones-no-slot')
          if (m.placed > 0) toVg(m.value, comparable(f, m.value) === lglC ? agreeRow : null)
          if (m.vgOnly.length) decisions.push({ ...dec, outcome: 'deferred', note: 'vg-only numbers' })
        } else if (action === 'to-lgl-else-hold') {
          if (r.vgC === '') policyHold('never-agreed')
          else decisions.push({ ...dec, outcome: 'deferred' })
        } else if (action === 'to-lgl') decisions.push({ ...dec, outcome: 'deferred' })
        else policyHold(kase)
      }
    }

    for (const p of people) {
      const lglDate = info.lastGiftDate ?? null
      const vgDate = p.donor.lastGiftDate ?? null
      if (lglDate === null || lglDate === vgDate) continue // a null LGL date never clears VG's
      counts.lastGiftDate++
      const personId = String(p.personId)
      const d = { kind: 'lastGiftDate', personId, constituentId: key, action: 'to-vg', lgl: lglDate, vg: vgDate }
      const fp = fingerprint([lglDate, vgDate, null])
      const r = refused.get(`${key}|${personId}|lastGiftDate|${fp}`)
      if (r) { hold({ ...d, field: 'lastGiftDate' }, { reason: 'vg-refused', fingerprint: fp, detail: r.detail }); continue }
      decisions.push({ ...d, outcome: 'write-vg' })
      donorWrites.push({ kind: 'donor', personId, constituentId: key, body: { lglConstituentId: key, lastGiftDate: lglDate }, expect: vgDate, fingerprint: fp })
    }
  }

  const writes = [...personWrites.values(), ...donorWrites]
  return {
    decisions, writes, agree, holds, unlinks,
    counts: {
      ...counts,
      fields: fieldCounts,
      writesPlanned: writes.length,
      peopleChanged: new Set(writes.map((w) => w.personId)).size,
      deferred: decisions.filter((d) => d.outcome === 'deferred').length,
      holds: holds.length,
    },
  }
}
