// makeSlackPoller: where a first attach starts reading, and how the cursor moves.
//
// Found by Antigravity reviewing 718e0bf (8 Nov 2026):
//   P1  First attach anchored to the newest TOP-LEVEL message's ts. A reply in a tracked thread
//       that is newer than that ts, but was posted before the bridge attached, was then delivered
//       as new: a "stop" from before the bridge existed acted on now.
//   P2  The cursor advanced only over top-level messages. Almost all bridge traffic is thread
//       replies, so the cursor stood still: the "offline since" in the downtime notice went stale,
//       and the s:/c: keys in the room were never pruned.
// The fake Slack below behaves like the real one for these two methods: history is newest-first,
// carries reply_count/latest_reply on thread roots, and has no `channel`; replies returns the root
// first, then replies oldest-first from `oldest` (inclusive).
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { slackArgs, slackArgsError } from './fake-slack-args.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { makeSlackPoller } = await import(pathToFileURL(path.join(ROOT, 'hive-slack.js')).href)

let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   ${detail}`}`) }

function fakeSlack() {
  const msgs = [] // { ts, text, user, thread_ts? }
  const add = (ts, text, thread_ts) => { msgs.push({ ts: ts.toFixed(6), text, user: 'U_ALICE', ...(thread_ts ? { thread_ts: thread_ts.toFixed(6) } : {}) }) }
  const n = (s) => Number(s) || 0
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop().split('?')[0]
    // Arguments as REAL Slack reads them (0.14.3 P0-4): a JSON body on a read method is not read.
    const h = (init && init.headers) || {}
    const body = slackArgs(method, h['Content-Type'] || h['content-type'], init.body, url)
    let out = slackArgsError(method, body)
    if (out) { /* answered as Slack answers a call with no arguments */ } else if (method === 'conversations.history') {
      const top = msgs.filter((m) => !m.thread_ts || m.thread_ts === m.ts).map((m) => {
        const reps = msgs.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts)
        const { ...copy } = m
        if (reps.length) { copy.reply_count = reps.length; copy.latest_reply = reps[reps.length - 1].ts; copy.thread_ts = m.ts }
        return copy
      }).sort((a, b) => n(b.ts) - n(a.ts))
      out = { ok: true, messages: top.slice(0, body.limit || 100), has_more: false }
    } else if (method === 'conversations.replies') {
      const root = msgs.find((m) => m.ts === String(body.ts))
      const reps = msgs.filter((r) => r.thread_ts === String(body.ts) && r.ts !== String(body.ts) && n(r.ts) >= n(body.oldest || 0))
      out = { ok: true, messages: [root, ...reps].filter(Boolean), has_more: false }
    } else out = { ok: false, error: 'unknown_method' }
    return { status: 200, headers: { get: () => null }, json: async () => out }
  }
  return { add, fetchImpl }
}

function poller(slack, { threads, nowSec }) {
  const store = new Map()
  const got = []
  const p = makeSlackPoller({
    token: 'xoxb-test', channel: 'C-TEST', api: 'http://fake', fetchImpl: slack.fetchImpl,
    store, threads, claimSettleMs: 0, now: () => nowSec * 1000,
    onEvent: async (ev) => { got.push(ev) }, logErr: () => {},
  })
  return { p, store, got }
}

// P1: the newest top-level message is a thread root (1000) whose latest reply (1500, "stop") came
// before the bridge attached. After attaching, the next tick must not deliver it.
{
  const s = fakeSlack()
  s.add(1000, 'room thread root')
  s.add(1500, 'stop', 1000)
  const threads = new Map([['__room__', '1000.000000']])
  const { p, got } = poller(s, { threads, nowSec: 1600 })
  await p.tick()
  await p.tick()
  T('P1 a reply posted before the first attach is not delivered (root is the newest message)', !got.some((m) => m.text === 'stop'), JSON.stringify(got.map((m) => [m.ts, m.text])))
  s.add(1700, 'after attach', 1000)
  await p.tick()
  T('P1 a reply posted after the attach IS delivered', got.some((m) => m.text === 'after attach'), JSON.stringify(got.map((m) => [m.ts, m.text])))
}

// P1b: the tracked thread is NOT the newest top-level message. Its root (900) is older than the
// newest top-level message (1000), but its reply (1600) is newer than both and pre-dates attach.
{
  const s = fakeSlack()
  s.add(900, 'task thread root')
  s.add(1000, 'unrelated channel message')
  s.add(1600, 'stop', 900)
  const threads = new Map([['T-1', '900.000000']])
  const { p, got } = poller(s, { threads, nowSec: 1700 })
  await p.tick()
  await p.tick()
  await p.tick()
  T('P1b a pre-attach reply in an older tracked thread is not delivered', !got.some((m) => m.text === 'stop'), JSON.stringify(got.map((m) => [m.ts, m.text])))
}

// P2: after attaching, only thread replies arrive. The cursor must move to the newest of them.
{
  const s = fakeSlack()
  s.add(1000, 'room thread root')
  const threads = new Map([['__room__', '1000.000000']])
  const { p, store, got } = poller(s, { threads, nowSec: 2200 })
  await p.tick() // anchors at 1000
  s.add(2000, 'reply one', 1000)
  s.add(2100, 'reply two', 1000)
  await p.tick()
  T('P2 both replies delivered', got.filter((m) => /^reply /.test(m.text)).length === 2, JSON.stringify(got.map((m) => [m.ts, m.text])))
  T('P2 the cursor moves over thread replies, not only top-level messages', store.get('cursor') === '2100.000000', `cursor=${store.get('cursor')}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
