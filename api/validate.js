// POST /api/validate
// Called by the VS Code extension to check if a license key is valid.
// Returns { valid: true/false, plan: 'pro'|null, status: 'active'|'cancelled' }

// Import the shared license store from the webhook handler.
// In production, replace this with a Supabase query.
const LICENSE_STORE = globalThis.__hiveLicenses || (globalThis.__hiveLicenses = new Map());

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { licenseKey } = req.body;

    if (!licenseKey || typeof licenseKey !== 'string') {
      return res.status(400).json({
        valid: false,
        error: 'Missing licenseKey in request body',
      });
    }

    const normalized = licenseKey.trim().toUpperCase();
    const license = LICENSE_STORE.get(normalized);

    if (!license) {
      return res.status(200).json({
        valid: false,
        plan: null,
        status: null,
      });
    }

    return res.status(200).json({
      valid: license.status === 'active',
      plan: license.plan,
      status: license.status,
      email: license.email,
    });

  } catch (error) {
    console.error('Validate error:', error);
    return res.status(500).json({
      valid: false,
      error: 'Validation failed',
    });
  }
}
