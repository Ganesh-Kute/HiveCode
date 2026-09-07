#!/usr/bin/env node
/**
 * THE CAST — spawn real headless Claude Code agents into one live room and record the panel.
 *
 * No terminal windows to arrange, no OBS, no window focus to lose. Each agent is a real
 * `claude -p` process with its own model, its own working folder, and its own scoped MCP
 * config pointing at hive-mcp.js. The visible artifact is the Control Panel, captured from
 * headless Chrome over CDP, so framing is identical every run.
 *
 * COSTS REAL MONEY. Every agent is real inference. --dry-run prints the exact plan and spends
 * nothing; that is the default posture and you should look at it before a live run.
 *
 *   node demo/cast.mjs --dry-run            # print the plan, spend nothing
 *   node demo/cast.mjs --dry-run --size 12  # the full roster
 *   node demo/cast.mjs --size 3 --live      # SPENDS MONEY: 3-agent pilot
 *   node demo/cast.mjs --size 12 --live     # SPENDS MONEY: the real take
 *
 * Model split is deliberate. Opus 5, Sonnet 5 and Haiku 4.5 are SEPARATE rate-limit families
 * (1K req / 500K input / 80K output per minute EACH), so spreading the roster across three
 * families triples the throughput ceiling as well as cutting the bill. Opus is spent only
 * where the reasoning has to land: the two agents who collide and negotiate.
 */
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

process.env.HIVE_PROVENANCE = 'on'
process.setMaxListeners(200)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)

const SIZE = Math.max(1, parseInt(arg('--size', '12'), 10) || 12)
const LIVE = has('--live')
const DRY = has('--dry-run') || !LIVE
const SECONDS = Math.max(60, parseInt(arg('--seconds', has('--pilot') ? '240' : '420'), 10) || 420)
const STAGGER_MS = Math.max(1000, parseInt(arg('--stagger', '7000'), 10) || 7000)

const RELAY_PORT = 1490
const WEB_PORT = 1491
const CDP_PORT = 9345
const FPS = 4
const W = 1280, H = 720, SCALE = 1.5      // 1280x720 layout rendered at 1920x1080

const OPUS = 'claude-opus-5'
const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5-20251001'

// WHAT THE HUMAN TYPES INTO THE PANEL, on camera, once. This is the only instruction the
// room ever receives. It names the deliverables so a viewer can follow along, and it names
// NOBODY — who does what is the agents' problem, which is the whole point.
//
// It deliberately spans both halves of the work: a decision that has to be argued and written
// down, and code that has to implement it. One folder, one engine, no git branches anywhere.
const BRIEF =
  'Everyone: we are adding request rate limiting to our API today. ' +
  'I need both halves and they have to agree with each other — ' +
  'the decision written down (what the limit should be and why, plus what each paid plan gets), ' +
  'and the working code that enforces it, with tests. ' +
  'Sort out between yourselves who takes what. I am not assigning anything.'

// DISCIPLINE, NOT ASSIGNMENT. Nobody is told which file to take — that is the thing being
// demonstrated. The two engineers are given OPPOSING DESIGN CONVICTIONS instead of a scripted
// clash: one believes cross-cutting logic belongs in a single module, the other believes each
// route owns its own policy. Two engineers who genuinely disagree about where logic lives will
// contest the same file on their own, and the argument is real rather than manufactured.
const ROSTER = [
  { name: 'Ada', model: OPUS, scope: ['**'], discipline:
    'You are a backend engineer. You hold a strong view: cross-cutting behaviour belongs in ONE ' +
    'module with one source of truth, and callers should just call it. Scattered policy is how ' +
    'systems rot. Argue for that when it comes up, and do not fold just to be agreeable.' },
  { name: 'Bo', model: OPUS, scope: ['**'], discipline:
    'You are a backend engineer. You hold a strong view: each endpoint should own its own policy, ' +
    'because a single shared module always ends up with a pile of special cases. Argue for that ' +
    'when it comes up, and do not fold just to be agreeable.' },

  { name: 'Ana', model: SONNET, scope: ['**'], discipline:
    'You are a data analyst. You are the only one who can turn a vague requirement into a ' +
    'defensible number, and you say so. When you have a number, tell whoever needs it BY NAME ' +
    'without waiting to be asked.' },
  { name: 'Mira', model: SONNET, scope: ['**'], discipline:
    'You are a product marketer. You own what we PROMISE customers in writing. You cannot ' +
    'promise anything until someone gives you real numbers, and what ships must match the page.' },
  { name: 'Raj', model: SONNET, scope: ['**'], discipline:
    'You are a reviewer. You read what other people produce and say plainly when two things ' +
    'contradict each other, naming the person and quoting the mismatch. You do not write ' +
    'product code yourself.' },

  { name: 'Kai', model: HAIKU, scope: ['**'], discipline: 'You are a test engineer. You test what others build, and you ask them directly what the interface is rather than guessing.' },
  { name: 'Nia', model: HAIKU, scope: ['**'], discipline: 'You are a technical writer. You document what the room actually decided, never what you assumed.' },
  { name: 'Sol', model: HAIKU, scope: ['**'], discipline: 'You keep the release notes. One line per real change, crediting whoever made it by name.' },
  { name: 'Ivo', model: HAIKU, scope: ['**'], discipline: 'You design error responses and status codes. They must match what the implementation actually returns.' },
  { name: 'Tao', model: HAIKU, scope: ['**'], discipline: 'You own configuration and defaults. You use real numbers from whoever measured them, never invented ones.' },
  { name: 'Lin', model: HAIKU, scope: ['**'], discipline: 'You own observability: what we measure to know a decision was right. You ask what is actually measurable.' },
  { name: 'Eve', model: HAIKU, scope: ['**'], discipline: 'You write customer-facing help. You check every answer with whoever owns the promise before publishing it.' },
]

// --pilot is the cheap de-risking run. It keeps the ONE thing that has to be validated --
// two agents set up to collide on the same file, plus a Haiku to confirm the cheap tier
// participates at all -- but downgrades the collision pair to Sonnet, because what is being
// tested is whether the PROMPTS produce coordination, not whether Opus reasons well.
// Plain --size 3 would have picked both Opus agents: the most expensive possible pilot.
const PILOT = has('--pilot')
const CAST = PILOT
  ? [
      { ...ROSTER[0], model: SONNET },   // the two engineers with opposing convictions
      { ...ROSTER[1], model: SONNET },
      { ...ROSTER[5], model: HAIKU },    // and one cheap-tier agent who must ask a question
    ]
  : ROSTER.slice(0, SIZE)
const ROOM = 'cast-' + crypto.randomBytes(4).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every agent gets the same law. Brevity is stated as law because a previous run burned
// fifteen minutes on agents writing sixty-line essays at each other.
// THE OBJECTIVE IS DELIBERATELY NOT IN HERE.
//
// The pilot baked the brief into every agent's prompt, so the recording showed agents
// spawning and instantly claiming files with no visible cause. Two things wrong with that:
// a viewer cannot tell what is happening, and — worse — nobody can tell whether the
// self-organisation was real or pre-written. If the task is in the prompt, the demo proves
// nothing about coordination.
//
// So an agent arrives knowing only WHO IT IS and HOW THE ROOM WORKS, and then waits. The
// human types the objective into the panel, on camera, at runtime. Everything after that —
// who takes which file, who needs whose number — is decided in the room by the agents.
// That is the difference between a script and a demonstration.
const LAW = (a) => [
  'You are joining a live shared workspace where several AI agents and a human all work on',
  'ONE folder at the same time. You are ' + a.name + '. ' + a.discipline,
  '',
  'HOW THIS ROOM WORKS — these are not suggestions:',
  '1. hive_join first, with the link and dir you were given, owner "Ganesh".',
  '2. Say ONE line announcing yourself and your discipline. Then WAIT.',
  '3. DO NOT invent work. There is no objective yet. A human will post one in chat.',
  '   Loop on hive_wait with timeoutSeconds 60 until it arrives. If hive_wait errors,',
  '   hive_join again with the same link and resume the loop. NEVER stop the loop.',
  '4. ADDRESS EVERY MESSAGE. Put @Name on it for whoever it is for. A message that names',
  '   nobody lands in everyone\'s "room activity" and will be skipped. Any agent may address',
  '   any other agent directly — there is nobody to route through and you need no permission.',
  '5. When the objective arrives: work out AMONG YOURSELVES who does what. Nobody is in',
  '   charge, there is no lead, and nobody assigns you anything. Claim what fits your',
  '   discipline, say by name what you are taking, and if two of you want the same file,',
  '   settle it between you with a reason.',
  '6. hive_claim a file BEFORE you edit it, hive_release when done. If a claim is refused,',
  '   the file is genuinely someone else\'s: @ them and negotiate.',
  '7. Every hive_say is SIX LINES OR FEWER. Decisions, not reasoning.',
  '8. Do not report progress to any human. Work, and answer the agents who address you.',
].join('\n')

// ── plan ──────────────────────────────────────────────────────────────────────
const byModel = CAST.reduce((m, a) => ((m[a.model] = (m[a.model] || 0) + 1), m), {})
console.log('\nCAST — ' + CAST.length + ' real agents, one room')
console.log('='.repeat(74))
console.log('  room     ' + ROOM)
console.log('  relay    ws://127.0.0.1:' + RELAY_PORT + '   HIVE_SEATS=' + Math.max(2, Math.ceil((CAST.length + 2) / 8)))
console.log('  capture  ' + (W * SCALE) + 'x' + (H * SCALE) + ' @ ' + FPS + 'fps  (' + W + 'x' + H + ' layout, ' + SCALE + 'x render)')
console.log('  run      ' + SECONDS + 's, joins staggered ' + (STAGGER_MS / 1000) + 's apart')
console.log('  models   ' + Object.entries(byModel).map(([m, n]) => n + ' x ' + m).join(', '))

// WHICH WALLET THIS CHARGES. `claude -p` uses ANTHROPIC_API_KEY when one is present and
// otherwise falls back to the OAuth subscription. The pilot silently took the second path,
// so the Console billing page read $0.00 and it looked like the agents were fake. They were
// not — the spend came out of the Claude PLAN allowance instead, which is the same pool this
// session runs on, so a big take can throttle real work. Say which one out loud, every time.
// The key is read from the ENVIRONMENT or from a gitignored file — never from a chat message
// and never written here. It is passed straight into the agents' env and is not logged, not
// echoed, and not stored by this script. Only its length and last 4 characters are ever
// printed, which is enough to confirm the right key is loaded without exposing it.
const KEYFILE = path.join(HERE, '.apikey')
function loadKey() {
  const env = (process.env.ANTHROPIC_API_KEY || '').trim()
  if (env) return { key: env, from: 'ANTHROPIC_API_KEY in the environment' }
  try {
    const f = fs.readFileSync(KEYFILE, 'utf8').trim()
    if (f) return { key: f, from: 'demo/.apikey' }
  } catch { /* absent is fine — subscription billing is a valid choice */ }
  return { key: '', from: null }
}
const { key: APIKEY, from: KEYFROM } = loadKey()
const KEYHINT = APIKEY ? APIKEY.length + ' chars, ends ' + APIKEY.slice(-4) : ''
console.log('  billing  ' + (APIKEY
  ? 'API key loaded from ' + KEYFROM + ' (' + KEYHINT + ')'
  : 'NO API KEY -> charges your CLAUDE SUBSCRIPTION allowance, not the API'))
if (APIKEY) {
  console.log('           -> spend lands on the API organisation and its $500 limit;')
  console.log('              your Claude plan allowance is left alone')
} else {
  console.log('           -> this is the same pool your interactive Claude Code runs on, so a')
  console.log('              large take can throttle your own work. To charge the API instead,')
  console.log('              put the key in demo/.apikey (gitignored) or export it:')
  console.log('                $env:ANTHROPIC_API_KEY="sk-ant-..."   (powershell)')
}
console.log('')
for (const a of CAST) console.log('  ' + a.name.padEnd(6) + a.model.padEnd(28) + a.discipline.slice(0, 56).replace(/\s+/g, ' '))
console.log('')
console.log('  TIMELINE — the agents are told WHO THEY ARE, never WHAT TO BUILD:')
console.log('    t=0      they join, announce a discipline, and WAIT. no objective exists yet.')
console.log('    t=20s    the human types the objective into the panel, on camera, once.')
console.log('    t=20s+   they divide the work themselves. no lead, nobody assigned anything.')
console.log('    t=' + Math.round(SECONDS * 0.6) + 's   the human redirects one agent mid-flight, by name.')
console.log('')
console.log('  WHY the stagger: each agent\'s FIRST request is uncached — system prompt, rules,')
console.log('  MCP schemas, ~40K tokens. ' + CAST.length + ' joining at once would be ~' +
  (CAST.length * 40) + 'K against a 500K/min')
console.log('  input ceiling, in the exact minute recording starts. ' + (STAGGER_MS / 1000) +
  's apart keeps every family clear.')

if (DRY) {
  console.log('\n  DRY RUN — nothing spawned, nothing spent.')
  console.log('  Live run:  node demo/cast.mjs --size ' + CAST.length + ' --live\n')
  process.exit(0)
}

// ── live ──────────────────────────────────────────────────────────────────────
const MAGICK_DIRS = [process.env.MAGICK_DIR, 'C:/Program Files/ImageMagick-7.1.0-Q16-HDRI'].filter(Boolean)
const findTool = (n) => {
  if (!spawnSync(n, ['-version'], { encoding: 'utf8' }).error) return n
  for (const d of MAGICK_DIRS) { const p = path.join(d, n + '.exe'); if (fs.existsSync(p)) return p }
  return null
}
const CLI = process.platform === 'win32'
  ? (['C:/Users/G1/AppData/Roaming/npm/claude.cmd', process.env.CLAUDE_CLI]
      .filter(Boolean).find((f) => fs.existsSync(f)) || 'claude.cmd')
  : 'claude'
const FFMPEG = findTool('ffmpeg')
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .filter(Boolean).find((p) => fs.existsSync(p))
if (!FFMPEG || !CHROME) { console.error('need ffmpeg + chrome'); process.exit(2) }

const dead = []
const die = (c) => { for (const f of dead) { try { f() } catch { /* best effort */ } } process.exit(c) }
process.on('SIGINT', () => die(130))

const SEATS = Math.max(2, Math.ceil((CAST.length + 2) / 8))
const relay = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(RELAY_PORT), HIVE_PROVENANCE: 'on', HIVE_SEATS: String(SEATS) },
  stdio: ['ignore', 'ignore', 'pipe'],
})
relay.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d) })
dead.push(() => relay.kill())

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
const web = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'control.html'
  const file = path.join(ROOT, 'public', rel)
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.statusCode = 403; return res.end('no') }
  fs.readFile(file, (e, buf) => {
    if (e) { res.statusCode = 404; return res.end('not found') }
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
    res.end(buf)
  })
})
await new Promise((r) => web.listen(WEB_PORT, '127.0.0.1', r))
dead.push(() => web.close())
await sleep(1500)

// ── panel ─────────────────────────────────────────────────────────────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
  '--window-size=' + W + ',' + (H + 40), '--hide-scrollbars', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  'http://127.0.0.1:' + WEB_PORT + '/control.html?name=Ganesh#ws://127.0.0.1:' + RELAY_PORT + '|' + ROOM,
], { stdio: ['ignore', 'ignore', 'pipe'] })
dead.push(() => chrome.kill())

let target = null
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500)
  try {
    const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
    target = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch { /* not up */ }
}
if (!target) { console.error('chrome never exposed a page'); die(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
dead.push(() => ws.close())
let msgId = 0
const pending = new Map()
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(String(raw)) } catch { return }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const cdp = (method, params) => new Promise((res, rej) => {
  const id = ++msgId
  pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result || {})))
  ws.send(JSON.stringify({ id, method, params: params || {} }))
  setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timed out')) }, 25000)
})
await cdp('Page.enable')
// 1280x720 CSS layout rendered at 1.5x = a true 1920x1080 frame with text still readable.
// Native 1920 CSS px would make the type too small to read in a 3-minute video.
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false })
await sleep(3500)

const FRAMES = path.join(HERE, 'cast-frames')
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })
let n = 0, capturing = true
const capture = (async () => {
  while (capturing) {
    const t = Date.now()
    try {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(FRAMES, 'c' + String(n++).padStart(5, '0') + '.png'), Buffer.from(data, 'base64'))
    } catch (e) { if (process.env.DEBUG) console.error('frame: ' + e.message) }
    const left = Math.round(1000 / FPS) - (Date.now() - t)
    if (left > 0) await sleep(left)
  }
})()

// ── the agents ────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-'))
const LINK = 'ws://127.0.0.1:' + RELAY_PORT + '|' + ROOM
const procs = []
for (const a of CAST) {
  const dir = path.join(tmp, a.name); fs.mkdirSync(dir, { recursive: true })
  const cfg = path.join(dir, 'mcp.json')
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: { hivecode: { command: process.execPath, args: [path.join(ROOT, 'hive-mcp.js')], env: { HIVE_PROVENANCE: 'on' } } },
  }, null, 1))
  const prompt = LAW(a) + '\n\nJOIN NOW: link "' + LINK + '", dir "' + dir.replace(/\\/g, '/') + '", name "' + a.name + '", owner "Ganesh".'
  // THE PROMPT GOES ON STDIN, NOT ARGV, AND shell IS OFF.
  // First attempt used `shell: true` with the prompt as an argv element. On Windows that hands
  // a multi-line string to cmd.exe, which truncated it at the first space -- every agent
  // received the single word "The" and replied "your message got cut off". Verified: stdin
  // delivers a 5-line prompt whole. Also spawn claude.cmd explicitly, since the bare name only
  // resolves through a shell.
  const p = spawn(CLI, ['-p', '--model', a.model, '--mcp-config', cfg,
    '--dangerously-skip-permissions'],
    {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      // The key, if there is one, is handed to the child and nowhere else.
      env: APIKEY ? { ...process.env, ANTHROPIC_API_KEY: APIKEY } : process.env,
    })
  // Buffer and write SYNCHRONOUSLY. Piping into a WriteStream loses the whole log when
  // process.exit() runs, which is why all three pilot logs were 0 bytes while the agents were
  // demonstrably working — I had no diagnosis and had to read the room instead.
  let buf = ''
  p.stdout.on('data', (d) => { buf += d })
  p.stderr.on('data', (d) => { buf += d })
  const flush = () => { try { fs.writeFileSync(path.join(dir, 'agent.log'), buf) } catch { /* ignore */ } }
  p.on('close', flush)
  a._flush = flush
  p.stdin.write(prompt); p.stdin.end()
  procs.push({ a, p })
  dead.push(() => { try { p.kill() } catch { /* gone */ } })
  console.log('  + ' + a.name.padEnd(6) + a.model.padEnd(28) + '-> ' + dir)
  await sleep(STAGGER_MS)
}

console.log('\n  all ' + procs.length + ' spawned. recording ' + SECONDS + 's...')
// The human is the BROWSER, typing into the panel's own composer — Epstein's RFS sentence made
// literal: drop into the same live session, watch it work, redirect it. The pilot had no human
// action in it at all, which is the one beat the whole positioning rests on.
const sayInPanel = async (t) => {
  try {
    await cdp('Runtime.evaluate', { expression: "document.getElementById('chatInput').focus()" })
    await cdp('Input.insertText', { text: t })
    await sleep(1600)                                  // let frames catch the typed text
    await cdp('Runtime.evaluate', { expression: "document.getElementById('send').click()" })
    console.log('  >> Ganesh typed into the panel: ' + t)
  } catch (e) { console.error('  panel type failed: ' + e.message) }
}

const t0 = Date.now()
// Two human moments, both typed into the panel so they happen on camera.
//   BRIEF_AT    — the room is idle and waiting. The human gives the objective. Nothing the
//                 agents do afterwards was in their prompts, and a viewer can verify that
//                 because they watched the instruction arrive.
//   REDIRECT_AT — mid-flight course correction. "watch it work, redirect it" from the RFS.
const BRIEF_AT = 20
const REDIRECT_AT = Math.round(SECONDS * 0.6)
const ENG = CAST[0].name
const BIZ = (CAST.find((x) => x.name === 'Mira') || CAST[CAST.length - 1]).name
let briefed = false, redirected = false
while ((Date.now() - t0) / 1000 < SECONDS) {
  await sleep(4000)
  const el = Math.round((Date.now() - t0) / 1000)
  if (!briefed && el >= BRIEF_AT) {
    briefed = true
    console.log('\n  >>> THE HUMAN GIVES THE TASK (nothing before this told them what to build)')
    await sayInPanel(BRIEF)
  }
  if (briefed && !redirected && el >= REDIRECT_AT) {
    redirected = true
    console.log('\n  >>> THE HUMAN REDIRECTS, MID-FLIGHT')
    await sayInPanel('@' + ENG + ' one change before you finish — the 429 response body has to ' +
      'match exactly what @' + BIZ + ' put on the pricing page, not just the header.')
  }
  if (el % 16 < 5) {
    const alive = procs.filter((x) => x.p.exitCode === null).length
    console.log('  t=' + el + 's  alive ' + alive + '/' + procs.length + '  frames ' + n)
  }
}

capturing = false
await capture
for (const x of procs) { try { x.a._flush && x.a._flush() } catch { /* ignore */ } }
for (const x of procs) { try { x.p.kill() } catch { /* gone */ } }
await sleep(1200)

// Record WHEN things actually happened, so captions can narrate the truth instead of what I
// hoped would happen. The human beats are deterministic; the agent beats are not, so those
// come from the room's own chat timestamps after the fact.
const timeline = {
  room: ROOM, fps: FPS, frames: n, startedAt: t0, seconds: SECONDS,
  cast: CAST.map((a) => ({ name: a.name, model: a.model })),
  humanBrief: { atSeconds: BRIEF_AT, text: BRIEF },
  humanRedirect: { atSeconds: REDIRECT_AT },
  chatFile: path.join(tmp, CAST[0].name, 'HIVE_CHAT.md'),
  roomFolder: path.join(tmp, CAST[0].name),
}
fs.writeFileSync(path.join(HERE, 'cast-timeline.json'), JSON.stringify(timeline, null, 1))

const out = path.join(HERE, 'cast.mp4')
const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', 'c%05d.png',
  '-r', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
  '-movflags', '+faststart', out], { cwd: FRAMES, encoding: 'utf8' })
if (r.status !== 0) { console.error('ffmpeg: ' + (r.stderr || '').slice(0, 400)); die(1) }
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' })
console.log('\n  cast.mp4  ' + (((probe.stderr || '').match(/Duration: ([0-9:.]+)/) || [])[1] || '?') +
  '  ' + Math.round(fs.statSync(out).size / 1024) + ' KB  (' + n + ' frames)')
console.log('  agent logs + folders: ' + tmp)
console.log('  room folder to inspect what they actually built: ' + path.join(tmp, CAST[0].name))
die(0)
