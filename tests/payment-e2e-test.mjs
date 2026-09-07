// PAYMENT, END TO END — every hop a real customer's money takes, in Razorpay's real order.
//
// THE BUG THIS EXISTS FOR, and it would have shipped:
//
// Switching from a one-off charge to a subscription changed the EVENT ORDER, and nothing
// tested the order. Razorpay fires `subscription.activated` FIRST, and that payload carries
// only the subscription entity -- there is no payment yet. So the licence row is created with
// `payment_id: null`.
//
// Meanwhile the browser's success handler receives `razorpay_payment_id` and polls
// `/api/license?payment_id=…`. That found nothing. Then `subscription.charged` arrived WITH a
// payment id, took the "existing licence" branch, and never recorded it.
//
// Net: a paying subscriber could never retrieve their own key. Not from the dialog, not from
// /recover. Their only route was the email -- and with RESEND_API_KEY unset there is no
// email, so a paid licence would sit in the database permanently unreachable.
//
// Every existing test passed throughout, because each one tested a single hop.
//
//   node tests/payment-e2e-test.mjs
import http from 'http'
import crypto from 'crypto'
import { Readable } from 'stream'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const SECRET = 'e2e-webhook-secret'
const SUB = 'sub_E2E12345'
const PAY = 'pay_E2E98765'
let rows = []

// ── a fake PostgREST that behaves like the real one for these four queries ──────────────
const store = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '')
  if (req.method === 'GET') {
    const k = eq('license_key'), sb = eq('subscription_id'), py = eq('payment_id')
    const hit = rows.filter((r) =>
      (k && r.license_key === k) || (sb && r.subscription_id === sb) || (py && r.payment_id === py))
    return res.end(JSON.stringify(hit))
  }
  let body = ''
  for await (const c of req) body += c
  const patch = JSON.parse(body || '{}')
  if (req.method === 'PATCH') {
    const k = eq('license_key')
    rows = rows.map((r) => (r.license_key === k ? { ...r, ...patch } : r))
    return res.end(JSON.stringify(rows.filter((r) => r.license_key === k)))
  }
  if (req.method === 'POST') {
    const rec = Array.isArray(patch) ? patch[0] : patch
    const i = rows.findIndex((r) => r.license_key === rec.license_key)
    if (i >= 0) rows[i] = { ...rows[i], ...rec }; else rows.push(rec)
    return res.end(JSON.stringify([rec]))
  }
  res.statusCode = 405; res.end('[]')
})
await new Promise((r) => store.listen(0, '127.0.0.1', r))
process.env.SUPABASE_URL = `http://127.0.0.1:${store.address().port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
process.env.RAZORPAY_KEY_ID = 'rzp_live_E2E'
process.env.RAZORPAY_KEY_SECRET = 'e2e-secret'
process.env.RAZORPAY_PLAN_ID = 'plan_E2E'

const webhook = (await import('../api/webhook.js')).default
const license = (await import('../api/license.js')).default
const validate = (await import('../api/validate.js')).default
const config = (await import('../api/config.js')).default

// Razorpay's server API, faked, so /api/subscribe can be exercised for real.
const realFetch = globalThis.fetch
globalThis.fetch = async (u, init) => {
  if (!String(u).includes('api.razorpay.com')) return realFetch(u, init)
  const b = JSON.parse(init.body || '{}')
  return new Response(JSON.stringify({ id: SUB, status: 'created', quantity: b.quantity }), { status: 200 })
}
const subscribe = (await import('../api/subscribe.js')).default

const mkRes = () => {
  const o = { code: 0, body: null }
  return { setHeader() { }, status(c) { o.code = c; return this }, json(b) { o.body = b; return o }, end() { return o }, _o: o }
}
const call = async (h, req) => { const r = mkRes(); return (await h(req, r)) || r._o }
const mkWebhookReq = (raw) => {
  const req = Readable.from([Buffer.from(raw, 'utf8')])
  req.method = 'POST'
  req.headers = { 'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex') }
  return req
}
const fire = (event, payload) => call(webhook, mkWebhookReq(JSON.stringify({ event, payload })))

console.log('\n# STEP 1 — the page asks whether checkout is even configured')
let r = await call(config, { method: 'GET' })
T('/api/config answers', r.code === 200)
T('it reports live mode', r.body.razorpayMode === 'live')
T('it never returns the secret', !JSON.stringify(r.body).includes('e2e-secret'))

console.log('\n# STEP 2 — the customer picks 3 seats and a subscription is created')
r = await call(subscribe, { method: 'POST', body: JSON.stringify({ seats: 3, email: 'buyer@example.com' }), headers: {} })
T('a subscription id comes back', r.code === 200 && r.body.subscriptionId === SUB)
T('the price shown matches the seats', r.body.monthlyTotal === 87)

console.log('\n# STEP 3 — subscription.activated lands FIRST, with NO payment entity')
// This is the real order, and the reason the bug existed.
r = await fire('subscription.activated', { subscription: { entity: { id: SUB, notes: { plan: 'pro', seats: '3' }, customer_email: 'buyer@example.com' } } })
T('the webhook issues a licence', r.code === 200 && r.body.licensed === true)
T('exactly one licence row exists', rows.length === 1)
const key = rows[0].license_key
T('it carries the seat count from notes', rows[0].max_committers === 3)
T('it carries the subscription id', rows[0].subscription_id === SUB)
T('...and payment_id is null, because no payment existed yet', !rows[0].payment_id)

console.log('\n# STEP 4 — the browser looks the key up. THIS is what used to fail.')
// The handler has razorpay_payment_id and razorpay_subscription_id, and sends both.
r = await call(license, { method: 'GET', query: { payment_id: PAY, subscription_id: SUB } })
T('the licence IS found, via the subscription id', r.code === 200 && r.body.found === true)
T('...and it is the right key', r.body.licenseKey === key)
T('...with the right seats', r.body.seats === 3)

// The regression, stated as its own assertion: payment id alone cannot work at this moment,
// which is exactly why the browser must send both.
r = await call(license, { method: 'GET', query: { payment_id: PAY } })
T('payment id ALONE finds nothing at this point (the old failure)', r.code === 404)

console.log('\n# STEP 5 — the relay validates the key the customer pastes')
r = await call(validate, { method: 'POST', body: { licenseKey: key }, headers: {} })
T('valid', r.body.valid === true)
T('seats come from the record, not the key', r.body.seats === 3)
T('plan is reported so the relay can size its limits', r.body.plan === 'pro')

console.log('\n# STEP 6 — subscription.charged arrives and BACKFILLS the payment id')
r = await fire('subscription.charged', {
  subscription: { entity: { id: SUB, notes: { plan: 'pro', seats: '3' } } },
  payment: { entity: { id: PAY, email: 'buyer@example.com' } },
})
T('it is treated as a renewal, not a new purchase', r.body.renewed === true)
T('STILL exactly one licence — no duplicate minted', rows.length === 1)
T('the payment id is now recorded', rows[0].payment_id === PAY)
r = await call(license, { method: 'GET', query: { payment_id: PAY } })
T('so payment id alone works from now on (what /recover needs)', r.code === 200 && r.body.found === true)

console.log('\n# STEP 7 — Razorpay retries the same event. Nothing may double.')
await fire('subscription.charged', {
  subscription: { entity: { id: SUB, notes: { plan: 'pro', seats: '3' } } },
  payment: { entity: { id: PAY } },
})
T('a retry does not mint a second licence', rows.length === 1)
T('...and does not change the key', rows[0].license_key === key)

console.log('\n# STEP 8 — a forged webhook is refused')
const forged = Readable.from([Buffer.from(JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_FAKE', notes: { seats: '99' } } } } }))])
forged.method = 'POST'; forged.headers = { 'x-razorpay-signature': 'deadbeef' }
r = await call(webhook, forged)
T('bad signature is rejected', r.code >= 400)
T('...and no licence was created for it', rows.length === 1)

console.log('\n# STEP 9 — seats change mid-life')
await fire('subscription.charged', {
  subscription: { entity: { id: SUB, notes: { plan: 'pro', seats: '10' } } },
  payment: { entity: { id: PAY } },
})
T('the seat count follows the subscription', rows[0].max_committers === 10)
r = await call(validate, { method: 'POST', body: { licenseKey: key }, headers: {} })
T('...and the relay sees the new number', r.body.seats === 10)

console.log('\n# STEP 10 — the customer cancels')
await fire('subscription.cancelled', { subscription: { entity: { id: SUB, current_end: Math.floor((Date.now() + 12 * 86400000) / 1000) } } })
r = await call(validate, { method: 'POST', body: { licenseKey: key }, headers: {} })
T('still valid — they paid through the period', r.body.valid === true)
T('and the end date is surfaced', !!r.body.accessUntil)
T('nothing was deleted', rows.length === 1 && rows[0].status === 'active')

console.log('\n# STEP 11 — a second, different customer does not collide')
const SUB2 = 'sub_OTHER', PAY2 = 'pay_OTHER'
await fire('subscription.activated', { subscription: { entity: { id: SUB2, notes: { plan: 'pro', seats: '1' }, customer_email: 'two@example.com' } } })
T('a second licence is issued', rows.length === 2)
T('...with a different key', rows[1].license_key !== key)
r = await call(license, { method: 'GET', query: { subscription_id: SUB2 } })
T('each customer resolves to their own licence', r.body.licenseKey === rows[1].license_key)
r = await call(license, { method: 'GET', query: { subscription_id: SUB } })
T('...and the first is unaffected', r.body.licenseKey === key)

console.log('\n# STEP 12 — the store goes down mid-lookup')
store.close()
r = await call(license, { method: 'GET', query: { subscription_id: SUB } })
T('a lookup failure is 503, never "not found"', r.code === 503)
r = await call(validate, { method: 'POST', body: { licenseKey: key }, headers: {} })
T('validation refuses to answer rather than answering "unpaid"', r.code === 503)
T('...and does not report valid:false as a verdict', r.body.valid !== true && /unavailable/i.test(r.body.error || ''))

globalThis.fetch = realFetch
console.log(`\n=== PAYMENT E2E: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
