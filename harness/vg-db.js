#!/usr/bin/env node
// The dev VG database: reseed it with the app's demo-data generator, then
// restore the two service accounts the generator wipes (it empties user_data,
// role_grant and privacy_acknowledgement).
//
//   node harness/vg-db.js reseed --env .env.harness
//
// The CLI runs the guards (harness/guards.js) first and stops if they fail.
//
// The accounts are inserted by SQL rather than left for the API to create on
// their first request: the same idempotent insert the app's own
// ensureBootstrapAdmin uses (INSERT ... ON DUPLICATE KEY by username), so the
// grants exist before either account calls the API, and the order of the two
// accounts' first requests does not matter. The API finds the row by
// username (preferred_username) and fills lastClaims on the first request.
//
// Grants (federation scope: villageId NULL, see the app's 0013-rbac-roles.js):
//   service-account-<VG_CLIENT_ID>          role 8 (Sync Service, 0033-sync.js)
//   service-account-<HARNESS_VG_CLIENT_ID>  role 4 (Admin) and role 8
//   HARNESS_VG_ADMIN_USER (default manual)  role 4 (Admin): a person's own dev login, so the dev app
//                                           can be used after a reseed (it acknowledges the privacy
//                                           rules itself, at first sign-in)
// Then each account acknowledges the privacy rules through the API: the
// service by its own `setup --acknowledge-privacy`, the harness by its staff
// client.
//
// The root password reaches mysql as MYSQL_PWD in docker exec's environment,
// never on a command line (where ps would show it).

import { spawn as nodeSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createVgStaff } from './vg-staff.js'

const REPO = new URL('..', import.meta.url).pathname
const EXAMPLE_FILE = join(REPO, '.env.harness.example')
const DEFAULT_GENERATOR_DIR = join(homedir(), 'dev/village-green/data')
const DEMO_PORT = '60002'
const SYNC_ROLE = 8
const ADMIN_ROLE = 4
export const DEFAULT_ADMIN_USER = 'manual'

// A MySQL string literal. Escapes as mysql_real_escape_string does.
export function sqlString(value) {
  if (typeof value !== 'string') throw new Error('sqlString takes a string')
  const map = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\t': '\\t', '\x1a': '\\Z', '\\': '\\\\', "'": "\\'", '"': '\\"' }
  return `'${value.replace(/[\0\n\r\b\t\x1a\\'"]/g, (c) => map[c])}'`
}

export const accountUsername = (clientId) => `service-account-${clientId}`.toLowerCase()

const userRow = (username) =>
  `INSERT INTO user_data (username) VALUES (${sqlString(username)}) ON DUPLICATE KEY UPDATE username = username;`
const grant = (username, roleId) =>
  `INSERT INTO role_grant (userId, roleId, villageId) SELECT userId, ${Number(roleId)}, NULL FROM user_data WHERE username = ${sqlString(username)} ON DUPLICATE KEY UPDATE roleId = role_grant.roleId;`

export const expectedGrants = ({ syncUser, harnessUser, adminUser }) => [
  [syncUser, SYNC_ROLE], [harnessUser, ADMIN_ROLE], [harnessUser, SYNC_ROLE],
  ...(adminUser ? [[adminUser, ADMIN_ROLE]] : []),
]

// The statements that restore the accounts. Pure; every value is escaped.
export function sqlFor(users) {
  const names = [users.syncUser, users.harnessUser, ...(users.adminUser ? [users.adminUser] : [])]
  return [
    'START TRANSACTION;',
    ...names.map(userRow),
    ...expectedGrants(users).map(([u, r]) => grant(u, r)),
    'COMMIT;',
  ]
}

const readBack = (users) =>
  `SELECT ud.username, rg.roleId FROM role_grant rg JOIN user_data ud ON ud.userId = rg.userId
   WHERE rg.villageId IS NULL AND ud.username IN (${[...new Set(expectedGrants(users).map(([u]) => u))].map(sqlString).join(', ')})
   ORDER BY ud.username, rg.roleId;`

// A staff resolution recorded on an unlinked donor's hold, written straight into the dev sync_hold
// until VG has its POST /sync/holds/{holdId}/resolution: the hold is reopened if it was dismissed,
// as that endpoint does. Pure; the values are escaped.
export function resolveSql(holdId, resolution) {
  if (!/^\d+$/.test(String(holdId))) throw new Error(`resolveSql: holdId must be digits, not ${holdId}`)
  return `UPDATE sync_hold SET resolution = CAST(${sqlString(JSON.stringify(resolution))} AS JSON), resolvedAt = NOW(3), ` +
    "state = 'open', dismissalKind = NULL, dismissedAt = NULL, dismissedUserId = NULL " +
    `WHERE holdId = ${Number(holdId)} AND personId IS NULL;`
}

export async function resolveHold(env, holdId, resolution, { exec = defaultExec } = {}) {
  const user = env.HARNESS_DB_USER || 'root'
  const res = await exec('docker',
    ['exec', '-i', '-e', 'MYSQL_PWD', env.HARNESS_DB_CONTAINER, 'mysql', `-u${user}`, '-N', '-B', env.HARNESS_DB_SCHEMA],
    { input: resolveSql(holdId, resolution) + '\n', env: { ...process.env, MYSQL_PWD: env.HARNESS_DB_PASSWORD } })
  if (res.code !== 0) throw new Error(`mysql in ${env.HARNESS_DB_CONTAINER} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`)
}

// Ruling R1: the service runs with every variable the example file names
// (commented or not) removed, so the --env file always wins.
export function serviceEnv(baseEnv, exampleText) {
  const names = new Set([...exampleText.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
  return Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !names.has(k)))
}

// Runs a command with inherited stdio (its output streams); resolves its exit code.
export function defaultSpawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { ...opts, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
}

// Runs a command with `input` on stdin; resolves { code, stdout, stderr }.
export function defaultExec(cmd, args, { input = '', ...opts } = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

const readExample = () => readFileSync(EXAMPLE_FILE, 'utf8')

export async function restoreAccounts(env, {
  exec = defaultExec, spawn = defaultSpawn, staff, stdout = console.log,
  exampleText = readExample(), envFile = '.env.harness', cwd = REPO,
} = {}) {
  const users = {
    syncUser: accountUsername(env.VG_CLIENT_ID), harnessUser: accountUsername(env.HARNESS_VG_CLIENT_ID),
    adminUser: String(env.HARNESS_VG_ADMIN_USER ?? '').trim() || DEFAULT_ADMIN_USER,
  }
  const input = [...sqlFor(users), readBack(users)].join('\n') + '\n'
  const user = env.HARNESS_DB_USER || 'root'
  const res = await exec('docker',
    ['exec', '-i', '-e', 'MYSQL_PWD', env.HARNESS_DB_CONTAINER, 'mysql', `-u${user}`, '-N', '-B', env.HARNESS_DB_SCHEMA],
    { input, env: { ...process.env, MYSQL_PWD: env.HARNESS_DB_PASSWORD } })
  if (res.code !== 0) throw new Error(`mysql in ${env.HARNESS_DB_CONTAINER} exited ${res.code}: ${res.stderr.trim().slice(0, 300)}`)

  const got = res.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t').join(':')).sort()
  const want = expectedGrants(users).map(([u, r]) => `${u}:${r}`).sort()
  if (got.join(',') !== want.join(',')) {
    throw new Error(`The account grants read back as [${got.join(', ')}], expected [${want.join(', ')}]`)
  }
  stdout(`Accounts restored: ${want.join(', ')}`)

  const code = await spawn(process.execPath, ['src/lgl-vg/main.js', 'setup', '--env', envFile, '--acknowledge-privacy'],
    { cwd, env: serviceEnv(process.env, exampleText) })
  if (code !== 0) throw new Error(`The service's setup exited ${code}`)

  const client = staff ?? createVgStaff({
    apiUrl: env.VG_API_URL, oidcUrl: env.VG_OIDC_URL,
    clientId: env.HARNESS_VG_CLIENT_ID, clientSecret: env.HARNESS_VG_CLIENT_SECRET,
  })
  const ack = await client.acknowledgePrivacy()
  stdout(`Harness privacy acknowledgement: ${ack.acknowledged ? 'recorded' : 'not owed'}`)
}

export async function reseedVg(env, deps = {}) {
  const { exec = defaultExec, spawn = defaultSpawn, stdout = console.log } = deps
  const container = env.HARNESS_DB_CONTAINER ?? ''
  const port = String(env.HARNESS_DB_PORT ?? '')
  if (container.startsWith('village-green-demo')) throw new Error(`${container} is the demo stack; the harness never touches it`)
  if (port === DEMO_PORT) throw new Error(`HARNESS_DB_PORT ${DEMO_PORT} is the demo database; the harness never touches it`)
  // The generator connects by host:port, the restore through the container: they must be the same database.
  const ports = await exec('docker', ['port', container, '3306'], {})
  if (ports.code !== 0 || !new RegExp(`:${port}$`, 'm').test(ports.stdout)) {
    throw new Error(`${container} does not publish port ${port} (docker port: ${ports.stdout.trim() || ports.stderr?.trim()})`)
  }

  const dir = (env.HARNESS_GENERATOR_DIR || DEFAULT_GENERATOR_DIR).replace(/^~(?=\/|$)/, homedir())
  stdout(`Reseeding ${container} (${env.HARNESS_DB_HOST}:${port}/${env.HARNESS_DB_SCHEMA}) with the generator in ${dir}`)
  const code = await spawn('npm', ['run', 'seed'], {
    cwd: dir,
    env: {
      ...process.env,
      VG_DB_HOST: env.HARNESS_DB_HOST, VG_DB_PORT: port, VG_DB_USER: env.HARNESS_DB_USER || 'root',
      VG_DB_PASSWORD: env.HARNESS_DB_PASSWORD, VG_DB_SCHEMA: env.HARNESS_DB_SCHEMA, VG_DEMO_DONORS: '0',
    },
  })
  if (code !== 0) throw new Error(`The generator exited ${code}`)
  await restoreAccounts(env, deps)
}

async function main(argv) {
  const i = argv.indexOf('--env')
  const envFile = i >= 0 ? argv[i + 1] : '.env.harness'
  if (argv[0] !== 'reseed' || !envFile) {
    console.log('Usage: node harness/vg-db.js reseed [--env .env.harness]')
    return 2
  }
  const env = parseEnv(readFileSync(envFile, 'utf8'))
  const { runGuards } = await import('./guards.js')
  const { createLglWriter } = await import('./lgl-write.js')
  const { createLglClient } = await import('../src/lgl-vg/lgl.js')
  const guards = await runGuards({
    env, lglWriter: createLglWriter({ apiKey: env.LGL_API_KEY }), lglReader: createLglClient({ apiKey: env.LGL_API_KEY }),
  })
  if (!guards.ok) {
    console.log(`GUARDS FAILED:\n- ${guards.failed.join('\n- ')}`)
    return 1
  }
  console.log('Guards passed.')
  await reseedVg(env, { envFile: resolve(envFile) })
  console.log('RESEED OK')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (err) => {
    console.log(`RESEED FAILED: ${err.message}`)
    process.exitCode = 1
  })
}
