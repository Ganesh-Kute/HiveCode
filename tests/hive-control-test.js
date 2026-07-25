// MISSION CONTROL: a human can PAUSE an agent — it stops picking up new work
// until resumed — and REASSIGN it. The pause is honored exactly the way the MCP
// agent's hive_wait honors it, so this test replicates that gate over a real relay.
//
//   node hive-control-test.js

import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { startSync } from './sync.js'

const PORT = 1304
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

// the exact gate hive_wait uses: no accepted work returned while paused
const workFor = (hive, me) => {
  const c = hive.doc.getMap('controls').get(me)
  if (c && c.state === 'paused') return []
  return [...hive.doc.getMap('tasks').values()].filter((t) => t.to === me && t.status === 'accepted')
}

const OWNER = path.resolve('.control-test/owner'), AGENT = path.resolve('.control-test/agent')
fs.rmSync(path.resolve('.control-test'), { recursive: true, force: true })
fs.mkdirSync(OWNER, { recursive: true }); fs.mkdirSync(AGENT, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const owner = startSync({ relay: RELAY, room: 'ctl', dir: OWNER, name: 'Owner', kind: 'human', log: () => {} })
const agent = startSync({ relay: RELAY, room: 'ctl', dir: AGENT, name: 'Bot', kind: 'ai', owner: 'Owner', log: () => {} })
await sleep(2500)

console.log('# Pause propagates and gates work')
owner.control('Bot', 'paused')
await sleep(1200)
assert('agent sees itself paused', agent.isPaused('Bot') === true)
owner.assign('Bot', 'do X') // owner->own AI = auto-accepted
await sleep(1200)
assert('an accepted task exists', [...agent.doc.getMap('tasks').values()].some((t) => t.to === 'Bot' && t.status === 'accepted'))
assert('but PAUSED agent is handed NO work', workFor(agent, 'Bot').length === 0)

console.log('\n# Resume releases the queued work')
owner.control('Bot', 'running')
await sleep(1200)
assert('resumed agent is no longer paused', agent.isPaused('Bot') === false)
assert('resumed agent now gets the queued task', workFor(agent, 'Bot').length === 1)

console.log('\n# Reassign reaches the agent')
owner.assign('Bot', 'switch to the login bug')
await sleep(1200)
assert('agent sees the reassigned task', [...agent.doc.getMap('tasks').values()].some((t) => /login bug/.test(t.text) && t.status === 'accepted'))

console.log(`\n=== ${failed === 0 ? 'MISSION CONTROL WORKS' : failed + ' FAILED'} ===`)
owner.stop(); agent.stop(); relay.kill()
fs.rmSync(path.resolve('.control-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
