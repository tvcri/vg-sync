#!/usr/bin/env node
// Spike, throwaway: how do writes to LGL behave?
//
// WRITES TO THE LIVE LGL ACCOUNT, but only to one invented constituent that
// this script creates itself ("Zztest Syncprobe"). Before every write it
// re-reads the target and refuses to continue unless it is that record.
//
//   node spike/lgl-write-probe.mjs create  --env <path to .env>
//   node spike/lgl-write-probe.mjs probe   --env <path to .env>
//   node spike/lgl-write-probe.mjs cleanup --env <path to .env>   (deletes the test record)
//
// Endpoints are the documented ones (api.littlegreenlight.com/api-docs):
//   POST  /constituents                         PATCH /constituents/{id}
//   POST  /constituents/{id}/street_addresses   PATCH /street_addresses/{id}
//   POST  /constituents/{id}/email_addresses    PATCH /email_addresses/{id}
//   POST  /constituents/{id}/phone_numbers      PATCH /phone_numbers/{id}
//   DELETE /constituents/{id}
//
// The id of the test record is kept in out/ (gitignored).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const MARK = 'Syncprobe'
const STATE = new URL('../out/lgl-write-probe.json', import.meta.url).pathname

const args = process.argv.slice(2)
const mode = args[0]
if (!['create', 'probe', 'cleanup'].includes(mode)) throw new Error('First argument: create | probe | cleanup')
const envPath = (args[args.indexOf('--env') + 1] ?? '.env').replace(/^~(?=\/)/, process.env.HOME)
process.loadEnvFile(envPath)
if (!process.env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envPath}`)
const auth = 'Basic ' + Buffer.from(`${process.env.LGL_API_KEY}:`).toString('base64')

let requests = 0
async function call(method, path, body, params = {}) {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))

// The guard: every write goes through here first.
async function target(id) {
  const r = await call('GET', `/constituents/${id}`)
  if (r.status !== 200 || r.json?.id !== id || r.json?.last_name !== MARK) {
    throw new Error(`Refusing to write: constituent ${id} is not the test record (HTTP ${r.status}).`)
  }
  return r.json
}

if (mode === 'create') {
  if (existsSync(STATE)) throw new Error(`${STATE} exists: a test record was already created. Run cleanup first.`)
  const r = await call('POST', '/constituents', {
    first_name: 'Zztest',
    last_name: MARK,
    email_addresses: [{ address: 'zztest.syncprobe@example.org' }],
  })
  console.log(`POST /constituents -> HTTP ${r.status}`)
  if (r.status !== 200 && r.status !== 201) { console.log(r.text.slice(0, 400)); process.exit(1) }
  mkdirSync(new URL('../out/', import.meta.url).pathname, { recursive: true })
  writeFileSync(STATE, JSON.stringify({ id: r.json.id, createdAt: new Date().toISOString() }))
  console.log(`Created test constituent ${r.json.id}; created_at ${r.json.created_at}, updated_at ${r.json.updated_at}`)
  process.exit(0)
}

const { id } = JSON.parse(readFileSync(STATE, 'utf8'))

if (mode === 'cleanup') {
  await target(id)
  const r = await call('DELETE', `/constituents/${id}`)
  console.log(`DELETE /constituents/${id} -> HTTP ${r.status}`)
  if (r.status >= 200 && r.status < 300) rmSync(STATE)
  process.exit(0)
}

// ---- probe ----
const results = []

// Runs one write, then reports whether the constituent's own updated_at moved
// and whether a search for "updated since just before the write" returns it.
async function step(label, write) {
  const before = await target(id)
  const since = new Date(Date.parse(before.updated_at) + 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  await sleep(2500) // timestamps have one-second resolution
  const w = await write()
  await sleep(1500)
  const after = await target(id)
  const moved = after.updated_at !== before.updated_at
  const s = await call('GET', '/constituents/search', undefined, { 'q[]': `updated_from=${since}`, limit: 1000 })
  const found = (s.json?.items ?? []).some((c) => c.id === id)
  console.log(`\n== ${label}`)
  console.log(`   HTTP ${w.status}`)
  if (w.status >= 400) console.log(`   body: ${w.text.slice(0, 300)}`)
  console.log(`   constituent updated_at: ${before.updated_at} -> ${after.updated_at}  (${moved ? 'MOVED' : 'did not move'})`)
  console.log(`   search updated_from=${since}: HTTP ${s.status}, ${s.json?.total_items} items, test record ${found ? 'FOUND' : 'not found'}`)
  results.push({ label, status: w.status, moved, found })
  return { w, after }
}
const subs = async (kind) => (await call('GET', `/constituents/${id}/${kind}`)).json?.items ?? []
const showSubs = async (kind, keys) => {
  for (const s of await subs(kind)) console.log(`   ${kind} ${s.id}:`, JSON.stringify(pick(s, keys)))
}
const ADDR = ['street', 'city', 'state', 'postal_code', 'zip5', 'is_preferred', 'not_current', 'street_type_name', 'verified', 'updated_at']
const MAIL = ['address', 'is_preferred', 'not_current', 'email_type_name', 'updated_at']
const TEL = ['number', 'normalized_number', 'is_preferred', 'not_current', 'phone_type_name', 'updated_at']

const emailsAtStart = await subs('email_addresses')
console.log(`Test constituent ${id}; ${emailsAtStart.length} email(s) at start`)

// 1. Name fields, sent without any nested lists.
{
  const { after } = await step('PATCH constituent: first_name, nick_name, suffix', () =>
    call('PATCH', `/constituents/${id}`, { first_name: 'Zztestb', nick_name: 'Zed', suffix: 'Jr.' }))
  console.log('   now:', JSON.stringify(pick(after, ['first_name', 'last_name', 'nick_name', 'suffix', 'addressee', 'salutation', 'sort_name'])))
  console.log(`   emails still present: ${(await subs('email_addresses')).length} (was ${emailsAtStart.length})`)
}

// 2. Deceased on, then off.
{
  const { after } = await step('PATCH constituent: is_deceased true with a date', () =>
    call('PATCH', `/constituents/${id}`, { is_deceased: true, deceased_date: '2026-01-01' }))
  console.log('   now:', JSON.stringify(pick(after, ['is_deceased', 'deceased_date'])))
  const off = await step('PATCH constituent: is_deceased false, date null', () =>
    call('PATCH', `/constituents/${id}`, { is_deceased: false, deceased_date: null }))
  console.log('   now:', JSON.stringify(pick(off.after, ['is_deceased', 'deceased_date'])))
}

// 3. Addresses: add, edit in place, add a second.
let addressId
{
  const { w } = await step('POST street address (first)', () =>
    call('POST', `/constituents/${id}/street_addresses`, { street: '100 Test Probe Ln', city: 'Providence', state: 'RI', postal_code: '02903' }))
  addressId = w.json?.id
  await showSubs('street_addresses', ADDR)
}
if (addressId) {
  await step('PATCH street address in place (two-line street)', () =>
    call('PATCH', `/street_addresses/${addressId}`, { street: '200 Test Probe Ln\nApt 2' }))
  await showSubs('street_addresses', ADDR)
  await step('POST street address (second)', () =>
    call('POST', `/constituents/${id}/street_addresses`, { street: 'PO Box 999', city: 'Providence', state: 'Rhode Island', postal_code: '02903-1234' }))
  await showSubs('street_addresses', ADDR)
}

// 4. Phone: add, edit in place.
{
  const { w } = await step('POST phone (Mobile)', () =>
    call('POST', `/constituents/${id}/phone_numbers`, { number: '401-555-0100', phone_type_name: 'Mobile' }))
  if (w.json?.id) {
    await step('PATCH phone in place', () => call('PATCH', `/phone_numbers/${w.json.id}`, { number: '401-555-0101' }))
  }
  await showSubs('phone_numbers', TEL)
}

// 5. Email: edit the existing one in place.
if (emailsAtStart[0]) {
  await step('PATCH email in place', () =>
    call('PATCH', `/email_addresses/${emailsAtStart[0].id}`, { address: 'zztest2.syncprobe@example.org' }))
  await showSubs('email_addresses', MAIL)
}

console.log('\n==== Summary ====')
for (const r of results) {
  console.log(`${String(r.status).padEnd(4)} ${r.moved ? 'stamp moved   ' : 'stamp unmoved '} ${r.found ? 'search found  ' : 'search missed '} ${r.label}`)
}
console.log(`requests made: ${requests}`)
