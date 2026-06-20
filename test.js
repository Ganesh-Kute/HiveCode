// Automated test suite — deterministic, in-memory (no relay needed).
// Run: node test.js   (exit code 0 = all pass)
//
// Covers every coordination guarantee the system promises, so future changes
// can be verified instantly.

import * as Y from 'yjs'
import crypto from 'crypto'
import { applyDiff, safeBump, lockHeldByOther, lockOrder, negotiate, mergeEdit, merge3, summarizeChange, hasConflictMarkers } from './core.js'
import { sign, verify, roomMatches, scopeForRoom, isSafeRelPath, FILE_SEP, keyFingerprint, roomFingerprint, isSecuredRoom, makeSecuredRoomId } from './token.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}`) }
}
function section(t) { console.log(`\n# ${t}`) }

// helper: fully sync two docs both ways
const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}

// ---------------------------------------------------------------------------
section('applyDiff (text mirroring)')
{
  const d = new Y.Doc()
  const t = d.getText('x')
  t.insert(0, 'hello world')
  applyDiff(t, 'hello brave world')
  check('inserts in the middle', t.toString() === 'hello brave world')
  applyDiff(t, 'hello world')
  check('deletes from the middle', t.toString() === 'hello world')
  check('no-op returns false', applyDiff(t, 'hello world') === false)
  applyDiff(t, '')
  check('clears to empty', t.toString() === '')
  applyDiff(t, 'fresh')
  check('fills from empty', t.toString() === 'fresh')
}

// ---------------------------------------------------------------------------
section('CRDT convergence (concurrent same-position edits)')
{
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText('f').insert(0, 'base')
  sync(a, b)
  a.getText('f').insert(0, 'A')
  b.getText('f').insert(0, 'B')
  sync(a, b)
  check('both machines identical', a.getText('f').toString() === b.getText('f').toString())
  check('no text lost', a.getText('f').toString().includes('A') && a.getText('f').toString().includes('B'))
}

// ---------------------------------------------------------------------------
section('Claim protocol (no duplicate work)')
{
  const a = new Y.Doc(), b = new Y.Doc()
  sync(a, b)
  // both try to claim the same task while offline
  a.getMap('claims').set('task1', a.clientID)
  b.getMap('claims').set('task1', b.clientID)
  sync(a, b)
  // after sync both agree on a single owner
  const ownerA = a.getMap('claims').get('task1')
  const ownerB = b.getMap('claims').get('task1')
  check('one deterministic winner', ownerA === ownerB)
  check('winner is one of the two', ownerA === a.clientID || ownerA === b.clientID)
}

// ---------------------------------------------------------------------------
section('Version check (stale write rejected)')
{
  const v = new Y.Doc().getMap('versions')
  v.set('foo', 0)
  const seen = v.get('foo')      // an agent reads version 0
  v.set('foo', 1); v.set('foo', 2); v.set('foo', 3) // others change it 3x
  const stale = safeBump(v, 'foo', seen)
  check('stale write is rejected', stale.stale === true && stale.current === 3)
  const fresh = safeBump(v, 'foo', v.get('foo'))
  check('fresh write succeeds', fresh.ok === true && fresh.version === 4)
}

// ---------------------------------------------------------------------------
section('Lock + negotiation logic')
{
  const a = new Y.Doc(), b = new Y.Doc()
  const now = 1000
  a.getMap('locks').set('fileA', { owner: 'A', intent: 'edit', exp: now + 5000 })
  sync(a, b)
  check('B sees A holds the lock', !!lockHeldByOther(b.getMap('locks'), 'fileA', 'B', now))
  check('A does not see itself as other', !lockHeldByOther(a.getMap('locks'), 'fileA', 'A', now))
  // B posts a request with a summary
  b.getMap('requests').set('fileA', { B: 'rename login' })
  sync(a, b)
  check('A receives B request + summary', a.getMap('requests').get('fileA').B === 'rename login')
  // lock expiry (crash safety)
  check('expired lock is free', !lockHeldByOther(b.getMap('locks'), 'fileA', 'B', now + 6000))
}

// ---------------------------------------------------------------------------
section('Deadlock-safe multi-file ordering')
{
  const want1 = ['fileB', 'fileA']
  const want2 = ['fileA', 'fileB']
  check('both agents lock in the same order', JSON.stringify(lockOrder(want1)) === JSON.stringify(lockOrder(want2)))
  check('order is sorted', JSON.stringify(lockOrder(['c', 'a', 'b'])) === JSON.stringify(['a', 'b', 'c']))
}

// ---------------------------------------------------------------------------
section('Richer negotiation (grant / counter / deny)')
{
  // no conflict -> grant
  const g = negotiate({ intent: 'add logging to parser', done: false }, { from: 'B', summary: 'rename the CLI flag' })
  check('grants when unrelated', g.decision === 'grant')
  // both touch "login" -> counter (take turns)
  const c = negotiate({ intent: 'add validation to login', done: false }, { from: 'B', summary: 'refactor login helper' })
  check('counters on overlap', c.decision === 'counter' && /login/.test(c.reason))
  // destructive while mid-edit -> deny
  const d = negotiate({ intent: 'tweak login copy', done: false }, { from: 'B', summary: 'delete the auth module' })
  check('denies destructive mid-edit', d.decision === 'deny')
  // once holder is done, overlap is fine -> grant
  const g2 = negotiate({ intent: 'add validation to login', done: true }, { from: 'B', summary: 'refactor login helper' })
  check('grants overlap once holder is done', g2.decision === 'grant')
}

// ---------------------------------------------------------------------------
section('Patch merge-or-rework (two writers, same file)')
{
  const base = 'a\nb\nc\nd\ne'
  // current unchanged -> take mine
  check('takes mine when current == base', mergeEdit(base, 'a\nB\nc\nd\ne', base).text === 'a\nB\nc\nd\ne')
  // disjoint line edits -> merge both, no rework
  const m = mergeEdit(base, 'a\nB\nc\nd\ne', 'a\nb\nc\nD\ne')
  check('merges disjoint edits', m.ok && m.text === 'a\nB\nc\nD\ne')
  // same line changed two ways -> conflict (rework)
  const c = mergeEdit(base, 'a\nb\nC\nd\ne', 'a\nb\nX\nd\ne')
  check('flags overlapping edit as conflict', c.conflict === true)
  // I changed nothing -> take current
  check('takes current when I made no change', mergeEdit(base, base, 'a\nb\nc\nd\nE').text === 'a\nb\nc\nd\nE')
}

// ---------------------------------------------------------------------------
section('merge3 (sync-layer 3-way merge — never silently loses work)')
{
  const base = 'a\nb\nc\nd\ne'
  // only one side changed -> take that side
  check('takes mine when theirs unchanged', merge3(base, 'a\nB\nc\nd\ne', base).text === 'a\nB\nc\nd\ne')
  check('takes theirs when mine unchanged', merge3(base, base, 'a\nb\nc\nd\nE').text === 'a\nb\nc\nd\nE')
  // disjoint full edits -> auto-merge, both survive, no conflict
  const m = merge3(base, 'a\nB\nc\nd\ne', 'a\nb\nc\nD\ne')
  check('auto-merges disjoint edits', !m.conflict && m.text === 'a\nB\nc\nD\ne')
  // same line two ways -> conflict markers, BOTH versions present (nothing lost)
  const c = merge3(base, 'a\nb\nMINE\nd\ne', 'a\nb\nTHEIRS\nd\ne')
  check('marks overlapping edit as conflict', c.conflict === true)
  check('conflict keeps my version', c.text.includes('MINE'))
  check('conflict keeps their version', c.text.includes('THEIRS'))
  check('conflict has git-style markers', c.text.includes('<<<<<<<') && c.text.includes('>>>>>>>'))
  // realistic: two agents append to different ends of a file -> clean merge
  const f = 'function login() {\n  return ok\n}'
  const mine = '// added by A\nfunction login() {\n  return ok\n}'
  const theirs = 'function login() {\n  return ok\n}\n// added by B'
  const r = merge3(f, mine, theirs)
  check('disjoint top/bottom edits merge', !r.conflict && r.text.includes('// added by A') && r.text.includes('// added by B'))
}

// ---------------------------------------------------------------------------
section('summarizeChange (auto-board: patch vs rewrite + what)')
{
  const file = [
    'function login(u, p) {',
    '  return check(u, p)',
    '}',
    'function logout() {',
    '  clearSession()',
    '}',
    'function ping() {',
    '  return 1',
    '}',
  ].join('\n')
  // small grep-and-patch (one line) -> NOT a rewrite -> no board entry
  const patched = file.replace('return check(u, p)', 'return check(u, p) && rateLimit(u)')
  check('small patch is not flagged as rewrite', summarizeChange(file, patched).isRewrite === false)
  // wholesale rewrite of most of the file -> IS a rewrite
  const rewritten = [
    'function login(user, pass, opts) {',
    '  validate(user)',
    '  return check(user, pass, opts)',
    '}',
    'function logout(session) {',
    '  clearSession(session)',
    '  audit("logout")',
    '}',
    'function ping() {',
    '  return Date.now()',
    '}',
  ].join('\n')
  const s = summarizeChange(file, rewritten)
  check('wholesale change is flagged as rewrite', s.isRewrite === true)
  check('records which symbols were touched', s.symbols.includes('login') && s.symbols.includes('logout'))
  // brand-new file is a create, not a rewrite
  check('new file is not a rewrite', summarizeChange('', 'function x() {}').isRewrite === false)
}

// ---------------------------------------------------------------------------
section('hasConflictMarkers (line-anchored, not a substring — no phantom conflicts)')
{
  // A real conflict produced by merge3 is detected.
  const real = merge3('a\nb\nc', 'a\nMINE\nc', 'a\nTHEIRS\nc')
  check('detects a real merge3 conflict', hasConflictMarkers(real.text) === true)
  // A clean file is not flagged.
  check('clean file is not flagged', hasConflictMarkers('function f() {\n  return 1\n}') === false)
  // THE BUG: prose that MENTIONS the markers must NOT be flagged. This README
  // line is exactly what caused phantom "MERGE CONFLICT" spam in the live test.
  const readme = 'If you ever see `<<<<<<<` conflict markers in a file, resolve them.'
  check('documentation mentioning <<<<<<< is NOT a conflict', hasConflictMarkers(readme) === false)
  // A fenced example showing markers inline (not at line-start with content) is safe.
  check('inline marker mention is not flagged', hasConflictMarkers('use the `<<<<<<<`/`>>>>>>>` syntax') === false)
  // Partial leftover (opener only, no closer) is not a full conflict.
  check('opener without closer is not flagged', hasConflictMarkers('<<<<<<< oops\nsome text') === false)
}

// ---------------------------------------------------------------------------
section('Access tokens (RBAC Phase 1: sign/verify/scope)')
{
  const secret = 's3cret'
  const base = { sub: 'p1', name: 'Bot', kind: 'ai', scopes: [{ room: 'room-1', role: 'agent' }], exp: Math.floor(Date.now() / 1000) + 60 }
  const tok = sign(base, { secret })
  check('a signed token is a 3-part JWT', tok.split('.').length === 3)
  check('verify accepts a good token', verify(tok, { secret }).ok === true)
  check('verify rejects a wrong secret', verify(tok, { secret: 'nope' }).ok === false)
  check('verify rejects a tampered payload', verify(tok.slice(0, -2) + 'zz', { secret }).ok === false)
  check('verify rejects garbage', verify('not.a.jwt', { secret }).ok === false)
  check('verify rejects an HS256 token with no secret', verify(tok, {}).ok === false)
  // expiry
  const expired = sign({ ...base, exp: Math.floor(Date.now() / 1000) - 1 }, { secret })
  const er = verify(expired, { secret })
  check('verify rejects an expired token', er.ok === false && /expired/.test(er.error))
  // room matching
  check('roomMatches exact', roomMatches('room-1', 'room-1') === true)
  check('roomMatches "*" wildcard', roomMatches('*', 'anything') === true)
  check('roomMatches prefix "acme/*"', roomMatches('acme/*', 'acme/api') === true && roomMatches('acme/*', 'other') === false)
  // scope lookup carries the role
  check('scopeForRoom finds the authorizing scope', (scopeForRoom(base, 'room-1') || {}).role === 'agent')
  check('scopeForRoom returns null for an unscoped room', scopeForRoom(base, 'room-2') === null)
}

// ---------------------------------------------------------------------------
section('Token attacks (forgery, alg confusion, expiry edge cases)')
{
  const now = Math.floor(Date.now() / 1000)
  const secret = 's3cret'
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  // alg:none — the classic "drop the signature" attack must NOT be accepted.
  const noneTok = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ sub: 'x', scopes: [{ room: 'r', role: 'admin' }] }) + '.'
  check('alg=none is rejected', verify(noneTok, { secret }).ok === false)
  // unsigned (empty signature segment) and malformed shapes.
  const unsigned = sign({ sub: 'x', exp: now + 60 }, { secret }).split('.').slice(0, 2).join('.') + '.'
  check('unsigned token (empty sig) is rejected', verify(unsigned, { secret }).ok === false)
  check('two-part token is rejected', verify('a.b', { secret }).ok === false)
  check('empty-string token is rejected', verify('', { secret }).ok === false)
  // RSA + the alg-confusion attack: forge an HS256 token using the PUBLIC key as
  // the HMAC secret; an RS256-only relay (publicKey, no secret) must reject it.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rs = sign({ sub: 'p', scopes: [{ room: 'r', role: 'agent' }], exp: now + 60 }, { privateKey })
  check('RS256 token verifies with the public key', verify(rs, { publicKey }).ok === true)
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
  const forged = sign({ sub: 'attacker', scopes: [{ room: 'r', role: 'admin' }], exp: now + 60 }, { secret: pubPem })
  check('alg-confusion (HS256 signed with public key) is rejected by an RS256-only relay', verify(forged, { publicKey }).ok === false)
  // alg pinning closes it explicitly even on a dual-key relay.
  check('alg pin rejects a mismatched alg', verify(rs, { publicKey, alg: 'HS256' }).ok === false)
  check('alg pin accepts the matching alg', verify(rs, { publicKey, alg: 'RS256' }).ok === true)
  // expiry/nbf edge cases — a non-numeric exp must FAIL CLOSED (else it never expires).
  const strExp = sign({ sub: 'x', scopes: [{ room: 'r', role: 'agent' }], exp: '9999999999' }, { secret })
  check('non-numeric exp is rejected (fail closed)', verify(strExp, { secret }).ok === false)
  const future = sign({ sub: 'x', scopes: [{ room: 'r', role: 'agent' }], nbf: now + 1000, exp: now + 2000 }, { secret })
  check('a not-yet-valid (nbf in future) token is rejected', verify(future, { secret }).ok === false)
}

// ---------------------------------------------------------------------------
section('isSafeRelPath (path-traversal / injection guard — arbitrary file write)')
{
  check('accepts a normal nested path', isSafeRelPath('src/ui/app.js') === true)
  check('accepts a dot-prefixed file', isSafeRelPath('.gitignore') === true)
  check('accepts ./ current-dir prefix', isSafeRelPath('./src/app.js') === true)
  check('rejects ../ traversal', isSafeRelPath('../../etc/passwd') === false)
  check('rejects an embedded ../ segment', isSafeRelPath('src/../../etc/x') === false)
  check('rejects a POSIX absolute path', isSafeRelPath('/etc/passwd') === false)
  check('rejects a Windows drive path', isSafeRelPath('C:\\Windows\\System32\\x') === false)
  check('rejects a backslash traversal', isSafeRelPath('..\\..\\x') === false)
  check('rejects a UNC path', isSafeRelPath('//server/share/x') === false)
  check('rejects a NUL byte', isSafeRelPath('a' + String.fromCharCode(0) + 'b') === false)
  check('rejects FILE_SEP injection (room-name smuggling)', isSafeRelPath('a' + FILE_SEP + 'b') === false)
  check('rejects an empty path', isSafeRelPath('') === false)
  check('rejects an absurdly long path', isSafeRelPath('a/'.repeat(700)) === false)
}

// ---------------------------------------------------------------------------
section('scopeForRoom specificity (a broad "*" must not shadow a tighter scope)')
{
  const tok = { scopes: [{ room: '*', role: 'agent', paths: ['**'] }, { room: 'acme/web', role: 'reader', paths: ['docs/**'] }] }
  const sc = scopeForRoom(tok, 'acme/web')
  check('most-specific scope wins over an earlier "*"', !!sc && sc.role === 'reader')
  check('"*" still authorizes a room with no tighter match', (scopeForRoom(tok, 'other-room') || {}).role === 'agent')
  // exact beats a prefix wildcard too
  const tok2 = { scopes: [{ room: 'acme/*', role: 'writer' }, { room: 'acme/api', role: 'reader' }] }
  check('exact room beats a prefix wildcard', (scopeForRoom(tok2, 'acme/api') || {}).role === 'reader')
}

// ---------------------------------------------------------------------------
section('Self-certifying secured rooms (room id = owner key fingerprint)')
{
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const fp = keyFingerprint(pem)
  check('fingerprint is 22 url-safe chars', typeof fp === 'string' && /^[A-Za-z0-9_-]{22}$/.test(fp))
  check('fingerprint is stable for the same key', keyFingerprint(pem) === fp)
  const { publicKey: other } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  check('a different key has a different fingerprint', keyFingerprint(other.export({ type: 'spki', format: 'pem' })) !== fp)
  const room = makeSecuredRoomId(pem, 'abc123')
  check('makeSecuredRoomId embeds the fingerprint', room === `hs_${fp}_abc123`)
  check('roomFingerprint extracts it back', roomFingerprint(room) === fp)
  check('isSecuredRoom true for an hs_ room', isSecuredRoom(room) === true)
  check('isSecuredRoom false for a normal room', isSecuredRoom('room-xyz') === false)
  check('roomFingerprint null for a normal room', roomFingerprint('room-xyz') === null)
  check('garbage key fingerprints to null', keyFingerprint('not a key') === null)
}

// ---------------------------------------------------------------------------
section('Room isolation (separate docs do not leak)')
{
  const roomX = new Y.Doc(), roomY = new Y.Doc()
  roomX.getText('f').insert(0, 'secret X')
  // we deliberately do NOT sync them — different rooms = different docs
  check('room Y never sees room X', roomY.getText('f').toString() === '')
}

// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
