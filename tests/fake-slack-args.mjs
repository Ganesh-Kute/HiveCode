// tests/fake-slack-args.mjs -- read a request to a FAKE Slack the way the REAL Web API reads it.
//
// 0.14.3 P0-4: every fake Slack in the tests parsed a JSON body on every method, so slackPost
// sending JSON to read methods passed every test, while the real API ignores a JSON body on them.
// Measured against the real API on 9 Nov 2026:
//   conversations.info with a JSON body -> { ok:false, error:'invalid_arguments' } (missing required field: channel)
//   users.info         with a JSON body -> { ok:false, error:'user_not_found' }
// and the same calls form-encoded work. Every fake uses this one file, so a fake cannot drift back.
//
// Kept independent of hive-slack.js on purpose: the fake must not learn its rule from the code it
// is checking.

// Methods whose arguments Slack reads only from the query string or a form body.
export const SLACK_READ_METHOD = /^(?:(?:conversations|users|team|bots)\.[A-Za-z.]+|auth\.test)$/

/** The arguments real Slack would see: query string, then a form body; a JSON body only on write methods. */
export function slackArgs(method, contentType, raw, url = '') {
  const args = {}
  try { for (const [k, v] of new URL(String(url || '/'), 'http://fake-slack').searchParams) args[k] = v } catch { }
  const ct = String(contentType || '').toLowerCase()
  if (!raw) return args
  if (ct.includes('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(String(raw))) args[k] = v
  } else if (ct.includes('application/json')) {
    if (SLACK_READ_METHOD.test(String(method || ''))) return args // ignored, as the real API does
    try { Object.assign(args, JSON.parse(String(raw))) } catch { }
  }
  return args
}

/** What real Slack answers when a read method's required argument did not arrive; null when it did. */
export function slackArgsError(method, args = {}) {
  const missing = (field) => ({ ok: false, error: 'invalid_arguments', response_metadata: { messages: [`[ERROR] missing required field: ${field}`] } })
  const bad = (v) => v === undefined || v === '' || v === 'undefined' || v === 'null'
  switch (String(method || '')) {
    case 'conversations.info':
    case 'conversations.history':
      if (bad(args.channel)) return args.channel === 'undefined' || args.channel === 'null' ? { ok: false, error: 'channel_not_found' } : missing('channel')
      return null
    case 'conversations.replies':
      if (bad(args.channel)) return missing('channel')
      if (bad(args.ts)) return missing('ts')
      return null
    case 'users.info':
      return bad(args.user) ? { ok: false, error: 'user_not_found' } : null
    default:
      return null
  }
}
