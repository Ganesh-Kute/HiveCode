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

    const active = license.status === STATUS.active;
    return res.status(200).json({
      valid: active,
      plan: license.plan || 'pro',
      seats: Number(license.max_committers) || 1,
      status: license.status,
      email: license.email || undefined,
    });
  } catch (error) {
    // Do not answer "invalid" because the database blinked.
    console.error('validate lookup failed:', error && error.message);
    return res.status(503).json({ valid: false, error: 'Validation temporarily unavailable' });
  }
}
