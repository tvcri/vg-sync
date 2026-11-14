// Matching of unlinked LGL donors to VG people: link, create, or hold.
// Ported 2026-11-11: normalizing and indexes from vg-utils/lgl-import/count.js (lines 41-64);
// nearDuplicates test and its helpers from vg-utils/lgl-import/src/suggest.js (lines 55-91).
// When in doubt the rule is hold: a wrong link or a duplicate person must never happen.

const norm = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[.,']/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
const firstNames = (first, nick) => {
  const f = first ?? ''
  const paren = f.match(/\(([^)]+)\)/)?.[1]
  const bare = f.replace(/\([^)]*\)/g, ' ')
  return [...new Set([bare, bare.trim().split(/\s+/)[0], paren, nick].filter(Boolean).map(norm).filter(Boolean))]
}
const nameKeys = (first, nick, last) => firstNames(first, nick).map((f) => `${f}|${norm(last)}`)
const emailKey = (s) => (s ?? '').trim().toLowerCase()
const addrKey = (street, zip) => {
  const num = norm(street).match(/^\d+/)?.[0]
  const z = (zip ?? '').trim().slice(0, 5)
  return num && z ? `${num}|${z}` : null
}
const lglPreferredAddress = (c) => {
  const a = (c.street_addresses ?? []).filter((x) => !x.not_current)
  return a.find((x) => x.is_preferred) ?? a[0] ?? null
}
const isCoupleRecord = (c) => / (and|&) /i.test(` ${c.first_name ?? ''} `) || / (and|&) /i.test(c.last_name ?? '')

// --- near-duplicate test (suggest.js) ---
const looseNorm = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,'()-]/g, ' ').replace(/\s+/g, ' ').trim()
const NICK = [
  ['richard', 'rick', 'dick', 'rich'], ['edward', 'ted', 'ed', 'eddie'], ['margaret', 'peg', 'peggy', 'maggie', 'meg'],
  ['elizabeth', 'betsy', 'beth', 'liz', 'betty'], ['john', 'jack'], ['joseph', 'joe'], ['judith', 'judy', 'judie'],
  ['kathleen', 'kathy', 'kate'], ['kathryn', 'kathy', 'kate'], ['katherine', 'kathy', 'kate'], ['thomas', 'tom'],
  ['kenneth', 'ken'], ['christine', 'chris'], ['steven', 'steve'], ['stephen', 'steve'], ['stephanie', 'stevie'],
  ['deborah', 'deb', 'debbie'], ['debra', 'deb', 'debbie'], ['robert', 'bob', 'rob'], ['william', 'bill'],
  ['joshua', 'josh'], ['patricia', 'pat'], ['susan', 'sue'],
]
const nickPair = (a, b) => NICK.some((g) => g.includes(a) && g.includes(b))
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}
const firstWord = (s) => looseNorm(s).split(' ')[0] ?? ''
const sameFirst = (a, b) => {
  const x = firstWord(a), y = firstWord(b)
  if (!x || !y) return false
  return x === y || nickPair(x, y) || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))) ||
    (Math.min(x.length, y.length) >= 4 && lev(x, y) <= 1)
}

const hold = (constituentId, reason) => ({ constituentId, outcome: 'hold', reason })

function horizonCutoff(today, horizonYears) {
  const [y, m, d] = today.split('-').map(Number)
  const day = m === 2 && d === 29 ? 28 : d
  return `${String(y - horizonYears).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function indexPersons(persons) {
  const byEmail = new Map(), byName = new Map(), list = []
  const add = (m, k, p) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(p) }
  for (const p of persons) {
    const d = p.detail ?? {}
    const info = { person: p, last: norm(d.lastName), addr: addrKey(d.street, d.zip) }
    list.push(info)
    const e = emailKey(p.email)
    if (e) add(byEmail, e, info)
    for (const k of nameKeys(d.firstName, d.nickname, d.lastName)) add(byName, k, info)
  }
  return { byEmail, byName, list }
}

const union = (sets) => new Set(sets.flatMap((s) => (s ? [...s] : [])))

export function matchUnlinked(donors, persons, { today, horizonYears }) {
  const idx = indexPersons(persons)
  const cutoff = horizonCutoff(today, horizonYears)
  const info = new Map() // constituentId -> facts used by the second pass
  const decisions = donors.map(({ constituent: c, lastGiftDate }) => {
    const id = c.id
    const last = norm(c.last_name)
    const addr = lglPreferredAddress(c)
    const zip = (addr?.zip5 || addr?.postal_code) ?? ''
    const emails = (c.email_addresses ?? []).filter((e) => !e.not_current).map((e) => emailKey(e.address)).filter(Boolean)
    info.set(id, { c, zip5: zip.trim().slice(0, 5), emails })

    if (/\banonymous\b/i.test(c.first_name ?? '') || /\banonymous\b/i.test(c.last_name ?? '')) return hold(id, 'anonymous')
    if (c.is_deceased) return hold(id, 'deceased-in-lgl')
    if (isCoupleRecord(c)) return hold(id, 'couple-name')

    if (!last) return hold(id, 'no-last-name')

    const E = union(emails.map((e) => idx.byEmail.get(e)))
    const N = union(nameKeys(c.first_name, c.nick_name, c.last_name).map((k) => idx.byName.get(k)))
    const EN = [...E].filter((p) => N.has(p))
    if (EN.length === 1) {
      const p = EN[0].person
      if (p.donor && String(p.donor.lglConstituentId) !== String(id)) return hold(id, 'already-linked-elsewhere')
      return { constituentId: id, outcome: 'link', reason: 'email-and-name', personId: p.personId }
    }
    if (EN.length > 1) return hold(id, 'multiple-matches')
    if (E.size) return hold(id, 'shared-email-different-name')
    if (N.size) return hold(id, 'name-only')
    const key = addrKey(addr?.street, zip)
    if (key && last && idx.list.some((p) => p.last === last && p.addr === key)) return hold(id, 'same-address-last-name')
    if (!lastGiftDate || lastGiftDate < cutoff) return hold(id, 'before-horizon')
    return { constituentId: id, outcome: 'create', reason: 'new' }
  })

  // Pass 1: two links to one person.
  const linkCount = new Map()
  for (const d of decisions) if (d.outcome === 'link') linkCount.set(d.personId, (linkCount.get(d.personId) ?? 0) + 1)
  let out = decisions.map((d) => (d.outcome === 'link' && linkCount.get(d.personId) > 1 ? hold(d.constituentId, 'duplicate-in-lgl') : d))

  // Pass 2: new donors that look like another donor entered twice (whatever that donor's own decision).
  const all = donors.map(({ constituent: c }) => info.get(c.id))
  const dup = new Set()
  const nameOf = (x) => `${norm(x.c.first_name)}|${norm(x.c.last_name)}`
  const looksAlike = (a, b) => {
    if (nameOf(a) === nameOf(b)) return true
    const la = looseNorm(a.c.last_name).replace(/ /g, ''), lb = looseNorm(b.c.last_name).replace(/ /g, '')
    if (la && lb && lev(la, lb) <= 1 && sameFirst(a.c.first_name, b.c.first_name)) {
      const sharedEmail = a.emails.some((e) => b.emails.includes(e))
      return Boolean((a.zip5 && a.zip5 === b.zip5) || sharedEmail)
    }
    return false
  }
  for (const d of out) {
    if (d.outcome !== 'create') continue
    const a = info.get(d.constituentId)
    if (all.some((b) => b !== a && looksAlike(a, b))) dup.add(d.constituentId)
  }
  return out.map((d) => (dup.has(d.constituentId) ? hold(d.constituentId, 'duplicate-in-lgl') : d))
}
