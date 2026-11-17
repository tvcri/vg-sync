// Reconciles the holds this pass wants against the sync_hold rows VG already has.
// Pure; returns the batch bodies for VG's hold endpoints. A hold is closed only by the step that
// owns it (linked pairs: step 3; unlinked donors: step 4); any other hold is never touched.
import { MATCH_REASONS } from './match.js'

export const OWNED_REASONS = new Set([
  'never-agreed', 'both-changed', 'lgl-cleared', 'vg-cleared',
  'unclean', 'ambiguous', 'couple', 'lost-nickname', 'deceased-removed', 'phones-no-slot', 'vg-refused',
  'lgl-missing', 'no-longer-donor',
  'po-box', 'flapping', 'lgl-refused', // step 7's LGL writes; 'addressee' and 'lgl-incomplete' are not owned: only staff close them
])

// Step 4: holds on an unlinked constituent (no personId), and the two person-level notices it opens.
export const UNLINKED_REASONS = new Set([...MATCH_REASONS, 'import-hold', 'vg-refused', 'resolution-failed'])
export const UNLINKED_PERSON_REASONS = new Set(['create-unfinished', 'unlinked'])

export const owned = (h) => (h.personId != null
  ? OWNED_REASONS.has(h.reason) || UNLINKED_PERSON_REASONS.has(h.reason)
  : UNLINKED_REASONS.has(h.reason))

// JSON with object keys sorted: MySQL hands a JSON column back with its keys reordered.
const canonical = (v) => JSON.stringify(v ?? null, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
  : x))
const sameDetail = (a, b) => canonical(a) === canonical(b)

const keyOf = (h) => [h.lglConstituentId, h.personId, h.field, h.reason].map((v) => String(v ?? '')).join('|')

// close: holdIds closed whatever the plan wants (a staff resolution carried out or failed). Such a
// hold does not stand for its key, so a desired hold with the same key opens as a new row; VG's
// unique open key means the closes must be sent before the new holds are created.
// An open or dismissed hold whose fingerprint is unchanged gets the plan's detail when it differs
// (counted as refreshed); its state is left as it is.
export function reconcileHolds(desired, existing, { close = [] } = {}) {
  const closing = new Set(close.map(String))
  const wanted = new Map()
  for (const d of desired) if (!wanted.has(keyOf(d))) wanted.set(keyOf(d), d)

  const have = new Map()
  const patch = []
  const counts = { opened: 0, seen: 0, changed: 0, reopened: 0, closed: 0, stillDismissed: 0, refreshed: 0 }
  for (const h of existing) {
    if (closing.has(String(h.holdId))) {
      if (h.state === 'open') { patch.push({ holdId: h.holdId, state: 'closed' }); counts.closed++; closing.delete(String(h.holdId)) }
      continue
    }
    const k = keyOf(h)
    const prior = have.get(k)
    if (!prior || (prior.state !== 'open' && h.state === 'open')) have.set(k, h) // prefer the open row
  }

  const open = []

  for (const [k, d] of wanted) {
    const h = have.get(k)
    if (!h) {
      open.push({
        lglConstituentId: d.lglConstituentId, personId: d.personId, field: d.field,
        reason: d.reason, fingerprint: d.fingerprint, detail: d.detail,
      })
      counts.opened++
    } else if (h.state === 'open') {
      if (h.fingerprint === d.fingerprint) {
        if (sameDetail(h.detail, d.detail)) patch.push({ holdId: h.holdId, seen: true })
        else { patch.push({ holdId: h.holdId, seen: true, detail: d.detail }); counts.refreshed++ }
        counts.seen++
      } else {
        patch.push({ holdId: h.holdId, seen: true, fingerprint: d.fingerprint, detail: d.detail })
        counts.changed++
      }
    } else if (h.state === 'dismissed' && h.fingerprint === d.fingerprint) {
      if (!sameDetail(h.detail, d.detail)) { patch.push({ holdId: h.holdId, detail: d.detail }); counts.refreshed++ }
      counts.stillDismissed++
    } else {
      // dismissed with a new fingerprint, or closed earlier and found again
      patch.push({ holdId: h.holdId, state: 'open', fingerprint: d.fingerprint, detail: d.detail })
      counts.reopened++
    }
  }

  for (const [k, h] of have) {
    if (wanted.has(k)) continue
    if (h.state === 'open' && owned(h)) {
      patch.push({ holdId: h.holdId, state: 'closed' })
      counts.closed++
    }
  }

  return { open, patch, counts }
}
