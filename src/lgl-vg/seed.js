// The one-time load of the LGL → VG import's decisions as holds, so the sync never undoes what
// staff decided in the import review. Pure: takes the import's run file (its `actions`), the VG
// people and the holds VG already has; returns the SyncHoldNew items to create.
//
//   staff chose Skip             → dismissed, kind staff, reason import-skip   (left alone for good)
//   last gift before the horizon → dismissed, kind rule,  reason before-horizon (reconsidered on a change)
//   "Anonymous" placeholder      → dismissed, kind rule,  reason anonymous
//   held by the import           → open, reason import-hold (left alone; never decided by staff)
//
// One hold per constituent; where a couple's rows differ, import-skip wins, then import-hold.
// A constituent linked in VG today, or already holding a hold with the same reason, gets nothing.
import { fingerprint } from './plan.js'
import { unlinkedFingerprint } from './match.js'

export const SEED_REASONS = new Set(['import-skip', 'import-hold', 'before-horizon', 'anonymous'])
const RANK = { 'import-skip': 3, 'import-hold': 2, 'before-horizon': 1, anonymous: 1 }
const NOTE = 'Loaded from the LGL import review (2026-11)'

function fromAction (a) {
  const x = String(a.lglId)
  if (a.kind === 'skip') {
    if (a.reason === 'Staff chose Skip') {
      return { lglConstituentId: x, reason: 'import-skip', fingerprint: fingerprint(['import-skip', x]), state: 'dismissed', dismissalKind: 'staff', note: `${NOTE}: staff chose Skip` }
    }
    if (/^Last gift before /.test(a.reason ?? '')) {
      return { lglConstituentId: x, reason: 'before-horizon', fingerprint: unlinkedFingerprint('before-horizon', [], a.lastGiftDate ?? null), state: 'dismissed', dismissalKind: 'rule', note: `${NOTE}: last gift before the horizon`, detail: { candidates: [], lastGiftDate: a.lastGiftDate ?? null } }
    }
    if (a.reason === 'Anonymous in LGL') {
      return { lglConstituentId: x, reason: 'anonymous', fingerprint: unlinkedFingerprint('anonymous', [], a.lastGiftDate ?? null), state: 'dismissed', dismissalKind: 'rule', note: `${NOTE}: Anonymous placeholder`, detail: { candidates: [], lastGiftDate: a.lastGiftDate ?? null } }
    }
    if (a.reason === 'No longer an LGL donor') return null
    throw new Error(`seed: an import skip with an unknown reason "${a.reason}"; nothing was loaded`)
  }
  if (a.kind === 'hold') {
    return { lglConstituentId: x, reason: 'import-hold', fingerprint: fingerprint(['import-hold', x]), state: 'open', note: `${NOTE}: held by the import`, detail: { importReason: a.reason ?? null } }
  }
  return null // link, create, update, already done: nothing to remember
}

export function importSeed (actions, { persons, holds }) {
  const linked = new Set(persons.filter((p) => p.donor).map((p) => String(p.donor.lglConstituentId)))
  // Already loaded means a hold with the same reason, in any state. A rule hold a pass opened itself
  // (before-horizon, say) does not stand in for a staff Skip or an import hold.
  const seeded = new Set(holds.filter((h) => h.personId == null && SEED_REASONS.has(h.reason)).map((h) => `${h.lglConstituentId}|${h.reason}`))
  const best = new Map()
  const counts = { 'import-skip': 0, 'import-hold': 0, 'before-horizon': 0, anonymous: 0, linkedToday: 0, alreadySeeded: 0 }
  for (const a of actions) {
    const item = fromAction(a)
    if (!item) continue
    const prior = best.get(item.lglConstituentId)
    if (!prior || RANK[item.reason] > RANK[prior.reason]) best.set(item.lglConstituentId, item)
  }
  const items = []
  for (const [x, item] of best) {
    if (linked.has(x)) { counts.linkedToday++; continue }
    if (seeded.has(`${x}|${item.reason}`)) { counts.alreadySeeded++; continue }
    items.push({ personId: null, field: null, detail: null, ...item })
    counts[item.reason]++
  }
  return { items, counts }
}
