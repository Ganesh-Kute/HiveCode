// WHY FILES ARE NOT SYNCING (HIV-P13): does the diagnosis match reality, or just sound decisive?
//
//   node tests/relay-diagnosis-test.mjs
//
// THE DEFECT.
// Two hand-written copies told an operator why their files were not arriving, and both were
// confidently wrong in the same three ways. Measured 21 Sep 2026: a third agent announced that
// 49 files could not connect and that "the usual cause is the relay being full (Q430)". At that
// moment the relay reported 56 connections of 512, and limits.js keys its per-room counter on
// the FILE-room, so each file held three connections against a cap of 64. Q430 needed 512 and
// had 56; Q431 needed 64 and had 3. NEITHER REFUSAL COULD HAVE FIRED.
//
// The real event was the relay dropping room state -- /health went rooms 44 -> 0 -> 29 -> 44 --
// and every client reconnecting one socket per file. "The relay is full" and "the relay just
// dropped everyone and we are reconnecting" have an identical local symptom and need OPPOSITE
// responses. Telling someone to raise a limit that is 89% free is worse than silence: they do
// it, nothing changes, and they conclude the product is broken on exactly the evidence given.
//
// SO EVERY SECTION BELOW RUNS A REAL RELAY, CONFIGURED INTO THE STATE IT DESCRIBES, and asks for
// the diagnosis. Nothing hands diagnose() a constructed health object -- the module was never in
// doubt; what is in doubt is whether the numbers it reads mean what it says they mean. That
// distinction is learnings/testing-the-consumer-instead-of-the-derivation.md, and section A
// closes it properly: it makes the relay ACTUALLY refuse a connection with Q430 and checks the
// diagnosis agrees with the refusal that really happened.
//
// Sections E-G exist because the fix is a de-duplication (learnings/repair-the-class-not-the-
// copy.md): F COUNTS the producers so a third copy fails a test rather than shipping, and G
// plants a violation to prove F can actually see one.

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { WebSocket } from 'ws'
import {
  probeRelayHealth, diagnose, healthUrlFor, explainNotSyncing,
  RELAY_FULL, ROOM_CAP, NOT_CAPACITY, UNREACHABLE,
} from '../hive-relay-health.js'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

let port = 24900 + (process.pid % 900)
const startRelay = async (env = {}) => {
  const p = ++port
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(p), ...env } })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((res) => proc.stdout.on('data', (d) => /listening on/.test(d) && res()))
  return { proc, url: `ws://localhost:${p}`, port: p }
}
const openWs = (url, room) => new Promise((res) => {
  const ws = new WebSocket(`${url}/${room}`)
  const done = (v) => res(v)
  ws.on('open', () => done({ ws, refused: null }))
  ws.on('unexpected-response', (_, r) => done({ ws: null, refused: r.statusCode }))
  ws.on('error', () => done({ ws: null, refused: 'error' }))
  setTimeout(() => done({ ws: null, refused: 'timeout' }), 4000)
})

const live = []
try {
  // ─── A. THE RELAY ACTUALLY REFUSES, AND THE DIAGNOSIS AGREES WITH THE REFUSAL ──────────────
  console.log('\n# A. a relay that is genuinely full')
  {
    const r = await startRelay({ HIVE_MAX_CONNS_TOTAL: '1', HIVE_PERSIST_DIR: 'off' })
    live.push(r)
    const first = await openWs(r.url, 'a-room')
    T('A0 the first connection is admitted', !!first.ws, first.refused ? `refused ${first.refused}` : '')
    // THE REAL REFUSAL. Without this the section would only be testing arithmetic on a number
    // the relay printed; with it, the verdict is checked against a refusal that truly occurred.
    const second = await openWs(r.url, 'a-room-2')
    T('A1 the SECOND connection is genuinely REFUSED by the relay (503 = Q430)',
      second.refused === 503, `got ${second.refused}`)

    const p = await probeRelayHealth(r.url)
    const d = diagnose(p, { stuck: 7 })
    T('A2 and the diagnosis reads RELAY_FULL', d.verdict === RELAY_FULL, d.verdict)
    T('A3 it names the knob that actually helps (HIVE_MAX_CONNS_TOTAL)',
      /HIVE_MAX_CONNS_TOTAL/.test(d.text))
    T('A4 it names Q430, the code the relay really returned',
      /Q430/.test(d.text))
    T('A5 it reports the real numbers it was given, not an adjective',
      /1 of 1 connections/.test(d.text), d.text.slice(0, 120))
    try { first.ws && first.ws.close() } catch { }
    try { second.ws && second.ws.close() } catch { }
  }

  // ─── B. THE CASE THE OLD MESSAGE COULD NOT EXPRESS AT ALL ──────────────────────────────────
  console.log('\n# B. total headroom, but the per-room cap is the constraint')
  {
    const r = await startRelay({ HIVE_PERSIST_DIR: 'off' })
    live.push(r)
    const p = await probeRelayHealth(r.url)
    T('B0 setup: the relay reports plenty of total room', p.ok && p.health.connections < p.health.limits.maxConnsTotal * 0.5,
      p.ok ? `${p.health.connections}/${p.health.limits.maxConnsTotal}` : 'probe failed')
    T('B1 setup: and a free-tier per-room cap', p.ok && p.health.connsPerRoom <= 8, p.ok ? `connsPerRoom=${p.health.connsPerRoom}` : '')

    const d = diagnose(p, { stuck: 49 })
    T('B2 the diagnosis reads ROOM_CAP, not RELAY_FULL', d.verdict === ROOM_CAP, d.verdict)
    T('B3 it names HIVE_SEATS — the knob that actually applies here', /HIVE_SEATS/.test(d.text))
    T('B4 AND IT SAYS RAISING THE TOTAL WILL NOT HELP, which is the whole point',
      /will NOT help/i.test(d.text), d.text.slice(-150))
    T('B5 it names Q431, the per-room code, not just Q430', /Q431/.test(d.text))
  }

  // ─── C. THE REGRESSION THAT STARTED THIS: capacity is fine, so say so ─────────────────────
  console.log('\n# C. capacity is fine and the files are stuck anyway')
  {
    const r = await startRelay({ HIVE_SEATS: '4', HIVE_PERSIST_DIR: 'off' })
    live.push(r)
    const p = await probeRelayHealth(r.url)
    T('C0 setup: seats raise the per-room cap above free tier', p.ok && p.health.connsPerRoom > 8,
      p.ok ? `connsPerRoom=${p.health.connsPerRoom}` : 'probe failed')

    const d = diagnose(p, { stuck: 49 })
    T('C1 the diagnosis REFUSES to blame capacity', d.verdict === NOT_CAPACITY, d.verdict)
    T('C2 and says so in those words, so nobody changes a limit for nothing',
      /CAPACITY IS NOT THE CAUSE/.test(d.text))
    T('C3 it offers the cause that actually produced this on 21 Sep — reconnection',
      /reconnecting/i.test(d.text))
    T('C4 it names no knob to raise', !/HIVE_MAX_CONNS_TOTAL|HIVE_SEATS/.test(d.text), d.text.slice(-120))
    T('C5 and it still names the causes it could NOT rule out, rather than implying none remain',
      /secured|token|licence/i.test(d.text))
  }

  // ─── D. A PROBE THAT FAILS IS MORE SPECIFIC THAN A GUESS, NOT LESS ────────────────────────
  console.log('\n# D. the relay cannot be reached at all')
  {
    const p = await probeRelayHealth('ws://localhost:1', { timeoutMs: 1200 })
    const d = diagnose(p, { stuck: 3 })
    T('D1 an unreachable relay reads UNREACHABLE', d.verdict === UNREACHABLE, d.verdict)
    T('D2 and is explicitly NOT reported as a capacity problem',
      /NOT A CAPACITY PROBLEM/i.test(d.text))
    T('D3 it names no knob to raise — there is nothing to raise', !/HIVE_MAX_CONNS_TOTAL|HIVE_SEATS/.test(d.text))
    T('D4 the failure reason is carried, not swallowed', !!p.error, `error=${p.error}`)
    // A probe that worked and a relay that is healthy are different facts. Reporting the absence
    // of an answer as a clean bill of health is how monitors lie.
    T('D5 probe.ok means "the probe worked", and it is false here', p.ok === false)
  }

  // ─── E. THE URL IT TELLS YOU TO CHECK IS A URL ────────────────────────────────────────────
  console.log('\n# E. the placeholder that shipped for three weeks')
  {
    T('E1 wss:// becomes https://', healthUrlFor('wss://relay.example.com') === 'https://relay.example.com/health',
      String(healthUrlFor('wss://relay.example.com')))
    T('E2 ws:// becomes http://', healthUrlFor('ws://localhost:1234') === 'http://localhost:1234/health')
    T('E3 a trailing slash does not produce a double slash', healthUrlFor('wss://x.dev/') === 'https://x.dev/health')
    T('E4 an unusable relay string yields null rather than a broken URL', healthUrlFor('') === null)

    const out = (await explainNotSyncing('ws://localhost:1', { stuck: 2, timeoutMs: 800, trailer: 'Trailer kept.' })).text
    T('E5 the message contains the REAL url, substituted', /http:\/\/localhost:1\/health/.test(out), out.slice(0, 120))
    T('E6 and never the literal placeholder', !/<relay-http>/.test(out))
    T('E7 the caller\'s trailer survives verbatim', /Trailer kept\./.test(out))
  }

  // ─── F. ONE PRODUCER. COUNTED, not asserted in prose. ─────────────────────────────────────
  console.log('\n# F. the class is countable (repair-the-class-not-the-copy)')
  const scanned = []
  {
    // SCOPED TO WHAT WE SHIP, and that scoping is a decision rather than a convenience. The
    // second run flagged server.js — whose boot banner tells a RELAY OPERATOR at startup that a
    // free-tier room will not fit twelve agents. That is legitimate and it is a different
    // audience on a different machine at a different moment; collapsing it into the client's
    // failure path would move the message to someone who cannot act on it. server.js is not in
    // package.json files[], so scoping the count to the shipped package excludes it for a
    // principled reason rather than by naming an exception.
    //
    // The property this pins: among the files we hand to a user, exactly one assembles the
    // inferred capacity advice. A new shipped file that hand-writes it fails F2 by existing.
    const shipped = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files)
    const files = fs.readdirSync(ROOT).filter((f) => /\.(js|cjs|mjs)$/.test(f) && shipped.has(f))
    const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

    // THE SIGNATURE HAD TO BE NARROWED, and the first run is why. "mentions HIVE_SEATS" matched
    // limits.js and server.js, which READ the env var, and seed-hivecode-full.mjs, which
    // documents it. Reading a knob and telling an operator to turn it are different acts, and a
    // rule that conflates them reports five violations where there are none — then gets ignored.
    //
    // It also matched sync.js:993 legitimately: explain(code) turns a status the relay ACTUALLY
    // returned into the right advice, and has done correctly since 5 Sep. That is not a copy to
    // collapse, it is better evidence than anything this module infers, which is why sync.js now
    // prefers it and only falls back to /health when nothing refused with a code at all.
    //
    // So what must stay singular is the INFERRED diagnosis: advice assembled from counters rather
    // than from a refusal. Its signature is an imperative aimed at a knob.
    const ADVICE = /\b(?:Raise|raise|Set|set)\s+HIVE_(?:MAX_CONNS_TOTAL|SEATS)\b/
    const placeholder = [], advisors = []
    for (const f of files) {
      let src
      try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
      scanned.push(f)
      const code = strip(src)
      if (/<relay-http>/.test(code)) placeholder.push(f)
      if (ADVICE.test(code)) advisors.push(f)
    }

    T(`F1 no shipped file prints the "<relay-http>" placeholder in CODE (${scanned.length} files scanned)`,
      placeholder.length === 0, placeholder.join(', '))
    T('F2 exactly ONE module assembles the INFERRED capacity advice',
      advisors.length === 1 && advisors[0] === 'hive-relay-health.js', advisors.join(', ') || '(none — see G)')
    T('F5 and sync.js prefers the relay\'s OWN status code over that inference when it has one',
      /refusedCodes/.test(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8')))
    T('F3 sync.js gets the diagnosis from that module rather than writing its own',
      /from '\.\/hive-relay-health\.js'/.test(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8')))
    T('F4 hive-mcp.js does too',
      /from '\.\/hive-relay-health\.js'/.test(fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')))
  }

  // ─── G. ANTI-VACUITY: can F actually see a third copy? ────────────────────────────────────
  console.log('\n# G. the count can fail')
  {
    T(`G1 the scan looked at a real number of files, not zero`, scanned.length >= 10, `${scanned.length} files`)
    T('G2 and it looked at the two callers specifically',
      scanned.includes('sync.js') && scanned.includes('hive-mcp.js'))

    // Plant a fourth copy on disk and confirm F2's rule rejects it. Written to a temp file inside
    // ROOT because that is the only place F2 looks -- a violation planted somewhere the scan does
    // not reach would prove nothing, which was the exact shape of the version-scanner failure.
    const planted = path.join(ROOT, '__p13_planted_violation.js')
    try {
      fs.writeFileSync(planted, 'export const advice = "the relay is full; raise HIVE_MAX_CONNS_TOTAL on the relay"\n')
      // Treated as shipped, faithfully: scripts/check-files.mjs already REFUSES the package if an
      // imported file is missing from files[], so any real third producer is necessarily shipped.
      // Planting it outside that set would prove nothing — which was precisely how the version
      // scanner passed across 81 files while matching none of them.
      const shipped2 = new Set([...JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files, '__p13_planted_violation.js'])
      const files = fs.readdirSync(ROOT).filter((f) => /\.(js|cjs|mjs)$/.test(f) && shipped2.has(f))
      const ADVICE = /\b(?:Raise|raise|Set|set)\s+HIVE_(?:MAX_CONNS_TOTAL|SEATS)\b/
      const advisors = files.filter((f) => {
        const code = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        return ADVICE.test(code)
      })
      T('G3 A PLANTED SECOND PRODUCER IS CAUGHT — F2 is a guard, not decoration',
        advisors.includes('__p13_planted_violation.js') && advisors.length === 2, advisors.join(', '))
    } finally {
      try { fs.unlinkSync(planted) } catch { }
    }
    T('G4 the planted file was removed again', !fs.existsSync(planted))

    // The four verdicts must be genuinely different. One label for every state would pass A-D
    // individually if the assertions were sloppy about which label they expected.
    const seen = new Set([RELAY_FULL, ROOM_CAP, NOT_CAPACITY, UNREACHABLE])
    T('G5 the four verdicts are four distinct values', seen.size === 4, [...seen].join(','))
  }
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const r of live) { try { r.proc.kill() } catch { } }
  await sleep(200)
}

console.log(`\n=== HIV-P13 RELAY DIAGNOSIS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
