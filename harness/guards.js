// Guards: the harness refuses to start unless both targets are the test ones.
// decideGuards is pure; runGuards gathers its inputs live and fails closed: an
// input that cannot be read is a failure naming the check, never a pass.

import { HARNESS_MARKER } from './lgl-write.js'

const REQUIRED = [
  'LGL_API_KEY', 'LGL_MEMBERSHIP_FUND_ID', 'LGL_PAYPAL_PAYMENT_TYPE_ID',
  'VG_API_URL', 'VG_OIDC_URL', 'VG_CLIENT_ID', 'VG_CLIENT_SECRET',
  'HARNESS_VG_CLIENT_ID', 'HARNESS_VG_CLIENT_SECRET',
  'HARNESS_DB_CONTAINER', 'HARNESS_DB_PASSWORD', 'HARNESS_DB_SCHEMA',
]
const MAX_CONSTITUENTS = 200
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']
// The dev stack's published endpoints (village-green orchestration, dev
// profile). The demo stack uses 54000/64003 for the API and 8091 for auth,
// and 60002 for its database; none of those is allowed.
const DEV_PORTS = { VG_API_URL: '64001', VG_OIDC_URL: '8090' }
const DEMO_DB_PORT = '60002'
const SENTINEL = { first_name: 'Zztrial', last_name: 'Sentinel' }

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^\[|\]$/g, '') } catch { return null }
}
function portOf(value) {
  try { return new URL(value).port } catch { return null }
}
const clean = (v) => String(v ?? '').trim()

export function decideGuards({ env, lglCount, sentinelFound, foreignDonors }) {
  const failed = []
  for (const name of REQUIRED) {
    if (!clean(env[name])) failed.push(`Required variable ${name} is empty.`)
  }
  if (!Number.isInteger(lglCount)) {
    failed.push('The LGL constituent count is unknown, so the trial account is not confirmed.')
  } else if (lglCount >= MAX_CONSTITUENTS) {
    failed.push(`The LGL account holds ${lglCount} constituents (the trial account holds fewer than ${MAX_CONSTITUENTS}); this key may reach production.`)
  }
  if (sentinelFound !== true) {
    failed.push('The LGL trial sentinel (Zztrial Sentinel) was not found; this key may not reach the trial account.')
  }
  for (const name of ['VG_API_URL', 'VG_OIDC_URL']) {
    if (!clean(env[name])) continue
    const value = clean(env[name])
    if (!LOCAL_HOSTS.includes(hostOf(value))) failed.push(`${name} must point at localhost, 127.0.0.1 or ::1.`)
    else if (portOf(value) !== DEV_PORTS[name]) failed.push(`${name} must use the dev stack's port ${DEV_PORTS[name]} (the demo stack's endpoints are refused).`)
  }
  const dbHost = clean(env.HARNESS_DB_HOST)
  if (dbHost && !LOCAL_HOSTS.includes(dbHost.replace(/^\[|\]$/g, ''))) {
    failed.push('HARNESS_DB_HOST must be empty or local (localhost, 127.0.0.1, ::1).')
  }
  if (clean(env.HARNESS_DB_PORT) === DEMO_DB_PORT) {
    failed.push(`HARNESS_DB_PORT ${DEMO_DB_PORT} is the demo database, which the harness must never touch.`)
  }
  if (clean(env.HARNESS_DB_CONTAINER).toLowerCase().startsWith('village-green-demo')) {
    failed.push('HARNESS_DB_CONTAINER names the demo stack (village-green-demo*), which the harness must never touch.')
  }
  if (!Number.isInteger(foreignDonors)) {
    failed.push('The count of non-harness LGL donors (constituents with a gift) is unknown.')
  } else if (foreignDonors > 0) {
    failed.push(`${foreignDonors} non-harness LGL constituent(s) have gifts; the account holds real donor data.`)
  }
  return { ok: failed.length === 0, failed }
}

export async function runGuards({ env, lglWriter, lglReader }) {
  const gatherFailures = []
  const gather = async (check, fn) => {
    try { return await fn() } catch (err) {
      gatherFailures.push(`Could not read ${check}: ${err.message}`)
      return undefined
    }
  }

  const lglCount = await gather('the LGL constituent count', () => lglWriter.countConstituents())
  // Nothing bigger is read from an account that is not confirmed small.
  const small = Number.isInteger(lglCount) && lglCount < MAX_CONSTITUENTS

  let sentinelFound = false
  let foreignDonors = 0
  if (small) {
    const found = await gather('the LGL sentinel', async () => {
      const r = await lglWriter.request('GET', '/constituents/search?limit=1000', undefined)
      return r.items.some((c) => c.first_name === SENTINEL.first_name && c.last_name === SENTINEL.last_name)
    })
    sentinelFound = found === true
    foreignDonors = await gather('the non-harness donors', async () => {
      const [constituents, gifts] = await Promise.all([lglReader.pullConstituents(), lglReader.pullGifts()])
      const withGift = new Set(gifts.map((g) => g.constituent_id))
      return constituents.filter((c) => c.external_constituent_id !== HARNESS_MARKER && withGift.has(c.id)).length
    })
  }

  const decided = decideGuards({ env, lglCount, sentinelFound, foreignDonors })
  const failed = [...decided.failed, ...gatherFailures]
  return { ok: failed.length === 0, failed }
}
