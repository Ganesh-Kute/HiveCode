// GET|POST /api/validate
//
// The single authority on whether a licence is real. Called by the VS Code extension and
// by the relay (server.js) before admitting a connection.
//
//   POST  { "licenseKey": "HC-PRO-…" }
//   GET   /api/validate?key=HC-PRO-…
//
// Response:
//   { valid, plan, seats, status, email? }
//
// `seats` comes from the stored record, never from the key. That is the whole point: the
// previous relay read the seat count out of the key string, so HC-PRO-9999-anything
// granted 9,999 committers to anyone who typed it.
//
// A lookup failure returns 503, NOT valid:false. "We could not check" and "you did not
// pay" must never be the same answer — one is a temporary fault, the other is a verdict.

import { isWellFormedLicenseKey, normalizeLicenseKey } from '../shared/license.js';
import { getLicense, isStoreConfigured, STATUS } from './_store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ valid: false, error: 'Method not allowed' });
  }

  const supplied =
    req.method === 'GET'
      ? (req.query && (req.query.key || req.query.licenseKey))
      : (req.body && (req.body.licenseKey || req.body.key));

  if (!supplied || typeof supplied !== 'string') {
    return res.status(400).json({ valid: false, error: 'Missing licenseKey' });
  }

  const licenseKey = normalizeLicenseKey(supplied);

  // Reject junk before spending a database round trip. Shape is not authority.
  if (!isWellFormedLicenseKey(licenseKey)) {
    return res.status(200).json({ valid: false, plan: null, seats: 0, status: null, reason: 'malformed' });
  }

  if (!isStoreConfigured()) {
    console.error('validate refused: licence store is not configured');
    return res.status(503).json({ valid: false, error: 'Validation temporarily unavailable' });
  }

  try {
    const license = await getLicense(licenseKey);
    if (!license) {
      return res.status(200).json({ valid: false, plan: null, seats: 0, status: null, reason: 'unknown key' });
    }

    // A licence can be 'active' AND on a deadline. The webhook sets one instead of revoking
    // access on the spot, because a cancellation means "paid through the end of the period"
    // and a failed charge means "we are chasing your card" — neither means "locked out now".
    // Those two columns are inert unless they are read here, so this is where they are read.
    const now = Date.now();
    const ts = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
    const accessUntil = ts(license.access_until);   // cancelled: end of the paid period
    const graceUntil = ts(license.grace_until);     // payment failed: card-replacement window

    let valid = license.status === STATUS.active;
    let reason;
    if (valid && accessUntil !== null && now > accessUntil) {
      valid = false; reason = 'cancelled, paid period ended';
    }
    if (valid && graceUntil !== null && now > graceUntil) {
      valid = false; reason = 'payment failed, grace period ended';
    }

    return res.status(200).json({
      valid,
      plan: license.plan || 'pro',
      seats: Number(license.max_committers) || 1,
      status: license.status,
      email: license.email || undefined,
      // Surfaced so the dashboard can show "renews / ends / card failed" rather than a bare
      // valid/invalid, and so support can see WHY without opening the database.
      ...(license.lapse_reason ? { lapseReason: license.lapse_reason } : {}),
      ...(accessUntil !== null ? { accessUntil: license.access_until } : {}),
      ...(graceUntil !== null ? { graceUntil: license.grace_until } : {}),
      ...(reason ? { reason } : {}),
    });
  } catch (error) {
    // Do not answer "invalid" because the database blinked.
    console.error('validate lookup failed:', error && error.message);
    return res.status(503).json({ valid: false, error: 'Validation temporarily unavailable' });
  }
}
