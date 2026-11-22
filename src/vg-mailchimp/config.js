// Reads the VG → Mailchimp service configuration from environment variables and validates it.

const REQUIRED = [
  'MAILCHIMP_API_KEY',
  'MAILCHIMP_LIST_ID',
  'MAILCHIMP_LIST_NAME',
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
  // With MAILCHIMP_MOCK (a state file standing in for Mailchimp) no API key is needed,
  // and the list name comes from that state file, so it is not required either.
  const mock = present(env.MAILCHIMP_MOCK)
  const missing = REQUIRED.filter((k) => !present(env[k]) && !(k === 'MAILCHIMP_API_KEY' && mock) && !(k === 'MAILCHIMP_LIST_NAME' && mock))
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)

  const planLimit = toPositive(env, 'PLAN_LIMIT', 5000)
  const limitMargin = toCount(env, 'LIMIT_MARGIN', 100)
  if (limitMargin >= planLimit) throw new Error(`LIMIT_MARGIN must be below PLAN_LIMIT (${limitMargin} >= ${planLimit})`)

  return {
    mailchimp: {
      apiKey: present(env.MAILCHIMP_API_KEY) ? String(env.MAILCHIMP_API_KEY).trim() : '',
      listId: present(env.MAILCHIMP_LIST_ID) ? String(env.MAILCHIMP_LIST_ID).trim() : '',
      listName: present(env.MAILCHIMP_LIST_NAME) ? String(env.MAILCHIMP_LIST_NAME).trim() : '',
      mock: mock ? String(env.MAILCHIMP_MOCK).trim() : null,
    },
    vg: {
      apiUrl: toUrl('VG_API_URL', env.VG_API_URL),
      oidcUrl: toUrl('VG_OIDC_URL', env.VG_OIDC_URL),
      clientId: String(env.VG_CLIENT_ID).trim(),
      clientSecret: String(env.VG_CLIENT_SECRET).trim(),
      scope: present(env.VG_SCOPE) ? String(env.VG_SCOPE).trim() : 'vg',
    },
    writeAdd: String(env.WRITE_MAILCHIMP_ADD ?? '').trim() === 'true',
    writeArchive: String(env.WRITE_MAILCHIMP_ARCHIVE ?? '').trim() === 'true',
    archiveAfterDays: toPositive(env, 'ARCHIVE_AFTER_DAYS', 30),
    planLimit,
    limitMargin,
    maxAdd: toCount(env, 'MAX_ADD', 50),
    maxArchive: toCount(env, 'MAX_ARCHIVE', 50),
    minCohort: toPositive(env, 'MIN_COHORT', 500),
    runUtc: toClock(env, 'MAILCHIMP_RUN_UTC', '08:00'),
    // Capped at a day: past about 35,791 minutes Node's timer would fire at once.
    runTimeoutMinutes: toBounded(env, 'RUN_TIMEOUT_MINUTES', 30, 1440),
    recordsKeepDays: toPositive(env, 'RECORDS_KEEP_DAYS', 30),
    outDir: present(env.OUT_DIR) ? String(env.OUT_DIR).trim() : 'out',
    imageRevision: present(env.IMAGE_REVISION) ? String(env.IMAGE_REVISION).trim() : null,
  }
}
