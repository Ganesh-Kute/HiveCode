#!/usr/bin/env node
/**
 * FIVE — the Instagram cut. Five developers, each with their own AI, on one codebase.
 *
 *   node demo/five.mjs --dry-run     # run the scenario, print what happened, record nothing
 *   node demo/five.mjs               # demo/five-916.mp4  (1080x1920, 60fps, silent)
 *   node demo/five.mjs --handle @you # put a handle on the end card
 *
 * WHY THIS EXISTS AND WHAT MAKES IT DIFFERENT FROM social60-916.
 *
 * The old cut argues "12 AI agents, one folder". That is the autonomous-swarm story, and it is
 * not what a team has today. Today a team is five PEOPLE who each drive an AI, and their features
 * are independent while their FILES are not: every new route, model or service has to register
 * itself in one shared file, so five genuinely disjoint tasks collide there every single time.
 * That afternoon is the product's actual market, so it is what this films.
 *
 * NOTHING HERE IS RE-ENACTED. Ten real sync clients join a real relay. The claims are real calls
 * into the same coordinator the MCP tool uses, and a refusal is `hive.claim()` returning false
 * because the shared claim map says someone else holds it -- no model is asked and this script
 * does not decide it. If the refusals do not happen the run FAILS rather than filming a lie,
 * which is the one property that makes the footage worth anything.
 *
 * The seat arithmetic is not incidental: the free tier caps a room at 8 connections and refuses
 * the 9th INVISIBLY -- the socket connects and simply never syncs. Ten participants need
 * HIVE_SEATS, so `startRelay({seats:4})` (4 x 8 = 32) is load-bearing, not a tuning knob.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startRelay, startWeb, openPanel, startScreencast, encodeTimeline, sleep } from './panel-recorder.mjs'
import { startSync } from '../sync.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'five-916.mp4')
const FRAMES = path.join(HERE, 'five-frames')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DRY = process.argv.includes('--dry-run')
const HANDLE = arg('--handle', null)

// 8791 is the GRM daemon's port on this machine — taking it makes the run die at startWeb.
const RELAY_PORT = 1239, WEB_PORT = 8794, CDP_PORT = 9366
const ROOM = 'five-' + Math.floor(Date.now() / 1000)     // a fresh room: stale claims would fake the take
const CONTESTED = 'src/routes/index.js'

// Five developers, each driving a different assistant -- the point is that the vendor does not
// matter to the relay. Their feature files are genuinely disjoint; only the registry is shared.
const CAST = [
  { name: 'Ada',  with: 'Claude Code', file: 'src/features/billing.js' },
  { name: 'Kai',  with: 'Cursor',      file: 'src/features/search.js' },
  { name: 'Bo',   with: 'Copilot',     file: 'src/features/uploads.js' },
  { name: 'Lex',  with: 'Windsurf',    file: 'src/features/webhooks.js' },
  { name: 'Mira', with: 'Antigravity', file: 'src/features/exports.js' },
].map((d) => ({ ...d, room: d.name + ' / ' + d.with }))   // the claim is held by THIS identity

const log = (m) => console.log(m)
const clients = []
function join(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'five-'))
  const h = startSync({
    relay: `ws://127.0.0.1:${RELAY_PORT}`, room: ROOM, dir, name,
    kind: 'ai', syncFiles: false, log: () => {},
  })
  clients.push(h)
  return h
}
const synced = (h) => new Promise((res) => {
  if (h.provider.synced) return res(true)
  h.provider.on('sync', (s) => { if (s) res(true) })
  setTimeout(() => res(false), 8000)
})

// ── the scenario ────────────────────────────────────────────────────────────────────────────
const relay = startRelay({ port: RELAY_PORT, seats: 4 })
await sleep(2500)
const health = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`).then((r) => r.json())
log(`relay :${RELAY_PORT}  connsPerRoom=${health.connsPerRoom}  room=${ROOM}`)
if (health.connsPerRoom < 10) throw new Error(`Q430 room caps at ${health.connsPerRoom}; ten participants will not fit`)

const web = await startWeb(WEB_PORT)
const stageHive = join('stage')
await synced(stageHive)
const stage = stageHive.doc.getMap('stage')
const claims = stageHive.doc.getMap('claims')

const cue = (o) => { for (const [k, v] of Object.entries(o)) stage.set(k, v) }
const cap = (a, b, hot) => cue({ cap: { a, b, hot: !!hot } })
cue({ cast: CAST, reveal: 0, conv: false, convLive: false, tally: 0, showTally: false, end: false, denied: {} })
if (HANDLE) cue({ handle: HANDLE })

// Every participant is a real connection: the five people and the five assistants they drive.
const people = {}, agents = {}
for (const d of CAST) { people[d.name] = join(d.name); agents[d.name] = join(d.room) }
await Promise.all([...Object.values(people), ...Object.values(agents)].map(synced))
const live = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`).then((r) => r.json())
log(`participants: ${live.connections} connections in one room`)
if (live.connections < 11) throw new Error(`only ${live.connections} connected — someone was refused invisibly`)

// ── camera ──────────────────────────────────────────────────────────────────────────────────
let panel = null, cast = null
if (!DRY) {
  panel = await openPanel({
    cdpPort: CDP_PORT, webPort: WEB_PORT, relayPort: RELAY_PORT, room: ROOM,
    width: 720, height: 1280, scale: 1.5,
    pageUrl: `http://127.0.0.1:${WEB_PORT}/five.html?room=${ROOM}#ws://127.0.0.1:${RELAY_PORT}`,
  })
  await sleep(2600)                                   // let the page connect and take first sync
  cast = startScreencast({ cdp: panel.cdp, on: panel.on, dir: FRAMES, quality: 92, maxWidth: 1080, maxHeight: 1920 })
  await sleep(700)
}

const beat = async (ms) => { await sleep(ms) }
const outcome = []

// BEAT 1 — the room fills.
cap('FIVE DEVELOPERS', 'one folder. live.')
for (let i = 1; i <= 5; i++) { cue({ reveal: i }); await beat(560) }
await beat(900)

// BEAT 2 — five disjoint features. Each person's assistant takes their own file and the relay
// grants every one of them, because nothing actually overlaps yet.
cap('FIVE FEATURES', 'nothing overlaps')
for (const d of CAST) {
  const ok = agents[d.name].claim(d.file, 'edit')
  outcome.push(`${d.name} -> ${d.file}: ${ok ? 'GRANTED' : 'DENIED'}`)
  await sleep(140)
}
await beat(2600)

// BEAT 3 — the convergence point. This is the part every team recognises.
cue({ conv: true })
cap('BUT EVERY FEATURE', 'has to register in one file')
await beat(3200)

// BEAT 4 — one of them gets there first. Real claim, real grant.
const first = CAST[0]
const gotIt = agents[first.name].claim(CONTESTED, 'register the billing route')
outcome.push(`${first.name} -> ${CONTESTED}: ${gotIt ? 'GRANTED' : 'DENIED'}`)
if (!gotIt) throw new Error('the first claim on the contested file was refused — the take is invalid')
cue({ cast: CAST.map((d) => (d.name === first.name ? { ...d, file: CONTESTED } : d)) })
cap('ONE OF THEM GETS THERE FIRST', `${first.name} holds it`)
await sleep(900)                                       // let the claim converge across all ten docs
await beat(1800)

// BEAT 5 — THE SHOT. The other four reach for the same file and the relay refuses each one.
// These are real return values. Nothing below fabricates a refusal.
const denied = {}
cue({ convLive: true })
cap('REFUSED', 'by the relay. before the write.', true)
for (const d of CAST.slice(1)) {
  const ok = agents[d.name].claim(CONTESTED, 'register my route')
  outcome.push(`${d.name} -> ${CONTESTED}: ${ok ? 'GRANTED' : 'DENIED'}`)
  if (!ok) { denied[d.name] = true; cue({ denied: { ...denied } }) }
  await sleep(320)
}
const refusals = Object.keys(denied).length
if (refusals !== 4) throw new Error(`expected 4 refusals, got ${refusals} — not filming a claim that did not happen`)
await beat(2400)

// BEAT 6 — the differentiator, counted from what actually happened.
cue({ showTally: true })
for (let i = 1; i <= refusals; i++) { cue({ tally: i }); await sleep(230) }
cap('NOT AT MERGE TIME', 'at the keystroke')
await beat(3000)

// BEAT 7 — and the thing that did NOT happen, which is the whole product.
cap('NOTHING WAS LOST', 'no branches. no conflict markers.')
await beat(2800)

// BEAT 8 — end card.
cue({ end: true })
await beat(4600)

// ── output ──────────────────────────────────────────────────────────────────────────────────
log('\nWHAT THE RELAY ACTUALLY DID')
for (const o of outcome) log('  ' + o)
log(`  holder of ${CONTESTED}: ${(claims.get(CONTESTED) || {}).by}`)
log(`  refusals: ${refusals}`)

if (!DRY) {
  const frames = await cast.stop()
  const r = encodeTimeline({ dir: FRAMES, out: OUT, frames, fps: 60, outW: 1080, outH: 1920 })
  log(`\n${path.relative(process.cwd(), OUT)}  ${r.resolution} ${r.duration} ${r.fps}fps ${r.kb}kB`)
  log(`captured ${r.captured} frames at ${r.captureFps}fps`)
  panel.stop()
}
for (const h of clients) { try { h.stop() } catch { /* going away anyway */ } }
web.close(); relay.kill()
process.exit(0)
