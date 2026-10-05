// One name, one participant.
//
//   node tests/duplicate-name-test.mjs
//
// Everything in a room is keyed by name: claims, mail, presence, receipts. Measured 3 Oct 2026, a
// second agent joined as "Claude" beside the first, was told "others here: none yet", and both
// were then told "claimed x.js -- it's yours"; the second one's write landed in the first one's
// folder while the first held the file, and hive_members showed a single Claude. Two agents called
// Hermes once fused a file to 32,038 lines the same way.
//
//   D  a second agent under a name already here is refused (Q581) with a free name to use instead,
//      and joining under that name works, with claims that are separate again
//   P  an agent may not take a person's name either
//   R  NOT refused: this same agent a moment ago in its own folder, and its own listener

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync, parseLink } = await import('../sync.js')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sec = (s) => console.log(`\n${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dupname-'))
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: 'queue', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
})
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))
const kids = [relay]
const raws = []
process.on('exit', () => {
  for (const r of raws) { try { r.stop() } catch { } }
  for (const k of kids) { try { k.kill() } catch { } }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

// An agent's MCP server, each in a folder of its own so session files never meet.
async function mcp(label) {
  const cwd = path.join(TMP, `${label}-mcp`)
  fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_RELAY: `ws://127.0.0.1:${PORT}`, HIVE_HOME: path.join(TMP, 'home') } })
  kids.push(p)
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : JSON.stringify(r)
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return { call }
}
const folder = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d }
const joined = (reply) => /invite link:/.test(reply) && !/NOT JOINED/.test(reply)

// ------------------------------------------------------------------ D
sec('D  a second agent under a name already here')
const A = await mcp('a')
const ja = await A.call('hive_join', { dir: folder('a'), name: 'Claude' })
const link = (/invite link: (\S+)/.exec(ja) || [])[1]
T('D0 setup: the first Claude joined', joined(ja), ja.slice(0, 120))
const B = await mcp('b')
const jb = await B.call('hive_join', { dir: folder('b'), name: 'Claude', link })
T('D1 a second agent named Claude is NOT joined, and is told why (Q581)', /^NOT JOINED -- Q581: Claude is already in this room/.test(jb), jb.slice(0, 160))
T('D2 ...and is offered a name nobody here uses', /name: "Claude-2"/.test(jb))
T('D3 ...and really is out: its tools say so', /not in a room/.test(await B.call('hive_status', {})))
fs.writeFileSync(path.join(TMP, 'a', 'x.js'), 'export const x = 1\n')
await sleep(2500)
T('D4 setup: the first Claude holds x.js', /it's yours/.test(await A.call('hive_claim', { region: 'x.js', intent: 'A edits x' })))
const jb2 = await B.call('hive_join', { dir: folder('b'), name: 'Claude-2', link })
T('D5 joining as Claude-2 works', joined(jb2), jb2.slice(0, 120))
await sleep(2000)
const cb = await B.call('hive_claim', { region: 'x.js', intent: 'B edits x' })
T('D6 ...and claims are separate again: Claude-2 cannot take x.js while Claude holds it', !/it's yours/.test(cb), cb.slice(0, 120))

// ------------------------------------------------------------------ P
sec('P  an agent may not take a person\'s name')
{
  const { relay: R, room } = parseLink(link)
  const person = startSync({ relay: R, room, dir: folder('ganesh'), name: 'Ganesh', kind: 'human', syncFiles: false, log: () => { } })
  raws.push(person)
  await until(() => { try { return person.connection().connected } catch { return false } }, 15000)
  await sleep(1000)
  const C = await mcp('c')
  const jc = await C.call('hive_join', { dir: folder('c'), name: 'Ganesh', link })
  T('P1 an agent joining as Ganesh, while the person Ganesh is here, is refused (Q581)', /^NOT JOINED -- Q581: Ganesh is already in this room \(human/.test(jc), jc.slice(0, 160))
}

// ------------------------------------------------------------------ R
sec('R  not refused: the same agent in its own folder, and its own listener')
{
  const D = await mcp('d')
  const jd = await D.call('hive_join', { dir: folder('rex'), name: 'Rex' })
  const link2 = (/invite link: (\S+)/.exec(jd) || [])[1]
  T('R0 setup: Rex joined a room of its own', joined(jd))
  const { relay: R2, room: room2 } = parseLink(link2)
  // Rex's own listener, under Rex's name, as an agent's shell starts it.
  const listenerTemp = folder('rex-await-temp')
  const L = spawn(process.execPath, [path.join(ROOT, 'hive-await.js'), link2, 'Rex', '5'], { cwd: ROOT, env: { ...process.env, TEMP: listenerTemp, TMPDIR: listenerTemp } })
  kids.push(L)
  let lerr = ''
  L.stderr.on('data', (d) => { lerr += d })
  await until(() => /listening in/.test(lerr), 15000)
  // The previous connection of this same agent, still in the room: same machine, same folder.
  const ghost = startSync({ relay: R2, room: room2, dir: path.join(TMP, 'rex'), name: 'Rex', kind: 'ai', syncFiles: false, log: () => { } })
  raws.push(ghost)
  await until(() => { try { return ghost.connection().connected } catch { return false } }, 15000)
  await sleep(1000)
  const again = await D.call('hive_join', { dir: path.join(TMP, 'rex'), name: 'Rex', link: link2 })
  T('R1 Rex rejoining from its own folder is NOT refused, with its listener and its previous connection both still present', joined(again), again.slice(0, 160))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
