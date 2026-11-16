#!/usr/bin/env node
// One-off, kept for the next trial account: how LGL treats the entries the
// sync will write at step 7 (addresses, emails, phones).
//
//   node harness/discover-entries.js --env .env.harness --addresses <file>            (dry)
//   node harness/discover-entries.js --env .env.harness --addresses <file> --write    (writes)
//   node harness/discover-entries.js --env .env.harness --phone-types --write         (phone types only)
//
// Part 1, preferred and not current. For each kind, on one invented record:
// add entry A, then entry B sent as preferred, then mark A not current, then
// make A current and preferred again. After each step it prints every entry's
// is_preferred and not_current, and whether the constituent's updated_at moved.
// It settles whether emails and phones behave as addresses do, and whether
// LGL clears the old preferred entry itself when another is made preferred.
//
// Part 2, verification of units and directionals. The addresses come from a
// file outside the repo (real addresses are never committed): a JSON list of
// { label, vg: { street, unit, city, state, zip }, oneLine? }. Each is sent as
// the sync sends a VG address: street and unit as two lines of one street
// value, or one line with oneLine. All go on one invented record. It then
// polls every minute, up to 35 minutes, until every address has verified_on,
// and prints LGL's rewrite and whether it compares the same as what was sent
// (src/lgl-vg/fields.js comparable), which is what keeps a rewrite from
// coming back to VG as a change.
//
// Before any write it checks that the key reaches the trial account, as
// harness/discover.js does. Every constituent it creates is deleted before it
// exits, each re-read first.

import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { comparable, lglFields } from '../src/lgl-vg/fields.js'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const SENTINEL = { first_name: 'Zztrial', last_name: 'Sentinel' }
const MAX_CONSTITUENTS = 200
const MAX_REQUESTS = 150
const PROBE_LAST = 'Zzharness'
const POLL_MS = 60_000
const POLL_LIMIT = 35
const KINDS = ['street_addresses', 'email_addresses', 'phone_numbers']

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const argOf = (name) => {
  const at = args.indexOf(name)
  if (at >= 0 && !args[at + 1]) throw new Error(`${name} needs a value`)
  return at >= 0 ? args[at + 1] : undefined
}
const envFile = argOf('--env') ?? '.env.harness'
const PHONE_TYPES = args.includes('--phone-types')
const addressFile = argOf('--addresses')
if (!addressFile && !PHONE_TYPES) throw new Error('--addresses <file> is required (a JSON list kept outside the repo)')
const addresses = addressFile ? JSON.parse(readFileSync(addressFile, 'utf8')) : []
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
const say = (label, r) =>
  console.log(`   ${label} -> HTTP ${r.status}${ok(r) ? '' : `: ${r.text.slice(0, 300)}`}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  return items
}

const created = []
async function createProbe(first_name) {
  const body = { first_name, last_name: PROBE_LAST }
  const r = await call('POST', '/constituents', body)
  say(`POST /constituents ${JSON.stringify(body)}`, r)
  if (ok(r) && r.json?.id) created.push(r.json.id)
  return r.json?.id
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
  }
}

const list = async (id, kind) => (await call('GET', `/constituents/${id}/${kind}`, undefined, { limit: 100 })).json?.items ?? []
const updatedAt = async (id) => (await call('GET', `/constituents/${id}`)).json?.updated_at
const VALUE = { street_addresses: 'street', email_addresses: 'address', phone_numbers: 'number' }

// ---- Part 1 ----
const SAMPLES = {
  street_addresses: [
    { street: '1 Alpha Lane', city: 'Zzyzxford', state: 'RI', postal_code: '00901', street_type_name: 'Home' },
    { street: '2 Beta Lane', city: 'Zzyzxford', state: 'RI', postal_code: '00901', street_type_name: 'Home' },
  ],
  email_addresses: [
    { address: 'jane.alpha@example.com', email_type_name: 'Home' },
    { address: 'jane.beta@example.com', email_type_name: 'Home' },
  ],
  phone_numbers: [
    { number: '401-555-0101', phone_type_name: 'Home' },
    { number: '401-555-0102', phone_type_name: 'Home' },
  ],
}

async function part1() {
  console.log('\n== Part 1: preferred and not current')
  const id = await createProbe('Entries')
  let before = WRITE ? await updatedAt(id) : null
  const step = async (label, kind, method, path, body) => {
    if (WRITE) await sleep(1100) // updated_at is to the second
    const r = await call(method, path, body)
    say(`${label}: ${method} ${path} ${JSON.stringify(body)}`, r)
    if (!WRITE) return r
    const after = await updatedAt(id)
    const rows = (await list(id, kind)).map((e) =>
      `${e[VALUE[kind]]} preferred=${e.is_preferred} not_current=${e.not_current}`)
    console.log(`      updated_at ${after === before ? 'did NOT move' : 'moved'}; entries: ${rows.join(' | ')}`)
    before = after
    return r
  }
  for (const kind of KINDS) {
    console.log(`\n-- ${kind}`)
    const [a, b] = SAMPLES[kind]
    const ra = await step('add A', kind, 'POST', `/constituents/${id}/${kind}`, a)
    await step('add B as preferred', kind, 'POST', `/constituents/${id}/${kind}`, { ...b, is_preferred: true })
    const aId = ra.json?.id
    await step('A not current', kind, 'PATCH', `/${kind}/${aId}`, { not_current: true })
    await step('A current and preferred again', kind, 'PATCH', `/${kind}/${aId}`, { not_current: false, is_preferred: true })
  }
}

// ---- --phone-types: is a phone's preferred mark per type, or one per constituent? ----
async function phoneTypes() {
  console.log('\n== Phone types: preferred per type or per constituent')
  const id = await createProbe('Phones')
  const show = async (label) => {
    if (!WRITE) return
    const rows = (await list(id, 'phone_numbers')).map((e) =>
      `${e.number} ${e.phone_type_name} preferred=${e.is_preferred} not_current=${e.not_current}`)
    console.log(`   after ${label}: ${rows.join(' | ')}`)
  }
  const add = async (label, body) => {
    const r = await call('POST', `/constituents/${id}/phone_numbers`, body)
    say(`${label}: POST ${JSON.stringify(body)}`, r)
    await show(label)
    return r.json?.id
  }
  await add('Home A', { number: '401-555-0111', phone_type_name: 'Home' })
  await add('Mobile M as preferred', { number: '401-555-0112', phone_type_name: 'Mobile', is_preferred: true })
  await add('Home B as preferred', { number: '401-555-0113', phone_type_name: 'Home', is_preferred: true })
}

// ---- Part 2 ----
const lglStreet = (a) => (a.vg.unit ? `${a.vg.street}${a.oneLine ? ' ' : '\n'}${a.vg.unit}` : a.vg.street)
const asLgl = (e) => lglFields({ street_addresses: [{ ...e, is_preferred: true, not_current: false }] })

async function part2() {
  console.log('\n== Part 2: verification of units and directionals')
  const id = await createProbe('Verify')
  const sent = new Map()
  for (const a of addresses) {
    const body = { street: lglStreet(a), city: a.vg.city, state: a.vg.state, postal_code: a.vg.zip, street_type_name: 'Home' }
    const r = await call('POST', `/constituents/${id}/street_addresses`, body)
    say(`add "${a.label}"`, r)
    if (ok(r) && r.json?.id) sent.set(r.json.id, a)
  }
  return { id, sent }
}

async function waitForVerification({ id, sent }) {
  if (!WRITE) return
  console.log('\n== Part 2: waiting for verification')
  const start = Date.now()
  let entries = []
  for (let i = 0; i < POLL_LIMIT; i++) {
    entries = (await list(id, 'street_addresses')).filter((e) => sent.has(e.id))
    const done = entries.filter((e) => e.verified_on).length
    console.log(`   ${Math.round((Date.now() - start) / 1000)} s: ${done} of ${sent.size} tried by verification`)
    if (done === sent.size) break
    await sleep(POLL_MS)
  }
  console.log('')
  for (const e of entries) {
    const a = sent.get(e.id)
    const lgl = asLgl(e)
    const lglC = lgl.values.address ? comparable('address', lgl.values.address) : `(unclean: ${lgl.problems.address})`
    const vgC = comparable('address', a.vg)
    console.log(`   ${a.label}: verified=${e.verified} verified_on=${e.verified_on ?? '-'}`)
    console.log(`      sent   ${JSON.stringify(lglStreet(a))}, ${a.vg.city}, ${a.vg.state} ${a.vg.zip}`)
    console.log(`      stored ${JSON.stringify(e.street)}, ${e.city}, ${e.state} ${e.postal_code}`)
    console.log(`      read back as ${JSON.stringify(lgl.values.address)}`)
    console.log(`      comparable ${lglC === vgC ? 'SAME' : `DIFFERS\n        vg  ${vgC}\n        lgl ${lglC}`}`)
  }
}

console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
const items = await guard()
const leftovers = items.filter((c) => c.last_name === PROBE_LAST)
if (leftovers.length) throw new Error(`STOP: ${leftovers.length} ${PROBE_LAST} record(s) left from an earlier run; delete them first.`)

try {
  if (PHONE_TYPES) await phoneTypes()
  else {
    const verifying = await part2() // addresses first, so the wait overlaps part 1
    await part1()
    await waitForVerification(verifying)
  }
} finally {
  console.log('\n== Cleanup')
  await cleanup()
  console.log(`\n${requests} requests.`)
}
