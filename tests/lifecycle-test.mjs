// SUBSCRIPTION LIFECYCLE test — cancellation and failed renewal.
//
// TWO MONEY BUGS THIS CLOSES, and both were in one handler:
//
//   subscription.cancelled set the licence to 'canceled' IMMEDIATELY. A customer who cancels
//   on the 3rd of the month has paid through the 30th. Cutting access on the 3rd is not a
//   cancellation, it is the shape of a chargeback.
//
//   subscription.halted set it to 'suspended' IMMEDIATELY. A halt is almost always an
//   expired card -- the most common and most innocent failure there is -- and locking someone
//   out of their own workspace on the first failed charge loses a customer who would have
//   replaced the card in a minute.
//
// The fix keeps the licence ACTIVE and attaches a deadline. Which means the deadline columns
// are inert unless validate.js reads them, so both halves are asserted here: the webhook
// writes them, and the validator honours them.
//
// The third case is the one that would have been missed: a customer who FIXES their card must
// have the deadline CLEARED, or they get downgraded a week after their money arrived.
//
//   node tests/lifecycle-test.mjs
import http from 'http'
import crypto from 'crypto'
import { Readable } from 'stream'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const KEY = 'HC-PRO-' + 'A1B2C3D4'.repeat(4)
const SECRET = 'wh-secret'
let row = null

// ── fake PostgREST holding exactly one licence ──────────────────────────────────────────
const store = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') {
    const wantKey = (url.searchParams.get('license_key') || '').replace(/^eq\./, '')
    const wantSub = (url.searchParams.get('subscription_id') || '').replace(/^eq\./, '')
    const wantPay = (url.searchParams.get('payment_id') || '').replace(/^eq\./, '')
    const hit = row && ((wantKey && wantKey === row.license_key)
      || (wantSub && wantSub === row.subscription_id)
      || (wantPay && wantPay === row.payment_id))
    return res.end(JSON.stringify(hit ? [row] : []))
  }
  let body = ''
  for await (const c of req) body += c
  const patch = JSON.parse(body || '{}')
  if (req.method === 'PATCH') { row = { ...row, ...patch }; return res.end(JSON.stringify([row])) }
  if (req.method === 'POST') { row = Array.isArray(patch) ? patch[0] : patch; return res.end(JSON.stringify([row])) }
  res.statusCode = 405; res.end('[]')
})
await new Promise((r) => store.listen(0, '127.0.0.1', r))
process.env.SUPABASE_URL = `http://127.0.0.1:${store.address().port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
process.env.HIVE_GRACE_DAYS = '7'

const webhook = (await import('../api/webhook.js')).default
const validate = (await import('../api/validate.js')).default

const mkRes = () => {
  const o = { code: 0, body: null }
  return { setHeader() { }, status(c) { o.code = c; return this }, json(b) { o.body = b; return o }, end() { return o }, _o: o }
}
// A REAL readable stream, not an object with a `body` string.
//
// readRawBody() iterates the request and only falls back to JSON.stringify(req.body) when
// the stream is already consumed -- and that fallback re-serialises, which cannot reproduce
// the exact bytes Razorpay signed. Handing it a stream exercises the `exact: true` path,
// which is the one production takes. A test that passed only via the fallback would be
// asserting against a code path no real request uses.
function mkReq(raw) {
  const req = Readable.from([Buffer.from(raw, 'utf8')])
  req.method = 'POST'
  req.headers = { 'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex') }
  return req
}
async function fire(event, subscription) {
  const raw = JSON.stringify({ event, payload: { subscription: { entity: subscription } } })
  const res = mkRes()
  return (await webhook(mkReq(raw), res)) || res._o
}
async function check() {
  const res = mkRes()
  // An OBJECT, because validate.js reads req.body.licenseKey — Vercel parses JSON bodies
  // before the handler sees them, unlike the webhook which deliberately needs the raw bytes.
  const out = (await validate({ method: 'POST', body: { licenseKey: KEY }, headers: {} }, res)) || res._o
  return out.body
}

const SUB = 'sub_LIFECYCLE1'
const freshRow = (over = {}) => ({
  license_key: KEY, email: 'buyer@example.com', plan: 'pro', max_committers: 3,
  status: 'active', subscription_id: SUB, payment_id: 'pay_1',
  grace_until: null, access_until: null, lapse_reason: null, ...over,
})

console.log('\n# A healthy subscription is simply valid')
row = freshRow()
let v = await check()
T('valid', v.valid === true)
T('seats come from the record', v.seats === 3)
T('no deadline is reported when there is none', v.accessUntil === undefined && v.graceUntil === undefined)

console.log('\n# Cancellation: access runs to the END of the paid period')
row = freshRow()
const endSec = Math.floor((Date.now() + 20 * 86400000) / 1000)
let r = await fire('subscription.cancelled', { id: SUB, current_end: endSec })
T('the webhook accepts it', r.code === 200)
T('the licence stays ACTIVE, not canceled', row.status === 'active')
T('an access deadline is recorded', !!row.access_until)
T('...at the period end Razorpay reported', Math.abs(Date.parse(row.access_until) - endSec * 1000) < 2000)
T('...with the reason', row.lapse_reason === 'cancelled')
v = await check()
T('STILL VALID — they paid for this month', v.valid === true)
T('...and the deadline is surfaced for the dashboard', v.accessUntil === row.access_until)
T('...and the reason is surfaced', v.lapseReason === 'cancelled')

console.log('\n# ...and it lapses once that period is actually over')
row = freshRow({ access_until: new Date(Date.now() - 60000).toISOString(), lapse_reason: 'cancelled' })
v = await check()
T('past the paid period -> no longer valid', v.valid === false)
T('...and it says why, not just "invalid"', /cancelled/.test(v.reason || ''))
T('the row is still ACTIVE — nothing was deleted', row.status === 'active')

console.log('\n# A missing current_end must not revoke instantly')
row = freshRow()
await fire('subscription.cancelled', { id: SUB })
T('a missing period end still grants a deadline in the future', Date.parse(row.access_until) > Date.now())
row = freshRow()
await fire('subscription.cancelled', { id: SUB, current_end: Math.floor((Date.now() - 99 * 86400000) / 1000) })
T('a period end in the PAST is not honoured as immediate revocation', Date.parse(row.access_until) > Date.now())

console.log('\n# Failed renewal: 7 days of grace, not instant lockout')
row = freshRow()
r = await fire('subscription.halted', { id: SUB })
T('the webhook accepts it', r.code === 200)
T('the licence stays ACTIVE', row.status === 'active')
T('a grace deadline is set', !!row.grace_until)
const graceDays = (Date.parse(row.grace_until) - Date.now()) / 86400000
T('...about 7 days out', graceDays > 6.9 && graceDays < 7.1)
T('...with a reason support can read', row.lapse_reason === 'payment-failed')
v = await check()
T('STILL VALID during grace — an expired card is not a cancellation', v.valid === true)
T('...and the grace deadline is surfaced', v.graceUntil === row.grace_until)

console.log('\n# ...and it lapses when grace runs out')
row = freshRow({ grace_until: new Date(Date.now() - 60000).toISOString(), lapse_reason: 'payment-failed' })
v = await check()
T('past grace -> no longer valid', v.valid === false)
T('...and it says why', /payment failed/.test(v.reason || ''))

console.log('\n# Fixing the card CLEARS the deadline — the case that would have been missed')
row = freshRow({ grace_until: new Date(Date.now() + 3 * 86400000).toISOString(), lapse_reason: 'payment-failed' })
r = await fire('subscription.charged', { id: SUB, notes: { plan: 'pro', seats: '3' }, current_end: endSec })
T('a successful charge is processed', r.code === 200)
T('grace is cleared', row.grace_until === null)
T('access_until is cleared', row.access_until === null)
T('the reason is cleared', row.lapse_reason === null)
v = await check()
T('valid, with no deadline left hanging', v.valid === true && v.graceUntil === undefined)

console.log('\n# An explicit resume also clears deadlines')
row = freshRow({ grace_until: new Date(Date.now() + 86400000).toISOString(), lapse_reason: 'paused' })
await fire('subscription.resumed', { id: SUB })
T('resumed clears grace', row.grace_until === null && row.lapse_reason === null)

console.log('\n# Paused behaves like halted, not like cancelled')
row = freshRow()
await fire('subscription.paused', { id: SUB })
T('paused grants grace rather than ending access', !!row.grace_until && row.status === 'active')
T('...and is labelled as paused, not as a payment failure', row.lapse_reason === 'paused')

console.log('\n# A refund still cancels outright — that money went back')
row = freshRow()
const refundRaw = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { payment_id: 'pay_1' } } } })
const rres = mkRes()
await webhook(mkReq(refundRaw), rres)
T('a refunded licence is canceled', row.status === 'canceled')

console.log('\n# An unknown subscription is not invented')
row = null
r = await fire('subscription.halted', { id: 'sub_NEVER_SEEN' })
T('it is acknowledged but ignored', r.code === 200 && /unknown/.test(JSON.stringify(r.body)))

store.close()
console.log(`\n=== LIFECYCLE: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
