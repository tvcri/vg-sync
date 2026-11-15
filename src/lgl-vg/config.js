// Reads the service configuration from environment variables and validates it.

const REQUIRED = [
  'LGL_API_KEY',
  'LGL_MEMBERSHIP_FUND_ID',
  'LGL_PAYPAL_PAYMENT_TYPE_ID',
  'VG_API_URL',
  'VG_OIDC_URL',
  'VG_CLIENT_ID',
  'VG_CLIENT_SECRET',
]

function present(v) {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function toId(name, value) {
  const s = String(value).trim()
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be a whole number, got "${s}"`)
  return Number(s)
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

function toClock(env, name, fallback) {
  if (!present(env[name])) return fallback
  const s = String(env[name]).trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${name} must be HH:MM (24-hour, UTC), got "${s}"`)
  return s
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !present(env[k]))
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`)

  const horizon = present(env.CREATE_HORIZON_YEARS) ? String(env.CREATE_HORIZON_YEARS).trim() : '5'
  if (!/^\d+$/.test(horizon)) throw new Error(`CREATE_HORIZON_YEARS must be a whole number, got "${horizon}"`)

  return {
    lgl: {
      apiKey: String(env.LGL_API_KEY).trim(),
      membershipFundId: toId('LGL_MEMBERSHIP_FUND_ID', env.LGL_MEMBERSHIP_FUND_ID),
      paypalPaymentTypeId: toId('LGL_PAYPAL_PAYMENT_TYPE_ID', env.LGL_PAYPAL_PAYMENT_TYPE_ID),
    },
    vg: {
      apiUrl: toUrl('VG_API_URL', env.VG_API_URL),
      oidcUrl: toUrl('VG_OIDC_URL', env.VG_OIDC_URL),
      clientId: String(env.VG_CLIENT_ID).trim(),
      clientSecret: String(env.VG_CLIENT_SECRET).trim(),
      scope: present(env.VG_SCOPE) ? String(env.VG_SCOPE).trim() : 'vg',
    },
    createHorizonYears: Number(horizon),
    circuitBreakerPeople: toCount(env, 'CIRCUIT_BREAKER_PEOPLE', 50),
    maxConstituentDropPercent: toCount(env, 'MAX_CONSTITUENT_DROP_PERCENT', 10),
    policyFile: present(env.POLICY_FILE) ? String(env.POLICY_FILE).trim() : 'policy.json',
    writeVg: String(env.WRITE_VG ?? '').trim() === 'true',
    fullPassUtc: toClock(env, 'FULL_PASS_UTC', '07:00'),
    outDir: present(env.OUT_DIR) ? String(env.OUT_DIR).trim() : 'out',
    decisionsKeepDays: toPositive(env, 'DECISIONS_KEEP_DAYS', 30),
    passTimeoutMinutes: toPositive(env, 'PASS_TIMEOUT_MINUTES', 30),
    imageRevision: present(env.IMAGE_REVISION) ? String(env.IMAGE_REVISION).trim() : null,
  }
}
