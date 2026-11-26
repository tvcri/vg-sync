// Name keys and the name test: does a typed name refer to a VG person? Fixed rules, no AI. Pure.
import { NICKNAMES } from './nicknames.js'

export { NICKNAMES }

// Lowercase letters only, accents folded, every run of anything else one space.
export function nameKey (s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
}

const GROUPS = new Map() // key -> Set of group indexes
NICKNAMES.forEach((group, i) => {
  for (const k of group) {
    if (!GROUPS.has(k)) GROUPS.set(k, new Set())
    GROUPS.get(k).add(i)
  }
})

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])

const firstWord = (key) => key.split(' ')[0]

function keysAgree (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const ga = GROUPS.get(a)
  const gb = GROUPS.get(b)
  if (!ga || !gb) return false
  for (const g of ga) if (gb.has(g)) return true
  return false
}

// The person's first-name and nickname keys, each also by its first word.
function personKeys (person) {
  const keys = new Set()
  for (const raw of [person?.firstName, person?.nickname]) {
    const k = nameKey(raw)
    if (k) { keys.add(k); keys.add(firstWord(k)) }
  }
  return keys
}

// typedFirstKey is already a nameKey. The whole key is tried first, then its first word.
export function firstNamesAgree (typedFirstKey, person) {
  const typed = nameKey(typedFirstKey)
  if (!typed) return false
  const candidates = [typed]
  if (firstWord(typed) !== typed) candidates.push(firstWord(typed))
  const keys = personKeys(person)
  return candidates.some((t) => [...keys].some((p) => keysAgree(t, p)))
}

// One trailing generational suffix is dropped, unless it is the whole key.
function lastKey (s) {
  const words = nameKey(s).split(' ').filter(Boolean)
  if (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}

export function nameMatches (typed, person) {
  const personLast = lastKey(person?.lastName)
  if (!personLast) return false
  const direct = lastKey(typed?.last) === personLast && firstNamesAgree(nameKey(typed?.first), person)
  if (direct) return true
  return lastKey(typed?.first) === personLast && firstNamesAgree(nameKey(typed?.last), person)
}
