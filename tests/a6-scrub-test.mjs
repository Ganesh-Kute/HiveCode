// A6 failing-first regression suite: shared scrubbing across hive-webhook.js, hive-slack.js,
// hive-room-watcher.js, and hive-room-mode.js (Q656 error link scrub).
//
//   node tests/a6-scrub-test.mjs

import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sign, makeSecuredRoomId } from '../token.js'
import { scrub } from '../hive-webhook.js'
import { scrubSlack } from '../hive-slack.js'
import { makeRoomWatcher } from '../hive-room-watcher.js'
import { postIssue } from '../hive-room-mode.js'

let pass = 0
let fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `   -- ${detail}` : ''}`) }
}

// Generate an isolated RS256 keypair + secured hs_ room + realistic JWT invite token (never a real secret).
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pkPem = publicKey.export({ type: 'spki', format: 'pem' })
const skPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const HS_ROOM = makeSecuredRoomId(pkPem, crypto.randomBytes(8).toString('hex'))
const HS_OTHER = makeSecuredRoomId(pkPem, crypto.randomBytes(8).toString('hex'))
const now = Math.floor(Date.now() / 1000)
const TOK = sign({
  iss: 'hivecode',
  sub: 'Alice',
  name: 'Alice',
  kind: 'ai',
  pk: pkPem,
  scopes: [{ room: HS_ROOM, role: 'maintainer' }],
  iat: now,
  exp: now + 3600,
  jti: 'jti-' + crypto.randomBytes(6).toString('hex'),
}, { privateKey: skPem })
const INVITE_LINK = `wss://relay.example.com|${HS_ROOM}|${TOK}`
const OPEN_ROOM = 'room-AbCdEf1234567890GhIjKl'
const OPEN_LINK = `wss://relay.example.com|${OPEN_ROOM}|${TOK}`
const FAKE_AWS = 'AKIA' + 'Q5R7ST9UVW2X4Y6N'

console.log('\n# 1. hive-webhook.js scrub()')
{
  const a = scrub(`joined ${HS_ROOM} and ${OPEN_ROOM}`)
  T('scrub strips bare hs_ room ID', !a.includes(HS_ROOM) && /\[room id removed\]/.test(a), a)
  T('scrub strips bare realistic 22-char room-... room ID', !a.includes(OPEN_ROOM) && /\[room id removed\]/.test(a), a)

  const keep1 = 'see hive-room-watcher.js and tests/room-key-revocations-test.mjs'
  T('scrub does not corrupt hyphenated filename/test paths starting with room-', scrub(keep1) === keep1, scrub(keep1))
  const keep2 = 'the room-service is down'
  T('scrub does not corrupt ordinary lowercase hyphenated phrase room-service', scrub(keep2) === keep2, scrub(keep2))
  const keep3 = 'check room-cleanup-helper-module in CI'
  T('scrub does not corrupt long lowercase hyphenated phrase starting with room-', scrub(keep3) === keep3, scrub(keep3))
  const keep4 = 'token_prefix_not_a_room_id room-short1'
  T('scrub does not corrupt short room-short1 under 16 chars', scrub(keep4) === keep4, scrub(keep4))

  const b = scrub(`invite ${INVITE_LINK} key=${FAKE_AWS}`)
  T('scrub strips wss://...|hs_...|jwt completely without leaking token or dangling fragment',
    !b.includes(HS_ROOM) && !b.includes(TOK) && !b.includes('relay.example.com') && !b.includes(FAKE_AWS)
    && /\[room link removed\]/.test(b) && !/token removed\]/.test(b),
    b)

  const c = scrub(`open link ${OPEN_LINK}`)
  T('scrub strips wss://...|room-...|jwt cleanly',
    !c.includes(OPEN_ROOM) && !c.includes(TOK) && /\[room link removed\]/.test(c) && !/token removed\]/.test(c),
    c)

  const d = scrub(`standalone token=${TOK}`)
  T('scrub still strips standalone JWT token', !d.includes(TOK) && /\[access token removed\]/.test(d), d)
}

console.log('\n# 2. hive-slack.js scrubSlack()')
{
  const a = scrubSlack(`do not paste ${INVITE_LINK} or ${HS_OTHER}`, { room: HS_ROOM, link: `wss://relay.example.com|${HS_ROOM}` })
  T('scrubSlack strips wss://...|hs_...|jwt cleanly (no mangled token fragment)',
    !a.includes(HS_ROOM) && !a.includes(TOK) && !a.includes('relay.example.com') && !/token removed\]/.test(a) && /\[room link removed\]/.test(a),
    a)
  T('scrubSlack strips foreign hs_ room IDs even when another room is configured',
    !a.includes(HS_OTHER) && /\[room id removed\]/.test(a),
    a)
}

console.log('\n# 3. hive-room-watcher.js GitHub comment scrubbing')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-a6-watch-'))
  try {
    const comments = []
    const gh = {
      labeledIssues: () => [{ number: 1, title: 'Leak check', body: 'test', user: { login: 'owner' }, labels: [{ name: 'hivecode' }] }],
      issueEvents: () => [{ event: 'labeled', label: { name: 'hivecode' }, actor: { login: 'owner', type: 'User' } }],
      permission: () => 'admin',
      comment: (n, body) => { comments.push(body); return { id: comments.length } },
      addLabel: () => {},
      pull: () => ({ number: 1, state: 'closed' }),
      comments: () => [],
      removeLabel: () => {},
    }
    let t = Date.parse('2026-11-14T10:00:00Z')
    const w = makeRoomWatcher({
      gh,
      link: `wss://relay.example.com|${HS_ROOM}`,
      branch: 'main',
      label: 'hivecode',
      stateFile: path.join(tmp, 'state.json'),
      now: () => t,
      maxMinutes: 1,
      deps: {
        postIssue: async () => ({ ok: true, taskId: 't1', comment: 'Sent to room' }),
        landIssue: async () => ({ ok: false, why: 'waiting' }),
        peek: async () => ({
          ok: true,
          agents: ['Bot'],
          reachable: ['Bot'],
          engaged: false,
          lastLines: [`Bot: other=${HS_OTHER} invite=${INVITE_LINK}`],
        }),
        say: async () => ({ ok: true }),
        prFeedback: async () => ({ ok: true }),
      },
      log: () => {},
    })
    await w.tick()
    t += 2 * 60000
    await w.tick()
    const body = comments.join('\n')
    T('GitHub comment reached timeout summary and strips hs_ room IDs, foreign hs_ IDs, relay link, and invite token',
      comments.length > 0 && body.includes('Bot:') && !body.includes(HS_ROOM) && !body.includes(HS_OTHER) && !body.includes(TOK) && !body.includes('relay.example.com'),
      body.slice(0, 300))
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

console.log('\n# 4. hive-room-mode.js Q656 catch message')
{
  const res = await postIssue({
    link: INVITE_LINK,
    issue: { number: 7, title: 'Check Q656 scrub', body: 'hi', attempt: 1 },
    syncRunner: async () => { throw new Error(`connect ECONNREFUSED via ${INVITE_LINK}`) },
  })
  T('postIssue Q656 error does not expose room link, hs_ id, or token',
    res && res.ok === false && res.code === 'Q656'
    && !res.why.includes(HS_ROOM) && !res.why.includes(TOK) && !res.why.includes('relay.example.com'),
    res && res.why)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
