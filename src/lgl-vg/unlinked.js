// The full pass's decisions for LGL donors with no VG link: link, create, finish an earlier create,
// or hold; and, for people whose constituent is gone from LGL, unlink or follow the record that
// replaced it. Pure: takes the pulled data and the holds read from VG, returns the writes and holds.
// A wrong link or a duplicate person is the failure to avoid; anything uncertain is held.
import { classifyDonors } from './donors.js'
import { FIELDS, lglFields, vgFields, comparable } from './fields.js'
import { matchUnlinked, unlinkedFingerprint } from './match.js'
import { fingerprint } from './plan.js'

const ENTRY_FIELDS = new Set(['address', 'email'])
const isOpenOrDismissed = (h) => h.state === 'open' || h.state === 'dismissed'
const noPerson = (h) => h.personId == null

// The POST /persons body and the memory rows for a person created from LGL's record. A field LGL
// leaves empty, or holds but could not clean, is left out of the body; only the clean and the empty
// get memory (the next pass holds the rest as usual).
export function createBody (c) {
  const { values, problems, entryIds } = lglFields(c)
  const body = {}
  const put = (k, v) => { if (v != null && v !== '') body[k] = v }
  for (const f of ['firstName', 'lastName', 'suffix', 'nickname', 'email']) if (!problems[f]) put(f, values[f])
  if (!problems.address && values.address) {
    for (const k of ['street', 'unit', 'city', 'state', 'zip']) put(k, values.address[k])
  }
  if (!problems.phones && values.phones) { put('phone', values.phones.phone); put('cell', values.phones.cell) }
  const agree = FIELDS.filter((f) => !problems[f]).map((f) => ({
    field: f, lglConstituentId: String(c.id), value: values[f] ?? null,
    lglEntryId: ENTRY_FIELDS.has(f) && entryIds[f] != null ? String(entryIds[f]) : null,
  }))
  const address = body.street ? { street: body.street, city: body.city, state: body.state, zip: body.zip } : null
  return { body, agree, address }
}

// True when the VG person's first and last names still compare equal to LGL's.
export function sameName (c, person) {
  const lgl = lglFields(c).values
  const vg = vgFields(person)
  return ['firstName', 'lastName'].every((f) => comparable(f, lgl[f]) !== '' && comparable(f, lgl[f]) === comparable(f, vg[f]))
}

// unlinking: [{ personId, constituentId, reason }] from planLinked, people whose donor row the
// policy removes. Matching treats them as having no donor row, so a donor that replaced the gone
// record (an LGL merge) is followed instead.
export function planUnlinked ({ constituents, gifts, persons, holds, unlinking = [], config, today }) {
  const donorInfo = classifyDonors(constituents, gifts, {
    membershipFundId: config.lgl.membershipFundId,
    paypalPaymentTypeId: config.lgl.paypalPaymentTypeId,
  })
  const byId = new Map(constituents.map((c) => [String(c.id), c]))
  const unlinkingBy = new Map(unlinking.map((u) => [String(u.personId), u]))
  const view = persons.map((p) => (unlinkingBy.has(String(p.personId)) ? { ...p, donor: null } : p))
  const personById = new Map(view.map((p) => [String(p.personId), p]))
  const linked = new Set(view.filter((p) => p.donor).map((p) => String(p.donor.lglConstituentId)))

  const decisions = []
  const desired = []
  const links = []
  const follows = []
  const creates = []
  const finishes = []
  const counts = { unlinkedDonors: 0, link: 0, follow: 0, create: 0, finish: 0, unlink: 0, skip: 0, hold: {} }
  const again = (h) => desired.push({
    lglConstituentId: String(h.lglConstituentId), personId: h.personId == null ? null : String(h.personId),
    field: h.field ?? null, reason: h.reason, fingerprint: h.fingerprint, detail: h.detail ?? null,
  })
  const holdDecision = (d, reason) => {
    decisions.push({ kind: 'unlinked', ...d, outcome: 'hold', note: reason })
    counts.hold[reason] = (counts.hold[reason] ?? 0) + 1
  }

  const donors = constituents
    .filter((c) => donorInfo.get(c.id)?.isDonor && !linked.has(String(c.id)))
    .map((c) => ({ constituent: c, lastGiftDate: donorInfo.get(c.id).lastGiftDate }))
  counts.unlinkedDonors = donors.length
  const isUnlinkedDonor = new Set(donors.map((d) => String(d.constituent.id)))

  // Left alone: a staff dismissal, an open import hold, or a create not yet finished.
  const exclude = new Set()
  const importHolds = new Map()
  const refused = new Map()
  for (const h of holds) {
    const x = String(h.lglConstituentId)
    if (noPerson(h) && h.state === 'dismissed' && h.dismissalKind === 'staff') exclude.add(x)
    if (noPerson(h) && h.state === 'open' && h.reason === 'import-hold') { exclude.add(x); importHolds.set(x, h) }
    if (noPerson(h) && h.reason === 'vg-refused' && isOpenOrDismissed(h)) refused.set(`${x}|${h.fingerprint}`, h)
  }

  // Creates logged by an earlier pass (an open create-unfinished hold) whose donor row is missing.
  for (const h of holds.filter((x) => x.state === 'open' && x.reason === 'create-unfinished')) {
    const x = String(h.lglConstituentId)
    const p = personById.get(String(h.personId))
    if (p?.donor && String(p.donor.lglConstituentId) === x) continue // finished after all: the hold closes
    exclude.add(x)
    const c = byId.get(x)
    const d = { constituentId: x, personId: String(h.personId), action: 'finish' }
    if (c && p && !p.donor && isUnlinkedDonor.has(x) && sameName(c, p)) {
      finishes.push({ holdId: String(h.holdId), personId: String(h.personId), constituentId: x, lastGiftDate: donorInfo.get(c.id).lastGiftDate, hold: h })
      decisions.push({ kind: 'unlinked', ...d, outcome: 'write-vg' })
      counts.finish++
    } else {
      again(h)
      holdDecision(d, 'create-unfinished')
    }
  }

  const results = matchUnlinked(donors, view, { today, horizonYears: config.createHorizonYears, exclude })
  const dateOf = (id) => donorInfo.get(id)?.lastGiftDate ?? null
  for (const r of results) {
    const x = String(r.constituentId)
    const lastGiftDate = dateOf(r.constituentId)
    if (r.outcome === 'skip') {
      counts.skip++
      if (importHolds.has(x)) again(importHolds.get(x))
      decisions.push({ kind: 'unlinked', constituentId: x, action: 'none', outcome: 'skip', note: r.reason })
      continue
    }
    if (r.outcome === 'hold') {
      const fp = unlinkedFingerprint(r.reason, r.candidates, lastGiftDate)
      desired.push({ lglConstituentId: x, personId: null, field: null, reason: r.reason, fingerprint: fp, detail: { candidates: r.candidates, lastGiftDate } })
      holdDecision({ constituentId: x, action: 'hold' }, r.reason)
      continue
    }
    const fp = unlinkedFingerprint(r.outcome, r.outcome === 'link' ? [r.personId] : [], lastGiftDate)
    const prior = refused.get(`${x}|${fp}`)
    if (prior) {
      again(prior)
      holdDecision({ constituentId: x, personId: r.personId == null ? undefined : String(r.personId), action: r.outcome }, 'vg-refused')
      continue
    }
    if (r.outcome === 'link') {
      const personId = String(r.personId)
      const old = unlinkingBy.get(personId)
      const write = { personId, constituentId: x, lastGiftDate, fingerprint: fp }
      if (old) {
        follows.push({ ...write, from: String(old.constituentId) })
        decisions.push({ kind: 'unlinked', constituentId: x, personId, action: 'follow', outcome: 'write-vg', note: `from ${old.constituentId}` })
        counts.follow++
      } else {
        links.push(write)
        decisions.push({ kind: 'unlinked', constituentId: x, personId, action: 'link', outcome: 'write-vg' })
        counts.link++
      }
    } else {
      creates.push({ constituentId: x, lastGiftDate, fingerprint: fp, ...createBody(byId.get(x)) })
      decisions.push({ kind: 'unlinked', constituentId: x, action: 'create', outcome: 'write-vg' })
      counts.create++
    }
  }

  const followed = new Set(follows.map((f) => f.personId))
  const unlinks = unlinking.filter((u) => !followed.has(String(u.personId)))
    .map((u) => ({ personId: String(u.personId), constituentId: String(u.constituentId), reason: u.reason }))
  for (const u of unlinks) {
    decisions.push({ kind: 'record', constituentId: u.constituentId, personId: u.personId, action: 'unlink', outcome: 'write-vg', note: u.reason })
    counts.unlink++
  }

  // An unlinked notice stays open while its person has no donor row and none is planned.
  const gettingOne = new Set([...links, ...follows, ...finishes].map((w) => w.personId))
  for (const h of holds.filter((x) => x.state === 'open' && x.reason === 'unlinked')) {
    const p = personById.get(String(h.personId))
    if (p && !p.donor && !gettingOne.has(String(h.personId))) again(h)
  }

  return { decisions, links, follows, unlinks, creates, finishes, holds: desired, counts }
}

// The notice opened for staff when a person loses the Donor mark.
export const unlinkedNotice = (u) => ({
  lglConstituentId: u.constituentId, personId: u.personId, field: null, reason: 'unlinked',
  fingerprint: fingerprint(['unlinked', u.constituentId, u.personId]), detail: { why: u.reason },
})

// The hold that logs a create between POST /persons and the donor row.
export const createUnfinished = (w, personId) => ({
  lglConstituentId: w.constituentId, personId: String(personId), field: null, reason: 'create-unfinished',
  fingerprint: fingerprint(['create-unfinished', w.constituentId, String(personId)]), detail: { lastGiftDate: w.lastGiftDate },
})
