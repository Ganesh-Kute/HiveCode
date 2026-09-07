// SUBSCRIPTIONS test — the fix for selling a perpetual licence as a monthly one.
//
// Before this, the checkout created a ONE-OFF payment while the page said "$29 / month" and
// the issued licence had no expiry. Every customer would have paid once and kept the product
// forever. The webhook was always ready for subscription events; nothing ever created a
// subscription.
//
// What is asserted here, in order of what would actually cost money if it broke:
//   1. the seat count is clamped SERVER-SIDE  — it arrives from a slider anyone can edit and
//      it decides the charge, so the browser's number must never be the authority
//   2. the KEY SECRET never leaves the server
//   3. a half-configured deployment says WHICH env var is missing, and charges nothing
//   4. `notes.seats` is present, because api/webhook.js reads the licence's seat count from it
//
//   node tests/subscribe-test.mjs
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// ── a fake Razorpay, installed over global fetch ────────────────────────────────────────
const realFetch = globalThis.fetch
let calls = []
let rzpMode = 'ok'
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.razorpay.com')) return realFetch(url, init)
  const body = JSON.parse(init.body || '{}')
  calls.push({ url: String(url), auth: (init.headers || {}).Authorization || '', body })
  if (rzpMode === 'reject') {
    return new Response(JSON.stringify({ error: { description: 'plan_id is invalid' } }), { status: 400 })
  }
  if (rzpMode === 'down') return new Response('gateway timeout', { status: 504 })
  if (rzpMode === 'noid') return new Response(JSON.stringify({ status: 'created' }), { status: 200 })
  return new Response(JSON.stringify({ id: 'sub_TEST123', status: 'created', quantity: body.quantity }), { status: 200 })
}

const mkRes = () => {
  const o = { code: 0, body: null, headers: {} }
  return {
    setHeader: (k, v) => { o.headers[k] = v },
    status(c) { o.code = c; return this },
    json(b) { o.body = b; return o },
    end() { return o },
    _o: o,
  }
}
const post = async (handler, body) => {
  const res = mkRes()
  const out = await handler({ method: 'POST', body: JSON.stringify(body), headers: {} }, res)
  return out || res._o
}

const handler = (await import('../api/subscribe.js')).default

console.log('\n# A half-configured deployment refuses clearly, and charges nothing')
delete process.env.RAZORPAY_KEY_ID
delete process.env.RAZORPAY_KEY_SECRET
delete process.env.RAZORPAY_PLAN_ID
let r = await post(handler, { seats: 3 })
T('no keys -> 503, not a crash', r.code === 503)
T('...and it names the missing keys', /RAZORPAY_KEY_ID/.test(r.body.error) && /Q461/.test(r.body.error))
T('...and nothing was sent to the payment provider', calls.length === 0)

process.env.RAZORPAY_KEY_ID = 'rzp_test_ID'
process.env.RAZORPAY_KEY_SECRET = 'sekrit'
r = await post(handler, { seats: 3 })
T('keys but no plan -> 503', r.code === 503)
T('...and it says a recurring PLAN is what is missing', /Q462/.test(r.body.error) && /RAZORPAY_PLAN_ID/.test(r.body.error))
T('...still nothing sent to the provider', calls.length === 0)

console.log('\n# A configured deployment creates a real subscription')
process.env.RAZORPAY_PLAN_ID = 'plan_MONTHLY_PER_SEAT'
calls = []
r = await post(handler, { seats: 5, email: 'buyer@example.com' })
T('returns 200 with a subscription id', r.code === 200 && r.body.subscriptionId === 'sub_TEST123')
T('it hit the SUBSCRIPTIONS endpoint, not payments', calls[0] && /\/v1\/subscriptions$/.test(calls[0].url))
T('the plan id is sent', calls[0].body.plan_id === 'plan_MONTHLY_PER_SEAT')
T('seats ride as `quantity` (per-unit plan)', calls[0].body.quantity === 5)
T('a finite billing cycle count is sent, as Razorpay requires', typeof calls[0].body.total_count === 'number' && calls[0].body.total_count > 1)
T('...and it is long enough to behave as until-cancelled', calls[0].body.total_count >= 60)
T('notes.seats is present — the webhook reads the licence seat count from it', calls[0].body.notes.seats === '5')
T('notes.plan is present', calls[0].body.notes.plan === 'pro')
T('the email is passed through when given', calls[0].body.notes.email === 'buyer@example.com')
T('the monthly total is echoed for the page to display', r.body.monthlyTotal === 145)

console.log('\n# The secret stays on the server')
T('auth is Basic over key_id:key_secret', /^Basic /.test(calls[0].auth))
T('the response body contains NO secret', !JSON.stringify(r.body).includes('sekrit'))
T('the response body contains no key id either', !JSON.stringify(r.body).includes('rzp_test_ID'))

console.log('\n# Seats are clamped server-side — the slider is a request, not the authority')
for (const [given, want, why] of [
  [999999, 100, 'above the plan ceiling'],
  [0, 1, 'below the floor'],
  [-40, 1, 'negative'],
  ['abc', 1, 'not a number'],
  [undefined, 1, 'absent'],
  [3.9, 3, 'fractional'],
]) {
  calls = []
  const rr = await post(handler, { seats: given })
  T(`${why} -> ${want} seat(s)`, calls[0] && calls[0].body.quantity === want && rr.body.seats === want)
}

console.log('\n# Provider failures never read as "your card was declined"')
rzpMode = 'reject'
r = await post(handler, { seats: 2 })
T('a 4xx from the provider surfaces as a config/input problem', r.code === 400 && /Q465/.test(r.body.error))
T('...and it includes the provider reason', /plan_id is invalid/.test(r.body.error))

rzpMode = 'down'
r = await post(handler, { seats: 2 })
T('a 5xx from the provider -> 503', r.code === 503 && /Q466/.test(r.body.error))
T('...and it states nothing was charged', /[Nn]othing was charged/.test(r.body.error))

rzpMode = 'noid'
r = await post(handler, { seats: 2 })
T('a 200 with no subscription id is treated as a failure', r.code === 503 && /Q464/.test(r.body.error))

rzpMode = 'ok'
console.log('\n# Method and body handling')
const res2 = mkRes()
const g = await handler({ method: 'GET', headers: {} }, res2) || res2._o
T('GET is refused', g.code === 405 && /Q460/.test(g.body.error))
const res3 = mkRes()
const bad = await handler({ method: 'POST', body: '{not json', headers: {} }, res3) || res3._o
T('malformed JSON -> 400, not a 500', bad.code === 400 && /Q463/.test(bad.body.error))

globalThis.fetch = realFetch
console.log(`\n=== SUBSCRIPTIONS: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
