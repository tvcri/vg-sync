// The full pass: read LGL and VG, plan every linked pair and every unlinked donor, and (only with
// writeVg) apply the plan. LGL writes are sent only with writeLgl (which needs writeVg), and only to
// constituents on the allow-list. Without writeVg, VG sees GET requests only.
import { planLinked, readLglWriteCounts } from './plan.js'
import { allowedForLgl } from './config.js'
import { planUnlinked } from './unlinked.js'
import { applyPlan } from './apply.js'
import { reconcileHolds } from './holds.js'
import { createStopper } from './abort.js'

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
  config, policy, vg, lgl = null, snapshot = null, writeVg = false, writeLgl = false, maxPeople = null, vgCursorFrom = null,
  now, writeLines, stdout, out, signal = null, quiet = false, onResult = () => {},
}) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const decisionsPath = `${out}/full-${stamp}.jsonl`
  const logged = []
  let planDecisions = null // set once planning has run; decides whether a decisions file is written
  let runId = null
  const mode = writeVg ? 'write-vg' : 'dry-run'

  const minutes = config.passTimeoutMinutes
  const { read, checkStop, stopError, timedOut } = createStopper(signal, { label: 'full', minutes })
  let result

  const saveDecisions = async () => {
    if (planDecisions === null) return
    const all = [...planDecisions, ...logged]
    await writeLines(decisionsPath, all.map((d) => JSON.stringify(d)).join('\n') + (all.length ? '\n' : ''))
  }

  try {
    await read(vg.whoAmI())
    checkStop()
    let constituents, gifts
    if (snapshot) ({ constituents, gifts } = snapshot)
    else {
      constituents = await read(lgl.pullConstituents())
      checkStop()
      gifts = await read(lgl.pullGifts())
    }
    checkStop()
    // The feed is read through to its end before the people, so anything changed after the cursor is
    // newer than what the pass reads. The content is ignored; only the end matters.
    let vgCursor = vgCursorFrom
    if (vgCursor === null) {
      const recent = await read(vg.recentRuns({ limit: 50 }))
      vgCursor = recent.find((r) => r.vgCursor !== null && r.vgCursor !== undefined)?.vgCursor ?? 0
      checkStop()
    }
    for (;;) {
      const page = await read(vg.getChanges(vgCursor))
      checkStop()
      const next = page.lastAuditId ?? null
      // a page that says more but does not move the cursor would be asked for again and again
      if (page.more && !(next > vgCursor)) throw new Error(`the VG change feed did not advance past audit id ${vgCursor} (more: true)`)
      if (next !== null) vgCursor = next
      if (!page.more) break
    }
    const persons = await read(vg.listPersons())
    checkStop()
    const memory = await read(vg.getSyncFields())
    checkStop()
    const holdsRead = await read(vg.getSyncHolds(['open', 'dismissed']))
    checkStop()
    const last = await read(vg.lastFullRun())
    checkStop()

    const lastCount = last?.counts?.constituents
    if (Number.isFinite(lastCount) && lastCount > 0) {
      const floor = lastCount * (100 - config.maxConstituentDropPercent) / 100
      if (constituents.length < floor) {
        throw Object.assign(new Error(`LGL returned ${constituents.length} constituents, fewer than ${100 - config.maxConstituentDropPercent}% of the last full run's ${lastCount}; nothing was written`), { final: true })
      }
    } else {
      stdout('No earlier successful full run with a constituent count: the constituent-drop check is skipped this pass')
    }

    // An open or dismissed refusal of the same write suppresses it; a dismissed one stays dismissed.
    const refusals = holdsRead.filter((h) => (h.state === 'open' || h.state === 'dismissed') &&
      (h.reason === 'vg-refused' || h.reason === 'lgl-refused'))
    const lglSend = (id) => writeLgl && allowedForLgl(config, id)
    const planWith = (lglWriteCounts) => planLinked({ constituents, gifts, persons, memory, refusals, policy, config, lglSend, writeLgl, lglWriteCounts })
    let plan = planWith(new Map())
    // The flapping guard's counts, for the people it looked up only; then the plan again with them.
    if (plan.lglGuarded.length) {
      plan = planWith(await readLglWriteCounts(vg, plan.lglGuarded, now(), read))
      checkStop()
    }
    const today = new Date(now()).toISOString().slice(0, 10)
    const unlinkedPlan = (people, unlinking) => planUnlinked({ constituents, gifts, persons: people, holds: holdsRead, unlinking, config, today })
    const unlinked = unlinkedPlan(persons, plan.unlinks)
    plan.unlinked = unlinked
    // People changed: field and gift date writes, LGL writes that will be sent, links, follows, finishes
    // and unlinks; a create counts once.
    plan.counts.peopleChanged = new Set([
      ...plan.writes.map((w) => w.personId),
      ...plan.lglWrites.filter((w) => w.send).flatMap((w) => w.personIds),
      ...[...unlinked.links, ...unlinked.follows, ...unlinked.finishes, ...unlinked.unlinks].map((w) => w.personId),
      ...unlinked.creates.map((w) => `new:${w.constituentId}`),
    ]).size
    plan.counts.unlinked = unlinked.counts
    planDecisions = [...plan.decisions, ...unlinked.decisions]

    const limit = maxPeople ?? config.circuitBreakerPeople
    const trips = plan.counts.peopleChanged > limit
    if (trips && writeVg) {
      throw Object.assign(new Error(`The plan changes ${plan.counts.peopleChanged} people, more than the limit of ${limit}; nothing was written. Review the decisions file, then raise the limit with --max-people.`), { final: true })
    }

    const openRead = holdsRead.filter((h) => h.state === 'open').length
    let applied = null
    if (writeVg) {
      // One write run at a time: a run row still 'running' within the pass timeout is a live pass.
      const cutoff = new Date(now()).getTime() - minutes * 60 * 1000
      // Read-then-insert is not atomic across processes: the race is accepted (a by-hand override only).
      const live = (await read(vg.recentRuns())).find((r) => r.result === 'running' && !(Date.parse(r.startedAt) < cutoff)) // an unparseable start counts as live
      if (live) throw new Error(`another sync run (id ${live.runId}, ${live.kind}) started at ${live.startedAt} is still running; nothing was written`)
      checkStop()
      const run = await vg.startRun({
        kind: 'full', switches: { writeVg: true, writeLgl },
        imageRevision: config.imageRevision, policyHash: policy.hash,
      })
      runId = run.runId
      applied = await applyPlan(plan, {
        vg, existingHolds: holdsRead, log: (d) => logged.push(d), replan: (fresh) => unlinkedPlan(fresh, []), signal,
        lgl, runId, policy,
      })
      if (applied.stopped) throw stopError()
      await vg.finishRun(runId, {
        result: 'ok',
        counts: { ...plan.counts, constituents: constituents.length, apply: applied.counts },
        lglCursor: snapshot ? null : lglCursorOf(constituents),
        vgCursor,
      })
      runId = null // finished; a later failure (writing the file) must not rewrite the row
    }
    await saveDecisions()

    // A dry run shows what the hold table would do: opened, kept, reopened, closed, left dismissed.
    const holdPreview = writeVg ? null : reconcileHolds([...plan.holds, ...unlinked.holds], holdsRead).counts
    if (!quiet) stdout(JSON.stringify({ counts: plan.counts, apply: applied?.counts ?? null, ...(holdPreview ? { holdsIfWritten: holdPreview } : {}) }, null, 2))
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
    // LGL's keys follow the others. Dry: the writes that would be sent.
    const al = a?.lgl
    parts.push(...(writeVg
      ? [`lgl-writes=${al.written}`, `lgl-stale=${al.stale}`, `lgl-refused=${al.refused}`]
      : [`lgl-writes=${plan.counts.lglWritesPlanned}`, 'lgl-stale=0', 'lgl-refused=0']))
    stdout(`PASS OK full ${mode} people=${plan.counts.peopleChanged} ${parts.join(' ')}`)
    result = {
      outcome: 'ok', retryable: false, error: null,
      ...(snapshot ? {} : { lgl: { constituents, gifts } }),
      lglCursor: snapshot ? null : lglCursorOf(constituents), vgCursor,
    }
  } catch (err) {
    if (runId !== null) {
      try {
        // SyncRunPatch: counts is a non-nullable object (left out here), error at most 1000 characters
        await vg.finishRun(runId, { result: 'failed', lglCursor: null, vgCursor: null, error: String(err.message).slice(0, 1000) })
      } catch { /* best effort: the failure being reported is the first one */ }
    }
    try { await saveDecisions() } catch { /* best effort */ }
    if (err.stop && !timedOut()) {
      stdout(`PASS STOPPED full ${err.message}`)
      result = { outcome: 'stopped', retryable: false, error: null }
    } else {
      stdout(`PASS FAILED full ${err.message}`)
      result = { outcome: 'failed', retryable: !(err.final === true), error: err.message }
    }
  }
  onResult(result)
  return result.outcome === 'failed' ? 1 : 0
}
