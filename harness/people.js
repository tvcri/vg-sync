// Builds a scenario's starting records from one invented person, so the two
// systems start agreeing on everything the scenario is not about. Not a scenario
// file: harness/scenarios/ holds only scenario lists.
//
//   agreeing({ first: 'Jane', last: 'Doe', street: '12 Quill Lane', ... })
//     -> { vg: { firstName, lastName, ... }, lgl: { first_name, last_name, street_addresses, ... } }
//
// A key left out (or null) is empty on both sides. `vg` and `lgl` overrides are
// merged on top, so a scenario can start the two disagreeing in one field.

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))

export function vgPerson (p) {
  return clean({
    firstName: p.first, lastName: p.last, nickname: p.nick, suffix: p.suffix,
    street: p.street, unit: p.unit, city: p.city, state: p.state, zip: p.zip,
    email: p.email, phone: p.phone, cell: p.cell,
  })
}

export function lglConstituent (p) {
  const phones = []
  if (p.phone) phones.push({ number: p.phone, type: 'Home' })
  if (p.cell) phones.push({ number: p.cell, type: 'Mobile' })
  return clean({
    first_name: p.first, last_name: p.last, nick_name: p.nick, suffix: p.suffix,
    street_addresses: p.street ? [clean({ street: p.street, city: p.city, state: p.state, postal_code: p.zip })] : undefined,
    email_addresses: p.email ? [{ address: p.email }] : undefined,
    phone_numbers: phones.length ? phones : undefined,
  })
}

export function agreeing (p, { vg = {}, lgl = {} } = {}) {
  return { vg: { ...vgPerson(p), ...vg }, lgl: { ...lglConstituent(p), ...lgl } }
}

// VG's side of an address, for expect: { street, unit, city, state, zip }.
export const address = (p) => ({ street: p.street, unit: p.unit ?? null, city: p.city, state: p.state, zip: p.zip })

// The ordinary gift every donor scenario starts with; VG's donor row is seeded with its date.
export const GIFT = { date: '-60d', amount: 50 }
