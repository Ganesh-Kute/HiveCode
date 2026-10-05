// HIV-P20 — self-hosting, end to end, against a relay this test actually starts.
//
// The claim under test is the one a company asks before it will try this at all:
//
//   "We can run the relay ourselves, and then our source never touches your server."
//
// That claim has lived in docs/SELF_HOSTING.md for months with nothing behind it. This
// suite is the thing behind it. It starts a REAL relay process, syncs a REAL file between
// two REAL clients through it, and then checks the two things that make the claim true
// rather than merely plausible:
//
//   - the bytes went to THIS relay (its own counters moved), and
//   - a client pinned to this relay REFUSES the public one instead of quietly using it.
//
// The second is the one that matters. A self-host guide that only proves "a private relay
// works" is proving the easy half; the failure mode in the field is one teammate whose
// agent fell back to the shipped default, joined successfully, and published the repo
// somewhere nobody chose. That is not a crash, it is a green join.
//
// Sections:
//   A  a relay of our own comes up and answers for itself
//   B  two clients sync a file through it
//   C  the traffic went HERE (anti-vacuity: the relay's own counters moved)
//   D  a pinned client refuses the public relay -- in the real client path, not a unit test
//   E  persistence: the room survives everyone disconnecting
//   F  anti-vacuity on the suite itself

import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { PUBLIC_DEFAULT_RELAY } from '../hive-privacy.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

function getJSON(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-selfhost-'))
const DATA = path.join(TMP, 'relay-data')
const DIR_A = path.join(TMP, 'alice')
const DIR_B = path.join(TMP, 'bob')
for (const d of [DATA, DIR_A, DIR_B]) fs.mkdirSync(d, { recursive: true })

const PORT = await freePort()
const RELAY = `ws://127.0.0.1:${PORT}`
const HEALTH = `http://127.0.0.1:${PORT}/health`
const ROOM = 'selfhost-' + Math.random().toString(36).slice(2, 8)

let relayProc = null
const cleanup = () => {
  try { if (relayProc) relayProc.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}
process.on('exit', cleanup)

// ------------------------------------------------------- A: a relay of our own comes up
sec('A  a relay of our own comes up and answers for itself')
{
  // hive-relay.js, the command the guide tells people to run, not server.js with an env built here:
  // until 3 Oct this started server.js directly, so it measured the env this file chose and never
  // what `npx hivecode-relay` sets. HIVE_ENFORCE_CLAIMS and HIVE_JWT_SECRET are blanked so an
  // operator's defaults are what get measured, not whatever the shell running the suite exports.
  relayProc = spawn(process.execPath, [path.join(ROOT, 'hive-relay.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: DATA, HIVE_SEATS: '25', HIVE_RELAY_PIN: '', HIVE_PRIVATE: '', HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let relayErr = ''
  relayProc.stderr.on('data', (d) => { relayErr += d.toString() })
  relayProc.stdout.resume() // the banner; unread, a full pipe would stall the relay

  let health = null
  for (let i = 0; i < 60 && !health; i++) { health = await getJSON(HEALTH); if (!health) await sleep(250) }

  T('A1 the relay started and answers /health', !!health, relayErr.slice(0, 300))
  if (!health) { console.log(`\n=== ${pass} passed, ${fail + 1} failed (relay never came up) ===`); process.exit(1) }
  T('A2 it reports itself healthy', health.ok === true)
  // The relay this test starts must be OURS, not the hosted one answering by accident.
  T('A3 it is on the port WE chose, so nothing else is being measured',
    typeof health.uptimeSec === 'number' && health.uptimeSec < 60, `uptime=${health.uptimeSec}`)
  T('A4 persistence is on (a room must survive the team going home)',
    health.persistence === true, JSON.stringify(health.persistence))
  // 3 Oct 2026: server.js defaults HIVE_ENFORCE_CLAIMS to 'off', and this command left it there,
  // so a team's own relay let anyone write over a file someone else had claimed, while the README
  // and the site promise the write is held. The public relay runs 'queue' (render.yaml).
  T('A4b claims hold: a write to a file someone else claimed is held, as on the public relay',
    health.enforceClaims === 'queue', JSON.stringify(health.enforceClaims))
  T('A5 it starts with no rooms, so section C measures OUR traffic',
    health.rooms === 0 && health.connections === 0, `rooms=${health.rooms} conns=${health.connections}`)
}

// --------------------------------------------------- B: two clients sync through it
sec('B  two clients sync a real file through it')
const { startSync } = await import('../sync.js')
let A = null, B = null
{
  A = startSync({ relay: RELAY, room: ROOM, dir: DIR_A, name: 'Alice', kind: 'human', log: () => { } })
  B = startSync({ relay: RELAY, room: ROOM, dir: DIR_B, name: 'Bob', kind: 'ai', owner: 'Alice', log: () => { } })

  // Wait for both to actually be connected before asserting anything about sync -- a
  // failure to connect and a failure to propagate look identical from the far folder.
  let connected = false
  for (let i = 0; i < 80 && !connected; i++) {
    await sleep(250)
    try { connected = A.status().connected && B.status().connected } catch { }
  }
  T('B1 both clients report connected', connected)

  const TARGET = 'shared-note.js'
  const BODY = `// written by Alice at ${Date.now()}\nexport const answer = 42\n`
  // ANTI-VACUITY, stated before the write: if Bob's folder already held this file, B3
  // would pass without anything having synced.
  T('B2 Bob does NOT have the file before Alice writes it',
    !fs.existsSync(path.join(DIR_B, TARGET)))

  A.claim(TARGET, 'write the shared note')
  fs.writeFileSync(path.join(DIR_A, TARGET), BODY)

  let landed = false
  for (let i = 0; i < 120 && !landed; i++) {
    await sleep(250)
    landed = fs.existsSync(path.join(DIR_B, TARGET))
  }
  T('B3 the file arrived in Bob\'s folder, through OUR relay', landed)
  T('B4 ... byte for byte',
    landed && fs.readFileSync(path.join(DIR_B, TARGET), 'utf8').includes('export const answer = 42'),
    landed ? fs.readFileSync(path.join(DIR_B, TARGET), 'utf8').slice(0, 60) : 'never arrived')

  // The other direction, because a one-way test would pass on a relay that only broadcasts
  // from the first client that speaks.
  const BACK = 'bob-reply.js'
  B.claim(BACK, 'reply')
  fs.writeFileSync(path.join(DIR_B, BACK), '// bob was here\n')
  let back = false
  for (let i = 0; i < 120 && !back; i++) { await sleep(250); back = fs.existsSync(path.join(DIR_A, BACK)) }
  T('B5 and it works in the other direction too', back)
}

// ------------------------------------------------- C: the traffic went HERE, provably
sec('C  the traffic went to OUR relay (its own counters moved)')
{
  const health = await getJSON(HEALTH)
  T('C1 the relay still answers', !!health)
  // A5 asserted 0/0 before any client connected. If these are still 0, the file in B3 got
  // there some other way -- a shared temp folder, a stale copy -- and the whole suite is
  // measuring the filesystem rather than the relay.
  T('C2 our relay now has connections (it was 0 at A5)', !!health && health.connections > 0,
    health ? `connections=${health.connections}` : '')
  T('C3 our relay now has rooms (it was 0 at A5)', !!health && health.rooms > 0,
    health ? `rooms=${health.rooms}` : '')
  T('C4 it is still running in open mode as we started it, not something else',
    !!health && health.authMode === 'open', health ? health.authMode : '')
}

// ---------------------------------------- D: a pinned client refuses the public relay
sec('D  a pinned client refuses the public relay — in the real client path')
{
  // This is the assertion the guide's privacy claim actually rests on. Everything above
  // proves a private relay WORKS; this proves you cannot end up on the public one by
  // accident while believing otherwise.
  const saved = process.env.HIVE_RELAY_PIN
  process.env.HIVE_RELAY_PIN = RELAY
  let threw = null
  try {
    const bad = startSync({ relay: PUBLIC_DEFAULT_RELAY, room: ROOM, dir: path.join(TMP, 'leaky'), name: 'Leaky', log: () => { } })
    try { bad.stop() } catch { }
  } catch (e) { threw = e }
  T('D1 startSync REFUSES a relay this machine is not pinned to', !!threw)
  T('D2 the refusal carries Q550', !!threw && threw.qcode === 'Q550', threw ? String(threw.qcode) : 'did not throw')
  T('D3 the refusal names the public relay it was asked for',
    !!threw && String(threw.message).includes(PUBLIC_DEFAULT_RELAY))
  // A refused join must leave nothing behind. The folder is what the next process reads to
  // decide where to connect, so a .hive.json written before the refusal would send the
  // NEXT run to the relay this one just refused.
  T('D4 the refused client created no .hive.json pointing at the refused relay',
    !fs.existsSync(path.join(TMP, 'leaky', '.hive.json')))

  // ANTI-VACUITY: the same call with the pin satisfied must SUCCEED. Without this, a
  // startSync that threw on everything would pass D1-D3.
  let ok = null
  try {
    const good = startSync({ relay: RELAY, room: ROOM + '-pinned', dir: path.join(TMP, 'pinned'), name: 'Pinned', log: () => { } })
    ok = good
  } catch (e) { ok = e }
  T('D5 ... while the PINNED relay is still accepted (so D1 refused for the pin)',
    ok && !(ok instanceof Error), ok instanceof Error ? ok.message.slice(0, 120) : '')
  try { if (ok && ok.stop) ok.stop() } catch { }

  if (saved === undefined) delete process.env.HIVE_RELAY_PIN; else process.env.HIVE_RELAY_PIN = saved
}

// ------------------------------------------------------------------ E: persistence
sec('E  the room survives everyone disconnecting')
{
  try { A.stop() } catch { }
  try { B.stop() } catch { }
  await sleep(2500) // the relay debounces its snapshot writes

  const files = fs.existsSync(DATA) ? fs.readdirSync(DATA) : []
  T('E1 the relay wrote the room to disk', files.length > 0, `data dir: ${files.length} entries`)
  // Without this the guide's "turn on persistence" line is advice nobody can check. With it,
  // a regression that silently stops snapshotting is a red test rather than a morning where
  // the folder came back empty.
  const total = files.reduce((n, f) => { try { return n + fs.statSync(path.join(DATA, f)).size } catch { return n } }, 0)
  T('E2 ... and the snapshot has real bytes in it', total > 0, `${total} bytes`)
}

// ---------------------------------------------------------------- F: suite anti-vacuity
sec('F  the suite is measuring something')
{
  T('F1 the relay this suite started is not the public one',
    !RELAY.includes('onrender.com') && RELAY.startsWith('ws://127.0.0.1:'), RELAY)
  T('F2 the two client folders are genuinely separate directories', DIR_A !== DIR_B)
  T('F3 hive-relay.js — the command the guide tells people to run — exists',
    fs.existsSync(path.join(ROOT, 'hive-relay.js')))
  // server.js is what hive-relay.js starts. If it ever stops being shipped, `npx
  // hivecode-relay` becomes a command that cannot run, which is the defect the whole
  // self-host story died of last time: a document naming a file the package omits.
  // THE RELAY IS ITS OWN PACKAGE, and the client must not ship it.
  //
  // The first version of this asserted server.js was in hivecode-mcp's files[] -- which made
  // `npx hivecode-relay` work, and also handed every client install the relay, the metering,
  // the licence check and the remote-MCP endpoint. A team that wants to run a relay should
  // get a relay; a developer installing the agent client should not receive the server side
  // of the product as a side effect. scripts/build-relay.mjs already existed for exactly
  // this and derives the package from server.js's import closure, so there is still only one
  // copy of every source file.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const relayFiles = ['server.js', 'remote-mcp.js', 'usage-meter.js', 'license-check.js', 'governor.js']
  const leaked = relayFiles.filter((f) => (pkg.files || []).includes(f))
  T('F4 the CLIENT package does not ship the relay', leaked.length === 0, leaked.join(', '))
  T('F5 ... and does not claim the hivecode-relay bin, which belongs to the relay package',
    !(pkg.bin && pkg.bin['hivecode-relay']), JSON.stringify(pkg.bin || {}))

  const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-relay.mjs'), 'utf8')
  T('F6 the relay package is built from hive-relay.js, so `npx hivecode-relay` gets the banner',
    /walk\('hive-relay\.js'\)/.test(builder))
  T('F7 ... and declares that as its bin',
    /'hivecode-relay':\s*'hive-relay\.js'/.test(builder))
  // The banner and the guide both tell an operator to mint tokens. Nothing imports that CLI,
  // so the closure walk cannot find it -- the first build from hive-relay.js left it out while
  // still instructing people to run it. A tool named in output must be a tool that ships.
  T('F8 the token CLI the banner names is staged and exposed',
    /TOOLS = \[[^\]]*'hive-token\.js'/.test(builder) && /'hivecode-token':\s*'hive-token\.js'/.test(builder))
}

// --------------------------------------- G: the guide is an API surface with a test now
sec('G  docs/SELF_HOSTING.md promises only things that exist')
{
  // THE GUIDE IS AN UNTESTED API SURFACE, and this one has already been wrong. The version
  // this replaced linked to a render.yaml at a path that did not exist, told people to run
  // `node server.js` from a package that does not ship server.js, and never once mentioned
  // HIVE_RELAY -- the single setting that decides where an AGENT sends the team's source.
  // Code has a suite; prose had an author and no gate. This is the gate.
  const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'SELF_HOSTING.md'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const SRC = ['sync.js', 'hive-mcp.js', 'server.js', 'limits.js', 'hive-privacy.js', 'hive-relay.js', 'token.js']
    .map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { return '' } }).join('\n')

  // Every relative link must resolve, from the doc's own directory.
  const links = [...DOC.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1])
  const deadLinks = links.filter((l) => !fs.existsSync(path.resolve(ROOT, 'docs', l)))
  T('G1 every relative link in the guide resolves', deadLinks.length === 0, deadLinks.join(', '))
  T('G2 ... and there were links to check (anti-vacuity)', links.length >= 6, `${links.length} links`)

  // Every HIVE_* variable the guide tells an operator to set must be read by something.
  const vars = [...new Set([...DOC.matchAll(/\b(HIVE_[A-Z_]+)\b/g)].map((m) => m[1]))]
  const unread = vars.filter((v) => !SRC.includes(v))
  T('G3 every HIVE_* var the guide names is actually read by the code', unread.length === 0, unread.join(', '))
  T('G4 ... and there were vars to check (anti-vacuity)', vars.length >= 6, `${vars.length}: ${vars.join(', ')}`)

  // Every npx command it tells people to run must be a bin SOMETHING declares. Two packages
  // now: hivecode-mcp (the client) and hivecode-relay (built by scripts/build-relay.mjs).
  // A command belonging to neither is the class this whole section exists for -- the guide
  // telling a team to run something that does not exist.
  const builderSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-relay.mjs'), 'utf8')
  const declared = new Set([
    ...Object.keys(pkg.bin || {}),
    ...[...builderSrc.matchAll(/'(hivecode-[a-z]+)':\s*'[^']+'/g)].map((m) => m[1]),
  ])
  const cmds = [...new Set([...DOC.matchAll(/npx (?:-y )?(hivecode-[a-z]+)/g)].map((m) => m[1]))]
  const missingBins = cmds.filter((c) => !declared.has(c))
  T('G5 every `npx hivecode-*` command in the guide is a bin one of the packages declares',
    missingBins.length === 0, `${missingBins.join(', ')} | declared: ${[...declared].join(', ')}`)
  T('G6 ... and there were commands to check (anti-vacuity)', cmds.length >= 2, cmds.join(', '))

  // The verdict strings it quotes must be the ones the code actually emits. A guide that
  // teaches people to look for a string the product stopped printing is worse than silence:
  // they look, do not find it, and conclude the check does not apply to them.
  const quoted = [...DOC.matchAll(/privacy: "([^"]+)"/g)].map((m) => m[1])
  const priv = fs.readFileSync(path.join(ROOT, 'hive-privacy.js'), 'utf8')
  const badQuotes = quoted.filter((q) => !priv.includes(q))
  T('G7 the privacy verdicts the guide quotes are strings hive-privacy.js emits',
    badQuotes.length === 0, badQuotes.join(' | '))
  T('G8 ... and it quoted some (anti-vacuity)', quoted.length >= 2, `${quoted.length}`)

  // Every Q-code it names must be one this build can actually produce.
  const qcodes = [...new Set([...DOC.matchAll(/\bQ(\d{3})\b/g)].map((m) => 'Q' + m[1]))]
  const unproducible = qcodes.filter((q) => !SRC.includes(q))
  T('G9 every Q-code the guide names exists in the source', unproducible.length === 0, unproducible.join(', '))
  T('G10 ... and it named some (anti-vacuity)', qcodes.length >= 3, qcodes.join(', '))

  // render.yaml IS A DEPLOYMENT CONTRACT, and it was the same class of defect: it set only
  // NODE_VERSION, so a Blueprint deploy produced an 8-connection relay that enforced nothing
  // -- the exact state production was in until 5 Sep 2026. It must carry the two settings
  // production was verified with, and every variable it sets must be one the relay reads.
  const RY = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8')
  const ryKeys = [...RY.matchAll(/^\s*-\s*key:\s*([A-Z_]+)/gm)].map((m) => m[1])
  T('G12 render.yaml sets HIVE_SEATS and HIVE_ENFORCE_CLAIMS, not just the Node version',
    ryKeys.includes('HIVE_SEATS') && ryKeys.includes('HIVE_ENFORCE_CLAIMS'), ryKeys.join(', '))
  const ryDead = ryKeys.filter((k) => k !== 'NODE_VERSION' && !SRC.includes(k))
  T('G13 every variable render.yaml sets is read by the relay', ryDead.length === 0, ryDead.join(', '))
  T('G14 render.yaml stores no secret value (secrets are sync:false, entered in the dashboard)',
    !/^\s*-\s*key:\s*[A-Z_]*(SECRET|TOKEN|KEY)[A-Z_]*\s*\n\s*value:/m.test(RY))

  // The guide points readers at this very file as the evidence for its claims. If it ever
  // stops being run, that sentence becomes the confident lie the whole class is about.
  T('G11 the suite the guide cites as its evidence is in an npm script',
    JSON.stringify(pkg.scripts || {}).includes('self-host-test.mjs'))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
cleanup()
process.exit(fail ? 1 : 0)
