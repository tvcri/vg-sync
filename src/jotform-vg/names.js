// Name keys and the name test: does a typed name refer to a VG person? Fixed rules, no AI. Pure.
import { NICKNAMES } from './nicknames.js'

export { NICKNAMES }

// Lowercase letters only, accents folded, every run of anything else one space. Combining marks are
// stripped from every script; accepted because the membership's names are Latin-script and the effect
// elsewhere is a rare over-match.
// VG's name_key column holds 200 characters; capping here keeps matching, remembered keys and holds in step.
const KEY_MAX = 200

export function nameKey (s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .slice(0, KEY_MAX)
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

// Two first-name keys agree when equal or in a shared NICKNAMES group. When exactly one of them is
// several words, its first word is also tried, so 'mary' fits 'mary kate' but 'mary ellen' does not.
function namesAgree (t, p) {
  if (keysAgree(t, p)) return true
  const tw = firstWord(t)
  const pw = firstWord(p)
  if (tw !== t && pw === p) return keysAgree(tw, p)
  if (pw !== p && tw === t) return keysAgree(t, pw)
  return false
}

// typedFirstName is any string; it is turned into a key here. The person's first name and nickname
// (null, empty or several words) are each tried.
export function firstNamesAgree (typedFirstName, person) {
  const typed = nameKey(typedFirstName)
  if (!typed) return false
  return [person?.firstName, person?.nickname]
    .map(nameKey)
    .some((p) => p && namesAgree(typed, p))
}

// The last-name key without one trailing generational suffix (kept apart), unless it is the whole key.
function lastParts (s) {
  const words = nameKey(s).split(' ').filter(Boolean)
  let suffix = ''
  if (words.length > 1 && SUFFIXES.has(words[words.length - 1])) suffix = words.pop()
  return { key: words.join(' '), suffix }
}

// Equal keys; suffixes must agree only when both sides carry one ('Doe Jr' fits 'Doe', not 'Doe Sr').
function lastsAgree (a, b) {
  return a.key !== '' && a.key === b.key && (!a.suffix || !b.suffix || a.suffix === b.suffix)
}

export function nameMatches (typed, person) {
  const personLast = lastParts(person?.lastName)
  if (lastsAgree(lastParts(typed?.last), personLast) && firstNamesAgree(typed?.first, person)) return true
  return lastsAgree(lastParts(typed?.first), personLast) && firstNamesAgree(typed?.last, person)
}
