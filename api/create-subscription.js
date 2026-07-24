// POST /api/create-subscription
// Creates a Razorpay subscription for Hivecode Pro and returns the subscription ID
// for the frontend to open the checkout modal.

import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const PLAN_IDS = {
  pro: process.env.RAZORPAY_PLAN_ID_PRO,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan, email } = req.body;

    if (!plan || !PLAN_IDS[plan]) {
      return res.status(400).json({ error: 'Invalid plan. Use "pro".' });
    }

    // Create a Razorpay subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: PLAN_IDS[plan],
      total_count: 120, // up to 120 billing cycles (10 years)
      quantity: 1,
      customer_notify: 1, // Razorpay sends payment receipts to the customer
      notes: {
        product: 'hivecode',
        plan: plan,
        email: email || '',
      },
    });

    return res.status(200).json({
      subscriptionId: subscription.id,
      plan: plan,
    });

  } catch (error) {
    console.error('Razorpay subscription error:', error);
    return res.status(500).json({
      error: 'Failed to create subscription',
      details: error.message,
    });
  }
}
