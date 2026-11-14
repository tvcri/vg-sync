// Applies a plan to VG: re-reads each person (by its LGL link), writes only what is still as
// planned, then records the sync memory and holds. The only module in the full pass that writes to VG.
// A refusal (400, 404, 422) becomes a vg-refused hold on the refused field alone (a refused
// multi-field PATCH is retried field by field); any other error fails the pass before memory or
// holds are sent.
import { vgFields, comparable } from './fields.js'
import { reconcileHolds } from './holds.js'

const isRefusal = (e) => [400, 404, 422].includes(e?.status)

export async function applyPlan(plan, { vg, existingHolds = [], log = () => {} }) {
  const counts = { written: 0, stale: 0, refused: 0, townMissing: 0, memoryUpserted: 0, holds: {} }
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

  if (agree.length) counts.memoryUpserted = await vg.putSyncFields(agree)

  const { open, patch, counts: holdCounts } = reconcileHolds([...plan.holds, ...refusalHolds], existingHolds)
  counts.holds = holdCounts
  if (open.length) await vg.createSyncHolds(open)
  if (patch.length) await vg.patchSyncHolds(patch)
  return { counts }
}
