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

// ───────────────────────────────────────────────────────────────────────────────────────
section('the licence email is the instruction manual')
// A buyer's only durable copy of the setup is this email. It previously told them to run
// "Hivecode: Set Licence Key", which is not a command the extension contributes — following
// it literally produced nothing and looked like a broken product. So the rendered bodies are
// checked against the extension's own command contributions.

const { _render } = await import('../api/_email.js')
const { TRACKS, MCP_ADD_COMMAND, SELF_HOST_NOTE } = await import('../shared/onboarding.js')
const ALL_STEPS = TRACKS.flatMap((t) => t.steps)
const contributedTitles = JSON.parse(
  await (await import('fs/promises')).readFile(new URL('../extension/package.json', import.meta.url), 'utf8'),
).contributes.commands.map((c) => c.title)

const mailArgs = { licenseKey: 'HC-PRO-0123456789ABCDEF0123456789ABCDEF', committers: '3 committers' }
const mailText = _render.textBody(mailArgs)
const mailHtml = _render.htmlBody(mailArgs)

// THE MCP CONFIG MUST CARRY THE LICENCE.
//
// It used to be `{"command":"npx","args":["-y","hivecode-mcp"]}` with no `env` block. So a
// customer paid, received a key, followed this email exactly, and the key never reached the
// relay: the seats they bought did nothing and nothing anywhere said so. The relay reads
// `?license=`, the client sends it from `$HIVE_LICENSE`, and the MCP env block is the only
// place it can come from on that route.
// The HTML body escapes quotes, so the same JSON reads as &quot;env&quot; there. Checking the
// raw form in both would assert a bug into existence: escaping that block is correct.
T('the MCP config carries an env block',
  mailText.includes('"env"') && /(&quot;|")env(&quot;|")/.test(mailHtml))
T('...naming HIVE_LICENSE', mailText.includes('HIVE_LICENSE') && mailHtml.includes('HIVE_LICENSE'))
T('...with the buyer’s REAL key, not a placeholder to substitute by hand',
  mailText.includes(`"HIVE_LICENSE": "${mailArgs.licenseKey}"`))
T('...in the HTML body too', mailHtml.includes(mailArgs.licenseKey))
T('no placeholder survives into a real customer email',
  !mailText.includes('YOUR-LICENCE-KEY') && !mailHtml.includes('YOUR-LICENCE-KEY'))

// The non-MCP route needs somewhere to put it too, and it must NOT be a project file.
T('the CLI route is documented', mailText.includes('~/.hivecode/config.json'))
T('...and the shell form', mailText.includes('HIVE_LICENSE=' + mailArgs.licenseKey))
T('the email never tells anyone to put the licence in .hive.json (it gets committed)',
  !/\.hive\.json/.test(mailText) && !/\.hive\.json/.test(mailHtml))
T('...nor into the join link (it gets shared)',
  !/relay\|room\|/.test(mailText))

T('both routes are offered, not just the editor one', TRACKS.length === 2)
for (const step of ALL_STEPS) {
  T(`text email carries step "${step.title}"`, mailText.includes(step.title))
  T(`html email carries step "${step.title}"`, mailHtml.includes(step.title))
  if (step.kind !== 'command') continue
  T(
    `"${step.literal}" is a command the extension really contributes`,
    contributedTitles.includes(step.literal),
  )
  T(`text email quotes it exactly`, mailText.includes(step.literal))
}
T('both bodies carry the licence key', mailText.includes(mailArgs.licenseKey) && mailHtml.includes(mailArgs.licenseKey))
T('both bodies carry the seat count', mailText.includes('3 committers') && mailHtml.includes('3 committers'))
T('the MCP registration command survives rendering', mailText.includes(MCP_ADD_COMMAND) && mailHtml.includes(MCP_ADD_COMMAND))
T('the self-hosting route is mentioned', mailText.includes(SELF_HOST_NOTE))
// `<your link>` inside a note would be eaten as an unknown tag if it were not escaped.
T('angle brackets in step notes are escaped for HTML', mailHtml.includes('&lt;your link&gt;'))
T('no raw placeholder tag leaked into the HTML', !mailHtml.includes('<your link>'))
T('the HTML body has a text alternative of similar substance', mailText.length > 600)

// ───────────────────────────────────────────────────────────────────────────────────────
section('the recovery page')
// Without an email service configured, this page IS licence delivery: Razorpay's own receipt
// carries the payment id, and the page turns it back into the key. So it has to exist, be
// reachable from the places customers actually look, and never grow an email lookup.

const fsp = await import('fs/promises')
const recoverPath = new URL('../public/recover.html', import.meta.url)
let recover = ''
try { recover = await fsp.readFile(recoverPath, 'utf8') } catch { /* reported below */ }

T('public/recover.html exists', recover.length > 0)
// This used to assert the literal string '/api/license?payment_id='. The page now builds the
// query, because a payment id is often the WRONG reference for a subscription customer: the
// licence row is created by subscription.activated, which carries no payment, so payment_id
// is null until a charge event lands. What matters is the behaviour, not the literal.
T('it queries the licence endpoint', recover.includes('/api/license?'))
T('it sends a payment id', recover.includes('payment_id='))
T('...and a subscription id, which is the only reference that works right after purchase',
  recover.includes('subscription_id='))
T('a sub_ reference is recognised as a subscription', /\/\^sub_\/i/.test(recover))
T('a deep link accepts either kind', recover.includes("get('subscription_id')"))
T('the input shape matches what api/license.js accepts', recover.includes('/^[A-Za-z0-9_]{6,64}$/'))
// The one thing this page must never do. api/license.js refuses email lookup on purpose;
// a form field here asking for an email would imply otherwise.
T('it does NOT offer lookup by email address', !/name="email"|type="email"/.test(recover))
T('a 503 is not reported as "you did not pay"', recover.includes('We cannot check right now'))
T('it accepts a prefilled ?payment_id= deep link', recover.includes("get('payment_id')"))
T('it works when served from the relay, which has no /api/license', recover.includes('https://hivecode.vercel.app'))
T('search engines are asked to skip it', recover.includes('name="robots" content="noindex"'))

const indexHtml = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8')
T('the site links to it from the footer', indexHtml.includes('href="/recover"'))
T('the FAQ answers "I lost my key"', /lost my licence key/i.test(indexHtml))

const vercelJson = JSON.parse(await fsp.readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
T(
  '/recover is routed, not just /recover.html',
  vercelJson.rewrites.some((r) => r.source === '/recover' && r.destination === '/recover.html'),
)
const relay = await fsp.readFile(new URL('../server.js', import.meta.url), 'utf8')
T("the relay serves it too (it hosts the site)", relay.includes("'/recover': 'recover.html'"))
T('the licence email points at it', mailText.includes('/recover') && mailHtml.includes('/recover'))

console.log(`\n=== BILLING: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
