import { nameKey, nameMatches } from './names.js'

// Roster rows from VG `GET /persons?projection=detail`. Names live under `detail`, the village under
// `village.villageId`. A role is held when its status is present (Active or Dropped).
export function buildRoster (persons) {
  return persons.map((p) => ({
    personId: String(p.personId),
    firstName: p.detail?.firstName ?? null,
    lastName: p.detail?.lastName ?? null,
    nickname: p.detail?.nickname ?? null,
    email: (p.email ?? '').trim().toLowerCase() || null,
    villageId: p.village?.villageId != null ? String(p.village.villageId) : null,
    isMember: p.memberStatus != null,
    isVolunteer: p.volunteerStatus != null
  }))
}

// An unknown village (null, undefined, 0, '0') is one value.
export function rememberedKey (role, key, villageId) {
  const v = villageId == null || String(villageId) === '0' ? '0' : String(villageId)
  return `${role}|${v}|${key}`
}

export function buildRemembered (nameMatchRows) {
  const map = new Map()
  for (const r of nameMatchRows) {
    map.set(rememberedKey(r.role, r.nameKey, r.villageId), {
      personId: r.personId == null ? null : String(r.personId),
      ignore: Boolean(r.ignore)
    })
  }
  return map
}

const candidatesOf = (people) => [...new Set(people.map((p) => p.personId))].sort()

// Returns { personId, how } | { ignore: true } | { personId: null, candidates }.
// When unsure it holds: a report counted under the wrong person is the worst outcome.
export function matchPerson ({ role, typed, email, villageId }, roster, remembered) {
  const answer = remembered.get(rememberedKey(role, nameKey(typed?.raw), villageId))
  if (answer) {
    if (answer.ignore) return { ignore: true }
    // A person deleted since staff answered is no answer; VG would refuse the write.
    if (answer.personId != null && roster.some((p) => p.personId === answer.personId)) {
      return { personId: answer.personId, how: 'remembered' }
    }
  }

  // Never match on half a name.
  if (!nameKey(typed?.first) || !nameKey(typed?.last)) return { personId: null, candidates: [] }

  const fits = roster.filter((p) => nameMatches(typed, p))

  if (role === 'volunteer') {
    // Only volunteers: an email on a member-only person must not name a volunteer.
    const e = (email ?? '').trim().toLowerCase()
    if (e) {
      const byEmail = fits.filter((p) => p.isVolunteer && p.email === e)
      if (byEmail.length === 1) return { personId: byEmail[0].personId, how: 'email' }
    }
  }

  const holders = fits.filter((p) => (role === 'member' ? p.isMember : p.isVolunteer))

  if (villageId != null && String(villageId) !== '0') {
    const here = holders.filter((p) => p.villageId === String(villageId))
    if (here.length === 1) return { personId: here[0].personId, how: 'name-village' }
    if (here.length > 1) return { personId: null, candidates: candidatesOf(here) }
  }

  if (holders.length === 1) return { personId: holders[0].personId, how: 'name-elsewhere' }
  return { personId: null, candidates: candidatesOf(holders) }
}
