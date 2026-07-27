// Relay-side licence verification.
//
// The relay used to decide entitlement by reading the key string itself:
//   license.startsWith('HC-PRO-')  and  seats = parseInt(license.split('-')[2])
// so `HC-PRO-9999-anything` admitted 9,999 committers to anyone who typed it. Nothing
// about a key may be trusted now — the record behind it is the only authority.
//
// The relay asks /api/validate rather than querying Supabase directly, deliberately: the
// service-role key then lives only in Vercel's environment and never on the relay host.
//
// Two properties matter for a paying customer:
//   • a cache, so a room full of agents does not hammer the validator, and
//   • GRACE — if the validator is unreachable but we have previously seen this key be
//     valid, we keep admitting it and log loudly. A billing outage must never look like
//     an expired subscription to someone who paid.
//
// Env:
//   HIVE_LICENSE_API      default https://hivecode.vercel.app/api/validate
//   HIVE_LICENSE_TIMEOUT  ms, default 4000
//   HIVE_LICENSE_GRACE_MS how long a stale-but-valid entry survives an outage,
//                         default 86400000 (24h)

import { isWellFormedLicenseKey, normalizeLicenseKey } from './shared/license.js'

const API = process.env.HIVE_LICENSE_API || 'https://hivecode.vercel.app/api/validate'
const TIMEOUT = Number(process.env.HIVE_LICENSE_TIMEOUT || 4000)
const GRACE_MS = Number(process.env.HIVE_LICENSE_GRACE_MS || 24 * 60 * 60 * 1000)
const OK_TTL = 10 * 60 * 1000 // re-check a good licence every 10 minutes
const BAD_TTL = 60 * 1000 // re-check a bad one every minute, so a fresh purchase works fast

/** @type {Map<string, {valid: boolean, seats: number, status: string|null, at: number}>} */
const cache = new Map()

export function _clearCache() {
  cache.clear()
}

/**
 * Test hook: age every cached entry by `ms`, so the grace path (stale entry + unreachable
 * validator) can be exercised without waiting out the real TTL.
 * @param {number} ms
 */
export function _ageCache(ms) {
  for (const entry of cache.values()) entry.at -= ms
}

/**
 * @param {string} rawKey
 * @returns {Promise<{valid: boolean, seats: number, status: string|null, source: string, reason?: string}>}
 */
export async function verifyLicense(rawKey) {
  const key = normalizeLicenseKey(rawKey)

  // Shape check first: junk never costs a network round trip. Shape is not authority —
  // a well-formed key that is not on record is still refused below.
  if (!isWellFormedLicenseKey(key)) {
    return { valid: false, seats: 0, status: null, source: 'shape', reason: 'malformed key' }
  }

  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < (hit.valid ? OK_TTL : BAD_TTL)) {
    return { valid: hit.valid, seats: hit.seats, status: hit.status, source: 'cache' }
  }

  let controller = null
  let timer = null
  try {
    controller = new AbortController()
    timer = setTimeout(() => controller.abort(), TIMEOUT)
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`validator returned ${res.status}`)
    const data = await res.json()
    const entry = {
      valid: Boolean(data && data.valid),
      seats: Number(data && data.seats) || 0,
      status: (data && data.status) || null,
      at: Date.now(),
    }
    cache.set(key, entry)
    return { valid: entry.valid, seats: entry.seats, status: entry.status, source: 'api' }
  } catch (err) {
    // GRACE: an outage must not evict paying customers.
    if (hit && hit.valid && now - hit.at < GRACE_MS) {
      console.warn(
        `[relay] licence validator unreachable (${err && err.message}); admitting on cached grant, ` +
          `${Math.round((now - hit.at) / 60000)}m old`,
      )
      return { valid: true, seats: hit.seats, status: hit.status, source: 'grace' }
    }
    console.error(`[relay] licence validator unreachable and no cached grant: ${err && err.message}`)
    return { valid: false, seats: 0, status: null, source: 'unavailable', reason: 'validator unreachable' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
