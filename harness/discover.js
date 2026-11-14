#!/usr/bin/env node
// One-off, kept for the next trial account: what the LGL trial account lets
// the test harness do through the API.
//
//   node harness/discover.js --env .env.harness            (reads only; writes are printed)
//   node harness/discover.js --env .env.harness --write    (writes to the trial account)
//
// It settles, and prints:
//   - the marker: can two constituents carry the same external_constituent_id,
//     and which search key finds them (external_id, external_constituent_id);
//   - whether GET /constituents/{id} honours expand for the three entry lists;
//   - phone types (GET /types, then the phone type's values) and what a phone
//     added with phone_type_name comes back as;
//   - deceased: which fields PATCH sets, whether the names must be sent too,
//     and whether a deceased constituent still shows in the search;
//   - gifts: funds, payment types, gift types, and the create call;
//   - the stand-in dues fund: an existing fund named like "membership", else
//     one named "Harness Membership", else it creates that one (kept);
//   - the ordinary fund for non-dues gifts: any active fund not named like
//     "membership", else it creates "Harness General" (kept);
//   - the stand-in for the PayPal payment type: one named PayPal if the
//     account has it, else the existing Credit Card type (payment types are
//     read-only in the API). Ordinary scenario gifts use Check or Cash, so
//     they are never mistaken for dues.
// Merges: the API has no merge call (api-docs list none), so nothing is tried.
//
// Before any write it checks that the key reaches the trial account: fewer
// than 200 constituents and exactly one named Zztrial Sentinel (as
// spike/lgl-trial.mjs does). Every constituent it creates is deleted before
// it exits, each re-read first; the fund it creates stays. At most 95 requests.

import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const SENTINEL = { first_name: 'Zztrial', last_name: 'Sentinel' }
const MAX_CONSTITUENTS = 200
const MAX_REQUESTS = 95
const MARKER = 'vg-sync-harness'
const PROBE_LAST = 'Zzharness'
const FUND_NAME = 'Harness Membership'
const ORDINARY_FUND_NAME = 'Harness General'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const envAt = args.indexOf('--env')
if (envAt >= 0 && !args[envAt + 1]) throw new Error('--env needs a file')
const envFile = envAt >= 0 ? args[envAt + 1] : '.env.harness'
const env = parseEnv(readFileSync(envFile, 'utf8'))
if (!env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envFile}`)
const auth = 'Basic ' + Buffer.from(`${env.LGL_API_KEY}:`).toString('base64')

let requests = 0
let fakeId = 0
async function call(method, path, body, params = {}) {
  if (method !== 'GET' && !WRITE) {
    console.log(`   DRY ${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`)
    return { status: 0, json: { id: `dry${++fakeId}` }, text: '(dry run)' }
  }
  if (requests >= MAX_REQUESTS) throw new Error(`STOP: request budget of ${MAX_REQUESTS} spent.`)
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  requests++
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (res.status === 429) throw new Error(`Rate limited (Retry-After ${res.headers.get('retry-after')}). Stopping.`)
  return { status: res.status, json, text }
}
const ok = (r) => r.status >= 200 && r.status < 300
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))
const say = (label, r) =>
  console.log(`   ${label} -> HTTP ${r.status}${ok(r) ? '' : `: ${r.text.slice(0, 300)}`}`)

// ---- the guard ----
async function guard() {
  const head = await call('GET', '/constituents/search', undefined, { limit: 1 })
  if (head.status !== 200) throw new Error(`Count request failed: HTTP ${head.status} ${head.text.slice(0, 200)}`)
  const total = head.json?.total_items
  if (!Number.isInteger(total)) throw new Error('Count request returned no total_items.')
  if (total >= MAX_CONSTITUENTS) {
    throw new Error(`STOP: ${total} constituents; the trial account has fewer than ${MAX_CONSTITUENTS}. This key may reach production.`)
  }
  const all = await call('GET', '/constituents/search', undefined, { limit: 1000 })
  const items = all.json?.items ?? []
  if (items.length !== total) throw new Error(`Read ${items.length} of ${total} constituents.`)
  const hits = items.filter((c) => c.first_name === SENTINEL.first_name && c.last_name === SENTINEL.last_name)
  if (hits.length !== 1) {
    throw new Error(`STOP: expected one constituent named ${SENTINEL.first_name} ${SENTINEL.last_name}, found ${hits.length}.`)
  }
  console.log(`GUARD PASSED: ${total} constituents, sentinel present.`)
  return { total, items }
}

// ---- created records: deleted at the end, each re-read first ----
const created = []
async function createProbe(first_name, extra = {}) {
  const body = { first_name, last_name: PROBE_LAST, ...extra }
  const r = await call('POST', '/constituents', body)
  say(`POST /constituents ${JSON.stringify(body)}`, r)
  if (ok(r) && r.json?.id) created.push(r.json.id)
  return r
}
async function cleanup() {
  for (const id of created) {
    const g = await call('GET', `/constituents/${id}`)
    if (g.status !== 200 || g.json?.id !== id || g.json?.last_name !== PROBE_LAST) {
      console.log(`   NOT deleting ${id}: it is not a probe record (HTTP ${g.status}).`)
      continue
    }
    const d = await call('DELETE', `/constituents/${id}`)
    say(`DELETE /constituents/${id}`, d)
    const after = await call('GET', `/constituents/${id}`)
    console.log(`   GET /constituents/${id} after delete -> HTTP ${after.status}`)
  }
}

const search = async (q, limit = 50) => call('GET', '/constituents/search', undefined, { 'q[]': q, limit })
const ids = (r) => (r.json?.items ?? []).map((c) => c.id)

console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
const { total, items } = await guard()
const marked = items.filter((c) => c.external_constituent_id === MARKER)
const withExt = items.filter((c) => c.external_constituent_id)
console.log(`constituents with an external id: ${withExt.length}; with the marker already: ${marked.length}`)
const leftovers = items.filter((c) => c.last_name === PROBE_LAST)
if (leftovers.length) throw new Error(`STOP: ${leftovers.length} ${PROBE_LAST} record(s) left from an earlier run; delete them first.`)

console.log('\n== Lists the account holds')
const funds = (await call('GET', '/funds', undefined, { limit: 100 })).json?.items ?? []
console.log(`funds: ${JSON.stringify(funds.map((f) => pick(f, ['id', 'name', 'is_active'])))}`)
const payTypes = (await call('GET', '/payment_types', undefined, { limit: 100 })).json?.items ?? []
console.log(`payment types: ${JSON.stringify(payTypes.map((p) => pick(p, ['id', 'name'])))}`)
const giftTypes = (await call('GET', '/gift_types', undefined, { limit: 100 })).json?.items ?? []
console.log(`gift types: ${JSON.stringify(giftTypes.map((g) => pick(g, ['id', 'name'])))}`)
const types = await call('GET', '/types')
const typeNames = (types.json?.items ?? types.json ?? []).map?.((t) => t.key ?? t.name ?? t) ?? []
console.log(`types (HTTP ${types.status}): ${JSON.stringify(typeNames)}`)
const phoneKey = typeNames.find((t) => /phone/i.test(String(t)))
if (phoneKey) {
  const pt = await call('GET', `/types/${phoneKey}`)
  console.log(`${phoneKey} (HTTP ${pt.status}): ${JSON.stringify((pt.json?.items ?? pt.json ?? []).map?.((v) => pick(v, ['id', 'name'])) ?? pt.text.slice(0, 300))}`)
}

const duesPaymentType = payTypes.find((p) => /pay\s*pal/i.test(p.name)) ?? payTypes.find((p) => p.name === 'Credit Card')
console.log(duesPaymentType
  ? `Stand-in for PayPal (LGL_PAYPAL_PAYMENT_TYPE_ID): ${duesPaymentType.id} (${duesPaymentType.name})`
  : 'No PayPal or Credit Card payment type, and the API cannot create one: the engineer picks a stand-in in the LGL screen.')
let fund = funds.find((f) => /membership/i.test(f.name))
if (fund) console.log(`Stand-in fund already present: ${fund.id} (${fund.name})`)
const giftType = giftTypes.find((g) => g.name === 'Gift') ?? giftTypes[0]

try {
console.log('\n== The marker')
const a = await createProbe('Discover', { external_constituent_id: MARKER })
const b = await createProbe('Second', { external_constituent_id: MARKER })
const aId = a.json?.id
const bId = b.json?.id
if (WRITE) {
  const mine = new Set(created)
  for (const key of ['external_id', 'external_constituent_id']) {
    const r = await search(`${key}=${MARKER}`)
    const got = ids(r)
    console.log(`   q[]=${key}=${MARKER}: HTTP ${r.status}, total ${r.json?.total_items}, ours ${got.filter((x) => mine.has(x)).length} of ${created.length}, others ${got.filter((x) => !mine.has(x)).length} (account total ${total + created.length})`)
  }
  const near = await search(`external_id=${MARKER.slice(0, -3)}`)
  console.log(`   q[]=external_id=<marker less 3 chars>: total ${near.json?.total_items} (a prefix match if > 0)`)
}

console.log('\n== A constituent read with expand')
if (WRITE && aId) {
  const r = await call('GET', `/constituents/${aId}`, undefined, { expand: 'street_addresses,email_addresses,phone_numbers' })
  console.log(`   keys: ${Object.keys(r.json ?? {}).sort().join(', ')}`)
  console.log(`   external_constituent_id: ${JSON.stringify(r.json?.external_constituent_id)}`)
}

console.log('\n== Phone type')
if (aId) {
  const r = await call('POST', `/constituents/${aId}/phone_numbers`, { number: '401-555-0100', phone_type_name: 'Mobile' })
  say('POST phone_numbers {number, phone_type_name: "Mobile"}', r)
  if (WRITE) console.log(`   ${JSON.stringify(pick(r.json, ['id', 'number', 'phone_number_type_id', 'phone_type_name', 'is_preferred']))}`)
  const r2 = await call('POST', `/constituents/${aId}/phone_numbers`, { number: '401-555-0101', phone_type_name: 'Nonesuch' })
  say('POST phone_numbers {phone_type_name: "Nonesuch"}', r2)
  if (WRITE) console.log(`   ${JSON.stringify(pick(r2.json, ['id', 'number', 'phone_number_type_id', 'phone_type_name']))}`)
}

console.log('\n== Deceased')
if (aId) {
  let r = await call('PATCH', `/constituents/${aId}`, { is_deceased: true, deceased_date: '2026-01-15' })
  say('PATCH {is_deceased, deceased_date} without names', r)
  if (WRITE && !ok(r)) {
    r = await call('PATCH', `/constituents/${aId}`, { first_name: 'Discover', last_name: PROBE_LAST, is_deceased: true, deceased_date: '2026-01-15' })
    say('PATCH with names', r)
  }
  if (WRITE) {
    const g = await call('GET', `/constituents/${aId}`)
    console.log(`   after: ${JSON.stringify(pick(g.json, ['first_name', 'last_name', 'is_deceased', 'deceased_date', 'external_constituent_id']))}`)
    const s = await search(`external_id=${MARKER}`)
    console.log(`   deceased record in the marker search: ${ids(s).includes(aId)}`)
    const n = await call('GET', '/constituents/search', undefined, { limit: 1 })
    console.log(`   account total now ${n.json?.total_items} (was ${total}, created ${created.length})`)
  }
}

console.log('\n== The stand-in fund')
if (!fund) fund = funds.find((f) => f.name === FUND_NAME)
if (!fund) {
  const r = await call('POST', '/funds', { name: FUND_NAME })
  say(`POST /funds {name: "${FUND_NAME}"}`, r)
  if (ok(r) || !WRITE) fund = r.json
}
if (fund) console.log(`   fund: ${fund.id} (${fund.name ?? FUND_NAME})`)

// Ordinary scenario gifts need a fund that is not the dues stand-in (harness/seed.js
// finds the first active one by name); a new trial account has none.
console.log('\n== The ordinary fund')
let ordinary = funds.find((f) => f.is_active !== false && !/membership/i.test(f.name ?? ''))
if (!ordinary) {
  const r = await call('POST', '/funds', { name: ORDINARY_FUND_NAME })
  say(`POST /funds {name: "${ORDINARY_FUND_NAME}"}`, r)
  if (ok(r) || !WRITE) ordinary = r.json
}
if (ordinary) console.log(`   fund: ${ordinary.id} (${ordinary.name ?? ORDINARY_FUND_NAME})`)

console.log('\n== A gift')
if (bId && fund && giftType) {
  const body = {
    gift_type_id: giftType.id,
    fund_id: fund.id,
    received_amount: 25,
    received_date: '2026-01-10',
    ...(duesPaymentType ? { payment_type_id: duesPaymentType.id } : {}),
  }
  let r = await call('POST', `/constituents/${bId}/gifts`, body)
  say(`POST /constituents/{id}/gifts ${JSON.stringify(body)}`, r)
  if (WRITE && !ok(r)) {
    r = await call('POST', `/constituents/${bId}/gifts`, { ...body, gift_type_name: giftType.name })
    say('POST again with gift_type_name', r)
  }
  if (WRITE && ok(r)) {
    const g = await call('GET', `/gifts/${r.json.id}`)
    console.log(`   gift: ${JSON.stringify(pick(g.json, ['id', 'constituent_id', 'gift_type_id', 'gift_type_name', 'fund_id', 'fund_name', 'payment_type_id', 'payment_type_name', 'received_amount', 'received_date']))}`)
    const d = await call('DELETE', `/gifts/${r.json.id}`)
    say('DELETE /gifts/{id}', d)
  }
} else console.log('   skipped: no fund or gift type')

} finally {
  console.log('\n== Cleanup')
  await cleanup()
}
console.log(`\nrequests made: ${requests}`)
