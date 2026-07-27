// Licence delivery email, over Resend's REST API with plain fetch (no dependency, so the
// serverless functions stay installable-free).
//
// Env:
//   RESEND_API_KEY     from resend.com. If unset, sending is skipped and logged — the
//                      licence is still stored and still retrievable via /api/license,
//                      so a missing key degrades delivery, it never loses a purchase.
//   LICENSE_FROM_EMAIL e.g. "Hivecode <keys@yourdomain.com>". Must be a domain you have
//                      verified with Resend.

const ENDPOINT = 'https://api.resend.com/emails'

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.LICENSE_FROM_EMAIL)
}

/**
 * @param {{to: string, licenseKey: string, seats: number}} params
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendLicenseEmail({ to, licenseKey, seats }) {
  if (!isEmailConfigured()) {
    console.warn(`licence ${licenseKey} not emailed: RESEND_API_KEY / LICENSE_FROM_EMAIL unset`)
    return { sent: false, reason: 'not configured' }
  }
  if (!to || !to.includes('@')) {
    console.warn(`licence ${licenseKey} not emailed: no usable address (${to})`)
    return { sent: false, reason: 'no address' }
  }

  const committers = seats === 1 ? '1 committer' : `${seats} committers`
  const body = {
    from: process.env.LICENSE_FROM_EMAIL,
    to: [to],
    subject: 'Your Hivecode Pro licence key',
    text: [
      'Thanks for buying Hivecode Pro.',
      '',
      `Licence key:  ${licenseKey}`,
      `Covers:       ${committers}`,
      '',
      'Two ways to use it:',
      '  • VS Code — run "Hivecode: Set Licence Key" and paste it in.',
      '  • Self-hosted relay — set HIVE_LICENSE to this key.',
      '',
      'Keep this email; the key is the only thing you need. If you lose it, reply here',
      'and we will look it up from your payment.',
      '',
      'https://hivecode.vercel.app',
    ].join('\n'),
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text()
      // Never throw: a delivery failure must not fail the webhook, or Razorpay will retry
      // and we would re-process a payment that was already handled correctly.
      console.error(`licence ${licenseKey} email failed: ${res.status} ${detail.slice(0, 200)}`)
      return { sent: false, reason: `resend ${res.status}` }
    }
    return { sent: true }
  } catch (err) {
    console.error(`licence ${licenseKey} email threw: ${err && err.message}`)
    return { sent: false, reason: 'network' }
  }
}
