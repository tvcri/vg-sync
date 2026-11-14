// Cleaning of LGL values. Ported from lgl-import/src/person.js, 2026-11-11.

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

// Unit designators, after USPS Pub 28 Appendix C2. The trailing-unit and
// leading-floor patterns are ported from address-standardize/src/lib.js
// (branch address-standardize, UNIT_IN_STREET and LEADING_FLOOR), 2026-11-09.
const DESIGNATOR = '(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|spc|space|dept|lowr|uppr|ph|bsmt|frnt|rear)'
const UNIT_LINE = new RegExp(`^(?:#\\s*\\w+|${DESIGNATOR}\\.?\\b.*|\\d+(?:st|nd|rd|th)\\s+(?:fl|floor)\\b.*)$`, 'i')
// A unit is a number-bearing token, or a single letter ("Apt B").
const TRAILING_UNIT = new RegExp(`[,\\s]+(#\\s*\\w+|${DESIGNATOR}\\.?\\s+(?:\\w*\\d\\w*|[a-z]))\\s*$`, 'i')
const LEADING_FLOOR = /^\s*(\d+(?:st|nd|rd|th)\s+(?:fl|floor))\b[,\s]*/i

const ORDINAL = '(?:\\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|ground|top)'
const TRAILING_FLOOR = new RegExp(`[,\\s]+(${ORDINAL}\\s+(?:fl|floor))\\.?\\s*$`, 'i')
const PO_BOX = /^(?:p\.?\s*o\.?\s*box|post office box|box)\s+\w+/i
const CARE_OF = /^(?:c\s*\/\s*o|care of)\b/i
const NUMBERED = /^\d/

/** Peel units off one line: "The Towers Apt. 12R" → rest "The Towers", unit "Apt. 12R". */
function peel (line) {
  const units = []
  let rest = line
  const lead = rest.match(LEADING_FLOOR)
  if (lead) { units.push(lead[1]); rest = rest.slice(lead[0].length) }
  if (rest && UNIT_LINE.test(rest)) return { rest: '', units: [...units, rest] }
  for (const re of [TRAILING_UNIT, TRAILING_FLOOR]) {
    const m = rest.match(re)
    if (m) { units.push(m[1]); rest = rest.slice(0, m.index) }
  }
  return { rest: clean(rest).replace(/,$/, ''), units }
}

/**
 * LGL street (may be several lines) → { street, unit, omitted } the way VG
 * stores them: one delivery line plus a unit. VG has no second address line,
 * so when LGL has more than one, the delivery line is kept and the others are
 * returned in `omitted`, for staff to check:
 *   - a "c/o" line, or a line of names or a building name (no number), when
 *     a numbered street or PO box is there;
 *   - a street line when there is also a PO box (the box is kept).
 * Lines with no number at all and nothing better ("Room 5 / City Hall")
 * are kept as they are.
 */
export function splitStreet (raw) {
  const lines = String(raw ?? '').split(/\r?\n/).map(clean).filter(Boolean)
  const units = []
  const rest = []
  for (const l of lines) {
    const p = peel(l)
    units.push(...p.units)
    if (p.rest) rest.push(p.rest)
  }
  if (!rest.length && units.length) rest.push(units.shift()) // a lone "#4" is not a unit of nothing
  const box = rest.filter((l) => PO_BOX.test(l))
  const numbered = rest.filter((l) => NUMBERED.test(l))
  let keep
  if (box.length) keep = box.slice(0, 1)
  else if (numbered.length) keep = numbered
  else keep = rest.filter((l) => !CARE_OF.test(l))
  const dropped = rest.filter((l) => !keep.includes(l))
  return { street: keep.join(', '), unit: units.map(clean).join(' '), omitted: dropped }
}

/** Any LGL phone → VG's 401-555-1212 form; an extension is kept. Not ten digits → null. */
export function formatPhone (p) {
  const raw = clean(p?.number)
  const ext = raw.match(/\s*(?:x|ext\.?)\s*(\d+)\s*$/i)
  let digits = (p?.normalized_number || raw.slice(0, ext ? ext.index : undefined)).replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length !== 10) return null
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}${ext ? ` x${ext[1]}` : ''}`
}


// USPS state and territory codes, and the names LGL sometimes holds instead.
const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'Virgin Islands', GU: 'Guam',
}
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]))
/** "Rhode Island", "ri", "R.I." → "RI"; anything else → null. */
export function stateCode (s) {
  const t = clean(s).replace(/\./g, '')
  if (STATES[t.toUpperCase()] && t.length === 2) return t.toUpperCase()
  return STATE_BY_NAME.get(t.toLowerCase()) ?? null
}

// Only a name typed entirely in one case is "obviously" wrong; mixed case
// (McDonald, DeLuca, van Dyke) is left exactly as LGL has it.
const oneCase = (s) => /[a-z]/i.test(s) && (s === s.toLowerCase() || (s === s.toUpperCase() && s.replace(/[^A-Z]/g, '').length > 1))
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'’])([a-z])/g, (_, a, b) => a + b.toUpperCase())

/** Whitespace collapsed and stray leading/trailing punctuation removed; case untouched. */
export function stripEdges (s) {
  return clean(s).replace(/^[\s,.\-;:]+|[\s,\-;:]+$/g, '')
}

/** A name with stray edge punctuation removed; title-cased only when typed in a single case. */
export function cleanName (s) {
  let v = stripEdges(s)
  if (oneCase(v)) v = titleCase(v)
  return v
}
