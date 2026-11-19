// Turns one LGL write (VG's value for a field) into the LGL API calls that make it LGL's value.
// Pure: no I/O. The plan prints these calls in a dry run; apply sends them in order on a fresh read.
import { lglFields, comparable, hasDefaultNames, isMobile, lglAddress, squash, phoneKey } from './fields.js'

const NAME_KEYS = { firstName: 'first_name', lastName: 'last_name', suffix: 'suffix', nickname: 'nick_name' }
// Only these names make up LGL's default addressee and salutation.
const ADDRESSEE_NAMES = new Set(['firstName', 'lastName', 'suffix'])


function setCall (id, write, constituent, addresseeSetting) {
  const { field, value } = write
  if (field === 'deceased') {
    if (!value?.flag) throw new Error(`LGL write for constituent ${id}: a deceased mark is never removed`)
    return { calls: [{ method: 'PATCH', path: `/constituents/${id}`, body: { is_deceased: true, deceased_date: value.date ?? null }, step: 'set' }], addressee: null }
  }
  // The comparison sets a "(Nick)" part aside, so it is not sent; VG's nickname goes to nick_name.
  const sent = field === 'firstName' && value != null ? squash(String(value).replace(/\([^)]*\)/g, ' ')) : value
  const body = { [NAME_KEYS[field]]: sent }
  let addressee = null
  if (ADDRESSEE_NAMES.has(field) && addresseeSetting === 'if-default') {
    if (hasDefaultNames(constituent)) {
      // An empty addressee and salutation make LGL build them again from the new name.
      body.addressee = ''
      body.salutation = ''
      addressee = 'rebuilt'
    } else addressee = 'left'
  }
  return { calls: [{ method: 'PATCH', path: `/constituents/${id}`, body, step: 'set' }], addressee }
}

const ENTRY = {
  address: {
    kind: 'street_addresses',
    compare: (e) => comparable('address', lglAddress(e)),
    body: (v) => ({ street: v.unit ? `${v.street}\n${v.unit}` : v.street, city: v.city, state: v.state, postal_code: v.zip, street_type_name: 'Home' }),
  },
  email: {
    kind: 'email_addresses',
    compare: (e) => comparable('email', e.address),
    body: (v) => ({ address: v, email_type_name: 'Home' }),
  },
}
const phoneOf = (e) => e.normalized_number || e.number

// The calls that make `value` the entry for one slot: revive a matching entry or add one, then
// retire the entry the sync read for the slot (unless `retire` is false).
function entryCalls ({ id, kind, entries, oldId, matches, body, preferred, retire }) {
  const candidates = entries.filter((e) => e.id !== oldId && matches(e))
  const found = candidates.find((e) => !e.not_current) ?? candidates[0]
  const oldEntryId = retire ? oldId : null
  const calls = [found
    ? { method: 'PATCH', path: `/${kind}/${found.id}`, body: { not_current: false, is_preferred: preferred }, step: 'revive', entryKind: kind, oldEntryId }
    : { method: 'POST', path: `/constituents/${id}/${kind}`, body: { ...body, is_preferred: preferred }, step: 'add', entryKind: kind, oldEntryId }]
  if (oldEntryId != null) calls.push({ method: 'PATCH', path: `/${kind}/${oldEntryId}`, body: { not_current: true }, step: 'retire', entryKind: kind, oldEntryId })
  return calls
}

// LGL's phones are a list of current numbers, of any types. A VG number LGL lacks is added (or a
// matching old entry revived), typed from its VG slot (Phone -> Home, Cell -> Mobile), whatever that
// type already holds. A merge retires nothing; a write retires each current number VG no longer
// has, right after the number that replaces it (one of the same type first). The plan holds a write
// that would retire more than it adds. LGL has one preferred phone: a new number takes the mark
// only from the entry it replaces, or when no current entry kept keeps it.
function phoneCalls (id, write, constituent) {
  const entries = constituent.phone_numbers ?? []
  const current = entries.filter((e) => !e.not_current)
  const keyOf = (e) => phoneKey(phoneOf(e))
  const lglKeys = new Set(current.map(keyOf).filter(Boolean))
  const vgKeys = new Set(['phone', 'cell'].map((s) => phoneKey(write.value?.[s])).filter(Boolean))
  // in the read's order (preferred first, then newest), so a number replaces the one shown in its slot
  // a write retires only numbers in `retirable` when it is given (the agreed ones: LGL's extras stay)
  const olds = write.merge ? [] : current.filter((e) => !vgKeys.has(keyOf(e)) && (!write.retirable || write.retirable.includes(keyOf(e))))
    .sort((a, b) => Number(Boolean(b.is_preferred)) - Number(Boolean(a.is_preferred)) || Number(b.id) - Number(a.id))
  // Each new number, with the old entry it replaces (none in a merge, or once the olds run out).
  const adds = []
  for (const slot of ['phone', 'cell']) {
    const key = phoneKey(write.value?.[slot])
    if (!key || lglKeys.has(key)) continue // VG has no number here (a clear is never written), or LGL has it
    lglKeys.add(key)
    const mobile = slot === 'cell'
    const i = olds.findIndex((e) => isMobile(e) === mobile)
    adds.push({ slot, key, mobile, old: olds.length ? olds.splice(i >= 0 ? i : 0, 1)[0] : null })
  }
  const retired = new Set(adds.map((a) => a.old).filter(Boolean))
  let markHeld = current.some((e) => e.is_preferred && !retired.has(e))
  const calls = []
  for (const { slot, key, mobile, old } of adds) {
    const preferred = Boolean(old?.is_preferred) || !markHeld
    if (preferred) markHeld = true
    calls.push(...entryCalls({
      id, kind: 'phone_numbers', entries, oldId: old?.id ?? null,
      matches: (e) => isMobile(e) === mobile && keyOf(e) === key,
      body: { number: write.value[slot], phone_type_name: mobile ? 'Mobile' : 'Home' },
      preferred,
      retire: old != null,
    }))
  }
  return calls
}

export function buildLglCalls (write, constituent, { addresseeSetting }) {
  const id = write.constituentId
  if (id == null || id === '') throw new Error(`LGL write for field "${write.field}" has no constituentId`)
  const { field, value } = write
  if (NAME_KEYS[field] || field === 'deceased') return setCall(id, write, constituent, addresseeSetting)
  const read = lglFields(constituent)
  if (field === 'phones') return { calls: phoneCalls(id, write, constituent), addressee: null }
  const spec = ENTRY[field]
  if (!spec) throw new Error(`LGL write for constituent ${id}: unknown field "${field}"`)
  const target = comparable(field, value)
  const calls = entryCalls({
    id, kind: spec.kind, entries: constituent[spec.kind] ?? [], oldId: read.entryIds[field],
    matches: (e) => spec.compare(e) === target,
    body: spec.body(value),
    preferred: true,
    retire: !write.merge,
  })
  return { calls, addressee: null }
}

// The decisions-file form of a call: LGL PATCH /street_addresses/12 {"not_current":true}
export function formatCall (call) {
  return `LGL ${call.method} ${call.path} ${JSON.stringify(call.body)}`
}
