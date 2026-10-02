// tests/onboarding-walk.mjs
// The stranger's first 10 minutes, scripted end to end on the build we ship.
//
// Walks in order:
// (1) setup run inside a temp git repo with a commit (NEXT leads with `branch hive-work`)
// (2) `branch hive-work` run there
// (3) the host's agent joins with the branch line
// (4) a host with no repo hosts an empty room, and reply carries forward-as-is invite
// (5) a teammate runs setup with that invite's link
// (6) the teammate's agent joins with checkout (3 files differ, 5 differ only in CRLF) -> 1 plain summary
// (7) an Antigravity-named client's first empty wait gets the listener line
//
// Prints every text a stranger meets into scratch/onboarding-transcript.txt.

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.HIVE_TEST_PORT) || (27000 + (process.pid % 8000))
const RELAY_URL = `ws://127.0.0.1:${PORT}`
process.env.HIVE_RELAY = RELAY_URL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCRATCH_DIR = process.env.SCRATCH_DIR || os.tmpdir()
fs.mkdirSync(SCRATCH_DIR, { recursive: true })
const TRANSCRIPT_PATH = path.join(SCRATCH_DIR, 'onboarding-transcript.txt')

let pass = 0, fail = 0
function T(name, ok, note = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `   ${note}` : ''}`)
  if (ok) pass++; else fail++
}

const transcriptEntries = []
function logTranscript(stepName, header, content) {
  transcriptEntries.push(`\n======================================================================\n${stepName}: ${header}\n======================================================================\n${content}\n`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-onboarding-walk-'))
const homeHost = path.join(tmp, 'home-host')
const homeTeammate = path.join(tmp, 'home-teammate')
const repoDir = path.join(tmp, 'project-repo')
const emptyHostDir = path.join(tmp, 'solo-host')
const teammateWorkDir = path.join(tmp, 'teammate-work')

fs.mkdirSync(homeHost, { recursive: true })
fs.mkdirSync(homeTeammate, { recursive: true })
fs.mkdirSync(emptyHostDir, { recursive: true })
fs.mkdirSync(teammateWorkDir, { recursive: true })

// Seed Claude Code config so setup detects an installed app and prints NEXT
fs.writeFileSync(path.join(homeHost, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2))
fs.writeFileSync(path.join(homeTeammate, '.claude.json'), JSON.stringify({ mcpServers: {} }, null, 2))

const envFor = (home) => ({
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  HIVE_RELAY: RELAY_URL,
})

const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))

console.log(`=== Starting local relay on port ${PORT}... ===`)
const relayProc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let relayOut = ''
relayProc.stdout.on('data', (d) => { relayOut += d.toString() })
relayProc.stderr.on('data', (d) => { relayOut += d.toString() })

await new Promise((resolve, reject) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    if (/listening on/i.test(relayOut)) { clearInterval(iv); resolve() }
    else if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error(`Relay start timeout:\n${relayOut}`)) }
  }, 100)
})

try {
  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: setup run inside a temp git repo with a commit
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 1: setup inside git repo with commit')
  fs.mkdirSync(repoDir, { recursive: true })
  g(repoDir, 'init', '-q', '-b', 'main')
  g(repoDir, 'config', 'user.email', 'dev@example.com')
  g(repoDir, 'config', 'user.name', 'Dev')
  g(repoDir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'console.log("hello world");\n')
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Project\n')
  g(repoDir, 'add', '-A')
  g(repoDir, 'commit', '-qm', 'initial commit')

  const envSetup1 = { ...envFor(homeHost) }
  delete envSetup1.HIVE_RELAY

  const setup1 = spawnSync(process.execPath, [path.join(ROOT, 'hive-mcp.js'), 'setup'], {
    cwd: repoDir,
    env: envSetup1,
    encoding: 'utf8',
  })
  const setup1Out = (setup1.stdout || '') + (setup1.stderr || '')
  logTranscript('STEP 1', 'npx -y hivecode-mcp@latest setup (run in git repo)', setup1Out)

  T('Step 1 NEXT leads with branch hive-work', setup1Out.includes('branch hive-work'))
  T('Step 1 names the repo and explains checkout untouched', /You're in a git repo/.test(setup1Out) && /without switching your checkout/.test(setup1Out))
  T('Step 1 warns on privacy before publishing', /anyone with the room's link can read/.test(setup1Out))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: `branch hive-work` run there
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 2: branch hive-work run in repo')
  const branch2 = spawnSync(process.execPath, [path.join(ROOT, 'hive-mcp.js'), 'branch', 'hive-work', '--relay', RELAY_URL], {
    cwd: repoDir,
    env: envFor(homeHost),
    encoding: 'utf8',
  })
  const branch2Out = (branch2.stdout || '') + (branch2.stderr || '')
  logTranscript('STEP 2', 'npx -y hivecode-mcp@latest branch hive-work', branch2Out)

  T('Step 2 Room ready for branch hive-work', branch2Out.includes('Room ready for branch hive-work'))
  T('Step 2 Dual-folder mental model explained', branch2Out.includes("~/hivecode/") && /checkout here doesn't change until you run pr/.test(branch2Out))
  T('Step 2 Prints line for agents', /Use hive_join with branch "hive-work"/.test(branch2Out) && branch2Out.includes('as a name of your own (each agent picks a different one)'))
  T('Step 2 Prints line for teammates', /branch hive-work --join/.test(branch2Out))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: the host's agent joins with the branch line
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 3: Host agent joins with branch line')
  const clientHost = await mcp('host-branch')
  const join3 = await clientHost._test.callTool('hive_join', {
    branch: 'hive-work',
    repo: repoDir,
    name: 'HostAgent',
    owner: 'Dev',
  })
  const join3Text = textOf(join3)
  logTranscript('STEP 3', 'Agent prompt: Use hive_join with branch "hive-work", repo "...", as HostAgent', join3Text)

  T('Step 3 Joined branch room banner returned', join3Text.includes('BRANCH ROOM: this room is git branch "hive-work"'))
  T('Step 3 HIVE RULES returned', join3Text.includes('FOLLOW THESE RULES'))
  T('Step 3 Explains agent folder location', join3Text.includes('folder:'))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: a host with no repo hosts an empty room (forward-as-is invite)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 4: Host with no repo hosts empty room')
  const clientEmpty = await mcp('empty-host')
  const join4 = await clientEmpty._test.callTool('hive_join', {
    dir: emptyHostDir,
    name: 'SoloHost',
    owner: 'Dev',
  })
  const join4Text = textOf(join4)
  logTranscript('STEP 4', 'Agent prompt: Use hive_join to host a new, empty Hivecode room as SoloHost', join4Text)

  T('Step 4 Returns HOSTED (new room)', join4Text.includes('HOSTED (new room)'))
  T('Step 4 Carries forward-as-is teammate invite', /to invite someone, forward this as is:/i.test(join4Text))
  T('Step 4 Invite has exact npx setup command', /npx -y hivecode-mcp@latest setup/.test(join4Text))
  T('Step 4 Invite has web link fallback', /No AI agent\? Open/.test(join4Text))

  const inviteMatch = /npx -y hivecode-mcp@latest setup "([^"]+)"/.exec(join4Text)
  const inviteLink = inviteMatch ? inviteMatch[1] : ''
  T('Step 4 Extracted valid invite link', !!inviteLink && inviteLink.startsWith('ws'))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: a teammate runs setup with that invite's link
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 5: Teammate runs setup with invite link')
  const setup5 = spawnSync(process.execPath, [path.join(ROOT, 'hive-mcp.js'), 'setup', inviteLink], {
    cwd: homeTeammate,
    env: envFor(homeTeammate),
    encoding: 'utf8',
  })
  const setup5Out = (setup5.stdout || '') + (setup5.stderr || '')
  logTranscript('STEP 5', `npx -y hivecode-mcp@latest setup "${inviteLink}" (run by teammate)`, setup5Out)

  T('Step 5 Teammate setup configures MCP apps', /READY/.test(setup5Out))
  T('Step 5 Prints sentence to paste to agent', /paste this to your agent/i.test(setup5Out))
  T('Step 5 Includes the room invite link in prompt', setup5Out.includes(inviteLink))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: teammate's agent joins with divergent & CRLF checkout
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 6: Teammate agent joins with checkout (3 diverged, 5 CRLF)')
  // Let the empty room have 10 baseline files published by SoloHost
  for (let i = 1; i <= 10; i++) {
    fs.writeFileSync(path.join(emptyHostDir, `file${i}.js`), `export const v${i} = "room-base-${i}";\n`)
  }
  // Wait a moment for SoloHost sync scan to pick up files
  await sleep(1500)

  // In teammate's folder:
  // - file1..file5: Differ ONLY in CRLF (same text, \r\n endings)
  // - file6..file8: Differ in content (unproven/diverged)
  // - file9..file10: Exact byte-for-byte match
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(teammateWorkDir, `file${i}.js`), `export const v${i} = "room-base-${i}";\r\n`)
  }
  for (let i = 6; i <= 8; i++) {
    fs.writeFileSync(path.join(teammateWorkDir, `file${i}.js`), `export const v${i} = "teammate-divergent-${i}";\n`)
  }
  for (let i = 9; i <= 10; i++) {
    fs.writeFileSync(path.join(teammateWorkDir, `file${i}.js`), `export const v${i} = "room-base-${i}";\n`)
  }

  const clientTeammate = await mcp('teammate-agent')
  const join6 = await clientTeammate._test.callTool('hive_join', {
    link: inviteLink,
    dir: teammateWorkDir,
    name: 'TeammateAgent',
    owner: 'Teammate',
  })
  const join6Text = textOf(join6)
  logTranscript('STEP 6', `Teammate agent join: hive_join with folder containing 3 diverged + 5 CRLF files`, join6Text)

  // Wait 3.5s for sliding debounce flushFirstContact()
  await sleep(3500)

  // Read chat from the room with full: true to avoid truncation
  const chat6 = await clientEmpty._test.callTool('hive_read_chat', { limit: 10, full: true })
  const chat6Text = textOf(chat6)
  logTranscript('STEP 6 (CHAT)', `Room chat after teammate join (First Contact summary):`, chat6Text)

  T('Step 6 Single summary message posted in chat', chat6Text.includes('↓ TeammateAgent joined with 8 files that differ from the room\'s copy.'))
  T('Step 6 Counts CRLF line endings without listing every file', chat6Text.includes('5 differed only in line endings and now match the room.'))
  T('Step 6 Names the 3 unadopted divergent files', /3 hold content the room has never seen/.test(chat6Text) && /file6\.js/.test(chat6Text))
  T('Step 6 Warns against deleting local files', chat6Text.includes("Don't delete a local copy to get the room's: a deletion syncs, and removes the file for everyone."))

  // ──────────────────────────────────────────────────────────────────────────
  // Step 7: an Antigravity-named client's first empty wait gets listener line
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n# Step 7: Antigravity-named client first empty wait')
  const clientAnti = await mcp('anti-wait')
  await clientAnti._test.initialize({
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'Antigravity', version: '2.0.0' }
  })
  await clientAnti._test.callTool('hive_join', {
    link: inviteLink,
    dir: path.join(tmp, 'anti-agent-dir'),
    name: 'AntigravityAgent',
    owner: 'Dev',
  })

  const wait7 = await clientAnti._test.callTool('hive_wait', { timeoutSeconds: 1 })
  const wait7Text = textOf(wait7)
  logTranscript('STEP 7', 'Antigravity client calls hive_wait (empty wait response):', wait7Text)

  T('Step 7 Orders agent to start background listener before ending turn', /BEFORE YOU END THIS TURN/.test(wait7Text))
  T('Step 7 Uses Antigravity run_command syntax with WaitMsBeforeAsync: 1000', wait7Text.includes('run_command') && wait7Text.includes('WaitMsBeforeAsync: 1000'))
  T('Step 7 Points to hive-await.js with room and agent name', wait7Text.includes('hive-await.js') && wait7Text.includes('AntigravityAgent'))

} finally {
  relayProc.kill()
  fs.writeFileSync(TRANSCRIPT_PATH, transcriptEntries.join('\n\n'), 'utf8')
  console.log(`\nTranscript written to: ${TRANSCRIPT_PATH}`)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== ONBOARDING WALK COMPLETE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
