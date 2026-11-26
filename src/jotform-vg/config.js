// Reads the JotForm → VG service configuration from environment variables and validates it.

const REQUIRED = [
  'JOTFORM_API_KEY',
  'JOTFORM_FORM_ID',
  'VG_API_URL',
  'VG_OIDC_URL',
  'VG_CLIENT_ID',
  'VG_CLIENT_SECRET',
]

function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function toUrl(name, value) {
  const s = String(value).trim()
  let u
  try {
    u = new URL(s)
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`${name} must be an https URL (http is allowed only for localhost)`)
  }
  return s.replace(/\/+$/, '')
}

function toCount(env, name, fallback) {
  if (!present(env[name])) return fallback
  const s = String(env[name]).trim()
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be a whole number, got "${s}"`)
  return Number(s)
}

function toPositive(env, name, fallback) {
  const n = toCount(env, name, fallback)
  if (n < 1) throw new Error(`${name} must be a positive whole number, got "${n}"`)
  return n
}

function toBounded(env, name, fallback, max) {
  const n = toPositive(env, name, fallback)
  if (n > max) throw new Error(`${name} must be at most ${max}, got "${n}"`)
  return n
}

function toClock(env, name, fallback) {
  if (!present(env[name])) return fallback
  const s = String(env[name]).trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${name} must be HH:MM (24-hour, UTC), got "${s}"`)
  return s
}

export function loadConfig(env = process.env) {
  // With JOTFORM_MOCK (a state file standing in for JotForm) no API key is needed.
  const mock = present(env.JOTFORM_MOCK)
  const missing = REQUIRED.filter((k) => !present(env[k]) && !(k === 'JOTFORM_API_KEY' && mock))
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)

  return {
    jotform: {
      apiKey: present(env.JOTFORM_API_KEY) ? String(env.JOTFORM_API_KEY).trim() : '',
      formId: String(env.JOTFORM_FORM_ID).trim(),
      mock: mock ? String(env.JOTFORM_MOCK).trim() : null,
    },
    vg: {
      apiUrl: toUrl('VG_API_URL', env.VG_API_URL),
      oidcUrl: toUrl('VG_OIDC_URL', env.VG_OIDC_URL),
      clientId: String(env.VG_CLIENT_ID).trim(),
      clientSecret: String(env.VG_CLIENT_SECRET).trim(),
      scope: present(env.VG_SCOPE) ? String(env.VG_SCOPE).trim() : 'vg',
    },
    writeVg: String(env.WRITE_VG ?? '').trim() === 'true',
    changeEveryMinutes: toPositive(env, 'CHANGE_EVERY_MINUTES', 5),
    fullRunUtc: toClock(env, 'FULL_RUN_UTC', '08:00'),
    overlapMinutes: toPositive(env, 'OVERLAP_MINUTES', 120),
    minFullPercent: toBounded(env, 'MIN_FULL_PERCENT', 90, 100),
    dateAheadDays: toCount(env, 'DATE_AHEAD_DAYS', 1),
    dateBehindDays: toCount(env, 'DATE_BEHIND_DAYS', 90),
    // Capped at a day: past about 35,791 minutes Node's timer would fire at once.
    runTimeoutMinutes: toBounded(env, 'RUN_TIMEOUT_MINUTES', 30, 1440),
    imageRevision: present(env.IMAGE_REVISION) ? String(env.IMAGE_REVISION).trim() : null,
  }
}
