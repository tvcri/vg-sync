// A change check's plan: what a VG or LGL check decides for the constituents it touched.
// Pure. Every field of a touched linked pair is compared, exactly as a full pass does. Unlinked
// donors are matched over the whole cache (matching compares donors with each other), and the
// result is cut to the touched constituents. A check never unlinks and never acts on the
// record-level reasons: those are the full pass's, the only one that sees deletions.
import { planLinked } from './plan.js'
import { planUnlinked } from './unlinked.js'
import { reconcileHolds } from './holds.js'

export const RECORD_REASONS = new Set(['lgl-missing', 'no-longer-donor'])

const str = (x) => String(x)
// The same string, or two spellings of the same instant (with and without milliseconds).
const sameInstant = (a, b) => a === b || (Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b))

// Folds an LGL check's reads into the cache. Returns a new cache (the one given is never changed)
// and the touched constituent ids: every constituent read that is new to the cache or whose
// updated_at differs from the cached copy's, and the constituent of every gift that is new or
// differs from the cached copy. A constituent is compared by updated_at alone: a copy cached from
// the VG check's single read has another shape than a search result. The LGL check asks from two
// minutes before its cursor, so the newest constituent it has seen comes back on every check;
// unchanged, it touches nothing.
export function mergeLglChanges(cache, { constituents = [], gifts = [] } = {}) {
  const cs = new Map(cache?.constituents ?? [])
  const gs = new Map(cache?.gifts ?? [])
  const touched = new Set()
  for (const c of constituents) {
    const k = str(c.id)
    const prior = cs.get(k)
    cs.set(k, c)
    if (!prior || !sameInstant(prior.updated_at, c.updated_at)) touched.add(k)
  }
  for (const g of gifts) {
    const k = str(g.id)
    const prior = gs.get(k)
    if (prior && JSON.stringify(prior) === JSON.stringify(g)) continue
    gs.set(k, g)
    touched.add(str(g.constituent_id))
    // a gift moved to another constituent changes the donor rule for both
    if (prior && str(prior.constituent_id) !== str(g.constituent_id)) touched.add(str(prior.constituent_id))
  }
  return { cache: { constituents: cs, gifts: gs }, touched }
}

// The later of the cursor and the newest updated_at given; never earlier than the cursor.
export function lglCursorAfter(cursor, constituents = []) {
  let best = cursor ?? null
  let bestT = best === null ? null : Date.parse(best)
  for (const c of constituents) {
    const t = Date.parse(c.updated_at)
    if (!Number.isFinite(t)) continue
    if (bestT === null || !Number.isFinite(bestT) || t > bestT) { best = c.updated_at; bestT = t }
  }
  return best
}

// changes: the feed's person entries ({ personId, changes }), over one or more pages. Their
// constituents are touched when they have a donor link; the rest wait for the full pass.
export function vgTouched(changes = [], persons = []) {
  const byId = new Map(persons.map((p) => [str(p.personId), p]))
  const touched = new Set()
  const unlinkedPeople = new Set()
  for (const ch of changes) {
    const id = str(ch.personId)
    const p = byId.get(id)
    if (p?.donor) touched.add(str(p.donor.lglConstituentId))
    else unlinkedPeople.add(id)
  }
  return { touched, unlinked: unlinkedPeople.size }
}

// planUnlinked's result cut down to the touched constituents.
function cutUnlinked(u, touched) {
  const keep = (x) => touched.has(str(x.constituentId))
  const decisions = u.decisions.filter(keep)
  const out = {
    decisions,
    links: u.links.filter(keep),
    follows: u.follows.filter(keep),
    unlinks: [],
    creates: u.creates.filter(keep),
    finishes: u.finishes.filter(keep),
    holds: u.holds.filter((h) => touched.has(str(h.lglConstituentId))),
  }
  const hold = {}
  for (const d of decisions) if (d.outcome === 'hold') hold[d.note] = (hold[d.note] ?? 0) + 1
  out.counts = {
    unlinkedDonors: new Set(decisions.filter((d) => d.kind === 'unlinked').map((d) => d.constituentId)).size,
    link: out.links.length, follow: out.follows.length, create: out.creates.length, finish: out.finishes.length,
    unlink: 0, skip: decisions.filter((d) => d.outcome === 'skip').length, hold,
  }
  return out
}

// The plan applyPlan takes, for the touched constituents only, with existingHolds narrowed the
// same way (reconcileHolds closes every owned open hold it is not asked to keep) and the replan
// applyPlan calls after a fresh read of every person.
export function planCheck({ touched, cache, persons, memory, holds, policy, config, today }) {
  const t = new Set([...touched].map(str))
  const constituents = [...(cache?.constituents?.values() ?? [])]
  const gifts = [...(cache?.gifts?.values() ?? [])]
  const isTouched = (id) => t.has(str(id))

  const linkedPersons = persons.filter((p) => p.donor && isTouched(p.donor.lglConstituentId))
  const linkedIds = new Set(linkedPersons.map((p) => str(p.donor.lglConstituentId)))
  const refusals = holds.filter((h) => h.reason === 'vg-refused' && (h.state === 'open' || h.state === 'dismissed') && isTouched(h.lglConstituentId))
  const linked = planLinked({
    constituents: constituents.filter((c) => linkedIds.has(str(c.id))),
    gifts, persons: linkedPersons, memory, refusals, policy, config,
  })

  const unlinkedPlan = (people) => cutUnlinked(
    planUnlinked({ constituents, gifts, persons: people, holds, unlinking: [], config, today }), t)
  const unlinked = unlinkedPlan(persons)

  const planHolds = linked.holds.filter((h) => !RECORD_REASONS.has(h.reason))
  const plan = {
    ...linked,
    decisions: linked.decisions.filter((d) => d.kind !== 'record'),
    holds: planHolds,
    unlinks: [],
    unlinked,
    existingHolds: holds.filter((h) => isTouched(h.lglConstituentId) && !RECORD_REASONS.has(h.reason)),
    replan: (freshPersons) => unlinkedPlan(freshPersons),
  }
  plan.counts = {
    ...linked.counts,
    lglMissing: 0, noLongerDonor: 0, // the check does not act on these; the full pass does
    holds: planHolds.length,
    unlinked: unlinked.counts,
    peopleChanged: peopleOf(plan, { donor: true }).size,
  }
  plan.counts.breakerPeople = breakerPeople(plan)
  return plan
}

function peopleOf(plan, { donor }) {
  const u = plan.unlinked ?? { links: [], follows: [], finishes: [], creates: [] }
  return new Set([
    ...plan.writes.filter((w) => donor || w.kind !== 'donor').map((w) => w.personId),
    ...[...u.links, ...u.follows, ...u.finishes].map((w) => str(w.personId)),
    ...u.creates.map((w) => `new:${w.constituentId}`),
  ])
}

// The people a check counts against the circuit breaker: field writes, links, follows, finishes
// and creates (once per constituent). A new last gift date alone does not count.
export const breakerPeople = (plan) => peopleOf(plan, { donor: false }).size

// Decision outcomes that are a change (plan.js and unlinked.js): a write, a deferred write, an
// agreed value recorded. 'hold' counts through the hold table below; 'skip' (a donor left alone) is not.
const CHANGE_OUTCOMES = new Set(['write-vg', 'deferred', 'record'])

// True when the plan holds anything other than same: a write or deferred decision, a hold the
// hold table would open, change, reopen or close, a memory row, or a link, follow, create or
// finish. An open hold that stays open unchanged, or a dismissed one left dismissed, is not.
export function foundChange(plan) {
  const u = plan.unlinked ?? { decisions: [], links: [], follows: [], creates: [], finishes: [], holds: [] }
  if ([...plan.decisions, ...u.decisions].some((d) => CHANGE_OUTCOMES.has(d.outcome))) return true
  if (plan.writes.length > 0 || plan.agree.length > 0) return true
  if ([u.links, u.follows, u.creates, u.finishes].some((x) => x.length > 0)) return true
  const h = reconcileHolds([...plan.holds, ...u.holds], plan.existingHolds ?? []).counts
  return h.opened + h.changed + h.reopened + h.closed > 0
}
