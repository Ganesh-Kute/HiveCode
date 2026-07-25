// One-shot SIGNED seeder: joins the room as its own peer (own folder, so it can never
// collide with the lead's MCP client), writes the test file with full provenance, exits.
import fs from 'fs'; import os from 'os'; import path from 'path'
import { startSync } from './sync.js'

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const room = process.argv[2] || 'room-N4soak'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-seeder-'))
const S = startSync({ relay: 'wss://livecode-xoss.onrender.com', room, dir, name: 'Seeder', kind: 'ai', log: () => {} })
await new Promise((r) => setTimeout(r, 4000))
S.claim('calc.js', 'seed test file')
fs.writeFileSync(path.join(dir, 'calc.js'), `// calc.js — swarm test. Patch ONLY the line assigned to you.
function forHermes1() { return 10 }

function forHermes2() { return 20 }

function forHermes3() { return 30 }

function sharedTarget() { return 999 }
`)
await new Promise((r) => setTimeout(r, 6000))
S.release('calc.js')
const v = S.verifyProvenanceOf('calc.js')
console.log('seeded + signed:', JSON.stringify(v))
S.stop(); process.exit(0)
