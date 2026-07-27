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

/** A licence key is well-formed if it looks like this. Authority still comes from the DB. */
const KEY_PATTERN = /^HC-([A-Z]+)-([0-9A-F]{32})$/

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
  return String(raw == null ? '' : raw).trim().toUpperCase()
}

/**
 * Check a key's SHAPE only.
 *
 * Deliberately not called `verify`: a well-formed key is not a paid key. Anything that
 * grants access MUST look the key up and read plan/seats/status from the record. This
 * function exists only to reject obvious junk before spending a database round trip.
 *
 * @param {string} raw
 * @returns {{plan: Exclude<PlanId,'free'>, token: string}|null}
 */
export function parseLicenseKey(raw) {
  const match = KEY_PATTERN.exec(normalizeLicenseKey(raw))
  if (!match) return null
  const plan = match[1].toLowerCase()
  if (plan !== 'pro') return null
  return { plan: 'pro', token: match[2] }
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isWellFormedLicenseKey(raw) {
  return parseLicenseKey(raw) !== null
}
