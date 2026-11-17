// Seeds scenario starting records into the LGL trial account and the dev VG,
// and applies the edits a phase makes between passes. Writes only through the
// injected lglWriter and vgStaff clients.
//
// Gift ids (decided here, per ruling R5): the dues stand-ins come from env
// (LGL_MEMBERSHIP_FUND_ID, LGL_PAYPAL_PAYMENT_TYPE_ID). Everything else is
// env when given (LGL_GIFT_TYPE_ID, LGL_ORDINARY_FUND_ID,
// LGL_ORDINARY_PAYMENT_TYPE_ID) and otherwise found once, by name, from
// GET /gift_types ("Gift"), /payment_types ("Check", else "Cash") and /funds
// (the first active fund that is not the membership stand-in).

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveDate } from './scenario.js'
import { resolveHold as dbResolveHold } from './vg-db.js'

export const STATE_FILE = 'out/harness-state.json'
const KINDS = ['street_addresses', 'email_addresses', 'phone_numbers']

const asList = (v) => (v === undefined || v === null ? [] : [].concat(v))
const needEnv = (env, name) => {
  if (!env[name]) throw new Error(`${name} is not set`)
  return env[name]
}
const dateOrOffset = (v, today) => (v == null ? v : resolveDate(v, today))

function entryBody(kind, body) {
  if (kind !== 'phone_numbers' || body.type === undefined) return { ...body }
  const { type, ...rest } = body
  return { ...rest, phone_type_name: type }
}

function constituentFields(fields, today) {
  const out = { ...fields }
  for (const k of KINDS) delete out[k]
  if (out.deceased_date !== undefined) out.deceased_date = dateOrOffset(out.deceased_date, today)
  return out
}

function giftIds({ lglWriter, env }) {
  let cached = null
  const byName = async (path, pick) => {
    const r = await lglWriter.request('GET', `${path}?limit=100`)
    return pick(r.items ?? [])
  }
  return async () => {
    if (cached) return cached
    const membershipFund = needEnv(env, 'LGL_MEMBERSHIP_FUND_ID')
    const standInPayment = needEnv(env, 'LGL_PAYPAL_PAYMENT_TYPE_ID')
    const giftType = env.LGL_GIFT_TYPE_ID || (await byName('/gift_types', (xs) => xs.find((x) => x.name === 'Gift')))?.id
    const ordinaryFund = env.LGL_ORDINARY_FUND_ID ||
      (await byName('/funds', (xs) => xs.find((x) => String(x.id) !== String(membershipFund) && x.is_active !== false && !/membership/i.test(x.name ?? ''))))?.id
    const ordinaryPayment = env.LGL_ORDINARY_PAYMENT_TYPE_ID ||
      (await byName('/payment_types', (xs) => xs.find((x) => x.name === 'Check') ?? xs.find((x) => x.name === 'Cash')))?.id
    if (!giftType) throw new Error('No "Gift" gift type found; set LGL_GIFT_TYPE_ID')
    if (!ordinaryFund) throw new Error('No ordinary fund found; set LGL_ORDINARY_FUND_ID')
    if (!ordinaryPayment) throw new Error('No Check or Cash payment type found; set LGL_ORDINARY_PAYMENT_TYPE_ID')
    cached = { giftType, membershipFund, standInPayment, ordinaryFund, ordinaryPayment }
    return cached
  }
}

async function addGifts(constituentId, gifts, { lglWriter, ids, today }) {
  const resolved = []
  for (const g of gifts) {
    const date = resolveDate(g.date, today)
    const i = await ids()
    await lglWriter.addGift(constituentId, {
      gift_type_id: i.giftType,
      fund_id: g.dues ? i.membershipFund : i.ordinaryFund,
      payment_type_id: g.dues ? i.standInPayment : i.ordinaryPayment,
      received_amount: g.amount,
      received_date: date,
    })
    resolved.push({ date, dues: g.dues === true })
  }
  return resolved
}

// stateFile: where the pairing is saved (tests pass a temporary path, so they never
// overwrite a real run's saved state).
export async function seedScenarios(selected, { lglWriter, vgStaff, env, today, log = () => {}, stateFile = STATE_FILE }) {
  const ids = giftIds({ lglWriter, env })
  const state = { seededAt: new Date().toISOString(), today, scenarios: {} }
  for (const s of selected) {
    const lgl = s.lgl ?? {}
    const { id: constituentId } = await lglWriter.createConstituent(constituentFields(lgl, today))
    for (const kind of KINDS) {
      for (const body of asList(lgl[kind])) await lglWriter.addEntry(constituentId, kind, entryBody(kind, body))
    }
    const gifts = await addGifts(constituentId, asList(s.gifts), { lglWriter, ids, today })

    const personIds = []
    for (const spec of asList(s.vg)) {
      const { deceased, deceasedDate, ...post } = spec
      const created = await vgStaff.createPerson(post)
      const personId = String(created.personId)
      if (deceased !== undefined || deceasedDate !== undefined) {
        await vgStaff.patchPerson(personId, {
          ...(deceased !== undefined ? { deceased } : {}),
          ...(deceasedDate !== undefined ? { deceasedDate: dateOrOffset(deceasedDate, today) } : {}),
        })
      }
      personIds.push(personId)
    }
    if (s.link !== false) {
      const countable = gifts.filter((g) => !g.dues).map((g) => g.date).sort()
      const lastGiftDate = countable.length ? countable[countable.length - 1] : null
      for (const personId of personIds) await vgStaff.putDonor(personId, { lglConstituentId: constituentId, lastGiftDate })
    }
    state.scenarios[s.name] = { constituentId, personIds }
    log(`seeded ${s.name}: constituent ${constituentId}, ${personIds.length} person(s)`)
  }
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n')
  return state
}

export async function wipeLgl({ lglWriter, log = () => {} }) {
  const found = await lglWriter.listHarnessConstituents()
  for (const c of found) await lglWriter.deleteConstituent(c.id)
  log(`wiped ${found.length} harness constituent(s) from LGL`)
  return found.length
}

// scenarios: every seeded scenario's state entry (resolve.to names one). resolveHold writes a
// resolution into the dev sync_hold (vg-db.js).
export async function applyEdit(edit, stateEntry, { lglWriter, vgStaff, env = {}, today, scenarios = {}, resolveHold = dbResolveHold }) {
  const { constituentId, personIds } = stateEntry
  // One person's edit, or a list of them (a couple whose partners both change in one phase).
  for (const one of asList(edit.vg)) {
    // lastGiftDate sets the person's donor row (as staff could), the rest is a person PATCH.
    const { person = 0, lastGiftDate, ...body } = one
    if (personIds[person] === undefined) throw new Error(`edit.vg: this scenario has no person ${person}`)
    if (body.deceasedDate !== undefined) body.deceasedDate = dateOrOffset(body.deceasedDate, today)
    if (Object.keys(body).length) await vgStaff.patchPerson(personIds[person], body)
    if (lastGiftDate !== undefined) {
      await vgStaff.putDonor(personIds[person], { lglConstituentId: constituentId, lastGiftDate: dateOrOffset(lastGiftDate, today) })
    }
  }
  if (edit.syncLog) {
    // `runs` LGL writes of one field for the first person, as the service logs them, each in a run of
    // its own: the flapping guard counts distinct runs. The run ids are invented (no run row; sync_log
    // has no foreign key), far above the dev database's own.
    const { field, runs } = edit.syncLog
    if (!Number.isInteger(runs) || runs < 1) throw new Error('edit.syncLog: runs must be a whole number of at least 1')
    const base = 900_000_000 + Math.floor(Math.random() * 1_000_000) * 10
    const rows = Array.from({ length: runs }, (_, i) => ({
      runId: String(base + i), lglConstituentId: String(constituentId), personId: String(personIds[0]), field, case: 'vg-changed',
      request: { method: 'PATCH', path: `/constituents/${constituentId}`, body: null },
      outcome: 'written', responseStatus: 200, note: 'harness: an earlier write, for the flapping guard',
    }))
    await vgStaff.appendSyncLog(rows)
  }
  if (edit.lgl) {
    const { entries, gifts, delete: del, ...rest } = edit.lgl
    if (del === true) {
      await lglWriter.deleteConstituent(constituentId)
    } else {
      const fields = constituentFields(rest, today)
      if (Object.keys(fields).length) await lglWriter.updateConstituent(constituentId, fields)
      for (const [kind, body] of Object.entries(entries ?? {})) {
        const list = await lglWriter.listEntries(constituentId, kind)
        const preferred = list.find((e) => e.is_preferred) ?? list[0]
        if (preferred) await lglWriter.updateEntry(constituentId, kind, preferred.id, entryBody(kind, body))
        else await lglWriter.addEntry(constituentId, kind, { is_preferred: true, ...entryBody(kind, body) })
      }
      if (gifts) await addGifts(constituentId, gifts, { lglWriter, ids: giftIds({ lglWriter, env }), today })
    }
  }
  if (edit.resolve) {
    // Staff answer the scenario's unlinked-donor hold: link to its own first person, or to another
    // scenario's (to), or create a new person.
    const { kind, to } = edit.resolve
    let resolution = { kind }
    if (kind === 'link') {
      const target = to === undefined ? stateEntry : scenarios[to]
      if (!target) throw new Error(`edit.resolve: no scenario ${to}`)
      resolution = { kind, personId: String(target.personIds[0]) }
    }
    const holds = await vgStaff.listHolds(['open', 'dismissed'])
    const mine = holds.filter((h) => h.personId == null && String(h.lglConstituentId) === String(constituentId))
    const hold = mine.find((h) => h.state === 'open') ?? mine[0]
    if (!hold) throw new Error('edit.resolve: no unlinked-donor hold on this scenario\'s constituent')
    await resolveHold(env, hold.holdId, resolution)
  }
  if (edit.dismiss) {
    const { field, reason, dismissalKind } = edit.dismiss
    const holds = await vgStaff.listHolds(['open'])
    const mine = new Set(personIds.map(String))
    const hold = holds.find((h) => mine.has(String(h.personId)) && h.field === field && h.reason === reason)
    if (!hold) throw new Error(`edit.dismiss: no open hold for field "${field}" reason "${reason}" on this scenario's person`)
    await vgStaff.dismissHold(hold.holdId, { dismissalKind })
  }
}
