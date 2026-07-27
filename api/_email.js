// Licence delivery email, over Resend's REST API with plain fetch (no dependency, so the
// serverless functions stay installable-free).
//
// This email is the only thing every customer definitely reads, so it carries the whole
// setup — the four steps come from shared/onboarding.js, the same array the website and the
// post-payment dialog render. It used to say "run Hivecode: Set Licence Key", which is not
// a command that exists; anyone following it literally concluded the product was broken.
//
// Env:
//   RESEND_API_KEY     from resend.com. If unset, sending is skipped and logged — the
//                      licence is still stored and still retrievable via /api/license,
//                      so a missing key degrades delivery, it never loses a purchase.
//   LICENSE_FROM_EMAIL e.g. "Hivecode <keys@yourdomain.com>". Must be a domain you have
//                      verified with Resend.

import {
  AGENT_GUIDE_URL,
  MCP_CONFIG_JSON,
  SELF_HOST_NOTE,
  SETUP_STEPS,
  SITE_URL,
  setupStepsAsText,
} from '../shared/onboarding.js'

const ENDPOINT = 'https://api.resend.com/emails'

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.LICENSE_FROM_EMAIL)
}

/** Step notes contain things like `<your link>`, which would vanish as an unknown tag. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param {{licenseKey: string, committers: string}} params */
function textBody({ licenseKey, committers }) {
  return [
    'Thanks for buying Hivecode Pro.',
    '',
    `Licence key:  ${licenseKey}`,
    `Covers:       ${committers}`,
    '',
    'FOUR STEPS TO YOUR FIRST ROOM',
    '',
    setupStepsAsText(),
    '',
    'For Claude Desktop or Cursor, add this to the MCP config instead of running the',
    'command in step 4:',
    '',
    MCP_CONFIG_JSON.split('\n').map((line) => `    ${line}`).join('\n'),
    '',
    `Full agent setup guide: ${AGENT_GUIDE_URL}`,
    '',
    SELF_HOST_NOTE,
    '',
    'Keep this email — the key is the only thing you need. If you lose it, reply here and',
    'we will look it up from your payment.',
    '',
    SITE_URL,
  ].join('\n')
}

/** @param {{licenseKey: string, committers: string}} params */
function htmlBody({ licenseKey, committers }) {
  const steps = SETUP_STEPS.map((step, i) => {
    const literal =
      step.kind === 'link' && step.url
        ? `<a href="${escapeHtml(step.url)}" style="color:#0F7FA8;font-weight:600">${escapeHtml(step.literal)}</a>`
        : step.literal
          ? `<code style="display:inline-block;background:#F1F4F8;border:1px solid #DCE3EC;border-radius:5px;padding:5px 9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#10202E">${escapeHtml(step.literal)}</code>`
          : ''
    const note = step.note
      ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.55;color:#63748A">${escapeHtml(step.note)}</p>`
      : ''
    return `
      <tr>
        <td style="padding:0 0 22px;vertical-align:top;width:34px">
          <span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:#10202E;color:#fff;text-align:center;line-height:26px;font-size:13px;font-weight:700">${i + 1}</span>
        </td>
        <td style="padding:0 0 22px">
          <p style="margin:0 0 5px;font-size:16px;font-weight:600;color:#10202E">${escapeHtml(step.title)}</p>
          <p style="margin:0 0 9px;font-size:14px;line-height:1.6;color:#3D4E61">${escapeHtml(step.body)}</p>
          ${literal}
          ${note}
        </td>
      </tr>`
  }).join('')

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#EEF1F5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F5">
<tr><td align="center" style="padding:32px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#FFFFFF;border-radius:14px;padding:34px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

    <tr><td>
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8494A6">Hivecode Pro</p>
      <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;color:#10202E">Your licence key is below</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3D4E61">
        Thanks for buying Hivecode Pro. This licence covers <b>${escapeHtml(committers)}</b>.
      </p>
    </td></tr>

    <tr><td style="padding:0 0 26px">
      <div style="background:#10202E;border-radius:10px;padding:18px 20px">
        <p style="margin:0 0 7px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#7E93A8">licence key</p>
        <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;color:#35C9F0;word-break:break-all">${escapeHtml(licenseKey)}</p>
      </div>
    </td></tr>

    <tr><td style="padding:0 0 18px;border-top:1px solid #E4E9EF">
      <p style="margin:22px 0 18px;font-size:17px;font-weight:600;color:#10202E">Four steps to your first room</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>
    </td></tr>

    <tr><td style="padding:0 0 22px">
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#63748A">
        Using Claude Desktop or Cursor? They read a config file rather than a CLI, so add this instead of running the step&nbsp;4 command:
      </p>
      <pre style="margin:0;background:#F1F4F8;border:1px solid #DCE3EC;border-radius:8px;padding:13px 15px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;color:#10202E;overflow-x:auto">${escapeHtml(MCP_CONFIG_JSON)}</pre>
      <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#63748A">
        <a href="${escapeHtml(AGENT_GUIDE_URL)}" style="color:#0F7FA8">Full agent setup guide →</a>
      </p>
    </td></tr>

    <tr><td style="padding:18px 0 0;border-top:1px solid #E4E9EF">
      <p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:#63748A">${escapeHtml(SELF_HOST_NOTE)}</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#63748A">
        Keep this email — the key is the only thing you need. Lost it? Reply here and we will
        look it up from your payment. &nbsp;·&nbsp; <a href="${escapeHtml(SITE_URL)}" style="color:#0F7FA8">hivecode.vercel.app</a>
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`
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
    subject: 'Your Hivecode Pro licence key — and the 4 steps to your first room',
    // Both parts are sent: some clients (and some readers) prefer plain text, and a
    // text/plain alternative measurably helps deliverability on a young sending domain.
    text: textBody({ licenseKey, committers }),
    html: htmlBody({ licenseKey, committers }),
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

// Exported for tests: assert the rendered bodies actually contain the real command names.
export const _render = { textBody, htmlBody }
