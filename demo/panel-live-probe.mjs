#!/usr/bin/env node
/**
 * THE BROWSER HALF OF THE DEAF-PANEL TEST.
 *
 *   node demo/panel-live-probe.mjs            # then open the printed /control URL
 *
 * deaf-repro.mjs settled everything it could with node clients and said so: "the untested
 * variable is the one that differs: the real panel is a BROWSER client and every client in the
 * reproduction is node." This is that variable. It stands up a relay with the cap raised (so the
 * connection ceiling cannot confound the result the way it did the first two times), puts ONE
 * node agent in the base room posting numbered messages forever, and then gets out of the way so
 * a real browser panel can be driven against it.
 *
 * The agent prints what IT sees every couple of seconds. Compare that with what the panel shows
 * after the panel has spoken: if the panel is deaf, the agent's counter keeps climbing while the
 * panel's stops. Numbered messages mean the answer is readable rather than inferred -- you can
 * see exactly which message it stopped at.
 */
import { spawn } from 'child_process'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const PORT = Number(arg('--port', '1473'))
const EVERY = Number(arg('--every', '1500'))
const ROOM = 'panel-' + crypto.randomBytes(6).toString('base64url')
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const relay = await new Promise((res, rej) => {
  // HIVE_SEATS raises the ceiling to the pro tier. Without it the free cap is 8 CONNECTIONS
  // (not people), and the panel opens one per file it touches -- exactly the confound that
  // produced the first wrong diagnosis.
  const env = { ...process.env, PORT: String(PORT), HIVE_SEATS: '32' }
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const t = setTimeout(() => rej(new Error('relay never reported listening')), 15000)
  p.stdout.on('data', (d) => { out += d; if (/listening/i.test(out)) { clearTimeout(t); res(p) } })
  p.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write('[relay] ' + d) })
  p.on('exit', (c) => { clearTimeout(t); rej(new Error('relay exited ' + c)) })
})

const doc = new Y.Doc()
// disableBc so nothing syncs peer-to-peer behind the relay's back. The browser panel does NOT
// pass this -- but it is a different origin/process, so there is no BroadcastChannel between us.
const provider = new WebsocketProvider('ws://127.0.0.1:' + PORT, ROOM, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
provider.awareness.setLocalStateField('user', { name: 'Probe', kind: 'ai', v: 2 })
const chat = doc.getArray('chat')

await new Promise((res) => { const f = () => res(); provider.on('sync', (s) => s && f()); setTimeout(f, 8000) })

console.log('\n  relay    ws://127.0.0.1:' + PORT)
console.log('  room     ' + ROOM)
console.log('  LINK     ws://127.0.0.1:' + PORT + '|' + ROOM)
console.log('  PANEL    http://127.0.0.1:' + PORT + '/control')
console.log('\n  Probe posts every ' + EVERY + 'ms. Watch whether the panel keeps up AFTER it speaks.\n')

let n = 0
const at = () => new Date().toTimeString().slice(0, 8)
setInterval(() => { chat.push([{ by: 'Probe', kind: 'ai', at: at(), text: 'probe #' + (++n) }]) }, EVERY)
setInterval(() => {
  const all = chat.toArray()
  const mine = all.filter((m) => m && m.by === 'Probe').length
  const human = all.filter((m) => m && m.kind === 'human').length
  console.log(`  [probe] posted ${n}  chat=${all.length}  probe-msgs=${mine}  human-msgs=${human}  ws=${provider.wsconnected} synced=${provider.synced} retries=${provider.wsUnsuccessfulReconnects}`)
}, 3000)

const bye = () => { try { provider.destroy() } catch {} ; try { relay.kill() } catch {} ; process.exit(0) }
process.on('SIGINT', bye); process.on('SIGTERM', bye)
