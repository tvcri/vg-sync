// The service's scheduler: one job at a time, from a queue. Two kinds of
// job: the full pass (nightly at FULL_PASS_UTC, and retries after a
// retryable failure) and the tick. A tick runs the VG check and, every fifth
// tick (every fifteenth once neither check has found a change for an hour),
// the LGL check after it. Ticks start after the first successful full pass;
// the next is armed TICK_MS after a tick ends. The heartbeat is a separate
// timer, not a job, so it prints even while a pass or a tick runs.
//
// Pure of I/O: the clock, the timers and stdout are injected.

const DAY_MS = 86_400_000

// The next instant strictly after nowMs at hhmm (UTC).
export function nextNightly(nowMs, hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(nowMs)
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m)
  if (at <= nowMs) at += DAY_MS
  return at
}

const MIN_MS = 60_000
const LGL_EVERY = 5 // ticks between LGL checks
const LGL_EVERY_IDLE = 15 // once neither check has found a change for IDLE_MS
const IDLE_MS = 60 * MIN_MS
const ESCALATE_MS = 15 * MIN_MS // a run of check failures this long is a PASS FAILED
const REPEAT_MS = 60 * MIN_MS // and repeats this often while it goes on
const LGL_PAUSE_MS = 5 * MIN_MS // after an LGL 429

const isoOrNone = (ms) => (ms === null ? 'none' : new Date(ms).toISOString())

export function createScheduler({
  now, setTimer, clearTimer, fullPassUtc, runFull, stdout,
  heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3,
  // runCheck(kind, { lglPaused }) → { outcome, final, breaker, rateLimited,
  // foundChange, error }. Without it no tick is armed (step 5's service).
  runCheck = null, tickMs = 60_000,
}) {
  const queue = [] // jobs waiting, { kind, source }, each kind at most once
  let running = null // the promise of the job running, if any
  let started = false
  let shutDown = false // stop() was called, or a job reported a shutdown

  let nightlyTimer = null
  let nightlyAt = null
  let retryTimer = null
  let retryAt = null
  let heartbeatTimer = null

  let retries = 0
  let lastFullAt = null
  let lastResult = 'none'
  let fullRunning = false

  // The checks.
  let checksOn = false // a full pass has succeeded since start
  let halted = null // null, 'final' or 'breaker': checks wait for a successful full pass
  let tickTimer = null
  let tickRunning = false
  let ticksSinceLgl = 0
  let lastChangeAt = null // set at start: the start counts as a change
  let lglPausedUntil = 0
  const checkState = {
    'vg-check': { failingSince: null, lastAlertAt: null, alerted: false, lastOkAt: null },
    'lgl-check': { failingSince: null, lastAlertAt: null, alerted: false, lastOkAt: null },
  }
  const every = () => (now() - lastChangeAt >= IDLE_MS ? LGL_EVERY_IDLE : LGL_EVERY)

  const jobs = { full: runFullJob, tick: runTickJob }

  // source says why the job was queued: 'start', 'nightly' or 'retry'.
  function enqueue(kind, source) {
    if (shutDown) return
    const waiting = queue.find((j) => j.kind === kind)
    if (waiting) {
      if (source === 'nightly') waiting.source = 'nightly' // a nightly gets its own retries
      return
    }
    queue.push({ kind, source })
    pump()
  }

  function pump() {
    if (shutDown || running || queue.length === 0) return
    const { kind, source } = queue.shift()
    // runFullJob catches a rejected runFull itself; this catch is for a throw
    // inside the job (an injected function), which must still be reported
    // and must not become an unhandled rejection.
    running = jobs[kind](source).catch((err) => {
      if (kind === 'full') fullRunning = false
      stdout(`PASS FAILED ${kind} scheduler error: ${err?.message ?? err}`)
    }).finally(() => {
      running = null
      pump()
    })
  }

  async function runFullJob(source) {
    clearRetry() // this pass stands in for any retry pending
    if (source === 'nightly') retries = 0 // each night starts a fresh count
    fullRunning = true
    let result
    try {
      result = await runFull()
    } catch (err) {
      stdout(`PASS FAILED full ${err?.message ?? err}`)
      result = { outcome: 'failed', retryable: true }
    }
    fullRunning = false
    if (result?.outcome === 'stopped') {
      shutDownJobs()
      return
    }
    lastFullAt = now()
    if (result?.outcome === 'ok') {
      lastResult = 'ok'
      retries = 0
      checksOn = true
      halted = null
      armTick()
      return
    }
    lastResult = 'failed'
    if (shutDown) return
    if (result?.retryable && retries < maxRetries) {
      retries++
      retryTimer = setTimer(() => {
        retryTimer = null
        retryAt = null
        enqueue('full', 'retry')
      }, retryDelayMs)
      retryAt = now() + retryDelayMs
    } else {
      retries = 0 // given up until the next night, which starts a fresh count
    }
  }

  // The service is shutting down: nothing more is scheduled. The heartbeat
  // runs on until stop(), and shows next-full=none.
  function shutDownJobs() {
    shutDown = true
    queue.length = 0
    clearRetry()
    if (nightlyTimer !== null) clearTimer(nightlyTimer)
    nightlyTimer = null
    nightlyAt = null
    if (tickTimer !== null) clearTimer(tickTimer)
    tickTimer = null
  }

  async function runTickJob() {
    tickRunning = true
    try {
      ticksSinceLgl++ // on every tick, whatever happens
      if (halted) return
      if (await check('vg-check') === 'stopped') return
      if (halted || shutDown) return
      if (ticksSinceLgl >= every() && now() >= lglPausedUntil) {
        ticksSinceLgl = 0
        await check('lgl-check')
      }
    } finally {
      tickRunning = false
      armTick() // the next tick is tickMs after this one ended, whatever the outcome
    }
  }

  // Runs one check and reports it. Returns its outcome.
  async function check(kind) {
    let r
    try {
      r = await runCheck(kind, { lglPaused: now() < lglPausedUntil })
    } catch (err) {
      r = { outcome: 'failed', error: err?.message ?? String(err) }
    }
    const st = checkState[kind]
    const error = r?.error ?? 'unknown error'
    if (r?.foundChange) lastChangeAt = now()
    if (r?.rateLimited) lglPausedUntil = now() + LGL_PAUSE_MS
    if (r?.outcome === 'ok') {
      if (st.alerted) stdout(`CHECK RECOVERED ${kind}`)
      st.failingSince = null
      st.lastAlertAt = null
      st.alerted = false
      st.lastOkAt = now()
      return 'ok'
    }
    if (r?.outcome === 'stopped') {
      stdout(`CHECK STOPPED ${kind} ${r.error ?? 'shutdown'}`)
      shutDownJobs()
      return 'stopped'
    }
    if (r?.final || r?.breaker) {
      // At once, and both checks wait for a successful full pass.
      stdout(`PASS FAILED ${kind} ${error}`)
      halted = r.final ? 'final' : 'breaker'
      st.alerted = true
      return 'failed'
    }
    stdout(`CHECK FAILED ${kind} ${error}`)
    st.failingSince ??= now()
    if (now() - st.failingSince >= ESCALATE_MS && (st.lastAlertAt === null || now() - st.lastAlertAt >= REPEAT_MS)) {
      stdout(`PASS FAILED ${kind} failing since ${isoOrNone(st.failingSince)}: ${error}`)
      st.lastAlertAt = now()
      st.alerted = true
    }
    return 'failed'
  }

  // Arms the next tick, unless one is armed, waiting or running already.
  function armTick() {
    if (!runCheck || !checksOn || shutDown || tickTimer !== null || tickRunning) return
    if (queue.some((j) => j.kind === 'tick')) return
    tickTimer = setTimer(() => {
      tickTimer = null
      enqueue('tick', 'tick')
    }, tickMs)
  }

  function clearRetry() {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
    retryAt = null
  }

  function armNightly() {
    nightlyAt = nextNightly(Math.max(now(), nightlyAt ?? 0), fullPassUtc)
    nightlyTimer = setTimer(() => {
      nightlyTimer = null
      if (shutDown) return
      armNightly()
      enqueue('full', 'nightly')
    }, nightlyAt - now())
  }

  function armHeartbeat() {
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null
      const result = fullRunning ? 'running' : lastResult
      const due = [nightlyAt, retryAt].filter((t) => t !== null)
      const nextFull = due.length ? Math.min(...due) : null
      stdout(`SYNC ALIVE last-full=${isoOrNone(lastFullAt)} result=${result} next-full=${isoOrNone(nextFull)}`
        + ` last-vg-check=${isoOrNone(checkState['vg-check'].lastOkAt)}`
        + ` last-lgl-check=${isoOrNone(checkState['lgl-check'].lastOkAt)} lgl-every=${every()}m`)
      armHeartbeat()
    }, heartbeatMs)
  }

  return {
    start() {
      if (started || shutDown) return
      started = true
      lastChangeAt = now()
      armNightly()
      armHeartbeat()
      enqueue('full', 'start')
    },
    async stop() {
      shutDown = true
      queue.length = 0
      for (const t of [nightlyTimer, retryTimer, heartbeatTimer, tickTimer]) if (t !== null) clearTimer(t)
      nightlyTimer = retryTimer = heartbeatTimer = tickTimer = null
      retryAt = null
      if (running) await running
    },
  }
}
