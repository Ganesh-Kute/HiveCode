// HIV-P20 — "am I private?" must be answerable without asking, and pinnable so it cannot
// be got wrong by omission.
//
// The defect this suite exists for is not a crash. It is a join that succeeds against the
// wrong relay: every status green, filesSynced climbing, and the team's source on a server
// they do not run. Nothing throws, so nothing reports it.
//
// Sections:
//   A  origin normalisation — the same relay written five ways is ONE relay
//   B  classification — which of these is ours, theirs, or nobody's
//   C  the pin refuses, and refuses BEFORE anything is published
//   D  a malformed pin is an error, never an empty pin
//   E  HIVE_PRIVATE turns the shipped fallback into a refusal
//   F  warnings that do not refuse
//   G  ANTI-VACUITY — the two copies of the public relay URL must not have drifted, and
//      every refusal code asserted above must actually be reachable

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  relayOrigin, classifyRelay, readPin, checkRelay, privacyLine, PUBLIC_DEFAULT_RELAY,
} from '../hive-privacy.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const seenCodes = new Set()
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

// ---------------------------------------------------------------- A: origin normalisation
sec('A  the same relay written five ways is ONE relay')
{
  const canon = relayOrigin('wss://relay.example.com')
  T('A1 bare wss host normalises', canon === 'wss://relay.example.com:443', String(canon))
  T('A2 a trailing slash is the same relay', relayOrigin('wss://relay.example.com/') === canon)
  T('A3 an explicit :443 is the same relay', relayOrigin('wss://relay.example.com:443') === canon)
  T('A4 case in the host does not matter', relayOrigin('wss://Relay.Example.COM') === canon)
  // A person pins what they copied out of a browser. If https:// did not match the wss://
  // the client dials, the guard would refuse a correct setup -- and a guard that fires on
  // the healthy path gets switched off, which is worse than not having it.
  T('A5 https:// pins the same relay as wss://', relayOrigin('https://relay.example.com') === canon)
  T('A6 a different PORT is a different relay',
    relayOrigin('wss://relay.example.com:8443') !== canon)
  T('A7 a different HOST is a different relay',
    relayOrigin('wss://relay.evil.com') !== canon)
  T('A8 garbage is null, not a relay', relayOrigin('not a url') === null)
  T('A9 empty is null, not a relay', relayOrigin('') === null)
  T('A10 a non-websocket scheme is null', relayOrigin('ftp://relay.example.com') === null)
}

// ------------------------------------------------------------------- B: classification
sec('B  which relay is this')
{
  T('B1 the shipped fallback is public-default',
    classifyRelay(PUBLIC_DEFAULT_RELAY).kind === 'public-default')
  T('B2 localhost is loopback', classifyRelay('ws://localhost:1234').kind === 'loopback')
  T('B3 127.0.0.1 is loopback', classifyRelay('ws://127.0.0.1:1234').kind === 'loopback')
  T('B4 192.168.x is private-lan', classifyRelay('ws://192.168.1.50:1234').kind === 'private-lan')
  T('B5 10.x is private-lan', classifyRelay('ws://10.0.0.7:1234').kind === 'private-lan')
  T('B6 172.16-31.x is private-lan', classifyRelay('ws://172.20.3.4:1234').kind === 'private-lan')
  T('B7 172.32.x is NOT private-lan (the range ends at 31)',
    classifyRelay('ws://172.32.3.4:1234').kind === 'own')
  T('B8 a company relay is "own"', classifyRelay('wss://relay.acme.com').kind === 'own')
  T('B9 wss is reported encrypted', classifyRelay('wss://relay.acme.com').encrypted === true)
  T('B10 ws is reported unencrypted', classifyRelay('ws://relay.acme.com').encrypted === false)
  T('B11 garbage classifies as unknown, not as safe',
    classifyRelay('???').kind === 'unknown')
}

// ------------------------------------------------------------------------- C: the pin
sec('C  the pin refuses, before anything is published')
{
  const env = { HIVE_RELAY_PIN: 'wss://relay.acme.com' }
  const good = checkRelay({ relay: 'wss://relay.acme.com', env })
  T('C1 the pinned relay is allowed', good.ok === true, good.code || '')

  const bad = checkRelay({ relay: PUBLIC_DEFAULT_RELAY, env })
  T('C2 any other relay is REFUSED', bad.ok === false)
  T('C3 the refusal carries Q550', bad.code === 'Q550', String(bad.code))
  if (bad.code) seenCodes.add(bad.code)
  T('C4 the refusal names the relay it was asked for',
    bad.detail.includes(PUBLIC_DEFAULT_RELAY), bad.detail.slice(0, 80))
  T('C5 the refusal names what it is pinned to',
    bad.detail.includes('wss://relay.acme.com:443'), bad.detail.slice(0, 120))
  // The whole point of refusing at this layer rather than after connecting: a caller that
  // honours ok:false has published nothing, so the refusal is not merely a warning about a
  // leak that already happened.
  T('C6 the refusal says nothing left the machine',
    /nothing was published|no file has left/i.test(bad.detail))

  T('C7 a pin written as https still admits the wss relay',
    checkRelay({ relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'https://relay.acme.com' } }).ok === true)
  T('C8 two pins are both honoured (staging + prod)',
    checkRelay({ relay: 'wss://staging.acme.com', env: { HIVE_RELAY_PIN: 'wss://relay.acme.com, wss://staging.acme.com' } }).ok === true)
  T('C9 ... and a third relay is still refused',
    checkRelay({ relay: 'wss://other.acme.com', env: { HIVE_RELAY_PIN: 'wss://relay.acme.com, wss://staging.acme.com' } }).ok === false)
  // ANTI-VACUITY for this whole section: with no pin set, C2's relay must be ALLOWED.
  // Without this, a checkRelay that refused everything would pass every test above.
  T('C10 with NO pin the same relay is allowed (so C2 refused for the pin, not by default)',
    checkRelay({ relay: PUBLIC_DEFAULT_RELAY, env: {} }).ok === true)
}

// ------------------------------------------------------------- D: a malformed pin errors
sec('D  a pin that cannot be parsed is an error, never an empty pin')
{
  const r = checkRelay({ relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'relay.acme.com' } })
  T('D1 a bare hostname is not a pin — it is REFUSED', r.ok === false)
  T('D2 the refusal carries Q552', r.code === 'Q552', String(r.code))
  if (r.code) seenCodes.add(r.code)
  T('D3 it says what was wrong with it', /not a relay URL/i.test(r.detail))
  T('D4 it shows the value it could not parse', r.detail.includes('relay.acme.com'))
  // This is the absence-rendered-as-a-value case: if a bad pin degraded to "no pin", the
  // operator would read a green join banner and conclude the machine was locked down.
  T('D5 a bad pin does NOT silently become no pin',
    readPin({ env: { HIVE_RELAY_PIN: 'nonsense' } }).pinned === true)
  T('D6 ... and it reports an error rather than an empty allow-list',
    !!readPin({ env: { HIVE_RELAY_PIN: 'nonsense' } }).error)
  T('D7 an unset pin is pinned:false (absence is absence)',
    readPin({ env: {} }).pinned === false)
  T('D8 one good pin and one typo is still an error, not a partial allow-list',
    checkRelay({ relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'wss://relay.acme.com,typo' } }).code === 'Q552')
}

// ------------------------------------------------------------------- E: HIVE_PRIVATE
sec('E  HIVE_PRIVATE turns the shipped fallback into a refusal')
{
  const r = checkRelay({ relay: PUBLIC_DEFAULT_RELAY, env: { HIVE_PRIVATE: '1' } })
  T('E1 the public fallback is REFUSED under HIVE_PRIVATE=1', r.ok === false)
  T('E2 the refusal carries Q551', r.code === 'Q551', String(r.code))
  if (r.code) seenCodes.add(r.code)
  T('E3 it explains that the fallback is reached by omission',
    /omission|nobody chose|missing link/i.test(r.detail))
  T('E4 a relay of your own is allowed under HIVE_PRIVATE=1',
    checkRelay({ relay: 'wss://relay.acme.com', env: { HIVE_PRIVATE: '1' } }).ok === true)
  T('E5 localhost is allowed under HIVE_PRIVATE=1',
    checkRelay({ relay: 'ws://localhost:1234', env: { HIVE_PRIVATE: '1' } }).ok === true)
  T('E6 HIVE_PRIVATE=0 is not HIVE_PRIVATE=1',
    checkRelay({ relay: PUBLIC_DEFAULT_RELAY, env: { HIVE_PRIVATE: '0' } }).ok === true)
}

// -------------------------------------------------------- F: warnings that do not refuse
sec('F  a verdict on every join, whether or not it refuses')
{
  const pub = checkRelay({ relay: PUBLIC_DEFAULT_RELAY, env: {} })
  T('F1 the public relay is admitted but SAYS SO', pub.ok === true && !!pub.warn)
  T('F2 ... in words a non-operator can act on',
    /run your own relay|HIVE_RELAY/i.test(pub.warn || ''))
  T('F3 the headline does not call the public relay private',
    !/PRIVATE/i.test(pub.headline), pub.headline)

  const plain = checkRelay({ relay: 'ws://relay.acme.com', env: {} })
  T('F4 plaintext ws:// to a real host warns about it', /plaintext|not encrypted/i.test(plain.warn || ''))
  T('F5 ... and still connects (this is a choice, not a defect)', plain.ok === true)

  const local = checkRelay({ relay: 'ws://127.0.0.1:1234', env: {} })
  T('F6 loopback ws:// is NOT warned about — it never leaves the machine', !local.warn)
  T('F7 loopback reads as private', /PRIVATE/i.test(local.headline), local.headline)

  const line = privacyLine('ws://127.0.0.1:1234')
  T('F8 privacyLine carries both the URL and the verdict',
    line.includes('ws://127.0.0.1:1234') && /PRIVATE/i.test(line), line)
}

// ------------------------------------------------- H: remote teams — mesh vs public tunnel
sec('H  a remote team: a private mesh is private, a public tunnel says what it is')
{
  // The two setups a remote team actually reaches for, and the first version of this module
  // got BOTH wrong: it told Tailscale users their source was "travelling the public internet
  // in plaintext" (it is WireGuard, end to end), and it told a cloudflared tunnel it was simply
  // "YOUR RELAY" (the provider decrypts at its edge and the URL is public).
  const ts = checkRelay({ relay: 'ws://100.101.102.103:1234', env: {} })
  T('H1 a Tailscale address (100.64.0.0/10) is a private network', ts.classification.kind === 'private-lan', ts.classification.kind)
  T('H2 ... with no plaintext alarm', !ts.warn, ts.warn || '')
  T('H3 a MagicDNS name (*.ts.net) is a private network too',
    classifyRelay('ws://relay-box.tail1234.ts.net:1234').kind === 'private-lan')
  // The range is 100.64 -- 100.127. Its edges are where a sloppy pattern leaks.
  T('H4 100.63.x.x is NOT in the mesh range', classifyRelay('ws://100.63.1.1:1234').kind === 'own')
  T('H5 100.128.x.x is NOT in the mesh range', classifyRelay('ws://100.128.1.1:1234').kind === 'own')
  T('H6 100.64.0.1 (first address) IS', classifyRelay('ws://100.64.0.1:1234').kind === 'private-lan')
  T('H7 100.127.255.254 (last address) IS', classifyRelay('ws://100.127.255.254:1234').kind === 'private-lan')

  const cf = checkRelay({ relay: 'wss://duncan-past-collins-silicon.trycloudflare.com', env: {} })
  T('H8 a cloudflared quick tunnel is classified as a tunnel', cf.classification.kind === 'tunnel', cf.classification.kind)
  T('H9 ... connects (it is the team\'s relay, not a defect)', cf.ok === true)
  T('H10 ... says the provider can read the traffic', /decrypts|can read/i.test(cf.warn || ''), cf.warn || '')
  T('H11 ... and tells them to set --secret', /--secret/.test(cf.warn || ''))
  T('H12 ... and never calls itself PRIVATE', !/PRIVATE/.test(cf.headline), cf.headline)
  T('H13 ngrok is recognised as a tunnel too', classifyRelay('wss://abc123.ngrok-free.app').kind === 'tunnel')
  // A lookalike must not pass: the pattern is anchored to the end of the host.
  T('H14 a host merely CONTAINING a tunnel domain is not a tunnel',
    classifyRelay('wss://trycloudflare.com.evil.example').kind === 'own')
  // Pinning is orthogonal to classification: a team may legitimately pin its tunnel URL.
  T('H15 a pin on a tunnel URL still admits that tunnel',
    checkRelay({ relay: 'wss://duncan-past-collins-silicon.trycloudflare.com',
      env: { HIVE_RELAY_PIN: 'wss://duncan-past-collins-silicon.trycloudflare.com' } }).ok === true)
}

// -------------------------------------------------------------------- G: anti-vacuity
sec('G  the suite is measuring something')
{
  // Two copies of the public relay URL exist by necessity: hive-mcp.js dials it, this
  // module decides whether it is public. If they drift, hive-privacy.js would classify the
  // relay the client actually uses as "own" -- a false PRIVATE verdict, which is the exact
  // failure this file was written to prevent, arriving through its own back door.
  const mcp = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
  const m = mcp.match(/HIVE_RELAY\s*\|\|\s*'([^']+)'/)
  T('G1 hive-mcp.js still declares its default relay where this test can read it', !!m)
  T('G2 hive-mcp.js and hive-privacy.js name the SAME public relay',
    !!m && relayOrigin(m[1]) === relayOrigin(PUBLIC_DEFAULT_RELAY),
    m ? `${m[1]} vs ${PUBLIC_DEFAULT_RELAY}` : '')

  // Every code the sections above claim to have seen must have actually been produced. A
  // checkRelay that returned ok:true forever would pass F and silently gut C, D and E.
  for (const code of ['Q550', 'Q551', 'Q552']) {
    T(`G3 ${code} was actually produced by a real call`, seenCodes.has(code))
  }

  // And the reverse: a happy path must exist, or "refuses everything" would pass C/D/E.
  T('G4 an unpinned, non-public, encrypted relay produces a clean ok with no warning',
    (() => { const r = checkRelay({ relay: 'wss://relay.acme.com', env: {} }); return r.ok && !r.warn && !r.code })())
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
