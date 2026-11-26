// The long-lived service: the start-up checks and markers, then the scheduler, which runs a full pass at start
// and nightly and change passes in between. Each pass gets its own AbortController: a ceiling of
// RUN_TIMEOUT_MINUTES aborts it with 'timeout', stop() aborts it with 'shutdown'. An aborted pass stops at its
// next call to VG or JotForm (the clients are wrapped) and is abandoned at once.
//
// Log lines carry counts only. VG and JotForm error messages can carry a request path with a submission id and
// part of a response body, so a failure is printed through describeError, never as the raw message.
//
// The clock, timers, sleep and clients are injected, so this is tested without waiting.

import { runPass as defaultRunPass } from './pass.js'
import { createScheduler } from './scheduler.js'

// Start-up checks VG, then JotForm. Each check gets up to three tries, 20 s apart, each try with up to 15 s.
// Both share one budget of 80 s, so start-up ends inside the deployer's 90-second health gate.
const STARTUP_BUDGET_MS = 80_000
const STARTUP_TRIES = 3
const STARTUP_DELAY_MS = 20_000
const STARTUP_TIMEOUT_MS = 15_000
const STARTUP_MIN_TRY_MS = 1_000 // a try with less time than this is not worth starting
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// An error whose message this service wrote itself, so it is safe to print as it is.
const safeError = (message, extra = {}) => Object.assign(new Error(message), { safe: true, ...extra })

// A path with ids replaced: the submission id, and any run of digits (a form id).
function cleanPath(path) {
  return path.split('?')[0]
    .replace(/\/submissions\/[^/]+/, '/submissions/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
}

const COUNT_ONLY = /^full read (returned \d+ of \d+ stored|would delete \d+ of \d+ stored); nothing deleted$/

// What may be printed about a failure: the operation, the HTTP status if any, the method and path with ids
// replaced; for a network or timeout error its short message. Never a response body, never an id.
export function describeError(err) {
  const msg = String(err?.message ?? '')
  if (err?.safe === true || COUNT_ONLY.test(msg)) return msg
  let m = /^(VG|JotForm) (GET|POST|PUT|DELETE|PATCH) (\S+?)(?: → (\d{3})| timed out after (\d+(?:\.\d+)?) s| returned responseCode (\d+))/.exec(msg)
  if (m) {
    const where = `${m[1]} ${m[2]} ${cleanPath(m[3])}`
    if (m[4]) return `${where} → ${m[4]}`
    if (m[5]) return `${where} timed out after ${m[5]} s`
    return `${where} returned responseCode ${m[6]}`
  }
  m = /^Keycloak token request → (\d{3})/.exec(msg)
  if (m) return `Keycloak token request → ${m[1]}`
  if (/^Keycloak token response has no /.test(msg)) return msg
  if (/^JotForm submissions response had no content list$/.test(msg)) return msg
  if (err?.status) return `HTTP ${err.status}`
  if (err instanceof TypeError || err?.code || err?.name === 'TimeoutError') {
    return `network error: ${msg.slice(0, 100)}`
  }
  return `unexpected ${err?.name ?? 'error'}`
}

const isFinal = (err) => err?.final === true || err?.status === 401 || err?.status === 403

// Tries fn(timeoutMs) up to three times, 20 seconds apart, within the shared start-up deadline. A final
// error is not retried. When the deadline leaves no room for another try, it fails with the last error.
async function withTries(fn, { sleep, now, deadline, stop = isFinal }) {
  const ranOut = (last) =>
    safeError(`start-up time ran out (${STARTUP_BUDGET_MS / 1000} s)${last ? `; last error: ${describeError(last)}` : ''}`)
  for (let attempt = 1; ; attempt++) {
    const left = deadline - now()
    if (left < STARTUP_MIN_TRY_MS) throw ranOut(null)
    try {
      return await fn(Math.min(STARTUP_TIMEOUT_MS, left))
    } catch (err) {
      if (stop(err) || attempt >= STARTUP_TRIES) throw err
      if (now() + STARTUP_DELAY_MS + STARTUP_MIN_TRY_MS > deadline) throw ranOut(err)
      await sleep(STARTUP_DELAY_MS)
    }
  }
}

// The object's functions, each failing at once once the signal is aborted.
function guarded(obj, signal) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'function'
      ? (...args) => (signal.aborted ? Promise.reject(abortError(signal)) : v.apply(obj, args))
      : v
  }
  return out
}

const abortError = (signal) => safeError(
  signal.reason === 'timeout' ? 'run timed out' : 'run stopped', { aborted: signal.reason },
)

// The warning to print for a pass's counts, or null.
const warnLine = (counts) => (counts?.failed > 0 ? `JOTFORM WARN ${counts.kind} failed=${counts.failed}` : null)
export { warnLine }

export async function startService({ config, deps }) {
  const {
    vg, jotform, stdout, now, setTimer = setTimeout, clearTimer = clearTimeout,
    sleep = defaultSleep, onFatal = () => {}, runPass = defaultRunPass,
  } = deps
  try {
    const deadline = now() + STARTUP_BUDGET_MS
    let me
    try {
      me = await withTries((timeoutMs) => vg.whoAmI({ timeoutMs }), { sleep, now, deadline })
    } catch (err) {
      throw safeError(`VG sign-in failed: ${describeError(err)}`)
    }
    stdout(`STARTUP VG signed in as ${me.username}`)
    let form
    try {
      form = await withTries(() => jotform.ping(), { sleep, now, deadline })
    } catch (err) {
      throw safeError(`JotForm not reached: ${describeError(err)}`)
    }
    // A form that is not ENABLED may still hold reports: a warning, not a failure.
    if (form.status === 'ENABLED') stdout('STARTUP JotForm form reached')
    else stdout(`JOTFORM WARN form status is ${form.status}, not ENABLED`)
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return null
  }

  let current = null // the running pass's AbortController
  let stopping = false

  async function runJob(kind) {
    const controller = new AbortController()
    current = controller
    if (stopping) controller.abort('shutdown')
    const timer = setTimer(() => controller.abort('timeout'), config.runTimeoutMinutes * 60_000)
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(abortError(controller.signal))
      if (controller.signal.aborted) fail()
      else controller.signal.addEventListener('abort', fail, { once: true })
    })
    aborted.catch(() => {}) // never an unhandled rejection
    try {
      const pass = runPass(kind, { jotform: guarded(jotform, controller.signal), vg: guarded(vg, controller.signal), config, stdout })
      pass.catch(() => {}) // an abandoned pass may fail later
      const counts = await Promise.race([pass, aborted])
      const warn = warnLine(counts)
      if (warn) stdout(warn)
      return { outcome: 'ok', retryable: false }
    } catch (err) {
      if (err?.aborted === 'shutdown') return { outcome: 'stopped', retryable: false }
      const why = err?.aborted === 'timeout'
        ? `run timed out after ${config.runTimeoutMinutes} minutes`
        : describeError(err)
      stdout(`JOTFORM FAILED ${kind}: ${why}`)
      if (isFinal(err)) {
        onFatal(err)
        return { outcome: 'stopped', retryable: false }
      }
      return { outcome: 'failed', retryable: true }
    } finally {
      clearTimer(timer)
      current = null
    }
  }

  const scheduler = createScheduler({
    now, setTimer, clearTimer, fullRunUtc: config.fullRunUtc, changeEveryMs: config.changeEveryMinutes * 60_000, runJob, stdout,
  })
  stdout(`STARTUP scheduler started write-vg=${config.writeVg ? 'on' : 'off'} full=${config.fullRunUtc}Z change-every=${config.changeEveryMinutes}m`)
  scheduler.start()

  return {
    async stop() {
      stopping = true
      current?.abort('shutdown')
      await scheduler.stop()
    },
  }
}
