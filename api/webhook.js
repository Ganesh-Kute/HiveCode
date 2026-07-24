// POST /api/webhook
// Receives Razorpay webhook events when a subscription is activated/charged/cancelled.
// Generates a license key and stores it in Supabase.

import crypto from 'crypto';

// Simple in-memory license store. Replace with Supabase in production.
// For now, licenses are stored in a global Map (persists across Vercel invocations
// within the same instance, but not across cold starts — Supabase needed for prod).
const LICENSE_STORE = globalThis.__hiveLicenses || (globalThis.__hiveLicenses = new Map());

function generateLicenseKey() {
  const hex = crypto.randomBytes(12).toString('hex');
  return `HIVE-PRO-${hex}`;
}

function verifyWebhookSignature(body, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');
  return expected === signature;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Verify webhook signature (skip in test mode if no secret set)
    if (secret && signature) {
      const valid = verifyWebhookSignature(req.body, signature, secret);
      if (!valid) {
        console.error('Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body.event;
    const payload = req.body.payload;

    console.log(`Webhook received: ${event}`);

    if (event === 'subscription.activated' || event === 'subscription.charged') {
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.email || subscription?.customer_email || 'unknown';
      const plan = subscription?.notes?.plan || 'pro';
      const subscriptionId = subscription?.id;

      // Check if this subscription already has a license
      let existingKey = null;
      for (const [key, data] of LICENSE_STORE) {
        if (data.subscriptionId === subscriptionId) {
          existingKey = key;
          break;
        }
      }

      if (!existingKey) {
        // Generate a new license key
        const licenseKey = generateLicenseKey();
        LICENSE_STORE.set(licenseKey, {
          email,
          plan,
          subscriptionId,
          status: 'active',
          createdAt: new Date().toISOString(),
        });
        console.log(`License created: ${licenseKey} for ${email}`);

        // TODO: Send license key via email using Razorpay's customer_notify
        // or integrate with a transactional email service (Resend, etc.)
      } else {
        // Refresh the existing license (renewal payment)
        const data = LICENSE_STORE.get(existingKey);
        data.status = 'active';
        data.lastChargedAt = new Date().toISOString();
        console.log(`License renewed: ${existingKey} for ${email}`);
      }
    }

    if (event === 'subscription.cancelled') {
      const subscription = payload.subscription?.entity;
      const subscriptionId = subscription?.id;

      // Deactivate the license
      for (const [key, data] of LICENSE_STORE) {
        if (data.subscriptionId === subscriptionId) {
          data.status = 'cancelled';
          console.log(`License cancelled: ${key}`);
          break;
        }
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// Export the store so the validate endpoint can access it
export { LICENSE_STORE };
