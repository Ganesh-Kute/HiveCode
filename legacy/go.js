// One-command launcher for livecode.
//
//   HOST a session (you, Jeevan):
//     node go.js host <file> [yourName]
//       -> starts relay + public tunnel + your client, and prints the exact
//          command your friend pastes to join. No 3-terminal juggling.
//
//   JOIN a session (your friend):
//     node go.js join <wss-url> <room> <file> [yourName]
//       (just copy the line the host prints for you)
//
//   Local test (same PC / LAN, no tunnel):
//     node go.js host <file> [name] --local
//
// Everything it spawns is a normal client of the same room, so AI agents can
// still join the printed address with agent-coord.js / agent-lease.js.

import { spawn } from 'child_process'
import crypto from 'crypto'

const [, , MODE, ...rest] = process.argv
const children = []

function run(cmd, args, tag, opts = {}) {
  const child = spawn(cmd, args, { shell: true, ...opts })
  child.stdout?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`))
  child.stderr?.on('data', (d) => process.stdout.write(`[${tag}] ${d}`))
  child.on('error', (e) => console.error(`[${tag}] failed to start: ${e.message}`))
  children.push(child)
  return child
}

function shutdown() {
  for (const c of children) { try { c.kill() } catch {} }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Wait until a child prints text matching `re`. Resolves with the match, or
// null if the child dies / times out (so callers can show a helpful message
// instead of hanging forever).
function waitFor(child, re, label, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const onData = (d) => { const m = d.toString().match(re); if (m) finish(m) }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    if (timeoutMs) setTimeout(() => finish(null), timeoutMs)
    if (label) console.log(`...waiting for ${label}`)
  })
}

function randomRoom() {
  // Unguessable room id = the project's private key. Anyone with the link can
  // join, so it must be hard to guess. ~17 random chars of crypto entropy.
  const bytes = crypto.randomBytes(13).toString('base64url')
  return 'room-' + bytes
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 2
  const bar = '═'.repeat(width)
  console.log('\n╔' + bar + '╗')
  for (const l of lines) console.log('║ ' + l.padEnd(width - 1) + '║')
  console.log('╚' + bar + '╝\n')
}

async function host() {
  const local = rest.includes('--local')
  // --relay <url>: use an already-hosted relay (no local server, no tunnel)
  const relayIdx = rest.indexOf('--relay')
  const hostedRelay = relayIdx !== -1 ? rest[relayIdx + 1] : null
  const args = rest.filter(
    (a, i) => a !== '--local' && a !== '--relay' && i !== relayIdx + 1
  )
  const DIR = args[0] || './workspace'
  const NAME = args[1] || 'Host'
  const ROOM = randomRoom()

  let WSS
  if (hostedRelay) {
    // Best case: the relay already runs in the cloud. Just use it.
    WSS = hostedRelay
    console.log(`using hosted relay ${WSS} (no local server / tunnel needed)`)
  } else if (local) {
    const relay = run('node', ['server.js'], 'relay')
    await waitFor(relay, /listening on/, 'relay to start')
    WSS = 'ws://localhost:1234'
    console.log('--local: skipping tunnel, using ' + WSS)
  } else {
    // Fallback: run a relay locally and expose it with a tunnel.
    const relay = run('node', ['server.js'], 'relay')
    await waitFor(relay, /listening on/, 'relay to start', 15000)
    const tunnel = run('cloudflared', ['tunnel', '--url', 'http://localhost:1234'], 'tunnel')
    const m = await waitFor(tunnel, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, 'public tunnel URL', 25000)
    if (!m) {
      console.error('\n[go] Could not get a public tunnel URL.')
      console.error('[go] Is cloudflared installed?  Install: winget install --id Cloudflare.cloudflared')
      console.error('[go] Or use your hosted relay instead (no tunnel needed):')
      console.error('[go]   node go.js host <dir> <name> --relay wss://livecode-xoss.onrender.com')
      shutdown()
      return
    }
    WSS = m[0].replace('https://', 'wss://')
  }

  // 3. show the friend exactly what to run
  banner([
    'SESSION IS LIVE',
    '',
    'Send your friend this command (they run it after npm install):',
    '',
    `  node go.js join ${WSS} ${ROOM} ./workspace Friend`,
    '',
    'An AI agent can join the same session with:',
    `  node agent-coord.js ${WSS} ${ROOM} MyAI`,
  ])

  // 4. your own client — sync the whole folder
  run('node', ['folder.js', WSS, ROOM, DIR, NAME], NAME)
  console.log(`You (${NAME}) are sharing folder ${DIR}. Press Ctrl+C to end the session.`)
}

function join() {
  const [WSS, ROOM, DIR = './workspace', NAME = 'Friend'] = rest
  if (!WSS || !ROOM) {
    console.error('Usage: node go.js join <wss-url> <room> <dir> [name]')
    process.exit(1)
  }
  run('node', ['folder.js', WSS, ROOM, DIR, NAME], NAME)
  console.log(`Joined room ${ROOM} as ${NAME}, sharing folder ${DIR}. Ctrl+C to leave.`)
}

if (MODE === 'host') host()
else if (MODE === 'join') join()
else {
  console.log('Usage:')
  console.log('  node go.js host <dir> [name]            # start a session (relay+tunnel+you)')
  console.log('  node go.js host <dir> [name] --local    # local test, no tunnel')
  console.log('  node go.js join <wss-url> <room> <dir> [name]   # join a session')
}
