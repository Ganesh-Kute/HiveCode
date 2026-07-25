import fs from 'fs'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')
fs.mkdirSync('./hive-work-Judge', { recursive: true })
const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-clean-run-9')
const hive = startSync({ relay, room, dir: './hive-work-Judge', name: 'Judge-Watch', kind: 'ai', owner: 'Ganesh', token: '', log: () => {} })

// A line is an agent's OWN post if its author tag is "<Name> (ai):" (my Claude-Lead
// instruction quotes the intent strings but is authored by Claude-Lead, so it won't match).
const authored = (chat, who, val) =>
  chat.split('\n').some((l) => l.includes(who + ' (ai):') && l.includes(val))

let done = false
for (let t = 0; t < 240 && !done; t += 4) {
  await new Promise((r) => setTimeout(r, 4000))
  let chat = ''; try { chat = fs.readFileSync('./hive-work-Judge/HIVE_CHAT.md', 'utf8') } catch {}
  let lim = ''; try { lim = fs.readFileSync('./hive-work-Judge/limits.js', 'utf8') } catch {}
  const aPost = authored(chat, 'Agent-A', '250')
  const bPost = authored(chat, 'Agent-B', '1000')
  const bFile = /return\s+1000/.test(lim)
  console.log(`t=${t}s Apost=${aPost} Bpost=${bPost} Bfile=${bFile} members=[${hive.members().map((m) => m.name).join(',')}]`)
  if (bPost || bFile) { console.log('=== AGENT-B HAS ACTED ==='); done = true }
}

let chat = ''; try { chat = fs.readFileSync('./hive-work-Judge/HIVE_CHAT.md', 'utf8') } catch {}
let lim = ''; try { lim = fs.readFileSync('./hive-work-Judge/limits.js', 'utf8') } catch {}
console.log('----AGENT CHAT LINES----')
console.log(chat.split('\n').filter((l) => l.includes('Agent-A (ai):') || l.includes('Agent-B (ai):')).join('\n') || '(none yet)')
console.log('----LIMITS.JS----')
console.log(lim || '(not synced)')
hive.stop()
process.exit(0)
