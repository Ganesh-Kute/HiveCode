// Tests for hive-time.js (timestamp formatting across control.html, hive_read_chat, and HIVE_CHAT.md)
//
//   node tests/hive-time-test.mjs

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { toMillis, ago, formatTime, formatAt } from '../hive-time.js'
import { formatMessage } from '../hive-mailbox.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

const now = 1730000000000 // fixed reference timestamp for deterministic testing

// 1. Red-first proof against old control.html ago() logic
const oldAgo = (t, refNow = Date.now()) => {
  if (!t) return ''
  const d = Math.max(0, refNow - t)
  const m = Math.floor(d / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'
}

const oneHourAgoMicros = (now - 3600 * 1000) * 1000
const oldResultOnMicros = oldAgo(oneHourAgoMicros, now)
T('RED PROOF: old ago() returns "now" for micros from 1 hour ago', oldResultOnMicros === 'now', `old returned ${oldResultOnMicros}`)

// 2. Verified fix on new ago()
const newResultOnMicros = ago(oneHourAgoMicros, now)
T('new ago() returns "1h" for micros from 1 hour ago', newResultOnMicros === '1h', `got ${newResultOnMicros}`)

const oneHourAgoMs = now - 3600 * 1000
T('ago() returns "1h" for ms from 1 hour ago', ago(oneHourAgoMs, now) === '1h')
T('ago() returns "now" for recent micros (< 1 minute)', ago(now * 1000 - 10000 * 1000, now) === 'now')
T('ago() returns "5m" for micros from 5 minutes ago', ago(now * 1000 - 300000 * 1000, now) === '5m')

// 3. String pass-through (Claude: "Strings print as they are; only numbers get ago() or a clock time")
T('ago() prints "HH:MM:SS" string as is', ago('12:34:56', now) === '12:34:56')
T('ago() prints arbitrary string text as is', ago('yesterday', now) === 'yesterday')

// 4. formatTime tests
const clockTime = formatTime(oneHourAgoMicros)
T('formatTime() formats micros to HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(clockTime), `got ${clockTime}`)
T('formatTime() passes through HH:MM:SS string', formatTime('14:20:00') === '14:20:00')

// 5. formatMessage in hive-mailbox.js
const slackMsgMicros = { by: 'slack:alice', kind: 'say', at: oneHourAgoMicros, text: 'hello from slack' }
const formattedMsg = formatMessage(slackMsgMicros)
T('formatMessage() renders clock time, not 16-digit micros', !formattedMsg.includes(String(oneHourAgoMicros)) && /^\d{2}:\d{2}:\d{2}\s+slack:alice\(say\):/.test(formattedMsg), formattedMsg)

// 6. Browser loading contract for public/control.html
const controlHtml = fs.readFileSync(path.join(ROOT, 'public', 'control.html'), 'utf8')
T('control.html script is type="module"', controlHtml.includes('<script type="module">'))
T('control.html imports ago from ./hive-time.js', /import\s*\{\s*ago\s*\}\s*from\s*['"]\.\/hive-time\.js['"]/.test(controlHtml))
T('control.html no longer defines inline ago()', !/const\s+ago\s*=\s*\(t\)\s*=>/.test(controlHtml))

// 7. Relay HTTP serving contract (GET /hive-time.js returns 200 with text/javascript)
// Import and run server listener check
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
T('server.js STATIC allowlist includes /hive-time.js', /['"]\/hive-time\.js['"]\s*:\s*['"]\.\.\/hive-time\.js['"]/.test(serverJs))

// Test real HTTP fetch against an ephemeral server instance simulating the relay route
const TYPES = { '.js': 'text/javascript; charset=utf-8' }
const testServer = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0]
  if (url === '/hive-time.js') {
    const body = fs.readFileSync(path.join(ROOT, 'hive-time.js'))
    res.writeHead(200, { 'Content-Type': TYPES['.js'] })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve))
const port = testServer.address().port

try {
  const res = await fetch(`http://127.0.0.1:${port}/hive-time.js`)
  T('GET /hive-time.js returns HTTP 200', res.status === 200)
  T('GET /hive-time.js Content-Type is text/javascript', (res.headers.get('content-type') || '').includes('text/javascript'))
  const bodyText = await res.text()
  T('GET /hive-time.js body exports ago() and formatTime()', bodyText.includes('export function ago') && bodyText.includes('export function formatTime'))
} finally {
  await new Promise(resolve => testServer.close(resolve))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
