// Licence storage, backed by Supabase over its REST (PostgREST) interface.
//
// Deliberately uses plain fetch instead of @supabase/supabase-js: the serverless
// functions then have ZERO dependencies, which is what lets vercel.json skip the install
// step entirely. Adding a dependency here means restoring that install command.
//
// Env (set these in Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL                 https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    service_role key — server-side only, NEVER in the client
//
// Schema lives in supabase/schema.sql. Run it once in the Supabase SQL editor.

const TABLE = 'licenses'

/** @returns {{url: string, key: string}} */
function config() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    // Fail loudly. A misconfigured store must never look like "no such licence",
    // because that is indistinguishable from a valid key being rejected.
    throw new Error('licence store is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  return { url: url.replace(/\/+$/, ''), key }
}

export function isStoreConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * @param {string} path   PostgREST path + query, e.g. "?license_key=eq.HC-PRO-..."
 * @param {RequestInit & {prefer?: string}} [init]
 */
async function request(path, init = {}) {
  const { url, key } = config()
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(init.prefer ? { Prefer: init.prefer } : {}),
  }
  const res = await fetch(`${url}/rest/v1/${TABLE}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// Column names follow supabase/schema.sql, which predates this code: seats are
// `max_committers`, and the status vocabulary is active | suspended | canceled (one L).
// Razorpay's events map on: cancelled -> canceled, halted -> suspended.
export const STATUS = Object.freeze({ active: 'active', suspended: 'suspended', canceled: 'canceled' })

/**
 * @typedef {object} License
 * @property {string} license_key
 * @property {string} email
 * @property {string} plan
 * @property {number} max_committers
 * @property {string} status            'active' | 'suspended' | 'canceled'
 * @property {string|null} subscription_id
 * @property {string|null} payment_id
 */

/**
 * Look a licence up by key. Returns null only when the key genuinely is not on record —
 * transport or configuration failures throw, so callers can tell "not paid" apart from
 * "we could not check".
 * @param {string} licenseKey
 * @returns {Promise<License|null>}
 */
export async function getLicense(licenseKey) {
  const rows = await request(`?license_key=eq.${encodeURIComponent(licenseKey)}&limit=1`)
  return Array.isArray(rows) && rows.length ? rows[0] : null
}

/** @param {string} subscriptionId @returns {Promise<License|null>} */
export async function findBySubscription(subscriptionId) {
  const rows = await request(`?subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`)
  return Array.isArray(rows) && rows.length ? rows[0] : null
}

/** @param {string} paymentId @returns {Promise<License|null>} */
export async function findByPayment(paymentId) {
  const rows = await request(`?payment_id=eq.${encodeURIComponent(paymentId)}&limit=1`)
  return Array.isArray(rows) && rows.length ? rows[0] : null
}

/**
 * Insert a licence, or update it if the key already exists (idempotent — Razorpay
 * retries webhooks, and a retry must not mint a second licence).
 * @param {Partial<License>} record
 * @returns {Promise<License>}
 */
export async function saveLicense(record) {
  const rows = await request('?on_conflict=license_key', {
    method: 'POST',
    body: JSON.stringify([record]),
    prefer: 'resolution=merge-duplicates,return=representation',
  })
  return Array.isArray(rows) && rows.length ? rows[0] : record
}

/**
 * @param {string} licenseKey
 * @param {Partial<License>} patch
 * @returns {Promise<License|null>}
 */
export async function updateLicense(licenseKey, patch) {
  const rows = await request(`?license_key=eq.${encodeURIComponent(licenseKey)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    prefer: 'return=representation',
  })
  return Array.isArray(rows) && rows.length ? rows[0] : null
}
