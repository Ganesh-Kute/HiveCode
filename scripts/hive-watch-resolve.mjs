// My live observer for the intent-resolution test in room-resolve-live-1.
// Joins on the NEW engine (forkInfo available), reports members/chat/file/fork state.
import fs from 'fs'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')
const dir = './hive-work-resolve'
fs.mkdirSync(dir, { recursive: true })
const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-resolve-live-1')
const hive = startSync({ relay, room, dir, name: 'Claude-Lead', kind: 'ai', owner: 'Ganesh', token: '', log: (m) => console.log('[engine]', m) })

let lastChatLen = 0, lastLim = null, lastFork = null, lastMembers = ''
console.log('joined room-resolve-live-1 as Claude-Lead — watching (relay may cold-start ~30s)…')
for (let t = 0; t < 900; t += 5) {
  await new Promise((r) => setTimeout(r, 5000))
  const members = hive.members().map((m) => m.name).sort().join(',')
  if (members !== lastMembers) { lastMembers = members; console.log(`t=${t}s MEMBERS: [${members}]`) }
  let chat = ''; try { chat = fs.readFileSync(dir + '/HIVE_CHAT.md', 'utf8') } catch {}
  const lines = chat.split('\n').filter((l) => /\d\d:\d\d:\d\d/.test(l))
  if (lines.length > lastChatLen) { for (const l of lines.slice(lastChatLen)) console.log('CHAT|', l); lastChatLen = lines.length }
  let lim = null; try { lim = fs.readFileSync(dir + '/limits.js', 'utf8') } catch {}
  if (lim !== lastLim) { lastLim = lim; console.log(`t=${t}s LIMITS.JS NOW:\n${lim}`) }
  const f = hive.forkInfo('limits.js')
  const fsig = f ? f.versions.map((v) => `${v.name}:"${v.intent}"`).join(' | ') : null
  if (fsig !== lastFork) { lastFork = fsig; console.log(`t=${t}s FORK: ${fsig || '(none/cleared)'}`) }
}
hive.stop(); process.exit(0)
