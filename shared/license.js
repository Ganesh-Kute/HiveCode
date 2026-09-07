// THE SINGLE SOURCE OF TRUTH FOR PLANS AND LICENCE KEYS.
//
// Imported by BOTH the browser bundle (web/src, via esbuild) and the serverless
// functions (api/*.js, natively). Plain JavaScript with JSDoc types on purpose: the API
// then needs no build step and no dependencies, while the TypeScript side still gets
// full type checking through these annotations.
//
// This module exists because the format was previously built by string concatenation in
// three places that disagreed: the browser minted `HC-PRO-<seats>-<paymentId>`, the
// webhook minted `HIVE-PRO-<hex>`, and the relay accepted any `HC-PRO-` prefix while
// reading the seat count out of the key itself.
//
// KEY FORMAT:  HC-<PLAN>-<TOKEN>
//   PLAN   uppercase plan id, e.g. PRO
//   TOKEN  32 hex chars of cryptographic randomness, issued server-side
//
// The key deliberately carries NO seat count and NO expiry. Both live in the licence
// record, because anything encoded in the key is something the holder can edit. The key
// identifies; the database authorises.

/** @typedef {'free'|'pro'} PlanId */

/**
 * @typedef {object} Plan
 * @property {PlanId} id
 * @property {string} name
 * @property {number} pricePerSeat  Price per committer per month, whole USD.
 * @property {number} minSeats
 * @property {number} maxSeats
 */

/** @type {Readonly<Record<PlanId, Plan>>} */
export const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', name: 'Free', pricePerSeat: 0, minSeats: 1, maxSeats: 2 }),
  pro: Object.freeze({ id: 'pro', name: 'Pro', pricePerSeat: 29, minSeats: 1, maxSeats: 100 }),
})

/**
 * WHAT THIS KEY IS, AND WHAT IT IS NOT.
 *
 * It is not a licence for the software. The CLIENT is MIT — `sync.js`, `hive-mcp.js`, the ICR
 * engine — and nothing in it checks whether the holder is allowed to run it.
 *
 * This key is an ACCOUNT KEY for the HOSTED RELAY: it says which account a connection to
 * *our* server bills to. The relay itself (`server.js`) is deliberately NOT in
 * package.json's `files[]`, so it is not in the published package and there is nothing to
 * license. Same shape as ngrok: the tool costs nothing and the service is the product.
 *
 * TWO FORMATS ARE ACCEPTED, and the new one is the one to issue:
 *
 *   hc_live_<32>   the format to use. The `hc_live_` prefix is not decoration -- GitHub
 *                  secret scanning, gitleaks and trufflehog all match on known prefixes, so
 *                  a customer who commits their key by accident gets *caught*. `hc_test_`
 *                  is the same thing for testing.
 *   HC-PRO-<32hex> the old shape. Kept because it is what the existing tests and any key
 *                  already issued look like, and because a key that stops working during a
 *                  rename is a support ticket for something nobody asked for. It is
 *                  invisible to every scanner, which is why it is not the one to issue.
 */
const KEY_PATTERN = /^HC-([A-Z]+)-([0-9A-F]{32})$/
const ACCOUNT_KEY_PATTERN = /^hc_(live|test)_([A-Za-z0-9]{32})$/

/** The prefix to issue. Recognised by secret scanners; see the note above. */
export const ACCOUNT_KEY_PREFIX = 'hc_live_'

/**
 * Format a new-style account key.
 * @param {string} token 32 url-safe alphanumerics
 * @param {'live'|'test'} [mode]
 */
export function formatAccountKey(token, mode = 'live') {
  return `hc_${mode}_${String(token || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`
}

/**
 * Clamp arbitrary seat input to what the plan allows.
 * @param {Plan} plan
 * @param {number} seats
 * @returns {number}
 */
export function clampSeats(plan, seats) {
  if (!Number.isFinite(seats)) return plan.minSeats
  return Math.min(plan.maxSeats, Math.max(plan.minSeats, Math.trunc(seats)))
}

/**
 * Monthly total in whole USD.
 * @param {Plan} plan
 * @param {number} seats
 * @returns {number}
 */
export function monthlyTotal(plan, seats) {
  return plan.pricePerSeat * clampSeats(plan, seats)
}

/**
 * Razorpay expects the smallest currency unit (cents for USD).
 * @param {Plan} plan
 * @param {number} seats
 * @returns {number}
 */
export function amountInMinorUnits(plan, seats) {
  return monthlyTotal(plan, seats) * 100
}

/**
 * Build a key from a plan id and a server-issued token.
 * @param {Exclude<PlanId,'free'>} plan
 * @param {string} token  32 hex chars
 * @returns {string}
 */
export function formatLicenseKey(plan, token) {
  return `HC-${plan.toUpperCase()}-${String(token).toUpperCase()}`
}

/**
 * Normalise user input (paste noise, casing) into the canonical form.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeLicenseKey(raw) {
  const s = String(raw == null ? '' : raw).trim()
  // FORMAT-AWARE, and it has to be. The old `HC-PRO-<HEX>` form is canonically uppercase, so
  // normalising meant uppercasing. The new `hc_live_<32>` form is case-SENSITIVE -- its body
  // is mixed-case alphanumerics -- so uppercasing it produces a different string, and since
  // this function decides the database lookup key, that would silently fail to find a real
  // paid account. Blanket .toUpperCase() is exactly the kind of change that looks harmless
  // and rejects a paying customer's key.
  if (/^hc_(live|test)_/i.test(s)) {
    const [, mode, body] = /^hc_(live|test)_(.*)$/i.exec(s) || []
    return `hc_${String(mode).toLowerCase()}_${body}`
  }
  return s.toUpperCase()
}

/**
 * Check a key's SHAPE only.
 *
 * Deliberately not called `verify`: a well-formed key is not a paid key. Anything that
 * grants access MUST look the key up and read plan/seats/status from the record. This
 * function exists only to reject obvious junk before spending a database round trip.
 *
 * Two shapes come back, and the difference is the security property. The legacy form
 * encodes a plan in the string; the account form does NOT, because an earlier relay read
 * entitlement out of the key and `HC-PRO-9999-anything` granted 9,999 committers. A shape
 * check may only report what it can prove, and for a bare identifier that is nothing.
 *
 * @param {string} raw
 * @returns {{plan: Exclude<PlanId,'free'>|null, token: string, format: 'legacy'|'account', mode?: 'live'|'test'}|null}
 */
export function parseLicenseKey(raw) {
  const norm = normalizeLicenseKey(raw)

  // The new account-key form carries no plan in the string, and that is on purpose. The old
  // form encoded `PRO` in the key, and an earlier version of the relay READ entitlement out
  // of it -- which is how `HC-PRO-9999-anything` once granted 9,999 committers. Entitlement
  // comes from the record; the key is only an identifier. So a shape check returns the plan
  // it can prove, which for a bare identifier is nothing.
  const acct = ACCOUNT_KEY_PATTERN.exec(norm)
  if (acct) {
    // Narrowed rather than cast: a regex capture is a plain string to the type checker, and
    // silencing that with an assertion is how a third mode would slip through unnoticed.
    const mode = acct[1] === 'test' ? 'test' : 'live'
    return { plan: null, token: acct[2], mode, format: 'account' }
  }

  const match = KEY_PATTERN.exec(norm)
  if (!match) return null
  const plan = match[1].toLowerCase()
  if (plan !== 'pro') return null
  return { plan: 'pro', token: match[2], format: 'legacy' }
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isWellFormedLicenseKey(raw) {
  return parseLicenseKey(raw) !== null
}
