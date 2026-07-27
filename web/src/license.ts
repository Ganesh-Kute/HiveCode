// THE SINGLE SOURCE OF TRUTH FOR LICENSE KEYS.
//
// This module exists because the license format was previously built by string
// concatenation in three places that disagreed with each other (the browser minted
// `HC-PRO-<seats>-<paymentId>`, the webhook minted `HIVE-PRO-<hex>`, the relay accepted
// any `HC-PRO-` prefix and read the seat count out of field 2). Anything that mints,
// displays, parses, or validates a key must go through here — client and server alike.
//
// Format:  HC-<PLAN>-<SEATS>-<TOKEN>
//   PLAN   uppercase plan id            e.g. PRO
//   SEATS  integer seat count, 1..MAX   e.g. 5
//   TOKEN  opaque server-issued id      e.g. a payment id or random hex
//
// NOTE (known gap, tracked separately): the token is not yet verified against a
// server-side record, so `parseLicenseKey` proves only that a key is WELL-FORMED, never
// that it was PAID FOR. Authorization must call the validate endpoint — see
// `isWellFormedLicenseKey`'s doc comment.

export type PlanId = 'free' | 'pro'

export interface Plan {
  readonly id: PlanId
  readonly name: string
  /** Price per seat per month, in whole USD. */
  readonly pricePerSeat: number
  readonly minSeats: number
  readonly maxSeats: number
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: { id: 'free', name: 'Free', pricePerSeat: 0, minSeats: 1, maxSeats: 2 },
  pro: { id: 'pro', name: 'Pro', pricePerSeat: 29, minSeats: 1, maxSeats: 100 },
}

export interface LicenseKey {
  readonly plan: Exclude<PlanId, 'free'>
  readonly seats: number
  readonly token: string
}

const KEY_PATTERN = /^HC-([A-Z]+)-(\d+)-([A-Za-z0-9_]+)$/

/** Clamp an arbitrary seat input to what the plan actually allows. */
export function clampSeats(plan: Plan, seats: number): number {
  if (!Number.isFinite(seats)) return plan.minSeats
  return Math.min(plan.maxSeats, Math.max(plan.minSeats, Math.trunc(seats)))
}

/** Monthly total in whole USD for a seat count on a plan. */
export function monthlyTotal(plan: Plan, seats: number): number {
  return plan.pricePerSeat * clampSeats(plan, seats)
}

/** Razorpay wants the smallest currency unit (cents for USD). */
export function amountInMinorUnits(plan: Plan, seats: number): number {
  return monthlyTotal(plan, seats) * 100
}

export function formatLicenseKey(key: LicenseKey): string {
  return `HC-${key.plan.toUpperCase()}-${key.seats}-${key.token}`
}

/**
 * Parse a key's SHAPE. Returns null when malformed.
 *
 * This is deliberately not named `verify`: a well-formed key is not a paid key. Callers
 * that gate access (the relay, the extension) must additionally confirm the token against
 * the issuing record, or the seat count is simply whatever the caller typed.
 */
export function parseLicenseKey(raw: string): LicenseKey | null {
  const match = KEY_PATTERN.exec(String(raw || '').trim().toUpperCase())
  if (!match) return null
  const [, planRaw, seatsRaw, token] = match
  const plan = planRaw.toLowerCase()
  if (plan !== 'pro') return null
  const seats = Number.parseInt(seatsRaw, 10)
  if (!Number.isInteger(seats) || seats < 1 || seats > PLANS.pro.maxSeats) return null
  return { plan: 'pro', seats, token }
}

export function isWellFormedLicenseKey(raw: string): boolean {
  return parseLicenseKey(raw) !== null
}
