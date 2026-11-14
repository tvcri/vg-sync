// The full pass: read LGL and VG, plan every linked pair and every unlinked donor, and (only with
// writeVg) apply the plan. Never calls an LGL write. Without writeVg, VG sees GET requests only.
import { planLinked } from './plan.js'
import { planUnlinked } from './unlinked.js'
import { applyPlan } from './apply.js'
import { reconcileHolds } from './holds.js'

const FIVE_MINUTES = 5 * 60 * 1000

function lglCursorOf(constituents) {
  let newest = null
  for (const c of constituents) {
    const t = Date.parse(c.updated_at)
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t
  }
  return newest === null ? null : new Date(newest - FIVE_MINUTES).toISOString()
}

export async function runFullPass({
  config, policy, vg, lgl = null, snapshot = null, writeVg = false, maxPeople = null,
  now, writeLines, stdout, out,
}) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const decisionsPath = `${out}/full-${stamp}.jsonl`
  const logged = []
  let planDecisions = null // set once planning has run; decides whether a decisions file is written
  let runId = null
  const mode = writeVg ? 'write-vg' : 'dry-run'

  const saveDecisions = async () => {
    if (planDecisions === null) return
    const all = [...planDecisions, ...logged]
    await writeLines(decisionsPath, all.map((d) => JSON.stringify(d)).join('\n') + (all.length ? '\n' : ''))
  }

  try {
    await vg.whoAmI()
    let constituents, gifts
    if (snapshot) ({ constituents, gifts } = snapshot)
    else {
      constituents = await lgl.pullConstituents()
      gifts = await lgl.pullGifts()
    }
    const persons = await vg.listPersons()
    const memory = await vg.getSyncFields()
    const holdsRead = await vg.getSyncHolds(['open', 'dismissed'])
    const last = await vg.lastFullRun()

    const lastCount = last?.counts?.constituents
    if (Number.isFinite(lastCount) && lastCount > 0) {
      const floor = lastCount * (100 - config.maxConstituentDropPercent) / 100
      if (constituents.length < floor) {
        throw new Error(`LGL returned ${constituents.length} constituents, fewer than ${100 - config.maxConstituentDropPercent}% of the last full run's ${lastCount}; nothing was written`)
      }
    } else {
      stdout('No earlier successful full run with a constituent count: the constituent-drop check is skipped this pass')
    }

    // An open or dismissed refusal of the same write suppresses it; a dismissed one stays dismissed.
    const refusals = holdsRead.filter((h) => (h.state === 'open' || h.state === 'dismissed') && h.reason === 'vg-refused')
    const plan = planLinked({ constituents, gifts, persons, memory, refusals, policy, config })
    const today = new Date(now()).toISOString().slice(0, 10)
    const unlinkedPlan = (people, unlinking) => planUnlinked({ constituents, gifts, persons: people, holds: holdsRead, unlinking, config, today })
    const unlinked = unlinkedPlan(persons, plan.unlinks)
    plan.unlinked = unlinked
    // People changed: field and gift date writes, links, follows, finishes and unlinks; a create counts once.
    plan.counts.peopleChanged = new Set([
      ...plan.writes.map((w) => w.personId),
      ...[...unlinked.links, ...unlinked.follows, ...unlinked.finishes, ...unlinked.unlinks].map((w) => w.personId),
      ...unlinked.creates.map((w) => `new:${w.constituentId}`),
    ]).size
    plan.counts.unlinked = unlinked.counts
    planDecisions = [...plan.decisions, ...unlinked.decisions]

    const limit = maxPeople ?? config.circuitBreakerPeople
    const trips = plan.counts.peopleChanged > limit
    if (trips && writeVg) {
      throw new Error(`The plan changes ${plan.counts.peopleChanged} people, more than the limit of ${limit}; nothing was written. Review the decisions file, then raise the limit with --max-people.`)
    }

    const openRead = holdsRead.filter((h) => h.state === 'open').length
    let applied = null
    if (writeVg) {
      const run = await vg.startRun({
        kind: 'full', switches: { writeVg: true, writeLgl: false },
        imageRevision: config.imageRevision, policyHash: policy.hash,
      })
      runId = run.runId
      applied = await applyPlan(plan, {
        vg, existingHolds: holdsRead, log: (d) => logged.push(d), replan: (fresh) => unlinkedPlan(fresh, []),
      })
      await vg.finishRun(runId, {
        result: 'ok',
        counts: { ...plan.counts, constituents: constituents.length, apply: applied.counts },
        lglCursor: snapshot ? null : lglCursorOf(constituents),
        vgCursor: null,
      })
      runId = null // finished; a later failure (writing the file) must not rewrite the row
    }
    await saveDecisions()

    // A dry run shows what the hold table would do: opened, kept, reopened, closed, left dismissed.
    const holdPreview = writeVg ? null : reconcileHolds([...plan.holds, ...unlinked.holds], holdsRead).counts
    stdout(JSON.stringify({ counts: plan.counts, apply: applied?.counts ?? null, ...(holdPreview ? { holdsIfWritten: holdPreview } : {}) }, null, 2))
    if (trips) {
      stdout(`The circuit breaker would trip: the plan changes ${plan.counts.peopleChanged} people, more than the limit of ${limit}. A write run would fail without writing; review the decisions file, then raise the limit with --max-people.`)
    }
    const a = applied?.counts
    const h = a?.holds
    const uc = unlinked.counts
    const ua = a?.unlinked
    const parts = writeVg
      ? [`writes=${a.written}`, `stale=${a.stale + ua.stale}`, `refused=${a.refused + ua.refused}`, `deferred=${plan.counts.deferred}`,
        `links=${ua.linked + ua.followed + ua.finished}`, `creates=${ua.created}`, `unlinks=${ua.unlinked}`,
        `holdsOpened=${h.opened}`, `holdsClosed=${h.closed}`, `holdsOpen=${openRead + h.opened + h.reopened - h.closed}`]
      : [`writes=${planDecisions.filter((d) => d.outcome === 'write-vg').length}`, 'stale=0', 'refused=0', `deferred=${plan.counts.deferred}`,
        `links=${uc.link + uc.follow + uc.finish}`, `creates=${uc.create}`, `unlinks=${uc.unlink}`,
        'holdsOpened=0', 'holdsClosed=0', `holdsOpen=${openRead}`, `holdsPlanned=${plan.counts.holds + unlinked.holds.length}`,
        ...(trips ? ['breaker=would-trip'] : [])]
    stdout(`PASS OK full ${mode} people=${plan.counts.peopleChanged} ${parts.join(' ')}`)
    return 0
  } catch (err) {
    if (runId !== null) {
      try {
        // SyncRunPatch: counts is a non-nullable object (left out here), error at most 1000 characters
        await vg.finishRun(runId, { result: 'failed', lglCursor: null, vgCursor: null, error: String(err.message).slice(0, 1000) })
      } catch { /* best effort: the failure being reported is the first one */ }
    }
    try { await saveDecisions() } catch { /* best effort */ }
    stdout(`PASS FAILED full ${err.message}`)
    return 1
  }
}
