// The service's scheduler: one job at a time. A full pass runs at start, nightly at fullRunUtc, and again after a
// retryable failure. Change passes begin after the first successful full pass: the next is armed changeEveryMs
// after a job ends, so passes never pile up. A queued full pass goes before a queued change pass. A failed
// change pass waits for the next tick. The heartbeat is a separate timer, so it prints even while a job runs.
//
// Pure of I/O: the clock, the timers and stdout are injected. (Copied and adapted from vg-mailchimp's.)

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
  now, setTimer, clearTimer, fullRunUtc, changeEveryMs, runJob, stdout,
  heartbeatMs = 300_000, retryDelayMs = 3_600_000, maxRetries = 3,
}) {
  const queued = { full: false, change: false }
  let running = null // the promise of the job running, if any
  let started = false
  let shutDown = false
  let changesOn = false // set by the first successful full pass

  let nightlyTimer = null
  let nightlyAt = null
  let retryTimer = null
  let changeTimer = null
  let heartbeatTimer = null

  let retries = 0
  let lastAt = null // the start time of the last finished job
  let lastResult = 'none'

  function enqueue(kind) {
    if (shutDown) return
    queued[kind] = true
    pump()
  }

  function pump() {
    if (shutDown || running) return
    const kind = queued.full ? 'full' : queued.change ? 'change' : null
    if (!kind) return
    queued[kind] = false
    // A throw inside the job (an injected function) must still be reported and must not become an
    // unhandled rejection. The message is not printed: it could carry data.
    running = job(kind).catch(() => {
      stdout('JOTFORM FAILED scheduler error')
    }).finally(() => {
      running = null
      armChange()
      pump()
    })
  }

  async function job(kind) {
    if (kind === 'full') clearRetry() // this run stands in for any retry pending
    const startedAt = now()
    let result
    try {
      result = await runJob(kind)
    } catch {
      stdout('JOTFORM FAILED scheduler error')
      result = { outcome: 'failed', retryable: true }
    }
    if (result?.outcome === 'stopped') {
      shutDownJobs()
      return
    }
    lastAt = startedAt
    if (result?.outcome === 'ok') {
      lastResult = 'ok'
      if (kind === 'full') {
        retries = 0
        changesOn = true
      }
      return
    }
    lastResult = 'failed'
    if (kind !== 'full' || shutDown) return // a change pass just waits for its next tick
    if (result?.retryable && retries < maxRetries) {
      retries++
      retryTimer = setTimer(() => {
        retryTimer = null
        enqueue('full')
      }, retryDelayMs)
    } else {
      retries = 0 // given up until the next night, which starts a fresh count
    }
  }

  function armChange() {
    if (shutDown || !changesOn || changeTimer !== null || queued.change) return
    changeTimer = setTimer(() => {
      changeTimer = null
      enqueue('change')
    }, changeEveryMs)
  }

  // The service is shutting down: nothing more is scheduled. The heartbeat runs on until stop().
  function shutDownJobs() {
    shutDown = true
    queued.full = queued.change = false
    clearRetry()
    for (const t of [nightlyTimer, changeTimer]) if (t !== null) clearTimer(t)
    nightlyTimer = changeTimer = null
  }

  function clearRetry() {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }

  function armNightly() {
    nightlyAt = nextNightly(Math.max(now(), nightlyAt ?? 0), fullRunUtc)
    nightlyTimer = setTimer(() => {
      nightlyTimer = null
      if (shutDown) return
      armNightly()
      retries = 0 // each night starts a fresh count
      enqueue('full')
    }, nightlyAt - now())
  }

  function armHeartbeat() {
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null
      stdout(`JOTFORM ALIVE last=${isoOrNone(lastAt)} result=${lastResult}`)
      armHeartbeat()
    }, heartbeatMs)
  }

  return {
    start() {
      if (started || shutDown) return
      started = true
      armNightly()
      armHeartbeat()
      enqueue('full')
    },
    async stop() {
      shutDown = true
      queued.full = queued.change = false
      for (const t of [nightlyTimer, retryTimer, changeTimer, heartbeatTimer]) if (t !== null) clearTimer(t)
      nightlyTimer = retryTimer = changeTimer = heartbeatTimer = null
      if (running) await running
    },
  }
}
