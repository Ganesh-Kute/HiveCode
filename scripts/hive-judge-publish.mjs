import fs from 'fs'
import { resolveMerge } from './packages/icr-merge/index.js'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')

const base = '// Rate limiting for the API gateway.\nfunction requestLimit(user) {\n  // requests allowed per minute\n  return 100\n}\n\nmodule.exports = { requestLimit }\n'
const ours = base.replace('return 100', 'return 250')      // Agent-A
const theirs = base.replace('return 100', 'return 1000')   // Agent-B
const intents = {
  ours: 'production traffic grew, 100/min is throttling real users',
  theirs: 'the enterprise tier load test needs 1000/min',
}
// I (Claude-Lead) am the judge: reconcile BOTH intents rather than let one win.
const judge = async () =>
  'function requestLimit(user) {\n  // requests/min: enterprise gets the load-test ceiling, everyone else the raised prod limit\n  return user.tier === "enterprise" ? 1000 : 250\n}'

const r = await resolveMerge(base, ours, theirs, { filename: 'limits.js', intents, judge })
if (!(r.resolved && r.clean)) { console.error('resolution failed validation — NOT publishing'); process.exit(1) }
console.log('resolved + re-validated. Publishing to room…')

const dir = './hive-work-Judge'
fs.mkdirSync(dir, { recursive: true })
const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-clean-run-9')
const hive = startSync({ relay, room, dir, name: 'Claude-Lead', kind: 'ai', owner: 'Ganesh', token: '', log: () => {} })
await new Promise((res) => setTimeout(res, 4000)) // let it pull current room state

fs.writeFileSync(dir + '/limits.js', r.text)
hive.say(`JUDGE RESOLUTION (intent-aware): A raised the limit to 250 because prod traffic is being throttled; B raised it to 1000 for an enterprise load test. The live relay had silently kept only 1000, dropping A. I reconciled BOTH intents instead: return user.tier === "enterprise" ? 1000 : 250 — enterprise gets B's ceiling, everyone else gets A's raised prod limit. Re-validated by ICR resolveMerge (parses + no dangling refs) before landing. limits.js updated in the room.`)
console.log('wrote reconciled limits.js + announced; holding 8s to sync…')
await new Promise((res) => setTimeout(res, 8000))
hive.stop()
console.log('published.')
process.exit(0)
