// tests/control-room-walk.mjs
// Stranger walk for a PERSON WITHOUT AN AGENT opening the browser Control Room.
// Runs hermetically against a local relay. If Chrome is not present on the system,
// it skips loudly and exits 0.

import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { default as WebSocket } from 'ws'
import * as NodeSecrets from '../hive-secrets.js'
import * as BrowserSecrets from '../public/hive-secrets.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const chromeBin = findChrome()
if (!chromeBin) {
  console.log('=== CONTROL ROOM WALK: SKIPPED (no Chrome/Chromium binary found) ===')
  process.exit(0)
}

let pass = 0, fail = 0
function T(name, ok, note = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `   ${note}` : ''}`)
  if (ok) pass++; else fail++
}

const PORT = Number(process.env.HIVE_TEST_PORT) || (29600 + (process.pid % 4000))
const CHROME_PORT = PORT + 1
const RELAY_URL = `ws://127.0.0.1:${PORT}`
const HTTP_URL = `http://127.0.0.1:${PORT}`
const ROOM = 'room-ctl-walk-' + Date.now().toString(36)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cwalk-'))
const hostDir = path.join(tmpDir, 'host')
const agentDir = path.join(tmpDir, 'agent')
const chromeDir = path.join(tmpDir, 'chrome')
fs.mkdirSync(hostDir, { recursive: true })
fs.mkdirSync(agentDir, { recursive: true })
fs.mkdirSync(chromeDir, { recursive: true })

console.log(`Starting local relay on port ${PORT}...`)
const relayProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
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
    else if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error('Relay start timeout: ' + relayOut)) }
  }, 100)
})

const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)

// Seed room state
const hostSync = startSync({
  relay: RELAY_URL,
  room: ROOM,
  dir: hostDir,
  name: 'Dev',
  kind: 'human',
  log: () => {}
})
await sleep(1000)

fs.writeFileSync(path.join(agentDir, 'app.js'), 'console.log("version 1 - original");\n')
fs.writeFileSync(path.join(agentDir, 'config.json'), '{"port": 8080, "env": "dev"}\n')

const agentSync = startSync({
  relay: RELAY_URL,
  room: ROOM,
  dir: agentDir,
  name: 'Alice-AI',
  kind: 'ai',
  owner: 'Bob',
  log: () => {}
})
await sleep(1500)

hostSync.doc.getMap('owners').set('Alice-AI', 'Bob')

// Alice-AI edits app.js and config.json to establish restore points
await sleep(1000)
agentSync.captureSnapshot('app.js', 'console.log("version 1 - original");\n', 'Dev', { force: true, kind: 'base', label: 'initial base' })
agentSync.edit('app.js', 'console.log("version 2 - edited by Alice-AI");\n', 'feature update')
agentSync.captureSnapshot('app.js', 'console.log("version 2 - edited by Alice-AI");\n', 'Alice-AI', { force: true, kind: 'auto', label: 'feature update' })

agentSync.captureSnapshot('config.json', '{"port": 8080, "env": "dev"}\n', 'Dev', { force: true, kind: 'base', label: 'initial config' })
agentSync.edit('config.json', '{"port": 9090, "env": "prod"}\n', 'port change')
agentSync.captureSnapshot('config.json', '{"port": 9090, "env": "prod"}\n', 'Alice-AI', { force: true, kind: 'auto', label: 'port change' })
await sleep(1200)

hostSync.say('Welcome to the room!', { by: 'Dev' })
agentSync.say('Alice-AI online. Ready.', { by: 'Alice-AI' })

const taskId = 'task-' + Date.now().toString(36)
hostSync.doc.getMap('tasks').set(taskId, {
  id: taskId,
  to: 'Alice-AI',
  by: 'Dev',
  byKind: 'human',
  text: 'Refactor database connection pool',
  status: 'pending',
  decidedBy: null,
  at: '03:30:00'
})
// Also waiting, but on Carol, not on Bob: the waiting strip must not count it as Bob's. Older than
// Alice-AI's task, so hers stays first in the list the later steps read.
hostSync.doc.getMap('owners').set('Zed-AI', 'Carol')
hostSync.doc.getMap('tasks').set('task-carol', {
  id: 'task-carol', to: 'Zed-AI', by: 'Dev', byKind: 'human', text: 'Rotate the staging certificate',
  status: 'pending', decidedBy: null, at: '01:00:00'
})
hostSync.doc.getArray('chat').push([{
  by: 'Dev',
  kind: 'human',
  at: '03:30:00',
  text: `@Alice-AI: Refactor database connection pool  (task ${taskId} — Bob must approve)`
}])
await sleep(1000)

const inviteLink = `${RELAY_URL}|${ROOM}`
const browserUrl = `${HTTP_URL}/control#${encodeURIComponent(inviteLink)}`

console.log('Launching headless Chrome via CDP...')
const chromeProc = spawn(chromeBin, [
  '--headless=new',
  `--remote-debugging-port=${CHROME_PORT}`,
  `--user-data-dir=${chromeDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900'
])
let targetRes = null
for (let i = 0; i < 20; i++) {
  try {
    targetRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new`, { method: 'PUT' })
    if (targetRes && targetRes.ok) break
  } catch {
    await sleep(250)
  }
}
if (!targetRes || !targetRes.ok) throw new Error('Could not connect to Chrome CDP on port ' + CHROME_PORT)

const target = await targetRes.json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.on('open', r))

let cdpId = 1
const dialogEvents = []
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogEvents.push(msg.params)
    sendCDP('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
  }
})

const sendCDP = (method, params = {}) => new Promise((resolve, reject) => {
  const cur = cdpId++
  const handler = (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.id === cur) {
      ws.removeListener('message', handler)
      if (msg.error) reject(new Error(`${method} failed: ${msg.error.message}`))
      else resolve(msg.result)
    }
  }
  ws.on('message', handler)
  ws.send(JSON.stringify({ id: cur, method, params }))
})

await sendCDP('Page.enable')
await sendCDP('Runtime.enable')

const evalJS = async (expr) => {
  const r = await sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result.value
}

try {
  // ─── STEP 1: GATE INITIAL GUIDANCE IS NEUTRAL ────────────────────────────
  console.log('\n# Step 1: Gate message on clean load is neutral with matching verb')
  await sendCDP('Page.navigate', { url: browserUrl })
  await sleep(2000)

  const s1 = await evalJS(`(() => {
    const err = document.getElementById('err');
    const connectBtn = document.getElementById('connect');
    return {
      errText: err ? err.textContent : '',
      isInfo: err ? err.classList.contains('info') : false,
      errColor: err ? getComputedStyle(err).color : '',
      btnText: connectBtn ? connectBtn.textContent : ''
    };
  })()`)

  T('gate guidance text matches Enter room verb', s1.errText === 'Pick the name the crew should see, then click Enter room.')
  T('gate guidance has neutral info class (not red error)', s1.isInfo)
  T('button reads Enter room', s1.btnText === 'Enter room')

  // ─── STEP 2: ENTER NAME AND JOIN ROOM ────────────────────────────────────
  console.log('\n# Step 2: Enter name and join room')
  await evalJS(`(() => {
    const uname = document.getElementById('uname');
    uname.value = 'Bob';
    uname.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('connect').click();
  })()`)
  await sleep(2500)

  const s2 = await evalJS(`(() => {
    return {
      appOn: document.getElementById('app').classList.contains('on'),
      connState: document.getElementById('connState').textContent,
      youChip: document.getElementById('youChip').textContent
    };
  })()`)

  T('app shell rendered upon connecting', s2.appOn)
  T('connection state is connected', s2.connState.includes('connected'))
  T('identity chip shows entered name', s2.youChip.includes('Bob'))

  // ─── STEP 3: CREW CONTROLS VISIBLE WITHOUT HOVER ─────────────────────────
  console.log('\n# Step 3: Agent action controls are visible without hovering')
  const s3 = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#members .mcard')];
    const aliceCard = cards.find(c => c.textContent.includes('Alice-AI'));
    const mctl = aliceCard ? aliceCard.querySelector('.mctl') : null;
    const style = mctl ? getComputedStyle(mctl) : null;
    return {
      hasAlice: !!aliceCard,
      hasControls: !!mctl,
      opacity: style ? parseFloat(style.opacity) : 0,
      display: style ? style.display : '',
      maxHeight: style ? style.maxHeight : '0px'
    };
  })()`)

  T('Alice-AI card present in crew list', s3.hasAlice)
  T('action controls container present on AI card', s3.hasControls)
  T('action controls visible without hover (opacity > 0, display flex)', s3.opacity > 0 && s3.display === 'flex' && s3.maxHeight === 'none')

  // ─── STEP 3b: WAITING ON YOU ─────────────────────────────────────────────
  // On 10 Oct 2026 a two-agent run stalled for an hour on one person's OK, and only a task list
  // nobody was reading said so. The strip says it first: Bob owns Alice-AI, and her task waits on him.
  console.log('\n# Step 3b: Waiting on you')
  const waitbar = () => evalJS(`(() => { const w = document.getElementById('waitbar'); return { shown: !!w && !w.hidden, text: w ? w.textContent.replace(/\\s+/g, ' ').trim() : '' } })()`)
  const s3b = await waitbar()
  T('the waiting strip names the approval only Bob can give', s3b.shown && /Waiting on you: 1 approval\b/.test(s3b.text), s3b.text)

  // ─── STEP 4: APPROVE PENDING TASK ────────────────────────────────────────
  console.log('\n# Step 4: Approve pending task')
  await evalJS(`(() => {
    const btn = document.querySelector('#tasks button[data-tact="accept"]');
    if (btn) btn.click();
  })()`)
  await sleep(1500)

  const s4 = await evalJS(`(() => {
    const task = document.querySelector('#tasks .task');
    const lastChat = document.querySelector('#chat .cmsg:last-child');
    return {
      taskStatus: task ? task.querySelector('.tst').textContent.trim() : '',
      hasButtons: !!(task && task.querySelector('.tact')),
      lastChat: lastChat ? lastChat.querySelector('.ctxt').textContent.trim() : ''
    };
  })()`)

  T('task status updated to accepted', s4.taskStatus === 'accepted')
  T('approval buttons hidden after action', !s4.hasButtons)
  T('chat announces approval', s4.lastChat.includes('APPROVED by Bob'))
  T('the waiting strip is gone once Bob has approved', !(await waitbar()).shown)

  agentSync.say('@Bob which port should the API listen on?')
  agentSync.say('@Bobby this one is for someone else')
  await sleep(1500)
  const s4c = await waitbar()
  T('a message from an agent naming Bob shows in the strip, and @Bobby does not', s4c.shown && /Waiting on you: 1 message naming you/.test(s4c.text), s4c.text)
  await evalJS(`(() => { const b = document.querySelector('#waitbar [data-wait="chat"]'); if (b) b.click() })()`)
  await sleep(800)
  T('opening those messages from the strip clears it', !(await waitbar()).shown)

  // ─── STEP 5: PAUSE AN AGENT ──────────────────────────────────────────────
  console.log('\n# Step 5: Pause an agent')
  await evalJS(`(() => {
    const btn = document.querySelector('button[data-act="pause"][data-name="Alice-AI"]');
    if (btn) btn.click();
  })()`)
  await sleep(1500)

  const s5 = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#members .mcard')];
    const aliceCard = cards.find(c => c.textContent.includes('Alice-AI'));
    const pz = aliceCard ? aliceCard.querySelector('.tag.pz') : null;
    const btn = aliceCard ? aliceCard.querySelector('button[data-name="Alice-AI"]') : null;
    const lastChat = document.querySelector('#chat .cmsg:last-child');
    return {
      isPaused: !!pz && pz.textContent.trim() === 'PAUSED',
      buttonAct: btn ? btn.getAttribute('data-act') : '',
      buttonText: btn ? btn.textContent.trim() : '',
      lastChat: lastChat ? lastChat.querySelector('.ctxt').textContent.trim() : ''
    };
  })()`)

  T('agent card shows PAUSED tag', s5.isPaused)
  T('action button toggles to Resume', s5.buttonAct === 'resume' && s5.buttonText === 'Resume')
  T('chat announces pause', s5.lastChat.includes('Bob ⏸ paused Alice-AI'))

  // ─── STEP 6: RESTORE A FILE ──────────────────────────────────────────────
  console.log('\n# Step 6: Restore a file')
  dialogEvents.length = 0
  await evalJS(`(() => {
    // Select the restore button for app.js that restores to the initial/created state
    const appBtns = [...document.querySelectorAll('.hrestore')].filter(b => b.dataset.file === 'app.js');
    const target = appBtns.length > 1 ? appBtns[appBtns.length - 1] : appBtns[0];
    if (target) target.click();
  })()`)
  await sleep(3500)

  const s6 = await evalJS(`(() => {
    const msgs = [...document.querySelectorAll('#chat .cmsg .ctxt')].map(m => m.textContent.trim());
    const lastChat = msgs[msgs.length - 1] || '';
    const hasRestoreChat = msgs.some(m => m.includes('restored app.js'));
    return {
      lastChat,
      hasRestoreChat,
      msgs
    };
  })()`)

  T('restore confirmation modal prompted user', dialogEvents.length > 0 && /Restore app\.js/.test(dialogEvents[0].message), dialogEvents[0] ? dialogEvents[0].message : 'no dialog')
  T('chat announces file restore with attribution', s6.hasRestoreChat, s6.lastChat)

  // ─── STEP 7: REVERT AN AGENT WITH FILE LIST PREVIEW ──────────────────────
  console.log('\n# Step 7: Revert an agent lists affected files in confirmation')
  dialogEvents.length = 0
  await evalJS(`(() => {
    const btn = document.querySelector('button[data-act="revert"][data-name="Alice-AI"]');
    if (btn) btn.click();
  })()`)
  await sleep(3500)

  const s7 = await evalJS(`(() => {
    const msgs = [...document.querySelectorAll('#chat .cmsg .ctxt')].map(m => m.textContent.trim());
    const lastChat = msgs[msgs.length - 1] || '';
    const hasRevertChat = msgs.some(m => m.includes("reverted Alice-AI's changes"));
    return {
      lastChat,
      hasRevertChat
    };
  })()`)

  T('revert confirmation names file count and exact files',
    dialogEvents.length > 0 &&
    /Revert Alice-AI's changes to 2 files: app\.js, config\.json\?[\s\S]*Each goes back to before Alice-AI's first edit\. Their current versions are saved first\./.test(dialogEvents[0].message),
    dialogEvents[0] ? dialogEvents[0].message : 'no dialog')
  T('chat announces revert across files', s7.hasRevertChat, s7.lastChat)

  // ─── STEP 8: SECRET GATE IN CONTROL ROOM CHAT ────────────────────────────
  console.log('\n# Step 8: Secret gate in Control Room chat send box')
  // Dynamically generate a key at runtime so the test file holds no literal key
  const genKey = () => {
    const p = ['g', 'h', 'p', '_'].join('')
    const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let b = ''
    for (let i = 0; i < 36; i++) b += c[(i * 7 + 13) % c.length]
    return p + b
  }
  const secretKey = genKey()
  const secretMsg = `my token is ${secretKey} please use it`

  await evalJS(`(() => {
    const input = document.getElementById('chatInput');
    input.value = ${JSON.stringify(secretMsg)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
  })()`)
  await sleep(1500)

  const s8 = await evalJS(`(() => {
    const input = document.getElementById('chatInput');
    const err = document.getElementById('chatErr') || document.querySelector('.composer-err');
    const msgs = [...document.querySelectorAll('#chat .cmsg .ctxt')].map(m => m.textContent);
    return {
      inputValue: input ? input.value : '',
      errText: err ? err.textContent.trim() : '',
      hasSecretInDom: msgs.some(m => m.includes(${JSON.stringify(secretKey)})),
      allMsgs: msgs
    };
  })()`)

  const roomChats = hostSync.doc.getArray('chat').toArray().map(m => String(m.text || ''))
  const hasSecretInRoom = roomChats.some(t => t.includes(secretKey))

  T('secret message was NOT sent to room chat array', !hasSecretInRoom)
  T('secret message was NOT rendered in DOM chat', !s8.hasSecretInDom)
  T('chat input box still holds the unsent text', s8.inputValue === secretMsg)
  T('inline notice explains refusal and names kind without leaking secret',
    /Not sent: this message contains a GitHub token\. Keys never go in the room; say where it is kept \(e\.g\. GITHUB_TOKEN in \.env\)\./.test(s8.errText) && !s8.errText.includes(secretKey),
    s8.errText || 'no error text')

  // Normal message still sends
  const normalMsg = 'Hello crew, all clear!'
  await evalJS(`(() => {
    const input = document.getElementById('chatInput');
    input.value = ${JSON.stringify(normalMsg)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
  })()`)
  await sleep(1500)

  const s8Normal = await evalJS(`(() => {
    const input = document.getElementById('chatInput');
    const err = document.getElementById('chatErr') || document.querySelector('.composer-err');
    const msgs = [...document.querySelectorAll('#chat .cmsg .ctxt')].map(m => m.textContent);
    return {
      inputValue: input ? input.value : '',
      errText: err ? err.textContent.trim() : '',
      lastMsg: msgs[msgs.length - 1] || ''
    };
  })()`)

  T('normal message sends successfully and clears input box', s8Normal.inputValue === '' && s8Normal.lastMsg.includes(normalMsg))
  T('inline notice clears after successful send', !s8Normal.errText || s8Normal.errText === '')

  // ─── STEP 9: SECRETS PARITY BETWEEN NODE AND BROWSER ───────────────────────
  console.log('\n# Step 9: Secrets parity between hive-secrets.js and browser copies')

  // 1. Stale check: build script --check exits cleanly
  let buildCheckOk = false
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-secrets-browser.cjs'), '--check'], { stdio: 'pipe' })
    buildCheckOk = true
  } catch (e) {
    buildCheckOk = false
  }
  T('browser secrets generator parity check passed (--check)', buildCheckOk)

  // 2. Parity of exported patterns
  const nodeSrc = fs.readFileSync(path.join(ROOT, 'hive-secrets.js'), 'utf8')
  const nodePatternMatches = [...nodeSrc.matchAll(/\{\s*kind:\s*'([^']+)',\s*re:\s*(\/[^\n]+\/[a-z]*)\s*\}/g)]
  const nodeKinds = nodePatternMatches.map(m => m[1])
  const allBrowserPatterns = [...BrowserSecrets.PATTERNS, ...(BrowserSecrets.TOKEN_PATTERNS || [])]
  const browserKinds = allBrowserPatterns.map(p => p.kind)
  T('browser PATTERNS export has identical kind count and names',
    nodeKinds.length === browserKinds.length && nodeKinds.every((k, i) => k === browserKinds[i]),
    `${browserKinds.length} vs ${nodeKinds.length}`)

  const patternSourcesMatch = allBrowserPatterns.every((bp, i) => {
    const rawRe = nodePatternMatches[i][2]
    const lastSlash = rawRe.lastIndexOf('/')
    const expectedSrc = rawRe.slice(1, lastSlash)
    const expectedFlags = rawRe.slice(lastSlash + 1)
    return bp.re.source === expectedSrc && bp.re.flags === expectedFlags
  })
  T('browser PATTERNS regex sources and flags match hive-secrets.js exactly', patternSourcesMatch)

  // 3. Live browser window._secrets pattern parity
  const winPatterns = await evalJS(`window._secrets && window._secrets.PATTERNS ? [...window._secrets.PATTERNS, ...(window._secrets.TOKEN_PATTERNS || [])].map(p => ({ kind: p.kind, src: p.re.source, flags: p.re.flags })) : []`)
  T('in-browser window._secrets.PATTERNS matches exported patterns',
    winPatterns.length === allBrowserPatterns.length &&
    winPatterns.every((wp, i) => wp.kind === allBrowserPatterns[i].kind && wp.src === allBrowserPatterns[i].re.source))

  // 4. Functional parity across sample credentials generated at runtime
  const genRand = (chars, len) => {
    let s = ''
    for (let i = 0; i < len; i++) s += chars[(i * 17 + 5) % chars.length]
    return s
  }
  const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const testSamples = [
    { kind: 'AWS access key', val: 'AKIA' + genRand('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16) },
    { kind: 'GitHub token', val: 'gh' + 'p_' + genRand(alnum, 36) },
    { kind: 'GitLab token', val: 'glpat-' + genRand(alnum, 24) },
    { kind: 'Slack token', val: 'xox' + 'b-987654-' + genRand(alnum, 16) },
    { kind: 'Stripe live key', val: 'r' + 'k_live_' + genRand(alnum, 24) },
    { kind: 'access token', val: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
  ]
  let funcParity = true
  for (const sample of testSamples) {
    const nodeRes = NodeSecrets.findSecrets(`key = ${sample.val}`, { tokens: true })
    const browserRes = BrowserSecrets.findSecrets(`key = ${sample.val}`, { tokens: true })
    const inWinRes = await evalJS(`window._secrets.findSecrets(${JSON.stringify(`key = ${sample.val}`)}, { tokens: true })`)
    if (!nodeRes.length || !browserRes.length || !inWinRes.length ||
        nodeRes[0].kind !== sample.kind ||
        browserRes[0].kind !== sample.kind ||
        inWinRes[0].kind !== sample.kind) {
      funcParity = false
      break
    }
  }
  T('Node and Browser findSecrets evaluate generated credentials identically', funcParity)

} catch (err) {
  T('suite ran cleanly', false, err.stack || String(err))
} finally {
  if (typeof ws !== 'undefined' && ws && typeof ws.close === 'function') try { ws.close() } catch {}
  if (typeof chromeProc !== 'undefined' && chromeProc && typeof chromeProc.kill === 'function') try { chromeProc.kill() } catch {}
  if (typeof hostSync !== 'undefined' && hostSync && typeof hostSync.stop === 'function') try { hostSync.stop() } catch {}
  if (typeof agentSync !== 'undefined' && agentSync && typeof agentSync.stop === 'function') try { agentSync.stop() } catch {}
  if (typeof relayProc !== 'undefined' && relayProc && typeof relayProc.kill === 'function') try { relayProc.kill() } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== CONTROL ROOM WALK: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
