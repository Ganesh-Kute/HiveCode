#!/usr/bin/env node
/**
 * RECORD THE CONTROL PANEL — a real browser, a real relay, real agents. Automatic.
 *
 * This is the twenty seconds the scorecard cannot give you: a human and several AI agents
 * visibly in ONE live room. The scorecard proves the enforcement; this shows the thing.
 *
 * Deliberately NOT screen capture. It drives headless Chrome over CDP and pulls frames
 * straight out of the page, so it needs no window in front, captures nothing else on your
 * desktop, and frames identically every run.
 *
 * The last beat matters most: one agent goes quiet on purpose, so the panel shows
 * "last edit 24s ago" instead of the old "idle". That label is the fix this demo exists to
 * show — "idle" on a working room is what made the previous take look dead.
 *
 *   node demo/record-panel.mjs               # ~55s of room, then encode
 *   node demo/record-panel.mjs --keep        # keep the PNG frames
 *   node demo/record-panel.mjs --show        # run Chrome visibly (debugging)
 */
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'
import { startSync } from '../sync.js'

// Signed provenance must be ON or the panel's Provenance card renders an empty state --
// which is precisely the "panels of zeros" look this recording exists to avoid.
process.env.HIVE_PROVENANCE = 'on'
process.setMaxListeners(40)   // relay + web + chrome + 3 clients share one process

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FRAMES = path.join(HERE, 'panel-frames')
const KEEP = process.argv.includes('--keep')
const SHOW = process.argv.includes('--show')

const RELAY_PORT = 1470
const WEB_PORT = 1471
const CDP_PORT = 9333
const FPS = 2.5
const TICK = Math.round(1000 / FPS)
const ROOM = 'panel-' + crypto.randomBytes(4).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── tools ─────────────────────────────────────────────────────────────────────
const MAGICK_DIRS = [process.env.MAGICK_DIR, 'C:/Program Files/ImageMagick-7.1.0-Q16-HDRI'].filter(Boolean)
function findTool(name) {
  if (!spawnSync(name, ['-version'], { encoding: 'utf8' }).error) return name
  for (const d of MAGICK_DIRS) { const p = path.join(d, name + '.exe'); if (fs.existsSync(p)) return p }
  return null
}
const FFMPEG = findTool('ffmpeg')
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find((p) => fs.existsSync(p))
if (!FFMPEG || !CHROME) {
  console.error('  ffmpeg: ' + (FFMPEG || 'NOT FOUND') + '\n  chrome: ' + (CHROME || 'NOT FOUND'))
  console.error('Set CHROME_PATH / MAGICK_DIR if these live elsewhere.')
  process.exit(2)
}

const dead = []
const die = (code) => { for (const f of dead) { try { f() } catch { /* best effort */ } } process.exit(code) }

// ── relay (open auth: this demo is about VISIBILITY; enforcement is the scorecard) ──
const relay = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(RELAY_PORT), HIVE_PROVENANCE: 'on' }, stdio: ['ignore', 'ignore', 'pipe'],
})
relay.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d) })
dead.push(() => relay.kill())

// ── static server for public/ ─────────────────────────────────────────────────
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
await sleep(1200)

// ── the crew ──────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-panel-'))
const mk = (name, kind) => {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true })
  const c = startSync({
    relay: 'ws://127.0.0.1:' + RELAY_PORT, room: ROOM, dir,
    name, kind, owner: kind === 'ai' ? 'Ganesh' : '', log: () => {},
  })
  dead.push(() => { try { c.stop() } catch { /* already down */ } })
  return { name, dir, c }
}
const put = (m, f, t) => {
  const full = path.join(m.dir, f)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, t)
}

console.log('room ' + ROOM + '   relay :' + RELAY_PORT + '   web :' + WEB_PORT)

// ── Chrome over CDP ───────────────────────────────────────────────────────────
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-chrome-'))
const chrome = spawn(CHROME, [
  SHOW ? '--new-window' : '--headless=new',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + profile,
  '--window-size=1280,760',
  '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter', '--disable-extensions',
  'http://127.0.0.1:' + WEB_PORT + '/control.html?name=Ganesh#ws://127.0.0.1:' + RELAY_PORT + '|' + ROOM,
], { stdio: ['ignore', 'ignore', 'pipe'] })
chrome.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write(d) })
dead.push(() => chrome.kill())

let target = null
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500)
  try {
    const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch { /* not up yet */ }
}
if (!target) { console.error('Chrome never exposed a debuggable page on :' + CDP_PORT); die(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
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
  setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timed out')) }, 20000)
})

await cdp('Page.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
console.log('chrome attached, panel loading...')
await sleep(3500)

// ── capture loop + choreography ───────────────────────────────────────────────
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })
let n = 0, capturing = true
const capture = (async () => {
  while (capturing) {
    const t = Date.now()
    try {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path.join(FRAMES, 'p' + String(n++).padStart(4, '0') + '.png'), Buffer.from(data, 'base64'))
    } catch (e) { if (process.env.DEBUG) console.error('  frame: ' + e.message) }
    const left = TICK - (Date.now() - t)
    if (left > 0) await sleep(left)
  }
})()

const beat = async (label, ms, fn) => {
  console.log('  ' + String(Math.round(n / FPS)).padStart(3) + 's  ' + label)
  if (fn) await fn()
  await sleep(ms)
}

// The human is the BROWSER, driven through the panel's own composer -- not a fourth client
// posting from a script. A viewer has to see the person type into the actual product.
const sayInPanel = async (text) => {
  await cdp('Runtime.evaluate', { expression: "document.getElementById('chatInput').focus()" })
  await cdp('Input.insertText', { text })
  await sleep(1400)                     // let a frame catch the typed text before it sends
  await cdp('Runtime.evaluate', { expression: "document.getElementById('send').click()" })
}

const Ada = mk('Ada', 'ai'), Blake = mk('Blake', 'ai'), Cara = mk('Cara', 'ai')
await beat('three agents join a room the human is already watching', 5000)
await beat('they announce what they are taking, as the room rules tell them to', 5000, () => {
  Ada.c.say('taking app.js -- boot + shutdown')
  Blake.c.say('taking api.js -- route table')
  Cara.c.say('taking docs/readme.md')
})

await beat('Ada takes app.js', 4000, () => put(Ada, 'app.js', 'export function boot() {\n  return "up"\n}\n'))
await beat('Blake takes api.js', 4000, () => put(Blake, 'api.js', 'export const routes = ["/health"]\n'))
await beat('Cara takes docs/readme.md', 4500, () => put(Cara, 'docs/readme.md', '# Service\n\nBooting.\n'))
await beat('all three writing at once', 5000, () => {
  put(Ada, 'app.js', 'export function boot() {\n  return "up"\n}\n\nexport function shutdown() {\n  return "down"\n}\n')
  put(Blake, 'api.js', 'export const routes = ["/health", "/refund"]\n')
  put(Cara, 'docs/readme.md', '# Service\n\nBooting. Two routes.\n')
})
await beat('the human types a redirect into the panel, mid-run', 4000,
  () => sayInPanel('@Cara stop on the readme and take the auth module instead'))
await beat('Cara reads it and switches', 5000, () => { Cara.c.say('got it -- dropping the readme, starting auth.js'); put(Cara, 'auth.js', 'export function login() {\n  return null\n}\n') })
await beat('Ada keeps going; Blake and Cara go quiet on purpose', 6000,
  () => put(Ada, 'app.js', 'export function boot() {\n  return "up"\n}\n\nexport function shutdown() {\n  return "down"\n}\n\nexport const version = 2\n'))
// THE POINT: past 15s the label becomes "last edit Ns ago", not "idle".
await beat('20s later — quiet agents read "last edit Ns ago", not "idle"', 21000)

capturing = false
await capture
console.log('captured ' + n + ' frames')

// ── encode ────────────────────────────────────────────────────────────────────
const out = path.join(HERE, 'panel.mp4')
const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS),
  '-i', 'p%04d.png', '-r', '15', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
  '-preset', 'slow', '-crf', '21', '-movflags', '+faststart', out],
  { cwd: FRAMES, encoding: 'utf8' })
if (r.status !== 0) { console.error('ffmpeg: ' + (r.stderr || '').slice(0, 400)); die(1) }
const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' })
console.log('\n  panel.mp4  ' + (((probe.stderr || '').match(/Duration: ([0-9:.]+)/) || [])[1] || '?') +
  '   ' + Math.round(fs.statSync(out).size / 1024) + ' KB')

if (!KEEP) fs.rmSync(FRAMES, { recursive: true, force: true })
else console.log('  frames kept in demo/panel-frames/')
die(0)
