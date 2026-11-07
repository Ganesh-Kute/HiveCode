// hive-authors.js -- who wrote what the room holds: the ONE authorsOf, shared by sync.js and hive-pr.js. A receipt counts only when verify(r) === true or verify(r).ok === true (a truthy {ok:false} used to count).
import { contentHash } from './substrate.js'

/**
 * Check whether a receipt is valid according to the optional verify function.
 * Handles both boolean returns and { ok: boolean } result objects (verifyReceipt).
 */
export function isReceiptValid(verify, r) {
  if (!verify) return true
  const v = verify(r)
  return v === true || Boolean(v && v.ok)
}

/**
 * The authors of a file's held content, newest-landed first, from verified receipts only.
 */
export function authorsOf(receipts, verify, roomText) {
  const ok = (receipts || []).filter((r) => r && r.author && isReceiptValid(verify, r))
  if (!ok.length) return { last: null, contributors: [], first: 0, receipts: [] }
  const want = typeof roomText === 'string' ? contentHash(roomText) : null
  let idx = -1
  if (want) {
    for (let i = ok.length - 1; i >= 0; i--) {
      if (ok[i].contentHash === want) {
        idx = i
        break
      }
    }
  }
  const held = idx >= 0 ? ok.slice(0, idx + 1) : ok
  const last = held[held.length - 1]
  const seen = new Map()
  for (const r of held) {
    if (!seen.has(r.author)) {
      seen.set(r.author, { author: r.author, name: r.name || 'agent', at: r.at || 0 })
    }
  }
  return {
    last: last ? { author: last.author, name: last.name || 'agent', at: last.at || 0 } : null,
    contributors: [...seen.values()],
    first: Math.min(...ok.map((r) => r.at || 0)),
    receipts: held,
  }
}
