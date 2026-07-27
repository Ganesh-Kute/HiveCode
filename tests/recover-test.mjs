// End-to-end check for the recovery page: serve public/ AND the real api/license.js handler
// over HTTP against a fake Supabase, then assert every status code the page branches on is a
// code the API actually produces. Without this, the page could handle four cases the server
// never returns (or miss one it does) and nobody would notice until a customer needed it.
//
//   node tests/recover-test.mjs
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log(`  ok    ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) } }

// ── fake PostgREST: one licence, against payment pay_REAL ────────────────────────────
const RECORD = {
  license_key: 'HC-PRO-0123456789ABCDEF0123456789ABCDEF',
  max_committers: 3,
  plan: 'pro',
  status: 'active',
  payment_id: 'pay_REAL',
  email: 'buyer@example.com',
}
let storeMode = 'ok'
const supabase = http.createServer((req, res) => {
  if (storeMode === 'down') { res.statusCode = 500; return res.end('boom') }
  const url = new URL(req.url, 'http://x')
  const want = (url.searchParams.get('payment_id') || '').replace(/^eq\./, '')
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(want === RECORD.payment_id ? [RECORD] : []))
})
await new Promise((r) => supabase.listen(0, '127.0.0.1', r))
process.env.SUPABASE_URL = `http://127.0.0.1:${supabase.address().port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const { default: licenseHandler } = await import(new URL('../api/license.js', import.meta.url))

// ── a server that mounts the static page and the real handler side by side ────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.js': 'text/javascript' }
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/license') {
    // Minimal shim of the Vercel req/res contract the handler is written against.
    const shim = {
      status(code) { res.statusCode = code; return shim },
      json(body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return shim },
      end() { res.end(); return shim },
    }
    return licenseHandler({ method: 'GET', query: Object.fromEntries(url.searchParams) }, shim)
  }
  const file = url.pathname === '/recover' ? 'recover.html' : url.pathname.slice(1)
  const full = path.join(ROOT, 'public', file)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.statusCode = 404; return res.end('nope') }
  res.setHeader('content-type', TYPES[path.extname(full)] || 'application/octet-stream')
  res.end(fs.readFileSync(full))
})
await new Promise((r) => app.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${app.address().port}`

const get = async (p) => {
  const res = await fetch(base + p)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, type: res.headers.get('content-type') || '', text, json }
}

// ── the page itself ──────────────────────────────────────────────────────────────────
console.log('\n# the page is served')
let r = await get('/recover')
T('GET /recover → 200', r.status === 200)
T('served as HTML', r.type.includes('text/html'))
T('the form is present', r.text.includes('id="form"') && r.text.includes('id="pid"'))
T('the live region for results exists', r.text.includes('aria-live="polite"'))
T('every referenced local asset exists', [...r.text.matchAll(/(?:src|href)="\/([^"#?]+)"/g)]
  .every((m) => m[1].startsWith('recover') || fs.existsSync(path.join(ROOT, 'public', m[1]))))

for (const tag of ['div', 'form', 'main', 'header', 'footer', 'p', 'button']) {
  const open = (r.text.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length
  const close = (r.text.match(new RegExp(`</${tag}>`, 'g')) || []).length
  T(`<${tag}> balanced (${open})`, open === close)
}

// ── the four API outcomes the page's script branches on ──────────────────────────────
console.log('\n# every branch in the page matches a real API response')
r = await get('/api/license?payment_id=pay_REAL')
T('a real reference returns 200', r.status === 200)
T('…with found:true and the key', r.json?.found === true && r.json?.licenseKey === RECORD.license_key)
T('…and seats from the record, not the key', r.json?.seats === 3)
T('…and the status the page prints', r.json?.status === 'active' && r.json?.active === true)

r = await get('/api/license?payment_id=pay_NOTHING')
T('an unknown reference returns 404 (the "not yet" branch)', r.status === 404)
T('…marked pending, not an error', r.json?.pending === true && r.json?.found === false)

r = await get('/api/license?payment_id=' + encodeURIComponent('has spaces!'))
T('a malformed reference returns 400', r.status === 400)

r = await get('/api/license')
T('a missing reference returns 400', r.status === 400)

storeMode = 'down'
r = await get('/api/license?payment_id=pay_REAL')
T('a store outage returns 503, NOT valid:false', r.status === 503)
T('…and never claims the licence does not exist', r.json?.found !== false)
storeMode = 'ok'

// ── the page must not be able to leak by email ────────────────────────────────────────
console.log('\n# the deliberate refusal holds')
r = await get('/api/license?email=' + encodeURIComponent(RECORD.email))
T('lookup by email is refused (400, no key)', r.status === 400 && !r.text.includes(RECORD.license_key))

app.close(); supabase.close()
console.log(`\n=== RECOVERY: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
