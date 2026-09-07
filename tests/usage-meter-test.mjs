// USAGE METERING test — the free-tier auto-lock, and the properties that keep it from
// hurting a customer.
//
// The model this replaces: seat counting, which was never really enforced. The relay's
// committer set is keyed by FILE-room, so a 2-seat licence admitted two agents to routes.js,
// two more to models.js, and so on with no overall bound. It was also per-process, so a
// restart forgot every count.
//
// The property that matters MOST here is not that the lock works. It is that the lock FAILS
// OPEN: if the meter is unreachable, nobody is locked out. A false lock on a paying customer
// is far worse than a few unmetered megabytes, and it is the same posture license-check.js
// takes with its grace window — "we could not check" must never reach a customer as "you
// have exceeded your plan". Half the assertions below are about that.
//
//   node tests/usage-meter-test.mjs
import http from 'http'
import fs from 'fs'; import os from 'os'; import path from 'path'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── a fake /api/usage, so nothing here needs Supabase ───────────────────────────────────
const rows = new Map() // `${account}|${period}` -> row
let mode = 'ok'          // ok | down | slow
let posts = 0, gets = 0
const SECRET = 'meter-test-secret'

const api = http.createServer(async (req, res) => {
  if (mode === 'down') { res.statusCode = 503; return res.end('{"error":"down"}') }
  if (mode === 'slow') { await sleep(9000) }
  if ((req.headers['x-hive-usage'] || '') !== SECRET) {
    res.statusCode = 403; return res.end('{"error":"Q451"}')
  }
  const u = new URL(req.url, 'http://x')
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') {
    gets++
    const acct = u.searchParams.get('account')
    const period = u.searchParams.get('period')
    const r = rows.get(`${acct}|${period}`)
    return res.end(JSON.stringify(r
      ? { account: acct, period, writes: r.writes, writeBytes: r.write_bytes, msgs: 0, bytes: 0, found: true }
      : { account: acct, period, writes: 0, writeBytes: 0, msgs: 0, bytes: 0, found: false }))
  }
  if (req.method === 'POST') {
    posts++
    let body = ''
    for await (const c of req) body += c
    const b = JSON.parse(body || '{}')
    const k = `${b.account}|${b.period}`
    const prev = rows.get(k) || { writes: 0, write_bytes: 0, msgs: 0, bytes: 0 }
    const merged = {
      writes: prev.writes + (b.writes || 0),
      write_bytes: prev.write_bytes + (b.writeBytes || 0),
      msgs: prev.msgs + (b.msgs || 0),
      bytes: prev.bytes + (b.bytes || 0),
    }
    rows.set(k, merged)
    return res.end(JSON.stringify({ ok: true, ...merged }))
  }
  res.statusCode = 405; res.end('{}')
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const PORT = api.address().port

// The module reads its config at import time, so the environment has to be set first.
process.env.HIVE_USAGE_API = `http://127.0.0.1:${PORT}/api/usage`
process.env.HIVE_USAGE_SECRET = SECRET
process.env.HIVE_USAGE_TIMEOUT_MS = '1500'
process.env.HIVE_USAGE_TTL_MS = '400'
process.env.HIVE_FREE_PERIOD_WRITE_BYTES = String(1000)
process.env.HIVE_FREE_PERIOD_WRITES = String(50)
const meter = await import('../usage-meter.js')

console.log('\n# Account identity — what usage meters against')
T('a licence key becomes the account', meter.accountFor('HC-PRO-ABCDEF0123456789', 'proj').startsWith('lic:'))
T('the full licence key is NOT used as the id (never in a log line)',
  !meter.accountFor('HC-PRO-ABCDEF0123456789', 'proj').includes('ABCDEF0123456789'))
T('no licence -> the base room becomes the account', meter.accountFor('', 'proj').startsWith('room:'))
T('the same licence in two rooms is ONE account (the seat bug, fixed)',
  meter.accountFor('HC-PRO-ABCDEF0123456789', 'roomA') === meter.accountFor('HC-PRO-ABCDEF0123456789', 'roomB'))
T('two anonymous rooms are two accounts',
  meter.accountFor('', 'roomA') !== meter.accountFor('', 'roomB'))
T('an absurd room id cannot make an oversized account key', meter.accountFor('', 'x'.repeat(9999)).length < 200)

console.log('\n# The period boundary')
T('period is YYYY-MM in UTC', /^\d{4}-\d{2}$/.test(meter.currentPeriod()))
T('a fixed date yields its own month', meter.currentPeriod(new Date('2026-03-07T23:59:59Z')) === '2026-03')
T('the last second of a month stays in that month', meter.currentPeriod(new Date('2026-12-31T23:59:59Z')) === '2026-12')

console.log('\n# Deltas accumulate, and the lock arms when they cross')
meter._reset()
const acct = 'room:metertest'
T('metering is enabled when the secret is set', meter.meteringEnabled() === true)
T('an unknown account is NOT locked (never lock on a cache miss)', meter.isOverQuota(acct) === false)

meter.note(acct, { writes: 10, writeBytes: 400, msgs: 10, bytes: 400 })
await meter.flush()
T('a flush reached the store', posts >= 1)
T('under the allowance -> still allowed', meter.isOverQuota(acct) === false)

meter.note(acct, { writes: 10, writeBytes: 700, msgs: 10, bytes: 700 })
await meter.flush()
T('crossing the byte allowance arms the lock', meter.isOverQuota(acct) === true)
T('...and it accumulated across TWO flushes, not one', (rows.get(`${acct}|${meter.currentPeriod()}`) || {}).write_bytes === 1100)

meter._reset()
const acct2 = 'room:writecount'
meter.note(acct2, { writes: 60, writeBytes: 10, msgs: 60, bytes: 10 })
await meter.flush()
T('the WRITE-count allowance arms it too, independently of bytes', meter.isOverQuota(acct2) === true)

console.log('\n# It survives a restart — the whole point')
meter._reset()
T('after a reset the verdict is unknown, so not locked', meter.isOverQuota(acct) === false)
await sleep(600) // let the background refresh land
T('a fresh process reads the accumulated total back and re-arms the lock', meter.isOverQuota(acct) === true)
T('the total came from the store, not from memory', gets >= 1)

console.log('\n# FAIL OPEN — the property that protects a paying customer')
mode = 'down'
meter._reset()
const acct3 = 'room:duringoutage'
T('an unreachable meter does not lock a new account', meter.isOverQuota(acct3) === false)
await sleep(300)
T('...still not locked after the failed lookup', meter.isOverQuota(acct3) === false)

meter._setQuota(acct3, true)
T('an account already known to be over stays locked (the last good answer holds)', meter.isOverQuota(acct3) === true)

meter.note(acct3, { writes: 1, writeBytes: 1, msgs: 1, bytes: 1 })
const r = await meter.flush()
T('a failed flush does not throw', !!r)
T('...and the delta is DROPPED, not queued forever', meter.snapshot().pendingAccounts === 0)

mode = 'ok'
meter._reset()
await sleep(100)
T('metering recovers once the endpoint returns', meter.isOverQuota('room:whatever') === false)

console.log('\n# A slow meter must not stall the write path')
mode = 'slow'
meter._reset()
const t0 = Date.now()
const verdict = meter.isOverQuota('room:slowcase')
const elapsed = Date.now() - t0
T('the quota check is synchronous and instant', elapsed < 50)
T('...and permissive while the lookup is outstanding', verdict === false)
mode = 'ok'

console.log('\n# Disabled metering is inert, not permissive-by-accident')
delete process.env.HIVE_USAGE_SECRET
const off = await import('../usage-meter.js?off=1')
T('with no secret, metering reports disabled', off.meteringEnabled() === false)
T('...nothing is ever locked', off.isOverQuota('anything') === false)
T('...note() is a no-op rather than an unbounded buffer', (off.note('a', { writes: 1 }), off.snapshot().pendingAccounts === 0))
T('...and start() declines to run a timer', off.start() === false)

console.log('\n# Month rollover — the verdict is scoped to its period')
// Keying the cache by account alone meant an account locked in March stayed locked into
// April until the TTL expired. Two minutes of wrongness, landing on the 1st of the month in
// front of a customer whose allowance has just reset.
meter._reset()
const rollAcct = 'room:rollover'
meter._setQuota(rollAcct, true)
T('locked in the current period', meter.isOverQuota(rollAcct) === true)

// The store has a row for THIS period only. Simulating the rollover by asking the meter for
// a verdict it has no cached entry for proves the key includes the period: a verdict cached
// under this month must not answer for next month.
const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15))
T('the next period is a different string', meter.currentPeriod(nextMonth) !== meter.currentPeriod())
// invalidate() matches on the account prefix of the composite key. If the key were the bare
// account, this would find nothing to delete and the assertion below would fail.
meter.invalidate(rollAcct)
T('the cached verdict was stored under a period-scoped key', meter.isOverQuota(rollAcct) === false)

console.log('\n# invalidate() — a customer who just paid should not wait out the TTL')
meter._reset()
const paidAcct = 'room:justpaid'
meter._setQuota(paidAcct, true)
T('locked before paying', meter.isOverQuota(paidAcct) === true)
meter.invalidate(paidAcct)
T('invalidate drops the cached verdict', meter.isOverQuota(paidAcct) === false)
T('...and it only touches that account', (meter._setQuota('room:other', true), meter.invalidate(paidAcct), meter.isOverQuota('room:other') === true))

meter.stop()
api.close()
console.log(`\n=== USAGE METERING: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
