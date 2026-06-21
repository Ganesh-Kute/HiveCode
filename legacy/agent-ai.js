// AI agent that actually reasons with Claude to edit a shared file.
//
//   node agent-ai.js <relay> <room> <name> <relativeFilePath> "<instruction>"
//
// It joins the room, LOCKS the target file (so it never collides), reads the
// current contents, asks Claude for the full new version, and writes it back
// through the shared doc — every other participant sees the edit live.
//
// Safe by default: with no API key it runs in STUB mode (a deterministic edit),
// so you can test the whole pipeline offline. To use the real model:
//   set LIVECODE_AI=1 and ANTHROPIC_API_KEY=...   then run as above.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff, lockHeldByOther } from './core.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'Claude', FILE = 'file.txt', ...rest] = process.argv
const INSTRUCTION = rest.join(' ') || 'improve this code'
const USE_AI = process.env.LIVECODE_AI === '1' && !!process.env.ANTHROPIC_API_KEY

const doc = new Y.Doc()
const files = doc.getMap('files')   // path -> Y.Text (same model as folder.js)
const locks = doc.getMap('locks')
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Ask Claude for the full new file. Falls back to a deterministic stub offline.
async function think(current) {
  if (!USE_AI) return current + `\n# [${NAME}] (stub) would: ${INSTRUCTION}\n`
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic()
  // Stream for long edits (avoids request timeouts); adaptive thinking on.
  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system:
      'You are a coding agent collaborating live on a shared file. ' +
      'Return ONLY the complete new contents of the file — no markdown fences, no commentary.',
    messages: [
      { role: 'user', content: `Current contents of ${FILE}:\n\n${current}\n\nApply this change: ${INSTRUCTION}` },
    ],
  })
  const msg = await stream.finalMessage()
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

// Lock → reason → write → release (so two AIs never clobber the same file).
async function withLock(file, fn) {
  while (true) {
    if (lockHeldByOther(locks, file, NAME, now())) { await sleep(400); continue }
    locks.set(file, { owner: NAME, intent: INSTRUCTION, exp: now() + 15000 })
    await sleep(500)
    if (locks.get(file)?.owner === NAME) break
    await sleep(300)
  }
  try { return await fn() }
  finally { if (locks.get(file)?.owner === NAME) locks.delete(file) }
}

provider.on('sync', async (s) => {
  if (!s) return
  console.log(`[${NAME}] joined "${ROOM}" (${USE_AI ? 'LIVE Claude' : 'stub'} mode). Target: ${FILE}`)
  await withLock(FILE, async () => {
    let yt = files.get(FILE)
    if (!yt) { yt = new Y.Text(); files.set(FILE, yt) }
    const before = yt.toString()
    console.log(`[${NAME}] locked ${FILE}, reasoning about: "${INSTRUCTION}"...`)
    const after = await think(before)
    applyDiff(yt, after)
    console.log(`[${NAME}] wrote ${FILE} (${before.length} → ${after.length} chars), releasing lock.`)
  })
  await sleep(1000) // let the edit propagate
  provider.destroy()
  process.exit(0)
})
