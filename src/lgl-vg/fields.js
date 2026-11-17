// Reduces an LGL constituent and a VG person to the same eight field values,
// and gives each value a comparable form for deciding whether two are the same.
import { splitStreet, stateCode, formatPhone, cleanName, stripEdges } from './clean.js'

export const FIELDS = ['firstName', 'lastName', 'suffix', 'nickname', 'address', 'email', 'phones', 'deceased']

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const ZIP = /^\d{5}(-?\d{4})?$/
const nul = (s) => (s == null || String(s).trim() === '' ? null : s)
export const isMobile = (p) => /mobile|cell/i.test(p.phone_type_name ?? '')

// Picks the entry to use from a list: the preferred current one, or the only current one.
function pick (list) {
  const current = (list ?? []).filter((x) => !x.not_current)
  if (!current.length) return { entry: null }
  const preferred = current.filter((x) => x.is_preferred)
  if (preferred.length > 1) return { ambiguous: true }
  if (preferred.length === 1) return { entry: preferred[0] }
  if (current.length === 1) return { entry: current[0] }
  return { ambiguous: true }
}

export function lglAddress (a) {
  const { street, unit } = splitStreet(a.street)
  const city = cleanName(a.city)
  const state = stateCode(a.state)
  const zipRaw = String(a.zip5 || a.postal_code || '').trim()
  if (!street || !city || /\d/.test(city) || !state || !ZIP.test(zipRaw)) return null
  return { street, unit: nul(unit), city, state, zip: zipRaw.replace(/\D/g, '').slice(0, 5) }
}

export function lglFields (c) {
  const values = {
    firstName: nul(cleanName(c.first_name)),
    lastName: nul(cleanName(c.last_name)),
    suffix: nul(stripEdges(c.suffix)),
    nickname: nul(cleanName(c.nick_name)),
    address: null,
    email: null,
    phones: null,
    deceased: { flag: Boolean(c.is_deceased), date: nul(c.deceased_date) },
  }
  const entryIds = { address: null, email: null, phone: null, cell: null }
  const problems = {}
  // LGL's value as stored, for a field that failed cleaning: shown in the hold and fingerprinted,
  // so a change from one malformed value to another is seen.
  const raw = {}
  const slots = { phone: null, cell: null }
  const rawSlots = { phone: null, cell: null }
  const slotProblems = []

  const lists = [
    ['address', c.street_addresses, lglAddress, (a) => ({ street: a.street ?? null, city: a.city ?? null, state: a.state ?? null, zip: a.zip5 || a.postal_code || null })],
    ['email', c.email_addresses, (e) => { const v = String(e.address ?? '').trim(); return EMAIL.test(v) ? v : null }, (e) => e.address ?? null],
    ['phone', (c.phone_numbers ?? []).filter((p) => !isMobile(p)), formatPhone, (p) => p.number ?? null],
    ['cell', (c.phone_numbers ?? []).filter(isMobile), formatPhone, (p) => p.number ?? null],
  ]
  for (const [field, list, convert, rawOf] of lists) {
    const { entry, ambiguous } = pick(list)
    const slot = field === 'phone' || field === 'cell'
    const fail = (kind) => { if (slot) slotProblems.push(kind); else problems[field] = kind }
    if (ambiguous) { fail('ambiguous'); continue }
    if (!entry) continue
    // The entry the sync read, clean or not: a write that repairs it retires this entry.
    entryIds[field] = entry.id
    const v = convert(entry)
    if (slot) rawSlots[field] = rawOf(entry)
    if (v == null) { fail('unclean'); if (!slot) raw[field] = rawOf(entry); continue }
    if (slot) slots[field] = v
    else values[field] = v
  }
  if (slotProblems.length) {
    problems.phones = slotProblems.includes('ambiguous') ? 'ambiguous' : 'unclean'
    if (problems.phones === 'unclean') raw.phones = rawSlots
  } else values.phones = slots
  return { values, entryIds, problems, raw }
}

export function vgFields (p) {
  const d = p.detail ?? {}
  const street = nul(d.street)
  return {
    firstName: nul(d.firstName),
    lastName: nul(d.lastName),
    suffix: nul(d.suffix),
    nickname: nul(d.nickname),
    address: street ? { street, unit: nul(d.unit), city: nul(d.city), state: nul(d.state), zip: nul(d.zip) } : null,
    email: nul(p.email),
    phones: { phone: nul(p.phone?.phone), cell: nul(p.phone?.cell) },
    deceased: { flag: Boolean(p.deceased), date: d.deceasedDate ?? null },
  }
}

const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/-/g, ' ').replace(/[.,'()]/g, '').replace(/\s+/g, ' ').trim()

// USPS Publication 28, Appendix C1: primary street suffix name -> standard abbreviation.
export const STREET_SUFFIXES = {
  alley: 'aly', annex: 'anx', arcade: 'arc', avenue: 'ave', bayou: 'byu', beach: 'bch', bend: 'bnd', bluff: 'blf',
  bottom: 'btm', boulevard: 'blvd', branch: 'br', bridge: 'brg', brook: 'brk', bypass: 'byp', camp: 'cp',
  canyon: 'cyn', cape: 'cpe', causeway: 'cswy', center: 'ctr', centre: 'ctr', circle: 'cir', cliff: 'clf',
  club: 'clb', common: 'cmn', corner: 'cor', course: 'crse', court: 'ct', cove: 'cv', creek: 'crk',
  crescent: 'cres', crossing: 'xing', crossroad: 'xrd', curve: 'curv', dale: 'dl', dam: 'dm', divide: 'dv',
  drive: 'dr', estate: 'est', estates: 'ests', expressway: 'expy', extension: 'ext', fall: 'fall', falls: 'fls',
  ferry: 'fry', field: 'fld', fields: 'flds', flat: 'flt', ford: 'frd', forest: 'frst', forge: 'frg',
  fork: 'frk', fort: 'ft', freeway: 'fwy', garden: 'gdn', gardens: 'gdns', gateway: 'gtwy', glen: 'gln',
  green: 'grn', grove: 'grv', harbor: 'hbr', haven: 'hvn', heights: 'hts', highway: 'hwy', hill: 'hl',
  hills: 'hls', hollow: 'holw', inlet: 'inlt', island: 'is', islands: 'iss', isle: 'isle', junction: 'jct',
  key: 'ky', knoll: 'knl', lake: 'lk', lakes: 'lks', land: 'land', landing: 'lndg', lane: 'ln', light: 'lgt',
  loaf: 'lf', lock: 'lck', lodge: 'ldg', loop: 'loop', mall: 'mall', manor: 'mnr', meadow: 'mdw',
  meadows: 'mdws', mill: 'ml', mills: 'mls', mission: 'msn', motorway: 'mtwy', mount: 'mt', mountain: 'mtn',
  neck: 'nck', orchard: 'orch', oval: 'oval', overpass: 'opas', park: 'park', parkway: 'pkwy', pass: 'pass',
  passage: 'psge', path: 'path', pike: 'pike', pine: 'pne', pines: 'pnes', place: 'pl', plain: 'pln',
  plains: 'plns', plaza: 'plz', point: 'pt', port: 'prt', prairie: 'pr', radial: 'radl', ramp: 'ramp',
  ranch: 'rnch', rapid: 'rpd', rapids: 'rpds', rest: 'rst', ridge: 'rdg', river: 'riv', road: 'rd',
  route: 'rte', row: 'row', run: 'run', shoal: 'shl', shore: 'shr', shores: 'shrs', skyway: 'skwy',
  spring: 'spg', springs: 'spgs', spur: 'spur', square: 'sq', station: 'sta', stravenue: 'stra',
  stream: 'strm', street: 'st', summit: 'smt', terrace: 'ter', throughway: 'trwy', trace: 'trce',
  track: 'trak', trail: 'trl', trailer: 'trlr', tunnel: 'tunl', turnpike: 'tpke', underpass: 'upas',
  union: 'un', valley: 'vly', viaduct: 'via', view: 'vw', village: 'vlg', ville: 'vl', vista: 'vis',
  walk: 'walk', way: 'way', well: 'wl', wharf: 'whrf',
}
const DIRECTIONS = {
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
}
const ORDINALS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th',
  seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th', eleventh: '11th', twelfth: '12th',
}
// USPS Publication 28, Appendix C2: secondary unit designators, abbreviated and spelled out.
const UNIT_WORDS = new Set([
  'apt', 'apartment', 'bldg', 'building', 'dept', 'department', 'fl', 'floor', 'frnt', 'front',
  'hngr', 'hangar', 'key', 'lbby', 'lobby', 'lot', 'lowr', 'lower', 'ofc', 'office', 'ph', 'penthouse',
  'pier', 'rear', 'rm', 'room', 'side', 'slip', 'spc', 'space', 'stop', 'ste', 'suite', 'trlr', 'trailer',
  'unit', 'uppr', 'upper',
])

// A unit word is dropped only when a unit designator follows: a token with a digit, or a single letter.
const isDesignator = (w) => w != null && (/\d/.test(w) || /^[a-z]$/.test(w))

// Address text reduced to letters and digits: unit words dropped, standard words, spacing removed
// (bar a split between digits, and a boundary after a leading house number).
function addressText (text, { suffixes, houseNumber }) {
  const words = norm(String(text ?? '').replace(/#/g, ' ')).split(' ').filter(Boolean)
  const kept = words.filter((w, i) => !(UNIT_WORDS.has(w) && isDesignator(words[i + 1])))
    .map((w) => (suffixes ? STREET_SUFFIXES[w] : undefined) ?? DIRECTIONS[w] ?? ORDINALS[w] ?? w)
  const lead = houseNumber && /^\d/.test(kept[0] ?? '') ? kept.shift() + '|' : ''
  return lead + kept.join(' ').replace(/(?<!\d) | (?!\d)/g, '') // "12-14" is not "1214"
}

const phoneDigits = (v) => String(v ?? '').replace(/\s*(?:x|ext\.?)\s*\d+\s*$/i, '').replace(/\D/g, '').slice(-10)

export function comparable (field, value) {
  if (value == null || value === '') return ''
  switch (field) {
    case 'firstName': return norm(String(value).replace(/\([^)]*\)/g, ' '))
    case 'email': return String(value).trim().toLowerCase()
    case 'phones': return [...new Set([value.phone, value.cell].map(phoneDigits).filter(Boolean))].sort().join(',')
    case 'deceased': return value.flag ? `1|${value.date ?? ''}` : '0'
    case 'address': {
      const streetUnit = addressText(`${value.street ?? ''} ${value.unit ?? ''}`, { suffixes: true, houseNumber: true })
      // a state name and its code are the same state: LGL is sent the code
      return [streetUnit, addressText(value.city, { suffixes: false }), norm(stateCode(value.state) ?? value.state), norm(value.zip).slice(0, 5)].join('|')
    }
    default: return norm(value)
  }
}

// The PATCH /persons/{id} properties for one field's LGL value (the town is added by apply.js).
export function vgPatch (field, value) {
  switch (field) {
    case 'phones': return { phone: value.phone, cell: value.cell }
    case 'deceased': return { deceased: value.flag, deceasedDate: value.flag ? value.date : null }
    case 'address': return { street: value.street, unit: value.unit, city: value.city, state: value.state, zip: value.zip }
    default: return { [field]: value }
  }
}

// Keeps VG's phone slots and fills empty ones with LGL numbers VG lacks.
export function mergePhones (lgl, vg) {
  const value = { phone: vg.phone ?? null, cell: vg.cell ?? null }
  const have = new Set([vg.phone, vg.cell].map(phoneDigits).filter(Boolean))
  const lglHas = new Set([lgl.phone, lgl.cell].map(phoneDigits).filter(Boolean))
  let placed = 0
  const unplaced = []
  for (const label of ['phone', 'cell']) {
    const number = lgl[label]
    const d = phoneDigits(number)
    if (!d || have.has(d)) continue
    const other = label === 'phone' ? 'cell' : 'phone'
    const slot = [label, other].find((s) => value[s] == null)
    if (slot) { value[slot] = number; have.add(d); placed++ } else unplaced.push(number)
  }
  const vgOnly = [vg.phone, vg.cell].filter((n) => phoneDigits(n) && !lglHas.has(phoneDigits(n)))
  return { value, placed, unplaced, vgOnly }
}

// False when VG's first name carries a parenthesized nickname the LGL first name lacks.
export function keepsNickname (lglFirst, vgFirst) {
  const parts = (s) => [...String(s ?? '').matchAll(/\(([^)]*)\)/g)].map((m) => norm(m[1]))
  const lglParts = parts(lglFirst)
  return parts(vgFirst).every((p) => lglParts.includes(p))
}

const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

// The addressee and salutation LGL fills in itself for a constituent's current name (trial-account behaviour):
// prefix, first, last and suffix (trailing period dropped); middle name and nickname are ignored.
export function lglDefaultNames (c) {
  const suffix = String(c.suffix ?? '').trim().replace(/\.+$/, '')
  const addressee = squash([c.prefix, c.first_name, c.last_name, suffix].filter((p) => p && String(p).trim()).join(' '))
  return { addressee, salutation: squash(c.first_name) }
}

// True when LGL's addressee and salutation are still its defaults for the current name.
export function hasDefaultNames (c) {
  const d = lglDefaultNames(c)
  return squash(c.addressee) === d.addressee && squash(c.salutation) === d.salutation
}

// LGL's value for `field` as a stale check compares it: the comparable form, or for a value that
// failed cleaning (whose comparable form is '') the value as LGL stored it, so an edit from one
// unclean value to another, or of a clean phone slot beside an unclean one, is seen. `read` is
// lglFields' result; the plan and apply-lgl.js both use this, so both sides compute it alike.
export const lglExpect = (read, field) => (read.problems[field] === 'unclean'
  ? `unclean:${JSON.stringify(read.raw[field])}`
  : comparable(field, read.values[field]))
