// The full pass's decisions for linked pairs: each field compared against the sync memory and
// decided by the policy file and the guards; last gift dates; record-level rules.
// Pure; takes the pulled data, memory and open or dismissed refusals, returns writes (to VG and to
// LGL), memory rows and holds.
import { createHash } from 'node:crypto'
import { classifyDonors } from './donors.js'
import { FIELDS, lglFields, vgFields, comparable, lglExpect, vgPatch, mergePhones, keepsNickname, phoneKey, ENTRY_FIELDS } from './fields.js'
import { compareField } from './compare.js'
import { PO_BOX, splitStreet, stateCode } from './clean.js'
import { buildLglCalls, formatCall } from './lgl-calls.js'

const SHARED = new Set(['address', 'email', 'phones'])
const COUPLE_OK_UNIT = new Set(['same', 'first-match', 'converged']) // names and deceased
const COUPLE_BLOCKS_SHARED = new Set(['vg-changed', 'vg-cleared', 'both-changed', 'never-agreed'])
// Actions that copy LGL's value to VG: the unclean guard blocks these, and only these.
const COPIES_TO_VG = new Set(['to-vg', 'merge', 'toward-deceased'])
// A couple's shared field is written to LGL only when every partner's case is one of these.
const COUPLE_WRITES_LGL = new Set(['vg-changed', 'both-changed'])
// Guards, Flapping: more LGL writes than this for one person and field in thirty days holds the field.
const FLAP_LIMIT = 3
const FLAP_DAYS = 30
// The most sync_log rows one read returns; a read that fills it may have missed some.
export const SYNC_LOG_LIMIT = 5000

// The sync_log read for the flapping guard: one person's written rows since thirty days before nowMs.
export const lglWriteLogQuery = (nowMs, personId) => ({
  personId: String(personId), outcome: 'written', since: new Date(nowMs - FLAP_DAYS * 86_400_000).toISOString(), limit: SYNC_LOG_LIMIT,
})

// The flapping guard's counts for the people a plan guarded (plan.lglGuarded), one log read each.
// read wraps each read (a run's stop). A read that fills the limit cannot be counted: it throws a
// final error (a retry reads the same log), and the run writes nothing.
export async function readLglWriteCounts(vg, personIds, nowMs, read = (p) => p) {
  const rows = []
  for (const personId of personIds) {
    const got = await read(vg.getSyncLog(lglWriteLogQuery(nowMs, personId)))
    if (got.length >= SYNC_LOG_LIMIT) {
      throw Object.assign(new Error(`the LGL write log of ${FLAP_DAYS} days for VG person ${personId} has ${SYNC_LOG_LIMIT} rows or more (the read limit), so the flapping guard cannot count it; nothing was written`), { final: true })
    }
    rows.push(...got)
  }
  return countLglWrites(rows)
}

// planLinked's lglWriteCounts from those rows: "personId|field" -> the number of distinct runs that
// wrote it (one write logs a row per call).
export function countLglWrites(rows) {
  const runs = new Map()
  for (const r of rows) {
    if (r.personId == null || r.field == null) continue
    const k = `${r.personId}|${r.field}`
    if (!runs.has(k)) runs.set(k, new Set())
    runs.get(k).add(String(r.runId))
  }
  return new Map([...runs].map(([k, s]) => [k, s.size]))
}

// The case for a field whose LGL value failed cleaning. That value is never equal to a clean
// agreed value, so LGL has changed; what VG did decides the rest.
function uncleanCase(vgC, agreedC) {
  if (agreedC === undefined) return 'never-agreed'
  return vgC === agreedC ? 'lgl-changed' : 'both-changed'
}

export const fingerprint = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)

// VG's value in the form an LGL write sends it: an address's state as its two-letter code; null
// when VG's state does not reduce to one (lglWrite decides what that means).
function lglValueOf(field, vgValue) {
  if (field !== 'address') return vgValue
  const state = stateCode(vgValue.state)
  return state ? { ...vgValue, state } : null
}

// True when VG has emptied a phone slot LGL's read slot (clean or not) still holds. Clearing is
// never written, so such a write would make no call for that slot and recur every run.
function clearsPhoneSlot(lgl, vg) {
  const read = lgl.problems.phones === 'unclean' ? lgl.raw.phones : lgl.values.phones
  return ['phone', 'cell'].some((slot) => !phoneKey(vg[slot]) && phoneKey(read?.[slot]))
}

// lglSend(constituentId): true when an LGL write to that constituent will be sent (writing on and
// allowed). writeLgl only names why one is not: 'write-lgl off' or 'not-allowed'.
// lglWriteCounts: "personId|field" -> LGL writes logged in the last thirty days. The plan's
// lglGuarded lists the people the flapping guard looked up: a caller plans once with no counts, reads
// the log for those people only, and plans again (sent or not, so a dry run or a run with LGL writes
// off keeps the flapping holds a write run opened).
export function planLinked({
  constituents, gifts, persons, memory, refusals, policy, config,
  lglSend = () => false, writeLgl = false, lglWriteCounts = new Map(),
}) {
  const donorInfo = classifyDonors(constituents, gifts, {
    membershipFundId: config.lgl.membershipFundId,
    paypalPaymentTypeId: config.lgl.paypalPaymentTypeId,
  })
  const byId = new Map(constituents.map((c) => [String(c.id), c]))
  const memo = new Map(memory.map((r) => [`${r.personId}|${r.field}`, r]))
  // An open or dismissed vg-refused hold on this exact write (same key and fingerprint) suppresses it.
  // Re-desiring a dismissed one is harmless: holds.js leaves a dismissed row with the same fingerprint alone.
  const refusedBy = (reason) => new Map(refusals
    .filter((h) => h.reason === reason && (h.state === 'open' || h.state === 'dismissed'))
    .map((h) => [`${h.lglConstituentId}|${h.personId}|${h.field}|${h.fingerprint}`, h]))
  const refused = refusedBy('vg-refused')
  // The same for LGL: an lgl-refused hold's fingerprint is the write attempted (field and VG's value).
  const lglRefused = refusedBy('lgl-refused')
  const addresseeSetting = policy.setting('lgl-addressee') ?? 'if-default'

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
  const lglWrites = []
  const lglGuarded = new Set()
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

  // An LGL write of `value` (VG's, in fields.js form; null for an address whose VG state is not a
  // code) for one person's field, or a couple's shared field (`rows` holds every partner). The guards
  // run first, in order: a refusal of this exact write, flapping, a PO box. A merge that would make
  // no call returns false, planning nothing; the caller decides what that means.
  const lglWrite = (c, lgl, rows, { value, merge = false }) => {
    const { constituentId: key, field: f, case: kase } = rows[0].dec
    // comparable reduces a state to its code, so VG's value as read gives the same fingerprint
    const fpWrite = fingerprint([f, comparable(f, value ?? rows[0].r.vg)])
    const guard = (reason, fpOf, detailOf) => { for (const x of rows) hold(x.dec, { reason, fingerprint: fpOf(x), detail: detailOf(x) }) }
    const refusal = rows.map((x) => lglRefused.get(`${key}|${x.dec.personId}|${f}|${fpWrite}`))
    if (refusal.some(Boolean)) {
      const any = refusal.find(Boolean)
      guard('lgl-refused', () => fpWrite, (x) => (refusal[rows.indexOf(x)] ?? any).detail)
      return true
    }
    for (const x of rows) lglGuarded.add(String(x.dec.personId))
    const writes = (x) => lglWriteCounts.get(`${x.dec.personId}|${f}`) ?? 0
    if (rows.some((x) => writes(x) > FLAP_LIMIT)) {
      guard('flapping', (x) => x.r.fp, (x) => ({ ...x.r.detail, case: kase, lglWrites: writes(x) }))
      return true
    }
    if (f === 'address') {
      // Guards, PO box: LGL's address as read, clean or not, is a PO box
      const street = lgl.problems.address === 'unclean' ? lgl.raw.address?.street : lgl.values.address?.street
      if (PO_BOX.test(splitStreet(street).street)) {
        guard('po-box', (x) => x.r.fp, (x) => ({ ...x.r.detail, case: kase }))
        return true
      }
    }
    if (value === null) {
      // VG's state comes from a picker, so one that is not a code breaks an invariant: a write that
      // would be sent fails the run; one that will not be sent is deferred with no calls.
      if (lglSend(key)) throw new Error(`VG person ${rows[0].dec.personId} address: state "${rows[0].r.vg.state}" is not a two-letter state code`)
      for (const x of rows) decisions.push({ ...x.dec, outcome: 'deferred', note: 'vg state not a code', calls: [] })
      return true
    }
    const write = {
      kind: 'lgl', constituentId: key, personIds: rows.map((x) => x.dec.personId), field: f, case: kase,
      value, expect: lglExpect(lgl, f), fingerprint: fpWrite, merge,
    }
    const { calls } = buildLglCalls(write, c, { addresseeSetting })
    if (!calls.length) {
      if (merge) return false
      // nothing to send (LGL's read entry already holds VG's value, e.g. an unclean phone with the same digits)
      for (const x of rows) decisions.push({ ...x.dec, outcome: 'skip', note: 'no calls' })
      return true
    }
    const send = Boolean(lglSend(key))
    lglWrites.push({ ...write, send })
    const outcome = send ? { outcome: 'write-lgl' } : { outcome: 'deferred', note: writeLgl ? 'not-allowed' : 'write-lgl off' }
    for (const x of rows) decisions.push({ ...x.dec, ...outcome, calls: calls.map(formatCall) })
    return true
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
      // Couples are decided as a unit: can a shared to-vg go ahead, can a shared to-lgl (every
      // partner changed it in VG, to one value), and does anything hold?
      const shared = isCouple && SHARED.has(f)
      const coupleToLgl = shared && rows.every((r) => COUPLE_WRITES_LGL.has(r.kase) && policy.fieldAction(f, r.kase) === 'to-lgl') &&
        new Set(rows.map((r) => r.vgC)).size === 1
      const sharedBlocked = shared && !coupleToLgl && rows.some((r) => COUPLE_BLOCKS_SHARED.has(r.kase))
      const coupleRows = [] // a couple's to-lgl rows, written once after the loop

      for (const r of rows) {
        const { d, kase } = r
        // A malformed LGL value takes priority over any other reason to hold the field.
        const why = (reason) => (unclean ? 'unclean' : reason)
        const held = (reason) => hold({ ...d, case: kase, action: 'hold', lgl: lglValue, vg: r.vg },
          { reason: why(reason), fingerprint: r.fp, detail: { ...r.detail, ...(kase ? { case: kase } : {}) } })
        const problem = lgl.problems[f]
        if (problem === 'ambiguous') { tally(f, problem); held(problem); continue }
        // Guards, Unclean: an unclean LGL value is never copied to VG; a copy from VG that would repair it goes ahead.
        // fill-blank copies either way, and an unclean value is not a blank: it is held too.
        if (problem === 'unclean' && (COPIES_TO_VG.has(policy.fieldAction(f, kase)) || policy.fieldAction(f, kase) === 'fill-blank')) { tally(f, problem); held(problem); continue }
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
        // VG's value to LGL, unless it is not one LGL is given: clearing is held both ways, and a
        // deceased mark is never removed.
        const toLgl = () => {
          if (r.vgC === '') policyHold(action === 'to-lgl-else-hold' ? 'never-agreed' : kase)
          else if (f === 'deceased' && !r.vg.flag) policyHold('deceased-removed')
          else if (f === 'phones' && clearsPhoneSlot(lgl, r.vg)) policyHold('vg-cleared')
          else if (coupleToLgl) coupleRows.push({ dec, r })
          else lglWrite(c, lgl, [{ dec, r }], { value: lglValueOf(f, r.vg) })
        }
        // toward-deceased copies a deceased mark LGL has and VG lacks to VG, and one VG has and LGL
        // lacks to LGL; two marks with different dates are held
        // fill-blank copies LGL's value to VG where VG's is empty, VG's to LGL where LGL's is empty,
        // and holds two different values under their case, as hold does.
        const lglC = comparable(f, lglValue)
        const copies = action === 'to-vg' || (action === 'toward-deceased' && lglValue.flag && !r.vg.flag) ||
          (action === 'fill-blank' && r.vgC === '' && lglC !== '')
        if (copies) {
          if (isCouple && SHARED.has(f) && policy.setting('couple-lgl-changed') !== 'to-vg') policyHold('couple')
          else if (f === 'firstName' && !keepsNickname(lglValue, r.vg)) policyHold('lost-nickname')
          else if (f === 'deceased' && !lglValue.flag && r.vg.flag) policyHold('deceased-removed')
          else toVg(lglValue, agreeRow)
        } else if (action === 'toward-deceased') {
          if (lglValue.flag) policyHold(kase)
          else toLgl()
        }
        else if (action === 'merge') {
          // Written both ways, different numbers in each direction; no memory row for either half:
          // the next run finds first-match if they now agree.
          const m = mergePhones(lglValue, r.vg)
          if (m.unplaced.length) policyHold('phones-no-slot')
          if (m.placed > 0) toVg(m.value, null)
          // A VG-only number LGL has no free type group for is not written; it is held as no slot.
          if (m.vgOnly.length && !lglWrite(c, lgl, [{ dec, r }], { value: r.vg, merge: true }) && !m.unplaced.length) policyHold('phones-no-slot')
        } else if (action === 'to-lgl-else-hold' || action === 'to-lgl' || (action === 'fill-blank' && lglC === '' && r.vgC !== '')) toLgl()
        else policyHold(kase)
      }
      if (coupleRows.length === rows.length) lglWrite(c, lgl, coupleRows, { value: lglValueOf(f, coupleRows[0].r.vg) })
      else for (const { dec, r } of coupleRows) hold(dec, { reason: 'couple', fingerprint: r.fp, detail: { ...r.detail, case: dec.case } })
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
  const lglSent = lglWrites.filter((w) => w.send)
  return {
    decisions, writes, agree, holds, unlinks, lglWrites, lglGuarded: [...lglGuarded].sort(),
    counts: {
      ...counts,
      fields: fieldCounts,
      writesPlanned: writes.length,
      lglWritesPlanned: lglSent.length,
      // LGL writes that will be sent count; deferred ones do not
      peopleChanged: new Set([...writes.map((w) => w.personId), ...lglSent.flatMap((w) => w.personIds)]).size,
      deferred: decisions.filter((d) => d.outcome === 'deferred').length,
      holds: holds.length,
    },
  }
}
