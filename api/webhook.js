// POST /api/webhook
//
// Razorpay calls this when money moves. It is the ONLY thing that may mint a licence:
// the browser no longer invents one, so a key that is not in this table does not exist.
//
// Fixes three holes in the previous version:
//   1. Verification was skipped whenever RAZORPAY_WEBHOOK_SECRET was unset, so anyone
//      who knew the URL could POST a fake "subscription.activated" and mint licences.
//      It is now mandatory and fails closed.
//   2. Only subscription.* events were handled, but the checkout on the site creates a
//      one-off payment, which emits payment.captured. No event ever matched, so no
//      licence was ever actually issued by the server.
//   3. Licences lived in an in-memory Map that Vercel discards on every cold start.
//
// Env:
//   RAZORPAY_WEBHOOK_SECRET   required — from the Razorpay dashboard webhook config
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   required (see api/_store.js)
//   RESEND_API_KEY / LICENSE_FROM_EMAIL        optional (see api/_email.js)

import crypto from 'crypto';
const DAY_MS = 86_400_000;
// Seven days to replace a card. Short enough to bound free usage, long enough to survive a
// weekend and a holiday, which is when cards expire.
const GRACE_DAYS = Number(process.env.HIVE_GRACE_DAYS) || 7;

import { PLANS, clampSeats, formatLicenseKey } from '../shared/license.js';
import { STATUS, findByPayment, findBySubscription, getLicense, isStoreConfigured, saveLicense, updateLicense } from './_store.js';
import { sendLicenseEmail } from './_email.js';

function newLicenseToken() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

/**
 * Razorpay signs the EXACT bytes it sent, so re-serialising the parsed body can produce a
 * different string and a false mismatch. Read the stream when it is still readable, and
 * fall back to canonical JSON only when the platform has already consumed it.
 */
async function readRawBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    if (chunks.length) return { raw: Buffer.concat(chunks).toString('utf8'), exact: true };
  } catch {
    /* already consumed — fall through */
  }
  return { raw: req.body ? JSON.stringify(req.body) : '', exact: false };
}

function signatureMatches(raw, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Seats come from the notes the checkout attached; clamp so nothing absurd is stored. */
function seatsFromNotes(notes) {
  return clampSeats(PLANS.pro, Number.parseInt((notes && notes.seats) || '1', 10));
}

function emailFrom(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.includes('@')) return value;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Fail CLOSED. Processing unverified payment events is how you mint free licences
    // for whoever finds this URL.
    console.error('webhook refused: RAZORPAY_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  if (!isStoreConfigured()) {
    // 500 (not 200) so Razorpay retries once the store is configured, instead of
    // treating a dropped purchase as delivered.
    console.error('webhook refused: licence store is not configured');
    return res.status(500).json({ error: 'Store not configured' });
  }

  const { raw, exact } = await readRawBody(req);
  if (!signatureMatches(raw, req.headers['x-razorpay-signature'], secret)) {
    console.error(`webhook rejected: bad signature (raw body ${exact ? 'exact' : 're-serialised'})`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = raw ? JSON.parse(raw) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed JSON' });
  }

  const name = event && event.event;
  const payload = (event && event.payload) || {};
  const payment = (payload.payment && payload.payment.entity) || null;
  const subscription = (payload.subscription && payload.subscription.entity) || null;

  try {
    // ── money in ────────────────────────────────────────────────────────────────────
    if (name === 'payment.captured' || name === 'subscription.activated' || name === 'subscription.charged') {
      const notes = (subscription && subscription.notes) || (payment && payment.notes) || {};
      const seats = seatsFromNotes(notes);
      const email = emailFrom(notes.email, payment && payment.email, subscription && subscription.customer_email);
      const subscriptionId = subscription ? subscription.id : null;
      const paymentId = payment ? payment.id : null;

      // Idempotency: Razorpay retries until it gets a 2xx, and a retry must not mint a
      // second licence for the same money.
      let existing = null;
      if (subscriptionId) existing = await findBySubscription(subscriptionId);
      if (!existing && paymentId) existing = await findByPayment(paymentId);

      if (existing) {
        await updateLicense(existing.license_key, {
          status: STATUS.active,
          max_committers: seats,
          last_charged_at: new Date().toISOString(),
          // RECORD THE PAYMENT ID WHENEVER ONE ARRIVES, and this branch is where it usually
          // does. `subscription.activated` fires FIRST and carries only the subscription
          // entity -- no payment -- so the row is created with payment_id: null. The payment
          // id only appears later, on `subscription.charged`, which lands here.
          //
          // Without this the id is never stored at all, and /api/license?payment_id= plus the
          // whole /recover page can never find a subscription customer's licence. Their only
          // route to their own key would be the email, and if that is not configured they end
          // up with a paid licence in the database that they cannot reach.
          ...(paymentId && !existing.payment_id ? { payment_id: paymentId } : {}),
          // Same for the subscription id: a first event of `payment.captured` (a one-off, or
          // an out-of-order delivery) creates the row without one.
          ...(subscriptionId && !existing.subscription_id ? { subscription_id: subscriptionId } : {}),
          // A successful charge ends any grace or wind-down. Leaving these set would
          // downgrade a customer a week after their payment went through.
          grace_until: null,
          access_until: null,
          lapse_reason: null,
          ...(email ? { email } : {}),
        });
        console.log(`licence renewed: ${existing.license_key} (${seats} committers)`);
        return res.status(200).json({ received: true, licensed: true, renewed: true });
      }

      const licenseKey = formatLicenseKey('pro', newLicenseToken());
      await saveLicense({
        license_key: licenseKey,
        email: email || 'unknown',
        plan: 'pro',
        max_committers: seats,
        status: STATUS.active,
        subscription_id: subscriptionId,
        payment_id: paymentId,
        last_charged_at: new Date().toISOString(),
      });
      console.log(`licence issued: ${licenseKey} (${seats} committers) for ${email || 'unknown'}`);

      const delivery = await sendLicenseEmail({ to: email, licenseKey, seats });
      return res.status(200).json({ received: true, licensed: true, emailed: delivery.sent });
    }

    // ── money stops ─────────────────────────────────────────────────────────────────
    // CANCELLATION AND FAILED RENEWAL -- neither one revokes access on the spot.
    //
    // This used to set 'canceled' or 'suspended' immediately, and both were wrong in a way
    // that costs customers rather than protecting revenue:
    //
    //   cancelled  A customer who cancels on the 3rd has paid through the 30th. Cutting
    //              them off on the 3rd is not a cancellation, it is the shape of a
    //              chargeback. Access runs to the end of the period they bought.
    //
    //   halted     A halt is almost always an expired card. Locking someone out of their
    //              own workspace on the first failed charge loses a customer who would have
    //              updated the card in a minute. GRACE_DAYS of paid access, then downgrade.
    //
    // In both cases the licence stays ACTIVE and carries a deadline; validate.js reports it
    // valid until that deadline passes. Nothing is ever deleted -- a lapsed account drops to
    // free ceilings and can still READ its own work, which is the difference between
    // "renew to keep writing" and "we took your workspace".
    if (name === 'subscription.cancelled' || name === 'subscription.halted' || name === 'subscription.paused') {
      const existing = subscription ? await findBySubscription(subscription.id) : null;
      if (!existing) {
        console.warn(`${name} for unknown subscription ${subscription && subscription.id}`);
        return res.status(200).json({ received: true, ignored: 'unknown subscription' });
      }

      if (name === 'subscription.cancelled') {
        // Razorpay reports the end of the paid period as current_end (unix seconds). If it
        // is missing or already past, fall back to now + 1 day rather than cutting access
        // instantly -- a missing field must never be read as "revoke immediately".
        const endSec = Number(subscription && subscription.current_end);
        const paidUntil = Number.isFinite(endSec) && endSec * 1000 > Date.now()
          ? new Date(endSec * 1000)
          : new Date(Date.now() + DAY_MS);
        await updateLicense(existing.license_key, {
          status: STATUS.active,
          access_until: paidUntil.toISOString(),
          grace_until: null,
          lapse_reason: 'cancelled',
        });
        console.log(`licence cancelled, access until ${paidUntil.toISOString()}: ${existing.license_key}`);
        return res.status(200).json({ received: true, status: 'active-until-period-end', accessUntil: paidUntil.toISOString() });
      }

      // halted / paused -> grace
      const graceUntil = new Date(Date.now() + GRACE_DAYS * DAY_MS);
      await updateLicense(existing.license_key, {
        status: STATUS.active,
        grace_until: graceUntil.toISOString(),
        lapse_reason: name === 'subscription.halted' ? 'payment-failed' : 'paused',
      });
      console.log(`licence in grace until ${graceUntil.toISOString()} (${name}): ${existing.license_key}`);
      return res.status(200).json({ received: true, status: 'grace', graceUntil: graceUntil.toISOString() });
    }

    // A renewal that succeeds must CLEAR any grace or end-of-period deadline. Without this a
    // customer who fixed their card would keep the old deadline and be downgraded anyway --
    // a bug that would only surface a week after the money arrived.
    if (name === 'subscription.resumed' || name === 'subscription.authenticated') {
      const existing = subscription ? await findBySubscription(subscription.id) : null;
      if (existing) {
        await updateLicense(existing.license_key, {
          status: STATUS.active, grace_until: null, access_until: null, lapse_reason: null,
        });
        console.log(`licence recovered, deadlines cleared: ${existing.license_key}`);
      }
      return res.status(200).json({ received: true, status: 'active' });
    }

    if (name === 'refund.created' || name === 'refund.processed') {
      const refunded = payload.refund && payload.refund.entity;
      const existing = refunded && refunded.payment_id ? await findByPayment(refunded.payment_id) : null;
      if (existing) {
        await updateLicense(existing.license_key, { status: STATUS.canceled });
        console.log(`licence canceled after refund: ${existing.license_key}`);
      }
      return res.status(200).json({ received: true });
    }

    console.log(`webhook ignored: ${name}`);
    return res.status(200).json({ received: true, ignored: name });
  } catch (error) {
    // 500 makes Razorpay retry. Swallowing this would silently drop a paid licence.
    console.error(`webhook failed on ${name}:`, error && error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

export { getLicense };
