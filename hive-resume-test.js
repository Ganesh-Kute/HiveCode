// PERSISTENCE / RESUME: when the owner reuses the same room id + private key after
// a close, every invite link issued BEFORE the restart must still work — nobody
// has to be re-invited. This is the protocol-level guarantee behind the extension's
// auto-resume (it stores the key in SecretStorage + the room in .hive.json).
//
//   node hive-resume-test.js

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'
import { sign, makeSecuredRoomId } from './token.js'

const PORT = 1284
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }

// The owner's keypair — in the real product this is persisted in SecretStorage and
// reloaded verbatim on reopen. Here we just keep the same variables across "restarts".
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keys = { publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const ROOM = makeSecuredRoomId(keys.publicKey, crypto.randomBytes(6).toString('hex')) // stored in .hive.json
const mkOwnerTok = () => sign({ iss: 'hivecode', sub: 'Owner', name: 'Owner', kind: 'human', pk: keys.publicKey, scopes: [{ room: ROOM, role: 'maintainer' }], iat: now(), exp: now() + 3600, jti: 'jti-owner-' + crypto.randomBytes(3).toString('hex') }, { privateKey: keys.privateKey })
// the invite link the agent received ONCE (issued before any restart)
const agentTok = sign({ iss: 'hivecode', sub: 'FrontBot', name: 'FrontBot', kind: 'ai', pk: keys.publicKey, scopes: [{ room: ROOM, role: 'agent', paths: ['frontend/**'] }], iat: now(), exp: now() + 3600, jti: 'jti-agent' }, { privateKey: keys.privateKey })

const OWNER = path.resolve('.resume-test/owner'), AGENT = path.resolve('.resume-test/agent')
fs.rmSync(path.resolve('.resume-test'), { recursive: true, force: true })
fs.mkdirSync(path.join(OWNER, 'frontend'), { recursive: true })
fs.mkdirSync(AGENT, { recursive: true })
fs.writeFileSync(path.join(OWNER, 'frontend', 'app.js'), 'v1')

// No HIVE_PERSIST_DIR: the hosted free-tier relay is stateless — when everyone
// leaves, the room doc is gone; on resume the owner republishes from disk. (The
// room IDENTITY + key are what persist, client-side — that's what keeps links valid.)
const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

console.log('# Session 1: owner hosts, agent joins with its invite link')
let owner = startSync({ relay: RELAY, room: ROOM, dir: OWNER, name: 'Owner', kind: 'human', token: mkOwnerTok(), log: () => {} })
await sleep(2000)
let agent = startSync({ relay: RELAY, room: ROOM, dir: AGENT, name: 'FrontBot', kind: 'ai', token: agentTok, log: () => {} })
await sleep(3000)
assert('agent got its in-scope file in session 1', (read(AGENT, 'frontend/app.js') || '') === 'v1')

console.log('\n# Everyone CLOSES (stop both clients) …')
owner.stop(); agent.stop()
await sleep(1500)

console.log('# Session 2: owner REOPENS — SAME room id + SAME key, brand-new owner token')
owner = startSync({ relay: RELAY, room: ROOM, dir: OWNER, name: 'Owner', kind: 'human', token: mkOwnerTok(), log: () => {} })
await sleep(2000)
// the owner edits while back
fs.writeFileSync(path.join(OWNER, 'frontend', 'app.js'), 'v2-after-reopen')
await sleep(1500)

console.log('# The agent REJOINS with the SAME OLD invite link (never re-issued)')
agent = startSync({ relay: RELAY, room: ROOM, dir: AGENT, name: 'FrontBot', kind: 'ai', token: agentTok, log: () => {} })
await sleep(3500)
assert('OLD invite link still admitted after restart', (read(AGENT, 'frontend/app.js') || '').length > 0)
assert('agent received the post-reopen edit', (read(AGENT, 'frontend/app.js') || '') === 'v2-after-reopen')

console.log('# Edits still flow both ways in the resumed room')
fs.writeFileSync(path.join(AGENT, 'frontend', 'app.js'), 'edited-by-agent-after-resume')
await sleep(3000)
assert('agent edit reached the owner after resume', (read(OWNER, 'frontend/app.js') || '') === 'edited-by-agent-after-resume')

console.log(`\n=== ${failed === 0 ? 'RESUME WORKS — OLD LINKS SURVIVE A RESTART' : failed + ' FAILED'} ===`)
owner.stop(); agent.stop(); relay.kill()
fs.rmSync(path.resolve('.resume-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
