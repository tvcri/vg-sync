// Turns one LGL write (VG's value for a field) into the LGL API calls that make it LGL's value.
// Pure: no I/O. The plan prints these calls in a dry run; apply sends them in order on a fresh read.
import { lglFields, comparable, hasDefaultNames, isMobile, lglAddress } from './fields.js'

const NAME_KEYS = { firstName: 'first_name', lastName: 'last_name', suffix: 'suffix', nickname: 'nick_name' }
// Only these names make up LGL's default addressee and salutation.
const ADDRESSEE_NAMES = new Set(['firstName', 'lastName', 'suffix'])

const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

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
const phoneKey = (n) => comparable('phones', { phone: n })
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

function phoneCalls (id, write, constituent, read) {
  const entries = constituent.phone_numbers ?? []
  const lglSlots = read.values.phones ?? { phone: null, cell: null }
  const lglNumbers = new Set([lglSlots.phone, lglSlots.cell].map(phoneKey).filter(Boolean))
  // LGL has one preferred phone per constituent; a write never moves the mark to the other type group.
  let markHeld = entries.some((e) => !e.not_current && e.is_preferred)
  const calls = []
  for (const slot of ['phone', 'cell']) {
    const key = phoneKey(write.value?.[slot])
    if (!key) continue // VG has no number here: clearing a slot is never a write
    if (write.merge ? lglNumbers.has(key) : key === phoneKey(lglSlots[slot])) continue
    const oldId = write.merge ? null : read.entryIds[slot]
    const old = entries.find((e) => e.id === oldId)
    const preferred = Boolean(old?.is_preferred) || !markHeld
    if (preferred) markHeld = true
    const mobile = slot === 'cell'
    calls.push(...entryCalls({
      id, kind: 'phone_numbers', entries, oldId,
      matches: (e) => isMobile(e) === mobile && phoneKey(phoneOf(e)) === key,
      body: { number: write.value[slot], phone_type_name: mobile ? 'Mobile' : 'Home' },
      preferred,
      retire: !write.merge,
    }))
  }
  return calls
}

export function buildLglCalls (write, constituent, { addresseeSetting }) {
  const id = write.constituentId ?? constituent.id
  const { field, value } = write
  if (NAME_KEYS[field] || field === 'deceased') return setCall(id, write, constituent, addresseeSetting)
  const read = lglFields(constituent)
  if (field === 'phones') return { calls: phoneCalls(id, write, constituent, read), addressee: null }
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
