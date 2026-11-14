#!/usr/bin/env node
// Spike, throwaway: write experiments against the LGL TRIAL account.
//
// The trial and production accounts share one API host; only the key decides
// which account a call reaches. So nothing here writes until the guard has
// shown that the key reaches the trial account:
//
//   1. the account holds at most MAX_CONSTITUENTS constituents (production
//      holds thousands), counted with a one-item request before anything is
//      pulled; and
//   2. exactly one constituent is named SENTINEL, a record created by hand in
//      the trial account's screen that production will never have.
//
//   node spike/lgl-trial.mjs check   --env .env.trial            (read-only)
//   node spike/lgl-trial.mjs dedup   --env .env.trial [--write]  (duplicate and invalid entries)
//   node spike/lgl-trial.mjs verify  --env .env.trial [--write]  (a real public address, sent untidy)
//   node spike/lgl-trial.mjs touch   --env .env.trial [--write]  (one email added to the Verify record)
//   node spike/lgl-trial.mjs repatch --env .env.trial [--write]  (address edit with no content change)
//   node spike/lgl-trial.mjs timing  --env .env.trial [--write]  (what triggers verification: ~30 min of polling)
//   node spike/lgl-trial.mjs observe --env .env.trial            (read-only: save probe records, diff with last save)
//   node spike/lgl-trial.mjs cleanup --env .env.trial [--write]  (deletes what this script created)
//
// LGL's address and phone deduplication run as a daily job, not at write
// time. Address verification is a sweep about every 10-11 minutes over
// addresses not yet tried; an edit does not trigger it (shown by `timing`).
// Run observe after writing, 11+ minutes later, and again the next day.
//
// Without --write, every POST, PATCH and DELETE is printed and not sent.
// Writes go only to constituents this script created (ids kept in out/,
// gitignored) whose last name is PROBE_LAST; each is re-read before a write.
//
// There is no default --env, so the production .env is never picked up by
// accident. Output names only the sentinel; other records are counted, not
// printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const BASE = 'https://api.littlegreenlight.com/api/v1'
const SENTINEL = { first_name: 'Zztrial', last_name: 'Sentinel' }
const PROBE_LAST = 'Zzprobe'
const MAX_CONSTITUENTS = 200
const STATE = new URL('../out/lgl-trial.json', import.meta.url).pathname

const args = process.argv.slice(2)
const mode = args[0]
// Real public addresses are not kept in this public repo: supply them in the
// environment as "street|city|state|zip", e.g. TRIAL_REAL_ADDRESS_1.
function realAddress(n) {
  const raw = process.env[`TRIAL_REAL_ADDRESS_${n}`]
  if (!raw) { console.error(`Set TRIAL_REAL_ADDRESS_${n} to "street|city|state|zip" (a real public address, typed untidy).`); process.exit(2) }
  const [street, city, state, postal_code] = raw.split('|')
  return { street, city, state, postal_code }
}

const WRITE = args.includes('--write')
const MODES = ['check', 'dedup', 'verify', 'touch', 'repatch', 'timing', 'observe', 'cleanup']
if (!MODES.includes(mode)) throw new Error(`First argument: ${MODES.join(' | ')}`)
const envAt = args.indexOf('--env')
if (envAt < 0 || !args[envAt + 1]) throw new Error('--env <path> is required (the trial key, e.g. .env.trial)')
const envPath = args[envAt + 1].replace(/^~(?=\/)/, process.env.HOME)
process.loadEnvFile(envPath)
if (!process.env.LGL_API_KEY) throw new Error(`LGL_API_KEY is not set in ${envPath}`)
const auth = 'Basic ' + Buffer.from(`${process.env.LGL_API_KEY}:`).toString('base64')

let requests = 0
let fakeId = 0
async function call(method, path, body, params = {}) {
  if (method !== 'GET' && !WRITE) {
    console.log(`   DRY ${method} ${path} ${body === undefined ? '' : JSON.stringify(body)}`)
    return { status: 0, json: { id: `dry${++fakeId}` }, text: '(dry run)' }
  }
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
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))

// The guard. Returns the sentinel record, or throws before any write can happen.
async function guard() {
  const head = await call('GET', '/constituents/search', undefined, { limit: 1 })
  if (head.status !== 200) throw new Error(`Count request failed: HTTP ${head.status} ${head.text.slice(0, 200)}`)
  const total = head.json?.total_items
  if (!Number.isInteger(total)) throw new Error('Count request returned no total_items.')
  console.log(`constituents in this account: ${total}`)
  if (total > MAX_CONSTITUENTS) {
    throw new Error(`STOP: ${total} constituents is more than ${MAX_CONSTITUENTS}. This key may reach production.`)
  }
  const all = await call('GET', '/constituents/search', undefined, { limit: 1000 })
  const items = all.json?.items ?? []
  if (items.length !== total) throw new Error(`Read ${items.length} of ${total} constituents.`)
  const hits = items.filter((c) => c.first_name === SENTINEL.first_name && c.last_name === SENTINEL.last_name)
  if (hits.length !== 1) {
    throw new Error(`STOP: expected one constituent named ${SENTINEL.first_name} ${SENTINEL.last_name}, found ${hits.length}.`)
  }
  return { total, sentinel: hits[0] }
}

// ---- state and the per-record guard ----
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { created: [] })
function saveState(s) {
  mkdirSync(new URL('../out/', import.meta.url).pathname, { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2))
}
async function target(id) {
  if (String(id).startsWith('dry')) return null
  if (!loadState().created.includes(id)) throw new Error(`Refusing to write: ${id} was not created by this script.`)
  const r = await call('GET', `/constituents/${id}`)
  if (r.status !== 200 || r.json?.id !== id || r.json?.last_name !== PROBE_LAST) {
    throw new Error(`Refusing to write: constituent ${id} is not a probe record (HTTP ${r.status}).`)
  }
  return r.json
}
async function createProbe(first_name) {
  const r = await call('POST', '/constituents', { first_name, last_name: PROBE_LAST })
  console.log(`POST /constituents (${first_name} ${PROBE_LAST}) -> HTTP ${r.status}`)
  if (!WRITE) return r.json.id
  if (r.status !== 200 && r.status !== 201) { console.log(r.text.slice(0, 400)); process.exit(1) }
  const s = loadState()
  s.created.push(r.json.id)
  saveState(s)
  console.log(`   created ${r.json.id}`)
  return r.json.id
}

const LISTS = {
  street_addresses: ['id', 'street', 'city', 'state', 'postal_code', 'is_preferred', 'not_current', 'street_type_name', 'verified'],
  phone_numbers: ['id', 'number', 'normalized_number', 'is_preferred', 'not_current', 'phone_type_name'],
  email_addresses: ['id', 'address', 'is_preferred', 'not_current', 'email_type_name'],
}
async function show(id, kind) {
  if (String(id).startsWith('dry')) return
  const items = (await call('GET', `/constituents/${id}/${kind}`)).json?.items ?? []
  console.log(`   ${kind} now ${items.length}:`)
  for (const s of items) console.log(`     ${JSON.stringify(pick(s, LISTS[kind]))}`)
}
// One write, its outcome, and the list it touched.
async function attempt(id, kind, label, method, path, body) {
  console.log(`\n== ${label}`)
  await target(id)
  const r = await call(method, path, body)
  if (WRITE) {
    console.log(`   HTTP ${r.status}${r.json?.id ? `, id ${r.json.id}` : ''}`)
    if (r.status >= 400 || r.status === 0) console.log(`   body: ${r.text.slice(0, 400)}`)
  }
  await show(id, kind)
  return r
}

if (mode === 'dedup') {
  await guard()
  console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
  const id = await createProbe('Dedup')
  const add = (kind, label, body) => attempt(id, kind, label, 'POST', `/constituents/${id}/${kind}`, body)

  // Addresses: the first, then the same one again, then variants of it.
  const A = { street: '12 Elm Street', city: 'Providence', state: 'RI', postal_code: '02903' }
  await add('street_addresses', 'address: first', A)
  await add('street_addresses', 'address: exact repeat', A)
  await add('street_addresses', 'address: "St" for "Street"', { ...A, street: '12 Elm St' })
  await add('street_addresses', 'address: upper case', { ...A, street: '12 ELM STREET', city: 'PROVIDENCE' })
  await add('street_addresses', 'address: ZIP+4', { ...A, postal_code: '02903-1234' })
  await add('street_addresses', 'address: state spelled out', { ...A, state: 'Rhode Island' })
  const other = await add('street_addresses', 'address: a different one', { ...A, street: '34 Oak Avenue' })
  if (other.json?.id) {
    await attempt(id, 'street_addresses', 'address: edit the different one to equal the first', 'PATCH',
      `/street_addresses/${other.json.id}`, { street: A.street })
  }

  // Phones: the first, then the same number in other formats.
  await add('phone_numbers', 'phone: first', { number: '401-555-0100' })
  await add('phone_numbers', 'phone: exact repeat', { number: '401-555-0100' })
  await add('phone_numbers', 'phone: (401) 555-0100', { number: '(401) 555-0100' })
  await add('phone_numbers', 'phone: digits only', { number: '4015550100' })
  await add('phone_numbers', 'phone: +1 401 555 0100', { number: '+1 401 555 0100' })
  await add('phone_numbers', 'phone: with extension', { number: '401-555-0100 x12' })
  await add('phone_numbers', 'phone: same number, other type', { number: '401-555-0100', phone_type_name: 'Mobile' })
  const tel = await add('phone_numbers', 'phone: a different one', { number: '401-555-0199' })
  if (tel.json?.id) {
    await attempt(id, 'phone_numbers', 'phone: edit the different one to equal the first', 'PATCH',
      `/phone_numbers/${tel.json.id}`, { number: '401-555-0100' })
  }

  // Emails: duplicates, then validation.
  await add('email_addresses', 'email: first', { address: 'dedup.probe@example.org' })
  await add('email_addresses', 'email: exact repeat', { address: 'dedup.probe@example.org' })
  await add('email_addresses', 'email: different case', { address: 'Dedup.Probe@Example.org' })
  await add('email_addresses', 'email: no @', { address: 'not-an-email' })
  await add('email_addresses', 'email: no dot in domain', { address: 'dedup.probe@localhost' })
  await add('email_addresses', 'email: space inside', { address: 'dedup probe@example.org' })
  await add('email_addresses', 'email: domain that cannot exist', { address: 'dedup.probe@no-such-domain.invalid' })
  await add('email_addresses', 'email: surrounding spaces', { address: '  dedup.trim@example.org  ' })

  console.log(`\nrequests made: ${requests}`)
}

if (mode === 'cleanup') {
  await guard()
  const s = loadState()
  console.log(`${s.created.length} probe record(s) to delete${WRITE ? '' : ' (dry run)'}`)
  for (const id of [...s.created]) {
    await target(id)
    const r = await call('DELETE', `/constituents/${id}`)
    if (WRITE) {
      console.log(`DELETE /constituents/${id} -> HTTP ${r.status}`)
      if (r.status >= 200 && r.status < 300) { s.created = s.created.filter((x) => x !== id); saveState(s) }
    }
  }
}

if (mode === 'verify') {
  await guard()
  console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
  const id = await createProbe('Verify')
  // A real public building, not a person, typed untidy: lower case,
  // abbreviated, no ZIP+4. Does the daily job rewrite it, and how?
  await attempt(id, 'street_addresses', 'address: real public address, untidy', 'POST',
    `/constituents/${id}/street_addresses`, realAddress(1))
  console.log(`\nrequests made: ${requests}`)
}

if (mode === 'touch') {
  // One unrelated write to the Verify record (an email), to see whether a
  // save of the constituent makes LGL try to verify its saved address.
  await guard()
  console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
  let id
  for (const c of loadState().created) if ((await target(c))?.first_name === 'Verify') id = c
  if (!id) throw new Error('No Verify probe record in the state file.')
  await attempt(id, 'email_addresses', 'email: unrelated write to the Verify record', 'POST',
    `/constituents/${id}/email_addresses`, { address: 'verify.probe@example.org' })
  console.log(`\nrequests made: ${requests}`)
}

if (mode === 'repatch') {
  // An address edit that changes no content: does an edit, unlike an add,
  // make LGL try to verify the address?
  await guard()
  console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
  let id
  for (const c of loadState().created) if ((await target(c))?.first_name === 'Verify') id = c
  if (!id) throw new Error('No Verify probe record in the state file.')
  const [addr] = (await call('GET', `/constituents/${id}/street_addresses`)).json?.items ?? []
  if (!addr) throw new Error('The Verify record has no address.')
  await attempt(id, 'street_addresses', 'address: PATCH with no content change (is_preferred true)', 'PATCH',
    `/street_addresses/${addr.id}`, { is_preferred: true })
  console.log(`\nrequests made: ${requests}`)
}

if (mode === 'timing') {
  // Edit-trigger or sweep? Two records get real public addresses (untidy,
  // suffix spelled out) at the same moment. A is never edited; B's address is
  // PATCHed with no content change at EDIT_AT. Both are polled every POLL ms;
  // every change to an address is printed with the time it was seen.
  const POLL = 30_000, EDIT_AT = 5 * 60_000, RUN = 30 * 60_000
  await guard()
  console.log(WRITE ? 'WRITING to the trial account.' : 'Dry run: writes are printed, not sent. Add --write to send.')
  const t0 = Date.now()
  const at = () => `${new Date().toISOString().slice(11, 19)}Z +${((Date.now() - t0) / 60_000).toFixed(1)}m`
  const recs = {}
  for (const [name, addr] of [
    ['TimingA', realAddress(2)],
    ['TimingB', realAddress(3)],
  ]) {
    const id = await createProbe(name)
    const r = await call('POST', `/constituents/${id}/street_addresses`, addr)
    console.log(`${at()} ${name}: address added -> HTTP ${r.status}, id ${r.json?.id}`)
    recs[name] = { id, addrId: r.json?.id, last: null }
  }
  if (!WRITE) process.exit(0)
  const KEYS = ['street', 'city', 'state', 'postal_code', 'county', 'lat', 'lng', 'verified', 'verified_on', 'updated_at']
  let edited = false
  while (Date.now() - t0 < RUN) {
    if (!edited && Date.now() - t0 >= EDIT_AT) {
      await target(recs.TimingB.id)
      const r = await call('PATCH', `/street_addresses/${recs.TimingB.addrId}`, { is_preferred: true })
      console.log(`${at()} TimingB: address PATCHed (no content change) -> HTTP ${r.status}`)
      edited = true
    }
    for (const [name, rec] of Object.entries(recs)) {
      const a = (await call('GET', `/street_addresses/${rec.addrId}`)).json
      const now = pick(a, KEYS)
      if (JSON.stringify(now) !== JSON.stringify(rec.last)) {
        console.log(`${at()} ${name}: ${JSON.stringify(now)}`)
        rec.last = now
      }
    }
    await new Promise((r) => setTimeout(r, POLL))
  }
  console.log(`${at()} done. requests made: ${requests}`)
}

if (mode === 'observe') {
  await guard()
  const s = loadState()
  const now = {}
  for (const id of s.created) {
    const c = (await call('GET', `/constituents/${id}`)).json
    now[id] = { constituent: c }
    for (const kind of Object.keys(LISTS)) {
      now[id][kind] = ((await call('GET', `/constituents/${id}/${kind}`)).json?.items ?? [])
        .sort((a, b) => a.id - b.id)
    }
  }
  const prev = s.observed ?? null
  console.log(prev ? `comparing with the save of ${prev.at}` : 'first save: nothing to compare with')
  for (const id of s.created) {
    const c = now[id].constituent
    console.log(`\n== ${c?.first_name} ${c?.last_name} (${id}), updated_at ${c?.updated_at}` +
      (prev?.records[id] ? ` (was ${prev.records[id].constituent?.updated_at})` : ''))
    for (const kind of Object.keys(LISTS)) {
      const before = new Map((prev?.records[id]?.[kind] ?? []).map((e) => [e.id, e]))
      const after = new Map(now[id][kind].map((e) => [e.id, e]))
      console.log(`   ${kind}: ${after.size}${prev ? ` (was ${before.size})` : ''}`)
      for (const [eid, e] of after) {
        const b = before.get(eid)
        if (!prev) { console.log(`     ${JSON.stringify(e)}`); continue }
        if (!b) { console.log(`     NEW     ${JSON.stringify(e)}`); continue }
        const changed = Object.keys({ ...b, ...e }).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(e[k]))
        if (changed.length) {
          console.log(`     CHANGED ${eid}: ` + changed.map((k) => `${k} ${JSON.stringify(b[k])} -> ${JSON.stringify(e[k])}`).join('; '))
        } else console.log(`     same    ${JSON.stringify(pick(e, LISTS[kind]))}`)
      }
      for (const [eid, b] of before) if (!after.has(eid)) console.log(`     GONE    ${JSON.stringify(pick(b, LISTS[kind]))}`)
    }
  }
  s.observed = { at: new Date().toISOString(), records: now }
  saveState(s)
  console.log(`\nsaved. requests made: ${requests}`)
}

if (mode === 'check') {
  const { sentinel } = await guard()
  console.log('sentinel found:')
  console.log(JSON.stringify(pick(sentinel, [
    'id', 'first_name', 'middle_name', 'last_name', 'nick_name', 'prefix', 'suffix',
    'addressee', 'salutation', 'sort_name', 'created_at', 'updated_at',
  ]), null, 2))
  // Every key the record carries, so later experiments know the field names.
  console.log(`fields on a constituent: ${Object.keys(sentinel).sort().join(', ')}`)
  console.log(`GUARD PASSED. requests made: ${requests}`)
}
