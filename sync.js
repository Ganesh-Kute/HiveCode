// Hivecode sync engine — the reusable core both the human client (folder.js)
// and the autonomous agent client (hive-agent.js) run on. This is also the seed
// of the public SDK: any tool or AI agent can `startSync(...)` to become a
// first-class participant in a room — no human setup required.
//
//   startSync({ relay, room, dir, name, kind, log }) -> { doc, provider, stop }
//
// `kind` is the participant's identity ('human' | 'ai'). It is set BY WHOEVER
// STARTS THE CLIENT — a human editor passes 'human', an agent passes 'ai' — so
// nobody has to manually "declare" anything; the identity is implicit in which
// client is run.
//
// Every change (disk->doc and doc->disk) goes through reconcile(): a 3-way merge
// against each file's last agreed base, so disjoint edits merge, same-line edits
// get conflict markers (nobody's work is silently lost), and wholesale rewrites
// are auto-logged to a shared board (HIVE_BOARD.md) for other agents to read.

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff, merge3, summarizeChange } from './core.js'

const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000
const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file

export function startSync({ relay = 'ws://localhost:1234', room = 'default', dir = '.', name = 'anon', kind = 'human', log = console.log }) {
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })

  const doc = new Y.Doc()
  const files = doc.getMap('files') // relPath -> Y.Text
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols }
  const provider = new WebsocketProvider(relay, room, doc, { WebSocketPolyfill: WebSocket })
  provider.awareness.setLocalStateField('user', { name, kind }) // identity is implicit in the client

  const known = new Set()
  const mtimes = new Map()
  const bases = new Map()

  function walk(d, acc = []) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, acc)
      else if (e.isFile()) acc.push(full)
    }
    return acc
  }
  const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')

  function readText(full) {
    try {
      const buf = fs.readFileSync(full)
      if (buf.length > MAX_BYTES || buf.includes(0)) return null
      return buf.toString('utf8')
    } catch { return null }
  }
  function writeToDisk(relPath, content) {
    const full = path.join(ROOT, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    known.add(relPath)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch {}
  }

  function reconcile(relPath, origin = 'local') {
    if (relPath === BOARD_FILE) return
    const full = path.join(ROOT, relPath)
    const yt = files.get(relPath)
    const disk = fs.existsSync(full) ? readText(full) : null
    const docText = yt ? yt.toString() : null
    if (disk === null && docText === null) return
    if (docText === null) {
      const t = new Y.Text(); files.set(relPath, t); t.insert(0, disk)
      known.add(relPath); bases.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch {}
      return
    }
    if (disk === null) { writeToDisk(relPath, docText); bases.set(relPath, docText); return }
    if (disk === docText) { known.add(relPath); bases.set(relPath, disk); return }
    const base = bases.has(relPath) ? bases.get(relPath) : disk
    if (origin === 'local') noteIfRewrite(relPath, base, disk)
    const res = merge3(base, disk, docText)
    doc.transact(() => applyDiff(yt, res.text))
    if (res.text !== disk) writeToDisk(relPath, res.text)
    known.add(relPath); bases.set(relPath, res.text)
    log(res.conflict ? `[${name}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers` : `[${name}] merged ${relPath} (both edits kept)`)
  }

  const fmtTime = () => new Date().toTimeString().slice(0, 8)
  function noteIfRewrite(relPath, base, next) {
    if (!base) return
    const s = summarizeChange(base, next)
    if (!s.isRewrite) return
    board.set(relPath, { by: name, at: fmtTime(), churn: `${s.changedLines}/${s.totalLines} lines`, symbols: s.symbols })
    log(`[${name}] board: logged REWRITE of ${relPath} (${s.changedLines}/${s.totalLines} lines; touched ${s.symbols.join(', ') || 'n/a'})`)
  }
  function renderBoard() {
    const out = [
      '# Hive Board — recent full-file rewrites (auto-logged by Hivecode).',
      '# READ THIS before editing a file someone just rewrote, then re-read that file.',
      '',
    ]
    const entries = [...board.entries()].map(([file, e]) => ({ file, ...e })).sort((a, b) => (a.at < b.at ? 1 : -1))
    if (!entries.length) out.push('(no rewrites yet — patches and small edits are not listed)')
    for (const e of entries) out.push(`- ${e.at}  ${e.by} rewrote \`${e.file}\` (${e.churn}) — touched: ${(e.symbols || []).join(', ') || 'n/a'}`)
    writeToDisk(BOARD_FILE, out.join('\n') + '\n')
  }
  board.observe(() => renderBoard())

  function scan() {
    const diskFulls = walk(ROOT)
    const diskRel = new Set(diskFulls.map(rel))
    for (const full of diskFulls) {
      const r = rel(full)
      if (r === BOARD_FILE) continue
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && files.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local')
    }
    const removed = [...known].filter((r) => !diskRel.has(r) && files.has(r))
    if (removed.length) {
      doc.transact(() => {
        for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r); bases.delete(r) }
      })
    }
  }

  files.observeDeep((events, txn) => {
    if (txn.local) return
    for (const ev of events) {
      if (ev.target === files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') {
            try { fs.rmSync(path.join(ROOT, key)) } catch {}
            known.delete(key); bases.delete(key)
            log(`[${name}] <- deleted ${key}`)
          } else {
            reconcile(key, 'remote')
          }
        })
      } else {
        for (const [key, yt] of files.entries()) {
          if (yt === ev.target) { reconcile(key, 'remote'); break }
        }
      }
    }
  })

  let scanTimer = null
  provider.on('sync', (s) => {
    if (!s) return
    for (const [key] of files.entries()) reconcile(key, 'remote')
    if (board.size) renderBoard()
    scan()
    log(`[${name}] folder sync active on ${ROOT} (room "${room}") as ${kind}. ${files.size} files.`)
    if (!scanTimer) scanTimer = setInterval(scan, 400)
  })

  return {
    doc,
    provider,
    members: () => [...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean),
    stop: () => { if (scanTimer) clearInterval(scanTimer); try { provider.destroy() } catch {}; try { doc.destroy() } catch {} },
  }
}

// Parse a Hivecode join link "wss://relay|room" into { relay, room }.
export function parseLink(link) {
  if (link && link.includes('|')) { const [r, m] = link.split('|'); return { relay: r.trim(), room: m.trim() } }
  return { relay: null, room: (link || '').trim() }
}
