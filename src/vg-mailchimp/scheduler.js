// The service's scheduler: one job at a time. The job runs at start, nightly at runUtc, and again after a
// retryable failure. The heartbeat is a separate timer, so it prints even while a job runs.
//
// Pure of I/O: the clock, the timers and stdout are injected. (Copied and cut down from the LGL sync's.)

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
  now, setTimer, clearTimer, runUtc, runJob, stdout,
  heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3,
}) {
  let queued = null // { source } of the job waiting, at most one
  let running = null // the promise of the job running, if any
  let started = false
  let shutDown = false

  let nightlyTimer = null
  let nightlyAt = null
  let retryTimer = null
  let retryAt = null
  let heartbeatTimer = null

  let retries = 0
  let lastAt = null // the start time of the last finished job
  let lastResult = 'none'
  let jobRunning = false

  // source says why the job was queued: 'start', 'nightly' or 'retry'.
  function enqueue(source) {
    if (shutDown) return
    if (queued) {
      if (source === 'nightly') queued.source = 'nightly' // a nightly gets its own retries
      return
    }
    queued = { source }
    pump()
  }

  function pump() {
    if (shutDown || running || !queued) return
    const { source } = queued
    queued = null
    // A throw inside the job (an injected function) must still be reported and must not become an
    // unhandled rejection.
    running = job(source).catch((err) => {
      jobRunning = false
      stdout(`MAILCHIMP FAILED scheduler error: ${err?.message ?? err}`)
    }).finally(() => {
      running = null
      pump()
    })
  }

  async function job(source) {
    clearRetry() // this run stands in for any retry pending
    if (source === 'nightly') retries = 0 // each night starts a fresh count
    const startedAt = now()
    jobRunning = true
    let result
    try {
      result = await runJob()
    } catch (err) {
      stdout(`MAILCHIMP FAILED ${err?.message ?? err}`)
      result = { outcome: 'failed', retryable: true }
    }
    jobRunning = false
    if (result?.outcome === 'stopped') {
      shutDownJobs()
      return
    }
    lastAt = startedAt
    if (result?.outcome === 'ok') {
      lastResult = 'ok'
      retries = 0
      return
    }
    lastResult = 'failed'
    if (shutDown) return
    if (result?.retryable && retries < maxRetries) {
      retries++
      retryTimer = setTimer(() => {
        retryTimer = null
        retryAt = null
        enqueue('retry')
      }, retryDelayMs)
      retryAt = now() + retryDelayMs
    } else {
      retries = 0 // given up until the next night, which starts a fresh count
    }
  }

  // The service is shutting down: nothing more is scheduled. The heartbeat runs on until stop().
  function shutDownJobs() {
    shutDown = true
    queued = null
    clearRetry()
    if (nightlyTimer !== null) clearTimer(nightlyTimer)
    nightlyTimer = null
    nightlyAt = null
  }

  function clearRetry() {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
    retryAt = null
  }

  function armNightly() {
    nightlyAt = nextNightly(Math.max(now(), nightlyAt ?? 0), runUtc)
    nightlyTimer = setTimer(() => {
      nightlyTimer = null
      if (shutDown) return
      armNightly()
      enqueue('nightly')
    }, nightlyAt - now())
  }

  function armHeartbeat() {
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null
      const result = jobRunning ? 'running' : lastResult
      const due = [nightlyAt, retryAt].filter((t) => t !== null)
      const next = due.length ? Math.min(...due) : null
      stdout(`MAILCHIMP ALIVE last=${isoOrNone(lastAt)} result=${result} next=${isoOrNone(next)}`)
      armHeartbeat()
    }, heartbeatMs)
  }

  return {
    start() {
      if (started || shutDown) return
      started = true
      armNightly()
      armHeartbeat()
      enqueue('start')
    },
    async stop() {
      shutDown = true
      queued = null
      for (const t of [nightlyTimer, retryTimer, heartbeatTimer]) if (t !== null) clearTimer(t)
      nightlyTimer = retryTimer = heartbeatTimer = null
      retryAt = null
      if (running) await running
    },
  }
}
