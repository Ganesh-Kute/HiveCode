// Billing + licensing tests.
//
// This covers the path that decides who gets in and who pays, so it is tested against the
// real modules with fake HTTP endpoints rather than mocks of our own code.
//
//   node tests/billing-test.mjs
//
// The headline case is REGRESSION: BYPASS — `HC-PRO-9999-…` used to admit 9,999 committers
// because the relay parsed entitlement out of the key string. Seats must come from the
// record, always.

import http from 'http'
import crypto from 'crypto'
import {
  PLANS,
  amountInMinorUnits,
  clampSeats,
  formatLicenseKey,
  isWellFormedLicenseKey,
  monthlyTotal,
  normalizeLicenseKey,
  parseLicenseKey,
} from '../shared/license.js'

let pass = 0, fail = 0
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}
const section = (s) => console.log(`\n# ${s}`)

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })

// ── the shared format ────────────────────────────────────────────────────────────────
section('shared/license.js — format and money maths')

const token = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const goodKey = formatLicenseKey('pro', token)
T('formatLicenseKey builds HC-PRO-<32 hex>', goodKey === `HC-PRO-${token}`)
T('parse accepts a well-formed key', parseLicenseKey(goodKey)?.token === token)
T('parse is case- and whitespace-insensitive', isWellFormedLicenseKey(`  hc-pro-${token.toLowerCase()} `))
T('normalize upper-cases and trims', normalizeLicenseKey(` hc-pro-abc `) === 'HC-PRO-ABC')

// The old format carried the seat count. It must no longer be accepted at all, so nothing
// can go on reading entitlement out of a key.
T('rejects the OLD seats-in-key format', !isWellFormedLicenseKey('HC-PRO-9999-pay_ABC123'))
T('rejects a bare prefix', !isWellFormedLicenseKey('HC-PRO-'))
T('rejects the legacy HIVE-PRO- format', !isWellFormedLicenseKey('HIVE-PRO-deadbeef'))
T('rejects a short token', !isWellFormedLicenseKey('HC-PRO-ABC'))
T('rejects a non-hex token', !isWellFormedLicenseKey(`HC-PRO-${'Z'.repeat(32)}`))
T('rejects the free plan as a key', !isWellFormedLicenseKey(`HC-FREE-${token}`))
T('rejects empty and null input', !isWellFormedLicenseKey('') && !isWellFormedLicenseKey(null))

T('seats clamp to the plan floor', clampSeats(PLANS.pro, 0) === 1 && clampSeats(PLANS.pro, -20) === 1)
T('seats clamp to the plan ceiling', clampSeats(PLANS.pro, 5000) === 100)
T('seats truncate fractions', clampSeats(PLANS.pro, 3.9) === 3)
T('seats survive garbage', clampSeats(PLANS.pro, Number.NaN) === 1)
T('monthly total is per seat', monthlyTotal(PLANS.pro, 5) === 145)
T('total uses clamped seats, never raw input', monthlyTotal(PLANS.pro, 99999) === 2900)
T('razorpay amount is in minor units', amountInMinorUnits(PLANS.pro, 2) === 5800)

// ── relay-side verification ──────────────────────────────────────────────────────────
section('license-check.js — the relay trusts the record, not the key')

// A validator that reports 2 seats for one specific key and nothing for anything else.
let validatorCalls = 0
let validatorMode = 'ok'
const validator = await listen(async (req, res) => {
  validatorCalls++
  if (validatorMode === 'down') { res.statusCode = 500; return res.end('boom') }
  const body = JSON.parse((await readBody(req)) || '{}')
  res.setHeader('content-type', 'application/json')
  if (body.licenseKey === goodKey) {
    return res.end(JSON.stringify({ valid: true, plan: 'pro', seats: 2, status: 'active' }))
  }
  return res.end(JSON.stringify({ valid: false, plan: null, seats: 0, status: null }))
})
process.env.HIVE_LICENSE_API = `http://127.0.0.1:${validator.port}/api/validate`
const { verifyLicense, _clearCache, _ageCache } = await import('../license-check.js')

let v = await verifyLicense(goodKey)
T('a real key is admitted', v.valid === true)
T('seats come from the validator (2), not the key', v.seats === 2)

// THE REGRESSION. Under the old relay this string granted 9,999 committers.
v = await verifyLicense('HC-PRO-9999-pay_ANYTHING')
T('REGRESSION: HC-PRO-9999-… is refused outright', v.valid === false)
T('REGRESSION: it grants zero seats', v.seats === 0)
T('REGRESSION: refused on shape, without a network call', v.source === 'shape')

// A well-formed key that was never bought must still be refused.
v = await verifyLicense(formatLicenseKey('pro', 'F'.repeat(32)))
T('a well-formed but unknown key is refused', v.valid === false && v.source === 'api')

const before = validatorCalls
await verifyLicense(goodKey)
T('a repeat check is served from cache', validatorCalls === before)

// Grace: an outage must not evict someone who has paid.
validatorMode = 'down'
_clearCache()
v = await verifyLicense(goodKey)
T('validator down with no cached grant → refused', v.valid === false && v.source === 'unavailable')
T('and it is reported as unavailable, not as unpaid', v.reason === 'validator unreachable')

validatorMode = 'ok'
await verifyLicense(goodKey) // re-warm the cache
// Age the entry past its re-check window but well inside the grace window, so the next
// call really does attempt the network and really does fall back.
_ageCache(11 * 60 * 1000)
validatorMode = 'down'
v = await verifyLicense(goodKey)
T('GRACE: validator down but previously valid → still admitted', v.valid === true)
T('GRACE: seats are preserved through the outage', v.seats === 2)
T('GRACE: the source says so, so logs are honest', v.source === 'grace')
validator.server.close()

// ── the webhook ──────────────────────────────────────────────────────────────────────
section('api/webhook.js — only Razorpay may mint a licence')

const SECRET = 'test_webhook_secret'
const stored = []
const supabase = await listen(async (req, res) => {
  const raw = await readBody(req)
  res.setHeader('content-type', 'application/json')
  if (req.method === 'POST') {
    const rows = JSON.parse(raw)
    stored.push(...rows)
    return res.end(JSON.stringify(rows))
  }
  if (req.method === 'PATCH') {
    const patch = JSON.parse(raw)
    const row = { ...(stored[0] || {}), ...patch }
    if (stored.length) stored[0] = row
    return res.end(JSON.stringify([row]))
  }
  // GET — idempotency lookups. Match on whatever the query filters by.
  const url = new URL(req.url, 'http://x')
  const q = url.search
  const found = stored.filter(
    (r) =>
      (q.includes('payment_id=eq.') && q.includes(String(r.payment_id))) ||
      (q.includes('subscription_id=eq.') && r.subscription_id && q.includes(String(r.subscription_id))) ||
      (q.includes('license_key=eq.') && q.includes(String(r.license_key))),
  )
  return res.end(JSON.stringify(found))
})
process.env.SUPABASE_URL = `http://127.0.0.1:${supabase.port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_test'
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
delete process.env.RESEND_API_KEY // exercise the "email not configured" path

const webhook = (await import('../api/webhook.js')).default

const mockRes = () => {
  const r = { statusCode: 0, body: null }
  r.status = (c) => { r.statusCode = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.end = () => r
  return r
}
const mockReq = (raw, { signed = true, method = 'POST' } = {}) => {
  const sig = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
  const req = {
    method,
    headers: { 'x-razorpay-signature': signed ? sig : 'deadbeef' },
    body: raw ? JSON.parse(raw) : undefined,
    query: {},
  }
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(raw) }
  return req
}

const paymentEvent = (id, seats, email) =>
  JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id, email, notes: { plan: 'pro', seats: String(seats) } } } },
  })

let res = mockRes()
await webhook(mockReq(paymentEvent('pay_forged', 5, 'attacker@example.com'), { signed: false }), res)
T('an unsigned/forged event is rejected 401', res.statusCode === 401)
T('and no licence was minted for it', stored.length === 0)

res = mockRes()
await webhook(mockReq(paymentEvent('pay_ok1', 3, 'buyer@example.com')), res)
T('a correctly signed payment.captured is accepted', res.statusCode === 200)
T('payment.captured mints a licence (the old code ignored this event)', stored.length === 1)
T('the stored key matches the shared format', isWellFormedLicenseKey(stored[0]?.license_key || ''))
T('seats are stored from the notes', stored[0]?.max_committers === 3)
T('the buyer email is stored for delivery', stored[0]?.email === 'buyer@example.com')
T('status starts active', stored[0]?.status === 'active')
T('a missing Resend key does not fail the webhook', res.body?.emailed === false)

const mintedCount = stored.length
res = mockRes()
await webhook(mockReq(paymentEvent('pay_ok1', 3, 'buyer@example.com')), res)
T('IDEMPOTENT: a Razorpay retry does not mint a second licence', stored.length === mintedCount)
T('the retry is acknowledged as a renewal', res.body?.renewed === true)

res = mockRes()
await webhook(mockReq(paymentEvent('pay_absurd', 100000, 'greedy@example.com')), res)
T('seats in the notes are clamped to the plan ceiling', stored[stored.length - 1]?.max_committers === 100)

delete process.env.RAZORPAY_WEBHOOK_SECRET
res = mockRes()
await webhook(mockReq(paymentEvent('pay_nosecret', 1, 'x@y.com')), res)
T('with no secret configured the webhook fails CLOSED (500, not "process it")', res.statusCode === 500)
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET

res = mockRes()
await webhook(mockReq('', { method: 'GET' }), res)
T('GET is rejected', res.statusCode === 405)

supabase.server.close()

console.log(`\n=== BILLING: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
