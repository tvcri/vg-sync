import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sqlFor, sqlString, serviceEnv, accountUsername, reseedVg, restoreAccounts } from '../../harness/vg-db.js'

const users = { syncUser: 'service-account-vg-sync', harnessUser: 'service-account-vg-sync-harness' }

test('sqlFor inserts both accounts and grants role 8 to the service, Admin and role 8 to the harness', () => {
  const sql = sqlFor(users).join('\n')
  assert.match(sql, /INSERT INTO user_data \(username\) VALUES \('service-account-vg-sync'\) ON DUPLICATE KEY/)
  assert.match(sql, /INSERT INTO user_data \(username\) VALUES \('service-account-vg-sync-harness'\) ON DUPLICATE KEY/)
  const grants = [...sql.matchAll(/SELECT userId, (\d+), NULL FROM user_data WHERE username = '([^']+)'/g)]
    .map((m) => `${m[2]}:${m[1]}`).sort()
  assert.deepEqual(grants, [
    'service-account-vg-sync-harness:4',
    'service-account-vg-sync-harness:8',
    'service-account-vg-sync:8',
  ])
})

test('sqlFor grants at federation scope (villageId NULL) and is idempotent', () => {
  for (const s of sqlFor(users).filter((s) => s.includes('role_grant'))) {
    assert.match(s, /INSERT INTO role_grant \(userId, roleId, villageId\)/)
    assert.match(s, /ON DUPLICATE KEY UPDATE/)
  }
})

test('a quote in a username is escaped, never interpolated raw', () => {
  const sql = sqlFor({ syncUser: "o'brien", harnessUser: 'back\\slash' }).join('\n')
  assert.ok(sql.includes("'o\\'brien'"))
  assert.ok(sql.includes("'back\\\\slash'"))
  assert.ok(!sql.includes("'o'brien'"))
})

test('sqlString escapes quotes, backslashes and control characters', () => {
  assert.equal(sqlString('a"b'), `'a\\"b'`)
  assert.equal(sqlString('a\nb\0'), `'a\\nb\\0'`)
  assert.throws(() => sqlString(5), /string/)
})

test('sqlFor with an admin user adds that login with Admin', () => {
  const sql = sqlFor({ ...users, adminUser: 'manual' }).join('\n')
  assert.match(sql, /INSERT INTO user_data \(username\) VALUES \('manual'\) ON DUPLICATE KEY/)
  assert.match(sql, /SELECT userId, 4, NULL FROM user_data WHERE username = 'manual'/)
})

test('restoreAccounts grants Admin to HARNESS_VG_ADMIN_USER, manual by default', async () => {
  const f = fakes()
  await restoreAccounts(env, { ...f, stdout: () => {}, exampleText: '' })
  assert.match(f.calls.exec[0].opts.input, /WHERE username = 'manual'/)
  const g = fakes({ stdout: 'jane.doe\t4\nservice-account-vg-sync\t8\nservice-account-vg-sync-harness\t4\nservice-account-vg-sync-harness\t8\n' })
  await restoreAccounts({ ...env, HARNESS_VG_ADMIN_USER: 'jane.doe' }, { ...g, stdout: () => {}, exampleText: '' })
  assert.match(g.calls.exec[0].opts.input, /WHERE username = 'jane.doe'/)
  assert.doesNotMatch(g.calls.exec[0].opts.input, /'manual'/)
})

test('accountUsername is Keycloak\'s service-account name, lower-cased', () => {
  assert.equal(accountUsername('VG-Sync'), 'service-account-vg-sync')
})

test('serviceEnv removes every variable named in the example file, commented or not (R1)', () => {
  const example = '# comment\nLGL_API_KEY=\nVG_SCOPE=vg\n# HARNESS_GENERATOR_DIR=~/x\n'
  const out = serviceEnv({ LGL_API_KEY: 'x', VG_SCOPE: 'y', HARNESS_GENERATOR_DIR: 'z', PATH: '/bin' }, example)
  assert.deepEqual(out, { PATH: '/bin' })
})

const env = {
  VG_API_URL: 'http://localhost:64001/api', VG_OIDC_URL: 'http://localhost:8090/realms/vg',
  VG_CLIENT_ID: 'vg-sync', HARNESS_VG_CLIENT_ID: 'vg-sync-harness', HARNESS_VG_CLIENT_SECRET: 'd',
  HARNESS_DB_CONTAINER: 'village-green-orch-db-1', HARNESS_DB_HOST: '127.0.0.1', HARNESS_DB_PORT: '60001',
  HARNESS_DB_USER: 'root', HARNESS_DB_PASSWORD: 'p', HARNESS_DB_SCHEMA: 'vg', HARNESS_GENERATOR_DIR: '/gen',
}
const grantsOut = 'manual\t4\nservice-account-vg-sync\t8\nservice-account-vg-sync-harness\t4\nservice-account-vg-sync-harness\t8\n'

function fakes({ code = 0, stdout = grantsOut, port = '60001' } = {}) {
  const calls = { spawn: [], exec: [] }
  return {
    calls,
    spawn: async (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); return 0 },
    exec: async (cmd, args, opts) => {
      if (args[0] === 'port') return { code: 0, stdout: `0.0.0.0:${port}\n[::]:${port}\n`, stderr: '' }
      calls.exec.push({ cmd, args, opts })
      return { code, stdout, stderr: '' }
    },
    staff: { acknowledgePrivacy: async () => { calls.ack = true; return { acknowledged: true } } },
  }
}

test('restoreAccounts runs the SQL in the container with the password in the environment, not the arguments', async () => {
  const f = fakes()
  await restoreAccounts(env, { ...f, stdout: () => {}, exampleText: 'VG_SCOPE=vg\n' })
  const [call] = f.calls.exec
  assert.equal(call.cmd, 'docker')
  assert.deepEqual(call.args, ['exec', '-i', '-e', 'MYSQL_PWD', 'village-green-orch-db-1', 'mysql', '-uroot', '-N', '-B', 'vg'])
  assert.ok(!call.args.join(' ').includes('-pp'))
  assert.equal(call.opts.env.MYSQL_PWD, 'p')
  assert.match(call.opts.input, /service-account-vg-sync-harness/)
  // then the service's setup acknowledges its own privacy, from a cleaned environment
  const [setup] = f.calls.spawn
  assert.deepEqual(setup.args.slice(-4), ['setup', '--env', '.env.harness', '--acknowledge-privacy'])
  assert.equal(setup.opts.env.VG_SCOPE, undefined)
  assert.equal(f.calls.ack, true)
})

test('restoreAccounts fails when the grants read back are not the expected three', async () => {
  const f = fakes({ stdout: 'service-account-vg-sync\t8\n' })
  await assert.rejects(restoreAccounts(env, { ...f, stdout: () => {}, exampleText: '' }), /grants/)
})

test('restoreAccounts fails when mysql exits non-zero', async () => {
  const f = fakes({ code: 1 })
  await assert.rejects(restoreAccounts(env, { ...f, stdout: () => {}, exampleText: '' }), /mysql/)
})

test('reseedVg runs the generator with the HARNESS_DB values and no demo donors, then restores the accounts', async () => {
  const f = fakes()
  await reseedVg(env, { ...f, stdout: () => {}, exampleText: '' })
  const [gen] = f.calls.spawn
  assert.equal(gen.cmd, 'npm')
  assert.deepEqual(gen.args, ['run', 'seed'])
  assert.equal(gen.opts.cwd, '/gen')
  assert.equal(gen.opts.env.VG_DB_HOST, '127.0.0.1')
  assert.equal(gen.opts.env.VG_DB_PORT, '60001')
  assert.equal(gen.opts.env.VG_DB_USER, 'root')
  assert.equal(gen.opts.env.VG_DB_PASSWORD, 'p')
  assert.equal(gen.opts.env.VG_DB_SCHEMA, 'vg')
  assert.equal(gen.opts.env.VG_DEMO_DONORS, '0')
  assert.equal(f.calls.exec.length, 1)
})

test('reseedVg stops when the generator fails', async () => {
  const f = fakes()
  f.spawn = async () => 1
  await assert.rejects(reseedVg(env, { ...f, stdout: () => {}, exampleText: '' }), /generator/)
})

test('reseedVg refuses the demo stack port and container', async () => {
  const f = fakes()
  await assert.rejects(reseedVg({ ...env, HARNESS_DB_PORT: '60002' }, { ...f, stdout: () => {}, exampleText: '' }), /60002/)
  await assert.rejects(reseedVg({ ...env, HARNESS_DB_CONTAINER: 'village-green-demo-db-1' }, { ...f, stdout: () => {}, exampleText: '' }), /demo/)
  assert.equal(f.calls.spawn.length, 0)
})

test('reseedVg refuses when the container does not publish HARNESS_DB_PORT', async () => {
  const f = fakes({ port: '60009' })
  await assert.rejects(reseedVg(env, { ...f, stdout: () => {}, exampleText: '' }), /publish/)
  assert.equal(f.calls.spawn.length, 0)
})

test('resolveSql records a resolution and reopens the hold, as VG\'s endpoint does', async () => {
  const { resolveSql } = await import('../../harness/vg-db.js')
  const sql = resolveSql('61', { kind: 'link', personId: "7'" })
  assert.match(sql, /^UPDATE sync_hold SET resolution = CAST\('\{\\"kind\\":\\"link\\",\\"personId\\":\\"7\\'\\"\}' AS JSON\), resolvedAt = NOW\(3\), state = 'open', dismissalKind = NULL, dismissedAt = NULL, dismissedUserId = NULL WHERE holdId = 61 AND personId IS NULL;/)
  assert.throws(() => resolveSql('6 1', { kind: 'create' }), /holdId/)
})
