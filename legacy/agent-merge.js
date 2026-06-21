// LIVE lock-free agent — patch-apply-or-rework over the relay.
//
//   stub mode (deterministic, no API key):
//     node agent-merge.js <relay> <room> <name> <file> <reasonMs> "<find>" "<replace>"
//   live mode (real Claude):
//     LIVECODE_AI=1 ANTHROPIC_API_KEY=... \
//     node agent-merge.js <relay> <room> <name> <file> <reasonMs> "<instruction...>"
//
// Nobody locks. The agent:
//   1. reads the file NOW            (this is its "base" — what it reasoned on)
//   2. posts its intent on the board (so teammates can see what it's doing)
//   3. reasons for <reasonMs>        (the window where the file can go stale)
//   4. at WRITE time re-reads the file and runs mergeEdit(base, mine, current):
//        - current unchanged      -> write mine
//        - disjoint line edits     -> merge both (no rework)
//        - same lines changed      -> CONFLICT -> re-reason on the fresh code
//
// Stub mode (default): the edit is a literal find->replace, so collisions are
// deterministic and easy to stage. Real mode (LIVECODE_AI=1 + ANTHROPIC_API_KEY)
// asks Claude for the new file and, on conflict, re-asks against the fresh code.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff, mergeEdit } from './core.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'Claude', FILE = 'file.txt', REASON = '3000', ...rest] = process.argv
const reasonMs = Number(REASON) || 0
const USE_AI = process.env.LIVECODE_AI === '1' && !!process.env.ANTHROPIC_API_KEY
// stub mode reads find/replace; live mode treats the rest as a natural instruction.
const FIND = rest[0] || ''
const REPLACE = rest[1] || ''
const AI_INSTRUCTION = rest.join(' ') || 'improve this file'

const doc = new Y.Doc()
const files = doc.getMap('files') // path -> Y.Text (same model as folder.js)
const board = doc.getMap('board') // name -> { file, intent, state, ts } (the shared coordination board)
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => `${NAME} @${Date.now() % 100000}`
const post = (state, intent) => board.set(NAME, { file: FILE, intent, state, ts: Date.now() % 100000 })

// Produce the new file contents from some current text. In stub mode this is a
// literal find->replace; the SAME function is reused on rework, so re-reasoning
// re-applies the intent to whatever the code looks like now.
async function edit(text, intent) {
  if (!USE_AI) return FIND ? text.split(FIND).join(REPLACE) : text + `\n# [${NAME}] ${intent}\n`
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const stream = new Anthropic().messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system: 'You are a coding agent collaborating live on a shared file. Return ONLY the complete new contents of the file — no fences, no commentary.',
    messages: [{ role: 'user', content: `Current contents of ${FILE}:\n\n${text}\n\nApply this change: ${intent}` }],
  })
  const msg = await stream.finalMessage()
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

provider.on('sync', async (s) => {
  if (!s) return
  const intent = USE_AI ? AI_INSTRUCTION : `change "${FIND}" -> "${REPLACE}"`
  console.log(`[${stamp()}] joined "${ROOM}" (${USE_AI ? 'LIVE Claude' : 'stub'}). target=${FILE}`)

  let yt = files.get(FILE)
  if (!yt) { yt = new Y.Text(); files.set(FILE, yt) }

  // 1. read base  2. post intent  3. reason (the stale-read window)
  const base = yt.toString()
  post('reasoning', intent)
  console.log(`[${stamp()}] read ${base.length} chars, posted intent, reasoning ${reasonMs}ms...`)
  const mine = await edit(base, intent)
  await sleep(reasonMs)

  // 4. write-time re-check against whatever is there NOW
  const current = files.get(FILE).toString()
  if (process.env.MERGE_DEBUG) {
    console.error(`[${NAME} DEBUG] base===current? ${base === current}`)
    console.error(`[${NAME} DEBUG] base:    ${JSON.stringify(base)}`)
    console.error(`[${NAME} DEBUG] mine:    ${JSON.stringify(mine)}`)
    console.error(`[${NAME} DEBUG] current: ${JSON.stringify(current)}`)
  }
  const r = mergeEdit(base, mine, current)
  if (r.ok) {
    if (current === base) console.log(`[${stamp()}] file unchanged -> writing my edit.`)
    else console.log(`[${stamp()}] file moved under me, but our edits are DISJOINT -> merging both (no rework).`)
    applyDiff(files.get(FILE), r.text)
    post('done', intent)
  } else {
    console.log(`[${stamp()}] CONFLICT — my lines changed under me. Re-reasoning on the FRESH code...`)
    post('reworking', intent)
    const redone = await edit(current, intent) // re-apply intent to current
    applyDiff(files.get(FILE), redone)
    post('done', intent)
    console.log(`[${stamp()}] reworked and wrote on top of the fresh code.`)
  }

  await sleep(800) // let the edit propagate
  provider.destroy()
  process.exit(0)
})
