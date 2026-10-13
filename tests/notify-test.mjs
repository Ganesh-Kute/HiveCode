// THE ROOM NOTIFIER (hive-notify.js): an owner hears when an agent is waiting on them.
//
//   node tests/notify-test.mjs
//
// Real relay, real participants, a webhook faked at fetch. What it must never do: look alive and
// deliver nothing, send the room's link, send a key, or send the same thing twice.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const url = (f) => `file:///${ROOT.replace(/\\/g, '/')}/${f}`
const { startSync } = await import(url('sync.js'))
// A mutant run points this at a changed copy beside the real one (scripts/github-mutants.mjs).
const N = await import(url(process.env.HIVE_NOTIFY_MODULE || 'hive-notify.js'))
const { makeNotifier } = await import(url('hive-webhook.js'))

const PORT = await freePort()
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'room-NotifyTestQ7xYz12abc'
const LINK = `${RELAY}|${ROOM}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-notify-'))
function startRelay() {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  })
}
async function until(pred, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true } catch { } await sleep(100) } return false }

/** A webhook: every post it took, as text. `status` decides what it answers. */
function webhook(status = 200) {
  const posts = []
  const fetchImpl = async (u, init) => { const b = JSON.parse(init.body); posts.push(b.text || b.content); return { ok: status < 300, status } }
  return { posts, fetchImpl }
}
const join = (name, kind, owner = '') => startSync({ relay: RELAY, room: ROOM, dir: path.join(tmp, name), name, kind, owner, syncFiles: false, log: () => { } })
const synced = (h) => new Promise((res) => { if (h.provider.synced) res(); h.provider.on('sync', (s) => { if (s) res() }) })

let relay = await startRelay()
const people = []
try {
  console.log('\n# it refuses to run silently')
  const bad = webhook(404)
  const out = []
  let code = await N.main([LINK, '--webhook', 'https://hooks.slack.com/services/T/B/x', '--for', 'Ganesh'], { fetchImpl: bad.fetchImpl, log: (s) => out.push(s), logErr: (s) => out.push(s), home: tmp, once: true })
  T('NT1 a webhook that refuses the first post: nothing runs', code === 1 && /Q643/.test(out.join('\n')), out.join(' | '))
  const good = webhook(200)
  code = await N.main([LINK, '--webhook', 'https://discord.com/api/webhooks/1/x', '--for', 'Ganesh', '--title', 'the night shift'], { fetchImpl: good.fetchImpl, log: () => { }, logErr: () => { }, home: tmp, once: true })
  T('NT2 a good webhook gets one hello naming who it watches for', code === 0 && good.posts.length === 1 && /when an agent in the night shift is waiting on Ganesh/.test(good.posts[0]), good.posts[0])
  const out3 = []
  code = await N.main([LINK, '--webhook', 'https://x.example/h'], { fetchImpl: good.fetchImpl, log: () => { }, logErr: (s) => out3.push(s), home: tmp, once: true })
  T('NT3 without --for it asks whose waits to report', code === 2 && /Q642/.test(out3.join('')))

  console.log('\n# approvals: at once, once, and not while the owner is here')
  const claude = join('Claude', 'ai', 'Ganesh'); people.push(claude)
  const builder = join('Builder', 'ai', 'Ganesh'); people.push(builder)
  const alice = join('Alice', 'human'); people.push(alice)
  const watcher = startSync({ relay: RELAY, room: ROOM, dir: path.join(tmp, 'Notifier'), name: 'Notifier', kind: 'ai', syncFiles: false, passive: true, log: () => { } }); people.push(watcher)
  await Promise.all(people.map(synced))
  await until(() => watcher.members().length >= 4)
  const hook = webhook(200)
  const send = makeNotifier('https://hooks.slack.com/services/T/B/x', { fetchImpl: hook.fetchImpl })
  let clock = Date.now()
  const stateFile = path.join(tmp, 'sent.json')
  let w = N.makeWatch({ hive: watcher, forNames: ['Ganesh'], title: 'the night shift', send, now: () => clock, every: 5, stateFile })
  const key = 'AKIA' + 'Q'.repeat(4) + 'ZX7Y2W9V4T8R'
  alice.assign('Claude', `deploy the fix; the deploy key is ${key}`)
  await until(() => w.waiting().length === 1)
  await w.check()
  await w.check()
  const approvals = hook.posts.filter((p) => /^Approval needed/.test(p))
  T('NT4 a task waiting for the owner is sent at once, and once', approvals.length === 1 && /Alice asked Claude to "deploy the fix/.test(approvals[0]) && /Ganesh approves or denies it/.test(approvals[0]), approvals[0])
  T('NT5 a key in the task text is removed before it is sent', approvals[0] && !approvals[0].includes(key) && /removed\]/.test(approvals[0]))
  const ganesh = join('Ganesh', 'human'); people.push(ganesh)
  await synced(ganesh)
  await until(() => watcher.members().some((m) => m.name === 'Ganesh'))
  alice.assign('Builder', 'also update the docs')
  await until(() => w.waiting().length === 2)
  await w.check()
  T('NT6 not sent while the owner is in the room', hook.posts.filter((p) => /^Approval needed/.test(p)).length === 1)
  ganesh.stop(); people.splice(people.indexOf(ganesh), 1)
  await until(() => !watcher.members().some((m) => m.name === 'Ganesh'), 15000)
  await w.check()
  T('NT7 sent once the owner has left', hook.posts.filter((p) => /^Approval needed/.test(p)).length === 2)
  w = N.makeWatch({ hive: watcher, forNames: ['Ganesh'], title: 'the night shift', send, now: () => clock, every: 5, stateFile })
  await w.check()
  T('NT8 a restart sends neither again', hook.posts.filter((p) => /^Approval needed/.test(p)).length === 2)

  console.log('\n# messages naming them: from agents, batched')
  const before = hook.posts.length
  builder.say('@Ganesh which port should the API listen on?')
  await until(() => watcher.doc.getArray('chat').toArray().some((m) => /which port/.test(m.text)))
  await w.check()
  T('NT9 the first message for them is sent', hook.posts.length === before + 1 && /1 message for Ganesh in the night shift:\n- Builder: @Ganesh which port/.test(hook.posts[before]), hook.posts[before])
  builder.say('@Ganesh also: should it log to a file?')
  builder.say('@all heads up, tests are green')
  builder.say('@Ganeshx is a different person')
  alice.say('@Ganesh a human saying something is not an agent waiting')
  await until(() => watcher.doc.getArray('chat').toArray().some((m) => /different person/.test(m.text)))
  clock += 60000
  await w.check()
  T('NT10 more within --every minutes wait', hook.posts.length === before + 1)
  clock += 5 * 60000
  await w.check()
  const batch = hook.posts[before + 1] || ''
  T('NT11 then one post carries them', /^2 messages for Ganesh/.test(batch) && /log to a file/.test(batch) && /tests are green/.test(batch), batch)
  T('NT12 not a longer name, and not a person\'s message', !/Ganeshx/.test(batch) && !/a human saying/.test(batch))
  T('NT13 no post anywhere names the room\'s id', !hook.posts.concat(good.posts).some((p) => p.includes(ROOM) || p.includes(LINK)))

  console.log('\n# the connection')
  const beforeLost = hook.posts.length
  relay.kill()
  await until(() => !watcher.connection().connected, 10000)
  await w.check()
  clock += 6 * 60000
  await w.check()
  await w.check()
  T('NT14 lost for five minutes is said once', hook.posts.length === beforeLost + 1 && /lost the night shift/.test(hook.posts[beforeLost]), hook.posts.slice(beforeLost).join(' | '))
  relay = await startRelay()
  await until(() => watcher.connection().connected, 20000)
  await w.check()
  T('NT15 and back is said once', hook.posts.length === beforeLost + 2 && /back in the night shift/.test(hook.posts[beforeLost + 1]))
} catch (err) {
  T(`no exception (${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err})`, false)
} finally {
  for (const p of people) { try { p.stop() } catch { } }
  relay.kill()
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
