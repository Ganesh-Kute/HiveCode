// hive-notify -- tell a person, on Slack or Discord, when an agent in a room is waiting on them.
//
//   npx -y hivecode-mcp@latest notify "<link>" --webhook <url> --for <name>[,<name>] [--every <minutes>] [--title <text>]
//
// WHY. On 10 Oct 2026 a two-agent demo stalled for an hour: one agent waited for its person's OK,
// the other waited for it, and the person was not looking at the chat. The room knew. Nobody was
// told. An owner who leaves agents working has to hear about the two things only they can unblock:
//
//   - a task waiting for their approval        sent at once: an agent is stopped until they answer
//   - messages from agents naming them          batched, at most one post per --every minutes
//
// Neither is sent while that person is in the room (the Control Room counts): they can see it.
//
// WHAT IS NEVER SENT: the room's link or full id. On an open relay the id is the key to the room's
// files, and a Slack channel is not the place for a key. Messages name the room by --title, or by
// the first characters of its id.
//
// IT MUST NOT LOOK ALIVE AND DELIVER NOTHING. It posts once when it starts and refuses to run if
// that post fails; it says once when it has lost the room and once when it is back.
//
// Error codes Q640-Q649 are this module's.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync, parseLink } from './sync.js'
import { makeNotifier, scrub } from './hive-webhook.js'
import { relayFetch } from './hive-transport.js'
import * as SEEN from './hive-seen.js' // what was already looked at, by Yjs id (0.14.4)

const oneLine = (s, n = 200) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LOST_AFTER = 5 * 60000

/** Does `text` address `name` (@Name, not part of a longer word)? @all counts. */
export function addresses(text, name) {
  const t = String(text || '')
  if (/(^|[^\w@])@all\b/i.test(t)) return true
  return new RegExp(`(^|[^\\w@])@${esc(name)}(?![\\w-])`, 'i').test(t)
}

/** What has been sent, kept on disk so a restart does not send it again. */
export function stateFileFor(room, home = os.homedir()) {
  const h = crypto.createHash('sha256').update(String(room)).digest('hex').slice(0, 16)
  return path.join(home, '.hivecode', 'notify', `${h}.json`)
}
export function lockFileFor(room, home = os.homedir()) {
  const h = crypto.createHash('sha256').update(String(room)).digest('hex').slice(0, 16)
  return path.join(home, '.hivecode', 'notify', `${h}.lock`)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** One notifier per room. Created exclusively so two starting at the same time cannot double-post. */
export function takeLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      fs.closeSync(fd)
      return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file) } catch { } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = null
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { held = null }
      if (held && held.pid && held.pid !== process.pid && alive(held.pid)) {
        const err = new Error(`Q644 a notifier is already running for this room (process ${held.pid}, since ${held.at}). Use that one, or stop it first.`)
        err.code = 'Q644'
        throw err
      }
      try { fs.unlinkSync(file) } catch { }
    }
  }
  const err = new Error(`Q644 could not take ${file}`)
  err.code = 'Q644'
  throw err
}
function loadSent(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.tasks) return j } catch { }
  return { tasks: {} }
}
function saveSent(file, s) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const ids = Object.keys(s.tasks)
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete s.tasks[id]
    fs.writeFileSync(file, JSON.stringify(s))
  } catch { /* a notifier that cannot remember sends twice; it still sends */ }
}

/**
 * The watching itself, on a live sync handle. `check()` is one pass; the CLI calls it on a timer,
 * and tests call it with a clock of their own.
 */
export function makeWatch({ hive, forNames, title, send, now = () => Date.now(), every = 5, stateFile, log = () => {} }) {
  const people = forNames.map((n) => String(n).trim()).filter(Boolean)
  const lc = new Set(people.map((n) => n.toLowerCase()))
  const tasks = hive.doc.getMap('tasks')
  const owners = hive.doc.getMap('owners')
  const chat = hive.doc.getArray('chat')
  const sent = loadSent(stateFile)
  // SEEN BY IDENTITY, NOT BY COUNT (0.14.4). A count missed a late message: one a peer pushed while
  // its update was in flight integrates BEHIND what was already counted, and `slice(seenChat)` never
  // looked there, so a mention of someone away was never notified (hive-seen.js has the incident).
  // A plain array (a test double) is append-only, so the count stays exact for it.
  const ych = SEEN.isYArray(chat)
  const seen = ych ? SEEN.makeFrontier() : null
  if (ych) for (const { id } of SEEN.itemsOf(chat)) seen.add(id) // what was said before this started is not news
  let seenChat = chat.length
  const buffer = []
  let lastFlush = 0
  let lostSince = 0
  let toldLost = false

  const here = (name) => (hive.members ? hive.members() : []).some((m) => String(m.name).toLowerCase() === name.toLowerCase() && m.kind === 'human')
  const ownerOf = (t) => String(owners.get(t.to) || '')

  function waiting() {
    return [...tasks.values()].filter((t) => t && t.status === 'pending' && lc.has(ownerOf(t).toLowerCase()))
  }

  async function check() {
    const t = now()
    // THE CONNECTION. Lost for five minutes is said once; back is said once.
    const connected = !!(hive.connection ? hive.connection().connected : hive.provider && hive.provider.wsconnected)
    if (!connected) {
      if (!lostSince) lostSince = t
      if (!toldLost && t - lostSince >= LOST_AFTER) {
        toldLost = true
        await send(`Hivecode lost ${title} ${Math.round((t - lostSince) / 60000)} minutes ago, so nothing from it can reach you here. It keeps trying to reconnect.`)
      }
      return
    }
    if (lostSince) {
      if (toldLost) await send(`Hivecode is back in ${title}.`)
      lostSince = 0
      toldLost = false
    }

    // A TASK WAITING FOR APPROVAL: at once, once per task.
    for (const task of waiting()) {
      const owner = ownerOf(task)
      if (sent.tasks[task.id] || here(owner)) continue
      const ok = await send(`Approval needed in ${title}: ${task.by} asked ${task.to} to "${oneLine(task.text, 300)}". ${task.to} waits until ${owner} approves or denies it in the Control Room.`)
      if (ok) {
        sent.tasks[task.id] = t
        saveSent(stateFile, sent)
      }
    }

    // MESSAGES NAMING THEM, from agents, while they are away: batched.
    let fresh
    if (ych) {
      // A rebuilt room needs no special case: its messages carry ids this frontier has never seen.
      fresh = []
      for (const { id, value } of SEEN.itemsOf(chat)) { if (seen.has(id)) continue; seen.add(id); fresh.push(value) }
    } else {
      const all = chat.toArray()
      if (all.length < seenChat) seenChat = 0 // the relay restarted and the room's history went with it
      fresh = all.slice(seenChat)
      seenChat = all.length
    }
    for (const m of fresh) {
      if (!m || m.kind !== 'ai') continue
      for (const p of people) if (addresses(m.text, p) && !here(p)) { buffer.push({ by: m.by, to: p, text: m.text }); break }
    }
    if (buffer.length && t - lastFlush >= every * 60000) {
      const shown = buffer.slice()
      const to = [...new Set(shown.map((b) => b.to))].join(', ')
      const lines = shown.slice(0, 5).map((b) => `- ${b.by}: ${oneLine(b.text, 220)}`)
      if (shown.length > 5) lines.push(`- and ${shown.length - 5} more`)
      const ok = await send(`${shown.length} message${shown.length === 1 ? '' : 's'} for ${to} in ${title}:\n${lines.join('\n')}`)
      if (ok) {
        buffer.splice(0, shown.length)
        lastFlush = t
      }
    }
  }

  return { check, waiting, buffered: () => buffer.length, sent }
}

// ---- CLI -------------------------------------------------------------------------------------------

const USAGE = `usage:
  npx -y hivecode-mcp@latest notify "<link>" --webhook <Slack or Discord webhook URL> --for <name>[,<name>]

  --for <names>     whose approvals and mentions to send (the people, not their agents)
  --every <min>     at most one post of messages per this many minutes (default 5)
  --title <text>    what to call the room in posts (default: the first characters of its id)
  --name <name>     the notifier's own name in the room (default Notifier)`

export async function main(argv, { log = console.log, logErr = console.error, fetchImpl = relayFetch, home = os.homedir(), now = () => Date.now(), once = false } = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { log(USAGE); return 0 }
  const SWITCHES = new Set(['dry-run', 'once'])
  const pos = []
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (SWITCHES.has(k)) f[k] = true
      else f[k] = argv[++i] ?? ''
    } else {
      pos.push(a)
    }
  }
  const link = pos[0] || ''
  const { relay, room, token } = parseLink(link)
  if (!relay || !room) { logErr(`Q640 "${link}" is not a room link (it looks like wss://relay|room-...).\n\n${USAGE}`); return 2 }
  if (!f.webhook) { logErr(`Q641 say where to post, with --webhook <Slack or Discord incoming-webhook URL>.\n\n${USAGE}`); return 2 }
  const forNames = String(f.for || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!forNames.length) { logErr(`Q642 say whose waits to report, with --for <name> (the person, as they appear in the room).\n\n${USAGE}`); return 2 }
  const every = Number(f.every || 5)
  if (!(every > 0)) { logErr('Q642 --every must be a positive number of minutes'); return 2 }
  const title = f.title ? oneLine(f.title, 60) : `room ${room.slice(0, 8)}…`
  const send = makeNotifier(f.webhook, { fetchImpl, log })

  // FIRST, PROVE THE WEBHOOK WORKS. A notifier whose posts go nowhere is worse than none: the person
  // believes they will be told.
  if (send.kind === 'other' && send.host) log(`posting in Slack format to ${send.host}`)
  const okSent = await send(`Hivecode will post here when an agent in ${title} is waiting on ${forNames.join(', ')}.`)
  if (!okSent) { logErr('Q643 the webhook refused the first post (see above). Check the URL, then start again. Nothing is running.'); return 1 }

  const lockFile = lockFileFor(room, home)
  const releaseLock = (() => { try { return takeLock(lockFile) } catch (e) { logErr(e.message); return null } })()
  if (!releaseLock) return 2

  const dir = path.join(home, '.hivecode', 'notify', `room-${crypto.createHash('sha256').update(room).digest('hex').slice(0, 12)}`)
  const hive = startSync({ relay, room, dir, name: f.name || 'Notifier', kind: 'ai', token: token || process.env.HIVE_TOKEN || '', syncFiles: false, passive: true, log: () => { } })
  const w = makeWatch({ hive, forNames, title, send, now, every, stateFile: stateFileFor(room, home), log })
  let synced = false
  await new Promise((res) => { const t = setTimeout(res, 15000); hive.provider.on('sync', (s) => { if (s) { synced = true; clearTimeout(t); res() } }) })
  if (!synced && !(hive.provider && hive.provider.wsconnected)) {
    logErr(`NOTE: could not connect to relay at ${relay}. The room may be unreachable or the network down.`)
  }
  const members = (hive.members() || []).filter((m) => m.name !== (f.name || 'Notifier')).map((m) => `${m.name} (${m.kind})`)
  const pending = w.waiting().length
  log(`watching ${title}: ${members.length ? members.join(', ') : 'nobody here yet'}; ${pending} approval(s) waiting now. Ctrl+C stops it.`)
  if (!members.length && !hive.doc.getArray('chat').length) log('NOTE: this room is empty -- no members and no chat. Is the link right?')
  if (once || f['dry-run']) { await w.check(); hive.stop(); releaseLock(); return 0 }
  const timer = setInterval(() => { w.check().catch((e) => log(`check failed: ${e.message}`)) }, 15000)
  const quit = () => { clearInterval(timer); try { hive.stop() } catch { } try { releaseLock() } catch { } process.exit(0) }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  await w.check()
  return new Promise(() => { }) // runs until stopped
}

