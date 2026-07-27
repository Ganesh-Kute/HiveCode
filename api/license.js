// GET /api/license?payment_id=pay_XXXX
//
// Licence recovery. The previous flow showed the key once in a browser alert() and never
// sent it anywhere, so closing that dialog lost a paid licence permanently. Now the key is
// stored at purchase, emailed, AND retrievable here with the payment id from the buyer's
// Razorpay receipt.
//
// The payment id is the proof of purchase: it is unguessable and only the buyer (and
// Razorpay) has it. Nothing else is accepted — you cannot enumerate licences by email,
// because that would let anyone who knows a customer's address take their key.

import { findByPayment, isStoreConfigured, STATUS } from './_store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const paymentId = req.query && (req.query.payment_id || req.query.paymentId);
  if (!paymentId || typeof paymentId !== 'string' || !/^[A-Za-z0-9_]{6,64}$/.test(paymentId)) {
    return res.status(400).json({ error: 'Missing or malformed payment_id' });
  }

  if (!isStoreConfigured()) {
    console.error('license lookup refused: store is not configured');
    return res.status(503).json({ error: 'Lookup temporarily unavailable' });
  }

  try {
    const license = await findByPayment(paymentId);
    if (!license) {
      // 404 rather than an error: the webhook may simply not have arrived yet, so the
      // client is expected to retry for a few seconds after checkout.
      return res.status(404).json({ found: false, pending: true });
    }
    return res.status(200).json({
      found: true,
      licenseKey: license.license_key,
      seats: Number(license.max_committers) || 1,
      plan: license.plan || 'pro',
      status: license.status,
      active: license.status === STATUS.active,
    });
  } catch (error) {
    console.error('license lookup failed:', error && error.message);
    return res.status(503).json({ error: 'Lookup temporarily unavailable' });
  }
}
