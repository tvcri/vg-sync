// The full pass's decisions for LGL donors with no VG link: link, create, finish an earlier create,
// or hold; and, for people whose constituent is gone from LGL, unlink or follow the record that
// replaced it. Pure: takes the pulled data and the holds read from VG, returns the writes and holds.
// A wrong link or a duplicate person is the failure to avoid; anything uncertain is held.
import { classifyDonors } from './donors.js'
import { FIELDS, lglFields, vgFields, comparable, ENTRY_FIELDS } from './fields.js'
import { matchUnlinked, unlinkedFingerprint } from './match.js'
import { fingerprint } from './plan.js'

const isOpenOrDismissed = (h) => h.state === 'open' || h.state === 'dismissed'
const noPerson = (h) => h.personId == null
const squash = (s) => s.replace(/\s+/g, ' ').trim()
const current = (list) => (list ?? []).filter((x) => !x.not_current)
const preferred = (list) => { const a = current(list); return a.find((x) => x.is_preferred) ?? a[0] ?? null }

// Who an unlinked donor is, for a person reading the hold: LGL's name, preferred email and address
// on one line, and last gift date. Display strings; any may be null.
export function lglDetail (c, lastGiftDate) {
  const name = squash([c.first_name, c.last_name, c.suffix].filter((x) => x && String(x).trim()).join(' '))
  const a = preferred(c.street_addresses)
  const street = a?.street ? a.street.split(/\n+/).map(squash).filter(Boolean).join(', ') : ''
  const zip = (a?.postal_code || a?.zip5) ?? ''
  const tail = squash([a?.state, zip].filter(Boolean).join(' '))
  const address = a ? [street, a.city, tail].map((x) => (x ?? '').trim()).filter(Boolean).join(', ') : ''
  return {
    name: name || null,
    email: preferred(c.email_addresses)?.address?.trim() || null,
    address: address || null,
    lastGiftDate: lastGiftDate ?? null,
  }
}

// A VG person as staff read them: "Last, First".
const personName = (p) => [p?.detail?.lastName, p?.detail?.firstName].filter(Boolean).join(', ') || `person ${p?.personId}`

// The hold opened when a staff resolution cannot be carried out. message is one sentence for staff.
export const resolutionFailed = (h, message) => ({
  lglConstituentId: String(h.lglConstituentId), personId: null, field: null, reason: 'resolution-failed',
  fingerprint: fingerprint(['resolution-failed', String(h.lglConstituentId), String(h.holdId), message]),
  detail: { resolution: h.resolution ?? null, message },
})
const resolutionOf = (h) => h.resolution ?? null // VG before its resolution migration sends no field

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
  const close = []
  const counts = {
    unlinkedDonors: 0, link: 0, follow: 0, create: 0, finish: 0, unlink: 0, skip: 0, hold: {},
    resolution: { link: 0, create: 0, done: 0, failed: 0 },
  }
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

  // Left alone: a staff dismissal, an open import hold, an open resolution-failed hold, a staff
  // resolution (carried out below), or a create not yet finished.
  const exclude = new Set()
  const importHolds = new Map()
  const refused = new Map()
  const resolvedBy = new Map() // constituent -> its open resolved holds
  for (const h of holds) {
    const x = String(h.lglConstituentId)
    if (!noPerson(h)) continue
    if (h.state === 'open' && resolutionOf(h) !== null) {
      exclude.add(x)
      resolvedBy.set(x, [...(resolvedBy.get(x) ?? []), h])
      continue
    }
    if (h.state === 'dismissed' && h.dismissalKind === 'staff') {
      exclude.add(x)
      if (isUnlinkedDonor.has(x)) again(h) // kept for its detail.lgl; it stays dismissed
    }
    if (h.state === 'open' && h.reason === 'import-hold') { exclude.add(x); importHolds.set(x, h) }
    if (h.state === 'open' && h.reason === 'resolution-failed') { exclude.add(x); if (!linked.has(x)) again(h) }
    if (h.reason === 'vg-refused' && isOpenOrDismissed(h)) refused.set(`${x}|${h.fingerprint}`, h)
  }

  // Staff resolutions: an answer staff recorded on an unlinked donor's hold in VG. The latest one on a
  // donor is checked against what VG and LGL hold now, then carried out as a link or a create (the
  // write carries its hold; applying closes it) or failed (closed here, resolution-failed opened).
  const linkedTo = new Map(view.filter((p) => p.donor).map((p) => [String(p.donor.lglConstituentId), p]))
  const latest = []
  for (const list of resolvedBy.values()) {
    const sorted = [...list].sort((a, b) => String(b.resolvedAt ?? '').localeCompare(String(a.resolvedAt ?? '')) || Number(b.holdId) - Number(a.holdId))
    latest.push(sorted[0])
    close.push(...sorted.slice(1))
  }
  const chosen = new Map() // personId -> how many resolutions link to them
  for (const h of latest) {
    const r = resolutionOf(h)
    if (r.kind === 'link' && r.personId != null) chosen.set(String(r.personId), (chosen.get(String(r.personId)) ?? 0) + 1)
  }
  const resolutionLinks = new Set()
  const fail = (h, message) => {
    close.push(h)
    desired.push(resolutionFailed(h, message))
    holdDecision({ constituentId: String(h.lglConstituentId), action: 'resolution' }, 'resolution-failed')
    counts.resolution.failed++
  }
  for (const h of latest) {
    const x = String(h.lglConstituentId)
    const r = resolutionOf(h)
    const pid = r.personId == null ? null : String(r.personId)
    const now = linkedTo.get(x)
    if (now) {
      if (r.kind === 'create' || (r.kind === 'link' && String(now.personId) === pid)) {
        close.push(h)
        counts.resolution.done++
        decisions.push({ kind: 'unlinked', constituentId: x, personId: String(now.personId), action: 'none', outcome: 'skip', note: 'resolution-done' })
      } else fail(h, `This LGL donor is already linked to ${personName(now)} in VG.`)
      continue
    }
    if (!byId.has(x)) { fail(h, 'This donor is no longer in LGL.'); continue }
    if (!isUnlinkedDonor.has(x)) { fail(h, 'This LGL record is no longer a donor.'); continue }
    const lastGiftDate = donorInfo.get(byId.get(x).id).lastGiftDate
    if (r.kind === 'link' && pid !== null) {
      const p = personById.get(pid)
      if (!p) { fail(h, 'The VG person chosen for this donor no longer exists.'); continue }
      if (p.donor) { fail(h, `${personName(p)} is already linked to another LGL donor.`); continue }
      if (chosen.get(pid) > 1) { fail(h, `${personName(p)} was chosen for two LGL donors; choose again.`); continue }
      resolutionLinks.add(pid)
      links.push({ personId: pid, constituentId: x, lastGiftDate, fingerprint: unlinkedFingerprint('link', [pid], lastGiftDate), hold: h })
      decisions.push({ kind: 'unlinked', constituentId: x, personId: pid, action: 'link', outcome: 'write-vg', note: 'resolution' })
      counts.resolution.link++
    } else if (r.kind === 'create') {
      creates.push({ constituentId: x, lastGiftDate, fingerprint: unlinkedFingerprint('create', [], lastGiftDate), ...createBody(byId.get(x)), hold: h })
      decisions.push({ kind: 'unlinked', constituentId: x, action: 'create', outcome: 'write-vg', note: 'resolution' })
      counts.resolution.create++
    } else fail(h, 'The answer recorded for this donor could not be read.')
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
      if (resolvedBy.has(x)) continue // decided above
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
    if (r.outcome === 'link' && resolutionLinks.has(String(r.personId))) {
      const candidates = [String(r.personId)]
      desired.push({ lglConstituentId: x, personId: null, field: null, reason: 'already-linked-elsewhere', fingerprint: unlinkedFingerprint('already-linked-elsewhere', candidates, lastGiftDate), detail: { candidates, lastGiftDate } })
      holdDecision({ constituentId: x, action: 'hold' }, 'already-linked-elsewhere')
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

  // Every hold on an unlinked donor says who the donor is.
  for (const d of desired) {
    const c = d.personId == null ? byId.get(String(d.lglConstituentId)) : null
    if (c) d.detail = { ...(d.detail ?? {}), lgl: lglDetail(c, donorInfo.get(c.id)?.lastGiftDate) }
  }

  return { decisions, links, follows, unlinks, creates, finishes, holds: desired, close, counts }
}

// The holds a plan closes when every write it carries succeeds: its failed and finished
// resolutions, and the resolved holds its links and creates carry.
export const closesOf = (u) => [...(u.close ?? []), ...[...u.links, ...u.creates].filter((w) => w.hold).map((w) => w.hold)]

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
