// HIVECODE'S OWN FILES LIVE IN .hive/, NOT ACROSS THE TOP OF THE PROJECT.
//
//   node tests/hive-dir-test.mjs
//
// WHY (15 Nov 2026). A fresh agent's folder got seven HIVE_*.md files at the top level, beside the
// project's own README and source: Ganesh counted them before showing the product to a founder.
// Six of them are rendered from the room and read by tools; nobody browses to them. They now live
// in .hive/. One stays where an agent with no Hivecode tools can see it: HIVE_FOR_AGENTS.md, the
// sign on the door.
//
//   D1 a client writes the six rendered files under .hive/, none at the top level, and the sign stays
//   D2 nothing under .hive/ is ever shared with the room, the rendered files or anything put there
//   D3 a top-level copy an older build left behind is removed on join
//   D4 a top-level copy that git tracks is left alone, byte for byte, and still never shared
//   D5 an older build in the same room is undisturbed, and so is this one (needs an older build
//      on this machine: skipped, and said so, when there is none)
//   D6 every file an agent-facing text names is where the engine writes it
//   D7 git is asked which old copies it tracks; "cannot tell" is never read as "none"
//   D8 landing a room on a git branch never takes a file from .hive/
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `   ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const has = (d, f) => fs.existsSync(path.join(d, f))

const MOVED = ['HIVE_RULES.md', 'HIVE_CHAT.md', 'HIVE_MEMBERS.md', 'HIVE_CLAIMS.md', 'HIVE_BOARD.md', 'HIVE_TASKS.md']
const SIGN = 'HIVE_FOR_AGENTS.md'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dir-'))
const dirOf = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d }
const kids = [], clients = []
const cleanup = () => { for (const c of clients) { try { c.stop() } catch { } } for (const k of kids) { try { k.kill() } catch { } } try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { } }
process.on('exit', cleanup)

const PORT = Number(process.env.HIVE_TEST_PORT) || await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
kids.push(relay)
const up = await new Promise((res) => {
  const giveUp = setTimeout(() => res(false), 20000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(giveUp); res(true) } })
})
if (!up) { console.log(`  FAIL the relay did not start on port ${PORT} within 20 s`); process.exit(1) }
const RELAY = `ws://127.0.0.1:${PORT}`
const tag = `${process.pid}-${Date.now().toString(36)}`

const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const join = (mod, room, dir, name) => { const c = mod({ relay: RELAY, room, dir, name, kind: 'ai', log: () => { } }); clients.push(c); return c }
const synced = (c) => until(() => c.status().connected, 15000)

// ── D1, D2 ────────────────────────────────────────────────────────────────────────────────
{
  const room = `dir-a-${tag}`
  const dA = dirOf('a'), dB = dirOf('b')
  const A = join(startSync, room, dA, 'Ada')
  await synced(A)
  A.say('hello from Ada')
  A.claim('src/app.js', 'adding the login check')
  const wrote = await until(() => has(dA, '.hive/HIVE_CHAT.md') && has(dA, '.hive/HIVE_RULES.md') && has(dA, '.hive/HIVE_MEMBERS.md') && has(dA, '.hive/HIVE_CLAIMS.md'), 15000)
  const atTop = MOVED.filter((f) => has(dA, f))
  T('D1 the rendered files are under .hive/, none of the six is at the top level, and the sign stays there',
    wrote && atTop.length === 0 && has(dA, SIGN) && /hello from Ada/.test(read(path.join(dA, '.hive/HIVE_CHAT.md')) || ''),
    `under .hive/: ${fs.existsSync(path.join(dA, '.hive')) ? fs.readdirSync(path.join(dA, '.hive')).join(', ') : 'no .hive/ folder'}; at the top: ${fs.readdirSync(dA).join(', ')}`)

  // Something a person, or a later build, puts in .hive/ must stay on this machine too.
  fs.mkdirSync(path.join(dA, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(dA, '.hive', 'notes.txt'), 'this machine only\n')
  fs.writeFileSync(path.join(dA, 'shared.txt'), 'everyone gets this\n')
  const B = join(startSync, room, dB, 'Bo')
  await synced(B)
  const arrived = await until(() => read(path.join(dB, 'shared.txt')) === 'everyone gets this\n', 20000) // sync works at all
  await sleep(1500)
  const inManifest = [...A.doc.getMap('manifest').keys(), ...B.doc.getMap('manifest').keys()].filter((k) => k.startsWith('.hive/') || MOVED.includes(k))
  T('D2 nothing under .hive/ is shared with the room: not the rendered files, not a file put there by hand',
    arrived && inManifest.length === 0 && !has(dB, '.hive/notes.txt') && !/hello from Ada/.test(read(path.join(dB, 'HIVE_CHAT.md')) || ''),
    `shared.txt arrived: ${arrived}; in the manifest: ${inManifest.join(', ') || 'none'}; B has .hive/notes.txt: ${has(dB, '.hive/notes.txt')}`)
  A.stop(); B.stop()
}

// ── D3 ────────────────────────────────────────────────────────────────────────────────────
{
  const d = dirOf('c')
  for (const f of MOVED) fs.writeFileSync(path.join(d, f), `# written by an older build: ${f}\n`)
  fs.writeFileSync(path.join(d, 'README.md'), '# mine\n')
  const C = join(startSync, `dir-c-${tag}`, d, 'Cy')
  await synced(C)
  C.say('after the update')
  const gone = await until(() => MOVED.every((f) => !has(d, f)) && has(d, '.hive/HIVE_CHAT.md'), 15000)
  T('D3 the top-level copies an older build left are removed on join, and nothing else is',
    gone && read(path.join(d, 'README.md')) === '# mine\n', `still at the top: ${MOVED.filter((f) => has(d, f)).join(', ') || 'none'}`)
  C.stop()
}

// ── D4 ────────────────────────────────────────────────────────────────────────────────────
{
  const room = `dir-d-${tag}`
  const d = dirOf('d'), dE = dirOf('e')
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' })
  const haveGit = git('init', '-q').status === 0
  if (!haveGit) T('D4 a top-level copy that git tracks is left alone (git is not on this machine: not checked)', true)
  else {
    const mine = '# Rules of MY project, committed by me\n'
    fs.writeFileSync(path.join(d, 'HIVE_RULES.md'), mine)
    fs.writeFileSync(path.join(d, 'HIVE_CHAT.md'), '# an untracked leftover\n')
    git('add', 'HIVE_RULES.md'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'mine')
    const D = join(startSync, room, d, 'Di')
    await synced(D)
    D.say('hi')
    await until(() => has(d, '.hive/HIVE_RULES.md') && !has(d, 'HIVE_CHAT.md'), 15000)
    fs.writeFileSync(path.join(d, 'shared.txt'), 'x\n')
    const E = join(startSync, room, dE, 'Ed')
    await synced(E)
    const arrived = await until(() => read(path.join(dE, 'shared.txt')) === 'x\n', 20000)
    await sleep(1000)
    T('D4 a top-level copy that git tracks is left alone, byte for byte; the untracked one beside it is removed; neither is shared',
      arrived && read(path.join(d, 'HIVE_RULES.md')) === mine && !has(d, 'HIVE_CHAT.md') && !has(dE, 'HIVE_RULES.md') && read(path.join(d, '.hive/HIVE_RULES.md')) !== mine,
      `tracked file intact: ${read(path.join(d, 'HIVE_RULES.md')) === mine}; leftover removed: ${!has(d, 'HIVE_CHAT.md')}; the other client got HIVE_RULES.md at the top: ${has(dE, 'HIVE_RULES.md')}`)
    D.stop(); E.stop()
  }
}

// ── D5 ────────────────────────────────────────────────────────────────────────────────────
{
  const candidates = [process.env.HIVE_OLD_BUILD, '/opt/node22/lib/node_modules/hivecode-mcp', path.join(ROOT, 'node_modules', 'hivecode-mcp')].filter(Boolean)
  const oldDir = candidates.find((p) => { try { return fs.existsSync(path.join(p, 'sync.js')) && !/HIVE_DIR/.test(fs.readFileSync(path.join(p, 'sync.js'), 'utf8')) } catch { return false } })
  if (!oldDir) T('D5 an older build in the same room (no older build on this machine: NOT CHECKED; set HIVE_OLD_BUILD to a 0.14.15 package folder)', true)
  else {
    const room = `dir-f-${tag}`
    const dOld = dirOf('old'), dNew = dirOf('new')
    const old = await import(pathToFileURL(path.join(oldDir, 'sync.js')).href)
    const O = join(old.startSync, room, dOld, 'Olga')
    const N = join(startSync, room, dNew, 'Nia')
    await synced(O); await synced(N)
    O.say('from the older build')
    N.say('from this build')
    fs.writeFileSync(path.join(dOld, 'a.txt'), 'from old\n')
    fs.writeFileSync(path.join(dNew, 'b.txt'), 'from new\n')
    const both = await until(() => read(path.join(dNew, 'a.txt')) === 'from old\n' && read(path.join(dOld, 'b.txt')) === 'from new\n', 25000)
    const chats = await until(() => /from this build/.test(read(path.join(dOld, 'HIVE_CHAT.md')) || '') && /from the older build/.test(read(path.join(dNew, '.hive/HIVE_CHAT.md')) || ''), 15000)
    await sleep(1000)
    const leaked = [...N.doc.getMap('manifest').keys()].filter((k) => k.startsWith('.hive/') || MOVED.includes(k) || k === SIGN)
    T(`D5 an older build (${JSON.parse(read(path.join(oldDir, 'package.json')) || '{}').version}) and this one share files and chat; each keeps its own layout; neither layout reaches the other`,
      both && chats && leaked.length === 0 && !has(dOld, '.hive') && MOVED.every((f) => !has(dNew, f)),
      `files both ways: ${both}; chat both ways: ${chats}; in the manifest: ${leaked.join(', ') || 'none'}; older folder has .hive/: ${has(dOld, '.hive')}; this folder has top-level copies: ${MOVED.filter((f) => has(dNew, f)).join(', ') || 'none'}`)
    O.stop(); N.stop()
  }
}

// ── D6 ────────────────────────────────────────────────────────────────────────────────────
{
  const SRC = await import(pathToFileURL(path.join(ROOT, 'hive-instructions.js')).href)
  const texts = { 'the join card': SRC.joinCard(), 'HIVE_FOR_AGENTS.md': SRC.AGENT_MANUAL, 'the rules install block': SRC.AGENT_FILE_BLOCK, 'the instructions': SRC.INSTRUCTIONS, 'HIVE_RULES.md': SRC.RULES_MD }
  const wrong = []
  for (const [where, text] of Object.entries(texts)) {
    for (const m of text.matchAll(/(\.hive\/)?(HIVE_[A-Z_]+\.md)/g)) {
      const inHive = !!m[1], file = m[2]
      if (file === SIGN ? inHive : !inHive) wrong.push(`${where}: ${m[0]}`)
    }
  }
  T('D6 every file an agent-facing text names is where the engine writes it', wrong.length === 0 && /\.hive\/HIVE_RULES\.md/.test(SRC.joinCard()), wrong.join(' | '))
}

// ── D7, D8 ────────────────────────────────────────────────────────────────────────────────
{
  const { gitTrackedAmong } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
  const repo = dirOf('g-repo'), plain = dirOf('g-plain')
  const haveGit = spawnSync('git', ['init', '-q'], { cwd: repo }).status === 0
  if (!haveGit) T('D7 what git tracks (git is not on this machine: not checked)', true)
  else {
    fs.writeFileSync(path.join(repo, 'HIVE_RULES.md'), 'mine\n'); fs.writeFileSync(path.join(repo, 'HIVE_CHAT.md'), 'left over\n')
    spawnSync('git', ['add', 'HIVE_RULES.md'], { cwd: repo })
    const names = ['HIVE_RULES.md', 'HIVE_CHAT.md']
    const inRepo = gitTrackedAmong(repo, names), outside = gitTrackedAmong(plain, names)
    // No git to ask (it is not on the path): inside a repository that must read as "cannot tell", so
    // nothing is removed; in a folder that is in no repository, nothing can be tracked.
    const PATH = process.env.PATH; process.env.PATH = ''
    let blindRepo, blindPlain
    try { blindRepo = gitTrackedAmong(repo, names); blindPlain = gitTrackedAmong(plain, names) } finally { process.env.PATH = PATH }
    T('D7 git is asked which copies it tracks; when it cannot be asked inside a repository the answer is "cannot tell", never "none"',
      inRepo instanceof Set && inRepo.has('HIVE_RULES.md') && !inRepo.has('HIVE_CHAT.md') && outside instanceof Set && outside.size === 0 && blindRepo === null && blindPlain instanceof Set && blindPlain.size === 0,
      `tracked: ${inRepo && [...inRepo].join(',')}; outside a repo: ${outside && outside.size}; no git, in a repo: ${blindRepo}; no git, no repo: ${blindPlain && blindPlain.size}`)
  }
  const { isOwnFile } = await import(pathToFileURL(path.join(ROOT, 'hive-pr.js')).href)
  T('D8 landing a room on a git branch never takes a file from .hive/',
    isOwnFile('.hive/HIVE_CHAT.md') && isOwnFile('.hive/notes.txt') && isOwnFile('sub/.hive/x.md') && !isOwnFile('src/app.js') && !isOwnFile('docs/hive.md'))
}

console.log(`\n=== HIVE DIR: ${pass} passed, ${fail} failed ===`)
cleanup()
process.exit(fail ? 1 : 0)
