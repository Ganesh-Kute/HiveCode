/**
 * Unified timestamp parsing and formatting for Hivecode chat and receipts.
 * Single source of truth used by:
 *   1. public/control.html (browser Control Room ago() and chat timestamps)
 *   2. hive-mailbox.js (hive_read_chat formatMessage)
 *   3. sync.js (HIVE_CHAT.md renderChat)
 *
 * Handles:
 *   - Unix microseconds (> 1e14), as emitted by hive-slack.js, hive-mcp-http.js, hive-gate.js
 *   - Unix milliseconds (> 1e11)
 *   - Existing "HH:MM:SS" strings (passed through as-is per Claude's directive)
 */

export function toMillis(at) {
  if (at == null || at === '') return null
  const num = typeof at === 'number' ? at : Number(at)
  if (!isNaN(num) && num > 0) {
    if (num > 1e14) {
      // Unix microseconds (> 100,000,000,000,000)
      return Math.round(num / 1000)
    }
    if (num > 1e11) {
      // Unix milliseconds (> 100,000,000,000)
      return Math.round(num)
    }
    if (num > 1e9) {
      // Unix seconds (> 1,000,000,000)
      return Math.round(num * 1000)
    }
    return Math.round(num)
  }
  return null
}

export function ago(at, now = Date.now()) {
  if (!at) return ''
  if (typeof at === 'string') {
    const num = Number(at)
    if (!isNaN(num) && num > 1e11) {
      return ago(num, now)
    }
    // String with clock time or text: print as is (matches control.html behavior)
    return at
  }
  const ms = toMillis(at)
  if (ms == null) return String(at)
  const d = Math.max(0, now - ms)
  const m = Math.floor(d / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export function formatTime(at, now = Date.now()) {
  if (!at) return ''
  if (typeof at === 'string') {
    const num = Number(at)
    if (!isNaN(num) && num > 1e11) {
      return formatTime(num, now)
    }
    return at
  }
  const ms = toMillis(at)
  if (ms == null) return String(at)
  return new Date(ms).toTimeString().slice(0, 8)
}

export function formatAt(at, { ago: isAgo = false, now = Date.now() } = {}) {
  return isAgo ? ago(at, now) : formatTime(at, now)
}
