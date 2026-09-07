// GET /api/license?payment_id=pay_XXXX   (or ?subscription_id=sub_XXXX)
//
// Licence recovery. The previous flow showed the key once in a browser alert() and never
// sent it anywhere, so closing that dialog lost a paid licence permanently. Now the key is
// stored at purchase, emailed, AND retrievable here with the payment id from the buyer's
// Razorpay receipt.
//
// The payment id is the proof of purchase: it is unguessable and only the buyer (and
// Razorpay) has it. Nothing else is accepted — you cannot enumerate licences by email,
// because that would let anyone who knows a customer's address take their key.

import { findByPayment, findBySubscription, isStoreConfigured, STATUS } from './_store.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // EITHER reference is accepted, and accepting the subscription id is not a convenience --
  // it is the only reliable key for a recurring customer.
  //
  // `subscription.activated` fires before any payment exists, so the licence row is created
  // with payment_id: null. A buyer holding only their payment id could therefore never find
  // their own licence, and neither could the /recover page. The checkout handler receives
  // BOTH ids, so it sends both and whichever one is on the row wins.
  //
  // Both are unguessable and only the buyer and Razorpay hold them. Email is still refused:
  // enumerating licences by address would let anyone who knows a customer's email take
  // their key.
  const q = req.query || {};
  const paymentId = q.payment_id || q.paymentId;
  const subscriptionId = q.subscription_id || q.subscriptionId;
  const REF = /^[A-Za-z0-9_]{6,64}$/;
  const okPayment = typeof paymentId === 'string' && REF.test(paymentId);
  const okSub = typeof subscriptionId === 'string' && REF.test(subscriptionId);
  if (!okPayment && !okSub) {
    return res.status(400).json({ error: 'Missing or malformed payment_id or subscription_id' });
  }

  if (!isStoreConfigured()) {
    console.error('license lookup refused: store is not configured');
    return res.status(503).json({ error: 'Lookup temporarily unavailable' });
  }

  try {
    // Subscription id first when both are given: it is present on the row from the very
    // first event, whereas the payment id only appears once a charge has been recorded.
    let license = null;
    if (okSub) license = await findBySubscription(subscriptionId);
    if (!license && okPayment) license = await findByPayment(paymentId);
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
