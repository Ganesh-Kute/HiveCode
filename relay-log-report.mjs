#!/usr/bin/env node
// Reads a Render (or local) relay log dump and answers the questions the raw log cannot,
// because a room is a FILE and the interesting unit is the WORKSPACE.
//
//   node relay-log-report.mjs relay.log
//   node relay-log-report.mjs relay.log --days 2
//   node relay-log-report.mjs relay.log --room room-_MDMIXHGQmR-GNFiVw
//
// Works on logs from BEFORE the workspace-census change too: it derives the base room by
// splitting on U+0001 itself, so old dumps give the same answer as new ones.

import fs from 'fs'

const FILE_SEP = ''
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1] }
const days = Number(flag('days', 0)) || 0
const only = flag('room', '')

if (!file) {
  console.error('usage: node relay-log-report.mjs <relay.log> [--days N] [--room ID]')
  process.exit(1)
}

// Secret-shaped filenames. This exists because a real user's android/key.properties
// crossed the relay before nested .gitignore files were read, and "did that happen to
// anyone else" is a question you must be able to answer with a command, not a guess.
const SECRET = [
  /(^|\/)key\.properties$/i, /(^|\/)local\.properties$/i, /(^|\/)secrets?\.properties$/i,
  /(^|\/)\.env($|\.)/i, /\.(pem|key|jks|keystore|p12|pfx|p8|mobileprovision)$/i,
  /(^|\/)google-services\.json$/i, /(^|\/)GoogleService-Info\.plist$/i,
  /(^|\/)credentials\.json$/i, /service-account.*\.json$/i,
  /(^|\/)\.npmrc$/i, /\.tfvars$/i, /\.tfstate/i, /(^|\/)id_(rsa|ed25519)$/i,
]

// Stack fingerprints, most specific first. Deliberately structural (files that only exist
// because of a toolchain) rather than guessing from a project's own naming.
const STACKS = [
  ['Flutter / Dart', [/(^|\/)pubspec\.yaml$/, /(^|\/)analysis_options\.yaml$/, /^lib\/.*\.dart$/]],
  ['Android native', [/^android\/app\/build\.gradle/, /(^|\/)AndroidManifest\.xml$/]],
  ['iOS native', [/^ios\/Runner/, /\.xcodeproj\//, /(^|\/)Podfile$/]],
  ['Next.js', [/(^|\/)next\.config\.(js|ts|mjs)$/, /^(app|pages)\/.*\.(tsx|jsx)$/]],
  ['React / TypeScript', [/\.tsx$/, /(^|\/)tsconfig\.json$/]],
  ['Node / JS', [/(^|\/)package\.json$/, /\.mjs$/]],
  ['Python', [/(^|\/)requirements\.txt$/, /(^|\/)pyproject\.toml$/, /\.py$/]],
  ['Rust', [/(^|\/)Cargo\.toml$/, /\.rs$/]],
  ['Go', [/(^|\/)go\.mod$/, /\.go$/]],
]

// Agents that announce themselves through the files they leave behind. This is the only
// honest way to say "an AI was in this room" for a client that connected without a token,
// because a client's own claim about what it is was never trusted.
const AGENT_MARKS = [
  [/(^|\/)\.aider/i, 'Aider'],
  [/(^|\/)CLAUDE\.md$/i, 'Claude Code'],
  [/(^|\/)\.cursor(rules|\/)/i, 'Cursor'],
  [/(^|\/)\.windsurf/i, 'Windsurf'],
  [/(^|\/)AGENTS?\.md$/i, 'an agent instruction file'],
  [/(^|\/)\.hive-/i, 'Hivecode client'],
]

const rooms = new Map() // baseRoom -> record

function rec(base) {
  let r = rooms.get(base)
  if (!r) {
    r = {
      base, files: new Set(), people: new Map(), days: new Set(),
      first: null, last: null, connects: 0, secrets: new Set(),
      agentMarks: new Set(), maxInRoom: 1, sessions: [],
    }
    rooms.set(base, r)
  }
  return r
}

let parsed = 0, skipped = 0
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('{')
  if (i === -1) { skipped++; continue }
  let o
  try { o = JSON.parse(line.slice(i)) } catch { skipped++; continue }
  if (!o || !o.room || (o.event !== 'connect' && o.event !== 'disconnect')) { skipped++; continue }
  parsed++

  // Derive rather than trust: old logs have no baseRoom/file fields at all.
  const sep = o.room.indexOf(FILE_SEP)
  const base = sep === -1 ? o.room : o.room.slice(0, sep)
  const rel = sep === -1 ? null : o.room.slice(sep + 1)
  if (only && base !== only) continue

  const r = rec(base)
  const ts = o.ts ? new Date(o.ts) : null
  if (ts && !isNaN(ts)) {
    if (!r.first || ts < r.first) r.first = ts
    if (!r.last || ts > r.last) r.last = ts
    r.days.add(ts.toISOString().slice(0, 10))
  }

  if (rel) {
    r.files.add(rel)
    for (const p of SECRET) if (p.test(rel)) r.secrets.add(rel)
    for (const [p, name] of AGENT_MARKS) if (p.test(rel)) r.agentMarks.add(name)
  }

  const id = o.identity || {}
  const name = id.name || '(anonymous)'
  if (o.event === 'connect') {
    r.connects++
    if (typeof o.inRoom === 'number' && o.inRoom > r.maxInRoom) r.maxInRoom = o.inRoom
    let p = r.people.get(name)
    if (!p) { p = { name, kinds: new Set(), declared: new Set(), roles: new Set(), conns: 0, first: ts, last: ts }; r.people.set(name, p) }
    p.conns++
    if (id.kind) p.kinds.add(id.kind)
    if (id.declaredKind) p.declared.add(id.declaredKind)
    if (o.role) p.roles.add(o.role)
    if (ts && (!p.first || ts < p.first)) p.first = ts
    if (ts && (!p.last || ts > p.last)) p.last = ts
  } else if (typeof o.heldMs === 'number') {
    r.sessions.push(o.heldMs)
  }
}

const cutoff = days ? Date.now() - days * 864e5 : 0
const list = [...rooms.values()]
  .filter((r) => !cutoff || (r.last && r.last.getTime() >= cutoff))
  .sort((a, b) => (b.last || 0) - (a.last || 0))

const d = (x) => (x ? x.toISOString().replace('T', ' ').slice(0, 16) : '?')
const stackOf = (files) => {
  const f = [...files]
  const hits = STACKS.filter(([, pats]) => pats.some((p) => f.some((x) => p.test(x)))).map(([n]) => n)
  return hits.length ? hits.join(' + ') : 'unrecognised'
}
const topDirs = (files) => {
  const c = new Map()
  for (const f of files) { const t = f.includes('/') ? f.slice(0, f.indexOf('/')) + '/' : '(root)'; c.set(t, (c.get(t) || 0) + 1) }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join('  ')
}

console.log(`\nparsed ${parsed} connect/disconnect events (${skipped} lines ignored)`)
console.log(days ? `showing workspaces active in the last ${days} day(s)\n` : `showing all workspaces\n`)

let totalPeople = 0, multi = 0
for (const r of list) {
  const names = [...r.people.values()]
  totalPeople += names.length
  if (names.length > 1) multi++

  console.log('='.repeat(78))
  console.log(`workspace  ${r.base}`)
  console.log(`active     ${d(r.first)} -> ${d(r.last)}   (${r.days.size} distinct day${r.days.size === 1 ? '' : 's'})`)
  console.log(`days seen  ${[...r.days].sort().join(', ')}`)
  console.log(`traffic    ${r.connects} file-connections across ${r.files.size} distinct files`)
  console.log(`stack      ${stackOf(r.files)}`)
  console.log(`top dirs   ${topDirs(r.files)}`)

  // THE HEADLINE. Peers per workspace, which is what "is anyone running more than one
  // writer" actually means -- inRoom in the raw log counts one FILE and is near-always 1.
  console.log(`\nPEOPLE IN THIS WORKSPACE: ${names.length}`)
  for (const p of names) {
    const kind = p.kinds.size ? [...p.kinds].join('/') : 'no token'
    const said = p.declared.size ? `, said "${[...p.declared].join('/')}"` : ''
    console.log(`  - ${p.name}  [${kind}${said}]  role ${[...p.roles].join('/') || '?'}  ` +
      `${p.conns} conns  ${d(p.first)} -> ${d(p.last)}`)
  }
  console.log(`  max concurrent on any single file: ${r.maxInRoom}`)
  if (r.sessions.length) {
    const s = r.sessions.slice().sort((a, b) => a - b)
    const med = s[Math.floor(s.length / 2)]
    console.log(`  ${s.length} closed sessions, median held ${(med / 1000).toFixed(1)}s, longest ${(s[s.length - 1] / 60000).toFixed(1)} min`)
  }

  if (r.agentMarks.size) console.log(`\nAGENT EVIDENCE   files belonging to: ${[...r.agentMarks].join(', ')}`)
  if (r.secrets.size) {
    console.log(`\n!! SECRETS THAT CROSSED THE RELAY (${r.secrets.size}):`)
    for (const f of r.secrets) console.log(`   ${f}`)
  }
  console.log('')
}

console.log('='.repeat(78))
console.log(`SUMMARY: ${list.length} workspace(s), ${totalPeople} distinct client identit(ies)`)
console.log(`         ${multi} workspace(s) had MORE THAN ONE person or agent in them`)
const allSecrets = list.reduce((n, r) => n + r.secrets.size, 0)
if (allSecrets) console.log(`         ${allSecrets} secret-shaped file(s) synced -- see above, and tell those users`)
console.log('')
