// A change check: the VG check (people changed in VG since the VG cursor) or the LGL check
// (constituents and gifts changed in LGL since the LGL cursor). Decides the touched constituents
// as a full pass would, and (only with writeVg) applies the plan. Never calls an LGL write.
// The state's cursors and LGL cache change only when the check succeeds: a failed or stopped
// check leaves them, and the next check covers the same ground. A failure is returned, not
// printed: the caller prints CHECK FAILED or PASS FAILED.
import { applyPlan } from './apply.js'
import { reconcileHolds } from './holds.js'
import { createStopper } from './abort.js'
import { mergeLglChanges, lglCursorAfter, vgTouched, planCheck, breakerPeople, foundChange } from './check-plan.js'

const TWO_MINUTES = 2 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const FEED_LIMIT = 1000
const CHECK_KINDS = ['vg-check', 'lgl-check']

const str = (x) => String(x)

// Where an LGL check asks from: two minutes before the cursor, so a record edited while the last
// read was under way is read again.
export const lglCheckFrom = (cursor) => new Date(Date.parse(cursor) - TWO_MINUTES).toISOString()
const isTokenError = (err) => /^Keycloak token|openid-connect\/token/.test(String(err?.message))
const is4xx = (err) => Number.isInteger(err?.status) && err.status >= 400 && err.status < 500

// Marks a request's failure with the system it came from; a stop is left as it is.
const from = (source, promise) => promise.catch((err) => {
  if (err && typeof err === 'object' && !err.stop) err.source ??= source
  throw err
})

// "(VG API unavailable since <time>; db down)", from GET /op/state; one try, never fails the caller.
async function apiStateNote(vg) {
  try {
    const s = await vg.apiState()
    const down = Object.entries(s?.dependencies ?? {}).filter(([, up]) => up === false).map(([name]) => `${name} down`)
    return ` (VG API ${s?.currentState} since ${s?.since}${down.length ? `; ${down.join(', ')}` : ''})`
  } catch {
    return ' (VG API state not reachable)'
  }
}

export async function runCheck({
  kind, state, config, policy, vg, lgl, writeVg = false, now, writeLines, stdout, out,
  signal = null, lglAttempts = 1, lglPaused = false, quiet = false, maxLglReads = 20, fetchGifts = null,
}) {
  const mode = writeVg ? 'write-vg' : 'dry-run'
  const { read, checkStop, stopError, timedOut } = createStopper(signal, { label: kind, minutes: config.checkTimeoutMinutes })
  const fromVg = (p) => read(from('vg', p))
  const fromLgl = (p) => read(from('lgl', p))
  const at = new Date(now()).toISOString()
  const logged = []
  let runId = null
  let found = false
  let planDecisions = null

  const saveDecisions = async () => {
    const all = [...(planDecisions ?? []), ...logged].map((d) => ({ ...d, check: kind, at }))
    if (!all.length) return
    await writeLines(`${out}/checks-${at.slice(0, 10)}.jsonl`, all.map((d) => JSON.stringify(d)).join('\n') + '\n', { append: true })
  }

  try {
    if (kind !== 'vg-check' && kind !== 'lgl-check') throw new Error(`unknown check kind: ${kind}`)
    let cache = state.cache
    let touched
    let persons = null
    let lglCursor = state.lglCursor
    let vgCursor = state.vgCursor

    if (kind === 'vg-check') {
      // 1. The feed, through to its end.
      const changes = []
      let after = state.vgCursor ?? 0
      for (;;) {
        const page = await fromVg(vg.getChanges(after, FEED_LIMIT))
        checkStop()
        changes.push(...(page?.persons ?? []))
        if (page?.lastAuditId != null) after = page.lastAuditId
        if (!page?.more) break
      }
      vgCursor = after
      if (changes.length) {
        persons = await fromVg(vg.listPersons())
        checkStop()
        touched = vgTouched(changes, persons).touched
      } else touched = new Set()

      // 2. Up to maxLglReads fresh LGL records; past that, the cache decides.
      if (touched.size > 0 && touched.size <= maxLglReads) {
        if (lglPaused) throw new Error('LGL rate-limited')
        const fresh = []
        const gifts = []
        const cachedGifts = new Set([...(cache?.gifts?.values() ?? [])].map((g) => str(g.constituent_id)))
        for (const id of [...touched]) {
          let c
          try {
            c = await fromLgl(lgl.getConstituent(id, { attempts: lglAttempts }))
          } catch (err) {
            if (err?.status !== 404 || err.stop) throw err
            touched.delete(id) // gone from LGL: the full pass, which sees deletions, decides the pair
            continue
          }
          checkStop()
          fresh.push(c)
          if (fetchGifts && !cachedGifts.has(id)) {
            gifts.push(...(await fromLgl(fetchGifts(id))))
            checkStop()
          }
        }
        cache = mergeLglChanges(cache, { constituents: fresh, gifts }).cache
      }
    } else {
      if (!state.lglCursor) throw new Error('no LGL cursor: a full pass has not succeeded yet')
      const fromIso = lglCheckFrom(state.lglCursor)
      const fromDate = new Date(Date.parse(state.lglCursor.slice(0, 10)) - DAY).toISOString().slice(0, 10)
      const constituents = await fromLgl(lgl.constituentsSince(fromIso, { attempts: lglAttempts }))
      checkStop()
      const gifts = await fromLgl(lgl.giftsSince(fromDate, { attempts: lglAttempts }))
      checkStop()
      const merged = mergeLglChanges(cache, { constituents, gifts })
      cache = merged.cache
      touched = merged.touched
      lglCursor = lglCursorAfter(state.lglCursor, constituents)
    }

    const commit = () => {
      state.cache = cache
      state.lglCursor = lglCursor
      state.vgCursor = vgCursor
    }
    if (touched.size === 0) {
      commit()
      return { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null }
    }

    // 3. VG people, the memory of those linked to touched constituents, and the holds.
    if (!persons) {
      persons = await fromVg(vg.listPersons())
      checkStop()
    }
    const linkedIds = [...new Set(persons.filter((p) => p.donor && touched.has(str(p.donor.lglConstituentId))).map((p) => str(p.personId)))]
    const memory = await fromVg(vg.getSyncFieldsFor(linkedIds))
    checkStop()
    const holds = await fromVg(vg.getSyncHolds(['open', 'dismissed']))
    checkStop()
    const plan = planCheck({ touched, cache, persons, memory, holds, policy, config, today: at.slice(0, 10) })
    found = foundChange(plan)
    if (!found) {
      commit()
      return { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: false, error: null }
    }
    planDecisions = [...plan.decisions, ...plan.unlinked.decisions]

    // 4. The breaker: people changed by this plan and by the ok checks of the last 24 hours since
    // the last successful full pass (its start), which clears a trip. VG filters `since` on startedAt.
    const fulls = await fromVg(vg.recentRuns({ kinds: ['full'], limit: 20 }))
    checkStop()
    const fullStarts = fulls.filter((r) => r.result === 'ok').map((r) => Date.parse(r.startedAt)).filter(Number.isFinite)
    const since = new Date(Math.max(now() - DAY, ...fullStarts)).toISOString()
    const runs = await fromVg(vg.recentRuns({ kinds: CHECK_KINDS, since, limit: 1000 }))
    checkStop()
    const earlier = runs.filter((r) => r.result === 'ok' && CHECK_KINDS.includes(r.kind ?? kind))
      .reduce((n, r) => n + (Number(r.counts?.breakerPeople) || 0), 0)
    const breakerTotal = earlier + breakerPeople(plan)
    const limit = config.circuitBreakerPeople
    const trips = breakerTotal > limit
    if (trips && writeVg) {
      return {
        outcome: 'failed', final: false, breaker: true, rateLimited: false, foundChange: true,
        error: `circuit breaker: ${breakerTotal} people changed by checks in 24 hours, more than the limit of ${limit}`,
      }
    }

    // 5. Apply, through the same run guard as a full pass.
    let applied = null
    if (writeVg) {
      const t = now()
      const live = (await fromVg(vg.recentRuns())).find((r) => {
        if (r.result !== 'running') return false
        const minutes = r.kind === 'full' ? config.passTimeoutMinutes : config.checkTimeoutMinutes
        return !(Date.parse(r.startedAt) < t - minutes * 60 * 1000) // an unparseable start counts as live
      })
      if (live) throw new Error(`another sync run (id ${live.runId}, ${live.kind}) started at ${live.startedAt} is still running; nothing was written`)
      checkStop()
      const run = await from('vg', vg.startRun({
        kind, switches: { writeVg: true, writeLgl: false }, imageRevision: config.imageRevision, policyHash: policy.hash,
      }))
      runId = run.runId
      applied = await from('vg', applyPlan(plan, {
        vg, existingHolds: plan.existingHolds, replan: plan.replan, log: (d) => logged.push(d), signal,
      }))
      if (applied.stopped) throw stopError()
      await from('vg', vg.finishRun(runId, {
        result: 'ok',
        counts: { ...plan.counts, peopleChanged: plan.counts.peopleChanged, breakerPeople: breakerPeople(plan), apply: applied.counts },
        lglCursor, vgCursor,
      }))
      runId = null
    }
    commit()

    // 6. The decisions file and the CHECK OK line.
    await saveDecisions()
    const holdPreview = writeVg ? null : reconcileHolds([...plan.holds, ...plan.unlinked.holds], plan.existingHolds).counts
    if (!quiet) stdout(JSON.stringify({ counts: plan.counts, apply: applied?.counts ?? null, ...(holdPreview ? { holdsIfWritten: holdPreview } : {}) }, null, 2))
    const a = applied?.counts
    const uc = plan.unlinked.counts
    const ua = a?.unlinked
    const parts = writeVg
      ? [`writes=${a.written}`, `deferred=${plan.counts.deferred}`, `links=${ua.linked + ua.followed + ua.finished}`,
        `creates=${ua.created}`, `holdsOpened=${a.holds.opened}`, `holdsClosed=${a.holds.closed}`]
      : [`writes=${planDecisions.filter((d) => d.outcome === 'write-vg').length}`, `deferred=${plan.counts.deferred}`,
        `links=${uc.link + uc.follow + uc.finish}`, `creates=${uc.create}`,
        `holdsOpened=${holdPreview.opened}`, `holdsClosed=${holdPreview.closed}`, ...(trips ? ['breaker=would-trip'] : [])]
    stdout(`CHECK OK ${kind} ${mode} people=${plan.counts.peopleChanged} ${parts.join(' ')}`)
    return { outcome: 'ok', final: false, breaker: false, rateLimited: false, foundChange: true, error: null }
  } catch (err) {
    if (runId !== null) {
      try {
        await vg.finishRun(runId, { result: 'failed', lglCursor: null, vgCursor: null, error: String(err?.message).slice(0, 1000) })
      } catch { /* best effort: the failure being reported is the first one */ }
      // writes were made: keep the record of them
      try { await saveDecisions() } catch { /* best effort */ }
    }
    if (err?.stop && !timedOut()) {
      return { outcome: 'stopped', final: false, breaker: false, rateLimited: false, foundChange: found, error: null }
    }
    let message = String(err?.message ?? err)
    if (err?.source === 'vg' && !err.stop && !isTokenError(err) && !is4xx(err)) message += await apiStateNote(vg)
    return {
      outcome: 'failed', final: err?.final === true, breaker: false,
      rateLimited: err?.source === 'lgl' && err?.status === 429, foundChange: found, error: message,
    }
  }
}
