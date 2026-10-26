// hive-webhook -- one Slack or Discord incoming-webhook URL, and the rule for what may be sent to it.
//
// Shared by the GitHub watcher (hive-github.js) and the room notifier (hive-notify.js): the same
// URL works for both, and the same two promises hold for both.
//   1. Nothing with a key or token in it leaves: every message is scrubbed first.
//   2. A notification that fails is logged and dropped, never retried in a loop and never a reason
//      to stop: it is a courtesy, the work is the point.
import { findSecrets } from './hive-secrets.js'

/** Every key or token in `text` replaced. Run on everything that goes to GitHub or a webhook. */
export function scrub(text) {
  let s = String(text || '')
  for (const f of findSecrets(s, { tokens: true })) s = s.split(f.value).join(`[${f.kind} removed]`)
  return s
}

export function cleanError(e, url) {
  let s = String(e && (e.message || e) || 'unknown error')
  if (url) s = s.split(url).join('[webhook url removed]')
  try {
    const u = new URL(url)
    if (u.pathname && u.pathname !== '/') s = s.split(u.pathname).join('[path removed]')
  } catch { }
  s = scrub(s)
  s = s.replace(/Failed to parse URL from .+/i, 'Failed to parse URL')
  return s
}

/** `send(text)` resolves true when the webhook took it. Slack wants {text}, Discord {content}; any
 *  other host gets Slack format ({text}). */
export function makeNotifier(url, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!url) return async () => false
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { host = '' }
  const slack = /(^|\.)slack\.com$/.test(host)
  const discord = /(^|\.)discord(app)?\.com$/.test(host)
  const kind = discord ? 'discord' : slack ? 'slack' : 'other'
  const send = async (text) => {
    const msg = scrub(text)
    // allowed_mentions: an issue titled "@everyone" must not page a whole Discord server.
    const body = discord ? { content: msg.slice(0, 1900), allowed_mentions: { parse: [] } } : { text: msg }
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      if (!r.ok) { log(`notification not delivered: HTTP ${r.status}`); return false }
      return true
    } catch (e) {
      log(`notification not delivered: ${cleanError(e, url)}`)
      return false
    }
  }
  send.host = host
  send.kind = kind
  return send
}
