// The service's scheduler: one job at a time, from a queue. Step 5 has one
// kind of job, the full pass (nightly at FULL_PASS_UTC, and retries after a
// retryable failure). The heartbeat is a separate timer, not a job, so it
// prints even while a pass runs. Step 6 adds the VG and LGL checks as more
// job kinds here.
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

const isoOrNone = (ms) => (ms === null ? 'none' : new Date(ms).toISOString())

export function createScheduler({
  now, setTimer, clearTimer, fullPassUtc, runFull, stdout,
  heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3,
}) {
  const queue = [] // jobs waiting, { kind, source }, each kind at most once
  let running = null // the promise of the job running, if any
  let started = false
  let halted = false // stop() was called, or a pass reported a shutdown

  let nightlyTimer = null
  let nightlyAt = null
  let retryTimer = null
  let retryAt = null
  let heartbeatTimer = null

  let retries = 0
  let lastFullAt = null
  let lastResult = 'none'
  let fullRunning = false

  const jobs = { full: runFullJob }

  // source says why the job was queued: 'start', 'nightly' or 'retry'.
  function enqueue(kind, source) {
    if (halted) return
    const waiting = queue.find((j) => j.kind === kind)
    if (waiting) {
      if (source === 'nightly') waiting.source = 'nightly' // a nightly gets its own retries
      return
    }
    queue.push({ kind, source })
    pump()
  }

  function pump() {
    if (halted || running || queue.length === 0) return
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
      // The service is shutting down: nothing more is scheduled. The
      // heartbeat runs on until stop(), and shows next-full=none.
      halted = true
      clearRetry()
      if (nightlyTimer !== null) clearTimer(nightlyTimer)
      nightlyTimer = null
      nightlyAt = null
      return
    }
    lastFullAt = now()
    if (result?.outcome === 'ok') {
      lastResult = 'ok'
      retries = 0
      return
    }
    lastResult = 'failed'
    if (halted) return
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

  function clearRetry() {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
    retryAt = null
  }

  function armNightly() {
    nightlyAt = nextNightly(Math.max(now(), nightlyAt ?? 0), fullPassUtc)
    nightlyTimer = setTimer(() => {
      nightlyTimer = null
      if (halted) return
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
      stdout(`SYNC ALIVE last-full=${isoOrNone(lastFullAt)} result=${result} next-full=${isoOrNone(nextFull)}`)
      armHeartbeat()
    }, heartbeatMs)
  }

  return {
    start() {
      if (started || halted) return
      started = true
      armNightly()
      armHeartbeat()
      enqueue('full', 'start')
    },
    async stop() {
      halted = true
      queue.length = 0
      for (const t of [nightlyTimer, retryTimer, heartbeatTimer]) if (t !== null) clearTimer(t)
      nightlyTimer = retryTimer = heartbeatTimer = null
      retryAt = null
      if (running) await running
    },
  }
}
