// Command line for the JotForm -> VG service. No command: the service (a full pass at start and nightly, change
// passes in between; it writes to VG only with WRITE_VG=true). --once change|full: one pass by hand, then exit.
// setup: the service account's sign-in, privacy acknowledgement and role grant, and the JotForm key.

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { createVgClient } from './vg.js'
import { openJotform } from './jotform-mock.js'
import { runPass } from './pass.js'
import { startService, describeError, warnLine, guarded } from './service.js'

const USAGE = `Usage:
  node src/jotform-vg/main.js
  node src/jotform-vg/main.js --once change|full
  node src/jotform-vg/main.js setup [--acknowledge-privacy]
With no command it runs as the service: a full pass at start and nightly at FULL_RUN_UTC, a change pass every
CHANGE_EVERY_MINUTES after the first full pass, writing to VG only when WRITE_VG=true, until SIGTERM or SIGINT.
--once runs one pass and exits 0 or 1. Any command also takes --env <file> (default .env). Variables already set
in the environment are not overridden by the file.`

export function envFileFrom(argv) {
  const rest = []
  let file = '.env'
  let explicit = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      const v = argv[++i]
      if (v === undefined) throw new Error('--env needs a file')
      file = v
      explicit = true
    } else rest.push(argv[i])
  }
  return { file, explicit, rest }
}

// The service's console: each line starts with the time it was written (ISO, UTC). A message of several
// lines gets the time on each. The alerts match text inside a line, so they still match.
export const stamped = (write, now) => (t) =>
  write(String(t).split('\n').map((line) => `${new Date(now()).toISOString()} ${line}`).join('\n'))

// The JotForm reader for a command: the real API, or with JOTFORM_MOCK the state file. A mock run says so.
async function jotformFor(config, deps, stdout) {
  const jotform = await openJotform(config, { fetchImpl: deps.fetchImpl ?? fetch, readFile: deps.readFile, writeFile: deps.writeFile })
  if (config.jotform.mock) stdout(`JOTFORM MOCK ${config.jotform.mock}: no request reaches JotForm; writes change this file`)
  return jotform
}

const vgFor = (config, { vg, fetchImpl = fetch, now }) => vg ?? createVgClient({ ...config.vg, fetchImpl, now })

// One pass by hand. Ends 0 on success, else 1. A signal or the RUN_TIMEOUT_MINUTES ceiling ends it.
async function once(argv, deps) {
  const { env, stdout, now, onSignal, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  const kind = argv[0]
  if (argv.length !== 1 || (kind !== 'change' && kind !== 'full')) {
    stdout(USAGE)
    return 2
  }
  try {
    const config = loadConfig(env)
    if (!config.writeVg) stdout('JOTFORM DRY RUN: nothing is written to VG')
    const controller = new AbortController()
    const rawVg = vgFor(config, { ...deps, now })
    const rawJotform = await jotformFor(config, deps, stdout)
    // After a timeout or signal every further call to VG or JotForm is refused, and the pass goes quiet.
    const vg = guarded(rawVg, controller.signal)
    const jotform = guarded(rawJotform, controller.signal)
    const quiet = (line) => { if (!controller.signal.aborted) stdout(line) }
    let timer
    const aborted = new Promise((_, reject) => {
      const fail = (message) => (reason) => {
        controller.abort(reason)
        reject(Object.assign(new Error(message), { safe: true }))
      }
      timer = setTimer(() => fail(`run timed out after ${config.runTimeoutMinutes} minutes`)('timeout'), config.runTimeoutMinutes * 60_000)
      onSignal?.('SIGTERM', () => fail('run stopped')('shutdown'))
      onSignal?.('SIGINT', () => fail('run stopped')('shutdown'))
    })
    aborted.catch(() => {})
    try {
      const pass = runPass(kind, { jotform, vg, config, stdout: quiet })
      pass.catch(() => {})
      const counts = await Promise.race([pass, aborted])
      const warn = warnLine(counts)
      if (warn) stdout(warn)
    } finally {
      clearTimer(timer)
    }
    return 0
  } catch (err) {
    stdout(`JOTFORM FAILED ${kind}: ${describeError(err)}`)
    return 1
  }
}

async function setup(argv, deps) {
  const { env, stdout, now } = deps
  try {
    let acknowledge = false
    for (const a of argv) {
      if (a === '--acknowledge-privacy') acknowledge = true
      else throw Object.assign(new Error(`Unknown option ${a}`), { safe: true })
    }
    const config = loadConfig(env)
    const vg = vgFor(config, { ...deps, now })

    const me = await vg.whoAmI() // also creates the user row on the account's first request
    stdout(`Signed in as ${me.username} (user id ${me.userId})`)

    const status = await vg.privacyStatus()
    if (status.needsAck === true) {
      if (!acknowledge) {
        stdout('Privacy acknowledgement is owed. Run again with --acknowledge-privacy.')
        return 1
      }
      const rules = await vg.currentPrivacyRules()
      await vg.acknowledgePrivacy(rules.id)
      stdout('Privacy acknowledgement recorded.')
    }

    try {
      await vg.getState()
    } catch (err) {
      if (err.status === 403) {
        stdout(`${me.username} has no role grant. Grant it the JotForm Sync role (role 10) at federation level in VG, then run setup again.`)
      } else {
        stdout(describeError(err))
      }
      return 1
    }

    const jotform = await jotformFor(config, deps, stdout)
    let form
    try {
      form = await jotform.ping()
    } catch (err) {
      stdout(`JotForm not reached: ${describeError(err)}`)
      return 1
    }
    if (form.status !== 'ENABLED') stdout(`JOTFORM WARN form status is ${form.status}, not ENABLED`)

    stdout('SETUP OK')
    return 0
  } catch (err) {
    stdout(`SETUP FAILED: ${describeError(err)}`)
    return 1
  }
}

// The service: start-up, then the scheduler until SIGTERM or SIGINT. Resolves 0 once stopped, 1 if it could
// not start or a pass was refused (401/403). The signal handlers are registered before start-up (a process
// with no handler that runs as PID 1 ignores SIGTERM): a signal during start-up stops at once.
async function service(deps) {
  const { env, stdout, now, onSignal, setTimer, clearTimer, sleep, startService: start = startService } = deps
  let svc = null
  let stopping = false
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const shutdown = async (code = 0) => {
    if (stopping) return
    stopping = true
    stdout('STOPPING')
    if (svc) await svc.stop()
    stdout('STOPPED')
    finish(code)
  }
  onSignal('SIGTERM', () => shutdown(0))
  onSignal('SIGINT', () => shutdown(0))

  let config, vg, jotform
  try {
    config = loadConfig(env)
    if (!config.writeVg) stdout('JOTFORM DRY RUN: nothing is written to VG')
    vg = vgFor(config, { ...deps, now })
    jotform = await jotformFor(config, deps, stdout)
  } catch (err) {
    stdout(`STARTUP FAILED ${describeError(err)}`)
    return 1
  }
  if (stopping) return finished // a signal arrived while the config was loaded
  start({
    config,
    deps: { vg, jotform, stdout, now, setTimer, clearTimer, sleep, onFatal: () => { shutdown(1) } },
  })
    .then(async (started) => {
      if (stopping) await started?.stop() // stopped during start-up: stop the scheduler it just started
      else if (!started) finish(1)
      else svc = started
    })
    .catch((err) => {
      stdout(`STARTUP FAILED ${describeError(err)}`)
      finish(1)
    })
  return finished
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function run(argv, deps) {
  deps = { ...deps, sleep: deps.sleep ?? realSleep }
  if (argv.length === 0) return service(deps)
  if (argv[0] === '--once') return once(argv.slice(1), deps)
  if (argv[0] === 'setup') return setup(argv.slice(1), deps)
  deps.stdout(USAGE)
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let envArgs
  try {
    envArgs = envFileFrom(process.argv.slice(2))
  } catch (err) {
    console.log(err.message)
    process.exit(1)
  }
  if (existsSync(envArgs.file)) process.loadEnvFile(envArgs.file)
  else if (envArgs.explicit) {
    console.log(`No such env file: ${envArgs.file}`)
    process.exit(1)
  }
  const code = await run(envArgs.rest, {
    env: process.env,
    fetchImpl: fetch,
    now: Date.now,
    sleep: realSleep,
    onSignal: (name, fn) => process.on(name, fn),
    // The service's lines carry their time; a command run by hand prints as it always has.
    stdout: envArgs.rest.length === 0 ? stamped((t) => console.log(t), Date.now) : (t) => console.log(t),
    writeFile: (p, text) => writeFile(p, text),
    readFile: (p) => readFile(p, 'utf8'),
  })
  // The service exits at once: a pass stopped mid-read leaves its request behind.
  // A hand-run pass that failed or was stopped exits too: an abandoned request must not keep it alive.
  if (envArgs.rest.length === 0 || code !== 0) process.exit(code)
  process.exitCode = code
}
