// hive-session.js -- which agent this is, on disk, for the folder its app started it in.
//
// The MCP server records its session in <launch folder>/.hive-mcp-session.json, so a restart rejoins
// as the same agent; the Stop hook, which runs in the same launch folder, reads it to learn which
// agent it is guarding.
//
// WHY THIS IS A MODULE. Until 9 Oct 2026 that file held ONE agent. Two agents started from one folder
// -- two Claude Code sessions in one repo, the obvious way to run a branch room -- overwrote each
// other, and the last writer was the only agent on record. The other one's Stop hook then steered it
// as the wrong agent (that agent's mail, a listener under that agent's name), and a restart brought
// it back as the other one. Found by walking the founder flow end to end (branch -> two agents ->
// pr), where the file also showed up in the developer's `git status`.
//
// Now the file keeps every agent started in that folder, each with the pid of the server that wrote
// it. Its top level is still the latest writer, which is all a Stop hook from before this reads, so an
// older hook keeps working exactly as it did. Server and hook read it through this one module, so
// the two cannot drift apart (the merge logic once lived twice, and the copies did).
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

export const SESSION_FILE_NAME = '.hive-mcp-session.json'
export const HOOK_STATE_NAME = '.hive-stop-hook.json'
const STALE_MS = 14 * 24 * 3600 * 1000 // a record whose server is gone and that nobody wrote for two weeks

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return !!e && e.code === 'EPERM' }
}

/** Every agent on record in a session file, by name. A file from before 9 Oct holds one, at its top level. */
export function readAgents(file) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
  if (!raw || typeof raw !== 'object') return {}
  if (raw.agents && typeof raw.agents === 'object') return { ...raw.agents }
  if (raw.name) { const one = { ...raw }; delete one.agents; return { [raw.name]: one } }
  return {}
}

/** Write the records back; the top level is `latest` (or the newest record), for a Stop hook from before 9 Oct. */
export function writeAgents(file, agents, latest = null) {
  const now = Date.now()
  for (const [n, s] of Object.entries(agents)) if (!pidAlive(s.pid) && s.at && now - s.at > STALE_MS) delete agents[n]
  const names = Object.keys(agents)
  if (!names.length) { try { fs.rmSync(file) } catch { } return }
  const top = latest && agents[latest.name] === latest ? latest
    : agents[names.sort((a, b) => (agents[b].at || 0) - (agents[a].at || 0))[0]]
  fs.writeFileSync(file, JSON.stringify({ ...top, agents }))
}

/** The record this server process owns: the one it wrote; else the one for its conversation; else, after
 *  a restart, the only one whose server is gone. Two gone is a guess, and a guess here is exactly how one
 *  agent wakes up as another, so it answers null and the agent rejoins by name instead. */
export function ownRecord(agents, { pid = process.pid, conv = '' } = {}) {
  const all = Object.values(agents)
  const mine = all.find((s) => s.pid === pid) || (conv ? all.find((s) => s.conv === conv) : null)
  if (mine) return mine
  const gone = all.filter((s) => !pidAlive(s.pid))
  return gone.length === 1 ? gone[0] : null
}

/** Which agent a Stop hook is guarding. One on record is that one. With several, the hook's own
 *  conversation decides: its id, else its transcript (the hive_join that answered "folder: <dir>",
 *  then that folder anywhere in it), else the only one whose server still runs. If none of that
 *  tells, null: a hook that speaks as the wrong agent does more harm than one that stays quiet. */
export function agentForHook(agents, hook = {}, { readTail = tailOf } = {}) {
  const all = Object.values(agents).filter((s) => s && s.dir && s.name)
  if (all.length <= 1) return all[0] || null
  const conv = String(hook.session_id || hook.conversationId || '')
  if (conv) { const byConv = all.find((s) => s.conv && s.conv === conv); if (byConv) return byConv }
  const t = hook.transcript_path ? readTail(hook.transcript_path) : ''
  if (t) {
    // The folder as a transcript line spells it: escaped once as JSON, twice if the text was nested.
    const spell = (dir) => { const once = JSON.stringify(String(dir)).slice(1, -1); return [once, JSON.stringify(once).slice(1, -1)] }
    const where = (s) => {
      const forms = spell(s.dir)
      const joined = Math.max(...forms.map((f) => t.lastIndexOf('folder: ' + f)))
      return joined >= 0 ? [1, joined] : [0, Math.max(...forms.map((f) => t.lastIndexOf(f)))]
    }
    const ranked = all.map((s) => ({ s, w: where(s) })).filter((x) => x.w[1] >= 0)
      .sort((a, b) => b.w[0] - a.w[0] || b.w[1] - a.w[1])
    if (ranked.length) return ranked[0].s
  }
  const live = all.filter((s) => pidAlive(s.pid))
  return live.length === 1 ? live[0] : null
}

function tailOf(file, max = 8 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size
    const n = Math.min(size, max)
    const fd = fs.openSync(file, 'r')
    try { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); return b.toString('utf8') } finally { fs.closeSync(fd) }
  } catch { return '' }
}

/** Keep our files out of `git status` in the launch folder, which is often the developer's own repo:
 *  listed in that repo's local exclude file (.git/info/exclude), never in a tracked .gitignore. */
export function excludeFromGit(dir, names = [SESSION_FILE_NAME, HOOK_STATE_NAME]) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (r.status !== 0 || !String(r.stdout || '').trim()) return false
    const file = path.resolve(dir, String(r.stdout).trim())
    let have = ''
    try { have = fs.readFileSync(file, 'utf8') } catch { }
    const listed = new Set(have.split(/\r?\n/).map((l) => l.trim()))
    const add = names.filter((n) => !listed.has(n) && !listed.has('/' + n))
    if (!add.length) return true
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}# Hivecode's local session files\n${add.join('\n')}\n`)
    return true
  } catch { return false }
}
