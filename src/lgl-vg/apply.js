// Applies a plan to VG: re-reads each person (by its LGL link), writes only what is still as
// planned, then records the sync memory and holds. The only module in the full pass that writes to VG.
// A refusal (400, 404, 422) becomes a vg-refused hold on the refused field alone (a refused
// multi-field PATCH is retried field by field); any other error fails the pass before memory or
// holds are sent.
// Unlinked donors (plan.unlinked, from planUnlinked) follow the linked pairs: unlinks and follows,
// then one fresh read of every person and a fresh plan (replan), and only the links, finishes and
// creates that the fresh plan still makes are written.
import { vgFields, comparable } from './fields.js'
import { reconcileHolds } from './holds.js'
import { unlinkedNotice, createUnfinished } from './unlinked.js'

const isRefusal = (e) => [400, 404, 422].includes(e?.status)

export async function applyPlan(plan, { vg, existingHolds = [], log = () => {}, replan = null }) {
  const counts = {
    written: 0, stale: 0, refused: 0, townMissing: 0, memoryUpserted: 0, holds: {},
    unlinked: { linked: 0, followed: 0, created: 0, finished: 0, unlinked: 0, stale: 0, refused: 0 },
  }
  const agree = [...plan.agree]
  const refusalHolds = []

  const note = (personId, constituentId, field, outcome, extra) => {
    log({ kind: field === 'lastGiftDate' ? 'lastGiftDate' : 'field', personId, constituentId, field, outcome, ...extra })
    counts[outcome]++
  }
  const refuse = (w, field, fingerprint, e, attempted) => {
    refusalHolds.push({
      lglConstituentId: String(w.constituentId), personId: w.personId, field,
      reason: 'vg-refused', fingerprint, detail: { error: e.message, attempted },
    })
    note(w.personId, w.constituentId, field, 'refused', { note: e.message })
  }
  // The person as VG has it now, from the persons linked to the planned constituent; null when the
  // link has changed since the read (the person is no longer linked to it).
  const reread = async (w) => {
    const linked = await vg.getLinkedPersons(w.constituentId)
    return linked.find((p) => String(p.personId) === String(w.personId)) ?? null
  }
  const tryPatch = async (personId, body) => {
    try {
      await vg.patchPerson(personId, body)
      return null
    } catch (e) {
      if (!isRefusal(e)) throw e
      return e
    }
  }

  for (const w of plan.writes.filter((x) => x.kind === 'person')) {
    const person = await reread(w)
    const fresh = person ? vgFields(person) : null
    const kept = []
    for (const [field, entry] of Object.entries(w.fields)) {
      if (fresh && comparable(field, fresh[field]) === entry.expect) kept.push(field)
      else note(w.personId, w.constituentId, field, 'stale')
    }
    if (!kept.length) continue
    // Each field's part of the PATCH body; the address carries its town.
    const parts = Object.fromEntries(kept.map((f) => [f, { ...w.fields[f].body }]))
    let townNote
    if (kept.includes('address') && w.address) {
      let town = null
      try {
        town = (await vg.geocodeTown(w.address))?.town ?? null
      } catch (e) {
        if (!isRefusal(e)) throw e
      }
      parts.address.town = town
      if (town === null) { counts.townMissing++; townNote = 'town not resolved' }
    }
    const accept = (f) => {
      if (w.fields[f].agree) agree.push(w.fields[f].agree)
      note(w.personId, w.constituentId, f, 'written', f === 'address' && townNote ? { note: townNote } : undefined)
    }
    const err = await tryPatch(w.personId, Object.assign({}, ...kept.map((f) => parts[f])))
    if (!err) { kept.forEach(accept); continue }
    if (kept.length === 1) { refuse(w, kept[0], w.fields[kept[0]].fingerprint, err, parts[kept[0]]); continue }
    // VG refused the whole PATCH: try each field alone, so one bad value holds only itself.
    for (const f of kept) {
      const e = await tryPatch(w.personId, parts[f])
      if (e) refuse(w, f, w.fields[f].fingerprint, e, parts[f])
      else accept(f)
    }
  }

  for (const w of plan.writes.filter((x) => x.kind === 'donor')) {
    const person = await reread(w)
    const date = person?.donor?.lastGiftDate ?? null
    if (!person || date !== w.expect) { note(w.personId, w.constituentId, 'lastGiftDate', 'stale'); continue }
    try {
      await vg.putDonor(w.personId, w.body)
    } catch (e) {
      if (!isRefusal(e)) throw e
      refuse(w, 'lastGiftDate', w.fingerprint, e, w.body)
      continue
    }
    note(w.personId, w.constituentId, 'lastGiftDate', 'written')
  }

  const u = plan.unlinked ? await applyUnlinked(plan.unlinked, { vg, log, replan, counts: counts.unlinked }) : { holds: [] }
  if (u.townMissing) counts.townMissing += u.townMissing

  if (agree.length) counts.memoryUpserted = await vg.putSyncFields(agree)

  const desired = [...plan.holds, ...refusalHolds, ...(plan.unlinked?.holds ?? []), ...u.holds]
  const { open, patch, counts: holdCounts } = reconcileHolds(desired, existingHolds)
  counts.holds = holdCounts
  if (open.length) await vg.createSyncHolds(open)
  if (patch.length) await vg.patchSyncHolds(patch)
  return { counts }
}

// Writes for unlinked donors. Returns the holds it wants on top of the plan's (notices, refusals,
// and unfinished creates that stay unfinished).
async function applyUnlinked(up, { vg, log, replan, counts }) {
  const holds = []
  let townMissing = 0
  const note = (kind, d, outcome, extra) => {
    log({ kind, ...d, outcome, ...extra })
    counts[outcome]++
  }
  const refuse = (w, e, action) => {
    holds.push({
      lglConstituentId: String(w.constituentId), personId: null, field: null, reason: 'vg-refused',
      fingerprint: w.fingerprint, detail: { error: e.message, action },
    })
    note('unlinked', { constituentId: w.constituentId, personId: w.personId, action }, 'refused', { note: e.message })
  }
  const stillLinked = async (personId, constituentId) =>
    (await vg.getLinkedPersons(constituentId)).some((p) => String(p.personId) === String(personId))
  const donorPut = async (w) => {
    try {
      await vg.putDonor(w.personId, { lglConstituentId: String(w.constituentId), lastGiftDate: w.lastGiftDate })
      return null
    } catch (e) {
      if (!isRefusal(e)) throw e
      return e
    }
  }

  for (const w of up.unlinks) {
    const d = { constituentId: w.constituentId, personId: w.personId, action: 'unlink' }
    if (!(await stillLinked(w.personId, w.constituentId))) { note('record', d, 'stale'); continue }
    await vg.deleteDonor(w.personId) // a refusal here is not expected: fail the pass
    holds.push(unlinkedNotice(w))
    note('record', d, 'unlinked')
  }
  for (const w of up.follows) {
    const d = { constituentId: w.constituentId, personId: w.personId, action: 'follow', from: w.from }
    // Still linked to the gone record, and the record it is followed to still linked to nobody.
    if (!(await stillLinked(w.personId, w.from)) || (await vg.getLinkedPersons(w.constituentId)).length) {
      note('unlinked', d, 'stale')
      continue
    }
    const e = await donorPut(w)
    if (e) refuse(w, e, 'follow')
    else note('unlinked', d, 'followed')
  }

  if (!up.links.length && !up.creates.length && !up.finishes.length) return { holds, townMissing }
  // One fresh read: anything whose decision has changed since the plan is left for the next pass.
  const fresh = replan ? replan(await vg.listPersons()) : up
  const has = (list, w, key) => list.some((x) => key(x) === key(w))
  const linkKey = (x) => `${x.personId}|${x.constituentId}`

  for (const w of up.links) {
    const d = { constituentId: w.constituentId, personId: w.personId, action: 'link' }
    if (!has(fresh.links, w, linkKey)) { note('unlinked', d, 'stale'); continue }
    const e = await donorPut(w)
    if (e) refuse(w, e, 'link')
    else note('unlinked', d, 'linked')
  }
  for (const w of up.finishes) {
    const d = { constituentId: w.constituentId, personId: w.personId, action: 'finish' }
    if (!has(fresh.finishes, w, (x) => x.holdId)) { holds.push(again(w.hold)); note('unlinked', d, 'stale'); continue }
    const e = await donorPut(w)
    if (e) { // the create-unfinished hold stays open; it is the record of this refusal
      holds.push(again(w.hold))
      note('unlinked', d, 'refused', { note: e.message })
      continue
    }
    note('unlinked', d, 'finished') // its create-unfinished hold is not desired, so it closes
  }
  for (const w of up.creates) {
    const d = { constituentId: w.constituentId, action: 'create' }
    if (!has(fresh.creates, w, (x) => x.constituentId)) { note('unlinked', d, 'stale'); continue }
    const body = { ...w.body }
    if (w.address) {
      let town = null
      try {
        town = (await vg.geocodeTown(w.address))?.town ?? null
      } catch (e) {
        if (!isRefusal(e)) throw e
      }
      if (town) body.town = town
      else townMissing++
    }
    let person
    try {
      person = await vg.createPerson(body)
    } catch (e) {
      if (!isRefusal(e)) throw e
      refuse(w, e, 'create')
      continue
    }
    const personId = String(person.personId)
    // Logged before the donor row: a pass that stops here leaves an open create-unfinished hold,
    // and the next pass finishes the link (planUnlinked) instead of creating the person again.
    const [logged] = await vg.createSyncHolds([createUnfinished(w, personId)])
    if (w.agree.length) await vg.putSyncFields(w.agree.map((r) => ({ personId, ...r })))
    const e = await donorPut({ ...w, personId })
    if (e) { refuse({ ...w, personId }, e, 'create'); continue } // the create-unfinished hold stays open
    await vg.patchSyncHolds([{ holdId: logged.holdId, state: 'closed' }])
    note('unlinked', { ...d, personId }, 'created', body.town === undefined && w.address ? { note: 'town not resolved' } : undefined)
  }
  return { holds, townMissing }
}

const again = (h) => ({
  lglConstituentId: String(h.lglConstituentId), personId: h.personId == null ? null : String(h.personId),
  field: h.field ?? null, reason: h.reason, fingerprint: h.fingerprint, detail: h.detail ?? null,
})
