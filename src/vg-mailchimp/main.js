// Command line for the VG -> Mailchimp audience service. No command: the service (a run at start and nightly;
// it writes only with WRITE_MAILCHIMP_ADD / WRITE_MAILCHIMP_ARCHIVE). --once: one run by hand, which ignores
// those switches and writes only with its own flags. setup: the service account's privacy acknowledgement.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { createVgReader } from './vg.js'
import { openMailchimp } from './mailchimp-mock.js'
import { runOnce } from './run.js'
import { startService } from './service.js'

const USAGE = `Usage:
  node src/vg-mailchimp/main.js
  node src/vg-mailchimp/main.js --once [--write-add] [--write-archive] [--max-add <n>] [--max-archive <n>] [--out <dir>]
  node src/vg-mailchimp/main.js setup [--acknowledge-privacy]
With no command it runs as the service: a run at start and nightly at MAILCHIMP_RUN_UTC, adding only when
WRITE_MAILCHIMP_ADD=true and archiving only when WRITE_MAILCHIMP_ARCHIVE=true, until SIGTERM or SIGINT.
--once ignores those two switches: it writes only with its own flags. --max-add and --max-archive override
MAX_ADD and MAX_ARCHIVE. Any command also takes --env <file> (default .env). Variables already set in the
environment are not overridden by the file.`

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

function parseOnceOptions(args) {
  const opts = { writeAdd: false, writeArchive: false, maxAdd: null, maxArchive: null, out: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--write-add') opts.writeAdd = true
    else if (a === '--write-archive') opts.writeArchive = true
    else if (a === '--max-add' || a === '--max-archive' || a === '--out') {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      if (a === '--out') opts.out = v
      else {
        if (!/^\d+$/.test(v)) throw new Error(`${a} must be a whole number`)
        if (a === '--max-add') opts.maxAdd = Number(v)
        else opts.maxArchive = Number(v)
      }
    } else throw new Error(`Unknown option ${a}`)
  }
  return opts
}

// The Mailchimp client for a command: the real API, or with MAILCHIMP_MOCK the state file. A mock run says so
// on its first line.
async function mailchimpFor(config, deps, stdout) {
  const { mc, mock } = await openMailchimp(config, {
    fetchImpl: deps.fetchImpl ?? fetch, sleep: deps.sleep, readFile: deps.readFile, writeFile: deps.writeFile, now: deps.now,
  })
  if (mock) stdout(`MAILCHIMP MOCK ${mock}: no request reaches Mailchimp; writes change this file`)
  return mc
}

// One run by hand. Dry unless --write-add / --write-archive. Ends 0 on 'ok', else 1. A signal or the
// RUN_TIMEOUT_MINUTES ceiling aborts the run, which saves its records first.
async function once(argv, deps) {
  const { env, fetchImpl = fetch, sleep, now, stdout, writeFile: write, onSignal, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  let opts
  try {
    opts = parseOnceOptions(argv)
  } catch (err) {
    stdout(err.message)
    return 2
  }
  try {
    const config = loadConfig(env)
    if (opts.out !== null) config.outDir = opts.out
    const vg = createVgReader({ ...config.vg, fetchImpl, now })
    const mc = await mailchimpFor(config, { fetchImpl, sleep, readFile: deps.readFile, writeFile: write, now }, stdout)
    const controller = new AbortController()
    const stop = () => controller.abort('shutdown')
    onSignal?.('SIGTERM', stop)
    onSignal?.('SIGINT', stop)
    const timer = setTimer(() => controller.abort('timeout'), config.runTimeoutMinutes * 60_000)
    let result
    try {
      result = await runOnce({
        config, vg, mc, now, sleep, writeFile: write, stdout, signal: controller.signal,
        writeAdd: opts.writeAdd, writeArchive: opts.writeArchive,
        maxAdd: opts.maxAdd ?? config.maxAdd, maxArchive: opts.maxArchive ?? config.maxArchive,
      })
    } finally {
      clearTimer(timer)
    }
    return result.outcome === 'ok' ? 0 : 1
  } catch (err) {
    stdout(`MAILCHIMP FAILED ${err.message}`)
    return 1
  }
}

function parseSetupOptions(args) {
  const opts = { acknowledgePrivacy: false }
  for (const a of args) {
    if (a === '--acknowledge-privacy') opts.acknowledgePrivacy = true
    else throw new Error(`Unknown option ${a}`)
  }
  return opts
}

async function setup(argv, { env, fetchImpl = fetch, now, stdout }) {
  try {
    const opts = parseSetupOptions(argv)
    const config = loadConfig(env)
    const vg = createVgReader({ ...config.vg, fetchImpl, now })

    const me = await vg.whoAmI() // also creates the user row on the account's first request
    stdout(`Signed in as ${me.username} (user id ${me.userId})`)

    const status = await vg.privacyStatus()
    if (status.needsAck === true) {
      if (!opts.acknowledgePrivacy) {
        stdout('Privacy acknowledgement is owed. Run again with --acknowledge-privacy.')
        return 1
      }
      const rules = await vg.currentPrivacyRules()
      await vg.acknowledgePrivacy(rules.id)
      stdout('Privacy acknowledgement recorded.')
    }

    try {
      await vg.listPersons()
    } catch (err) {
      if (err.status === 403) {
        stdout(`${me.username} has no role grant. Grant it the Mailchimp Sync role at federation level in VG, then run setup again.`)
      } else {
        stdout(err.message)
      }
      return 1
    }

    stdout('SETUP OK')
    return 0
  } catch (err) {
    stdout(`SETUP FAILED: ${err.message}`)
    return 1
  }
}

// The service: start-up, then the scheduler until SIGTERM or SIGINT. Resolves 0 once stopped, 1 if it could
// not start. The signal handlers are registered before start-up (a process with no handler that runs as
// PID 1 ignores SIGTERM): a signal during start-up stops at once, since nothing has been written yet.
async function service({
  env, fetchImpl = fetch, sleep, now, stdout, writeFile: write, readFile: read,
  onSignal, setTimer, clearTimer, fs, startService: start = startService,
}) {
  let svc = null
  let stopping = false
  let finish
  const finished = new Promise((resolve) => { finish = resolve })
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    stdout('STOPPING')
    if (svc) await svc.stop()
    stdout('STOPPED')
    finish(0)
  }
  onSignal('SIGTERM', shutdown)
  onSignal('SIGINT', shutdown)

  let config, vg, mc
  try {
    config = loadConfig(env)
    vg = createVgReader({ ...config.vg, fetchImpl, now })
    mc = await mailchimpFor(config, { fetchImpl, sleep, readFile: read, writeFile: write, now }, stdout)
  } catch (err) {
    stdout(`STARTUP FAILED ${err.message}`)
    return 1
  }
  if (stopping) return finished // a signal arrived while the config was loaded
  start({ config, vg, mc, stdout, now, setTimer, clearTimer, sleep, writeFile: write, fs })
    .then(async (started) => {
      if (stopping) await started?.stop() // stopped during start-up: stop the scheduler it just started
      else if (!started) finish(1)
      else svc = started
    })
    .catch((err) => {
      stdout(`STARTUP FAILED ${err?.message ?? err}`)
      finish(1)
    })
  return finished
}

export async function run(argv, deps) {
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
    onSignal: (name, fn) => process.on(name, fn),
    // The service's lines carry their time; a command run by hand prints as it always has.
    stdout: envArgs.rest.length === 0 ? stamped((t) => console.log(t), Date.now) : (t) => console.log(t),
    writeFile: async (p, text) => {
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, text)
    },
    readFile: (p) => readFile(p, 'utf8'),
  })
  // The service exits at once: a run stopped mid-read leaves its request (and any backoff) behind.
  if (envArgs.rest.length === 0) process.exit(code)
  process.exitCode = code
}
