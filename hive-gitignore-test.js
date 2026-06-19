// Proves we never sync secrets / gitignored / build files.
//   - normal.js syncs across
//   - secret.txt (in .gitignore) does NOT
//   - dist/ (in .gitignore) does NOT
//   - .env does NOT (always-ignored, even without .gitignore)
//
//   node hive-gitignore-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'

const PORT = 1248
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'gi-test'
const A = path.resolve('.gi-test/a')
const B = path.resolve('.gi-test/b')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const has = (dir, f) => fs.existsSync(path.join(dir, f))

fs.rmSync(path.resolve('.gi-test'), { recursive: true, force: true })
fs.mkdirSync(path.join(A, 'dist'), { recursive: true })
fs.mkdirSync(B, { recursive: true })
fs.writeFileSync(path.join(A, '.gitignore'), 'secret.txt\ndist/\n')
fs.writeFileSync(path.join(A, 'normal.js'), 'export const ok = 1\n')
fs.writeFileSync(path.join(A, 'secret.txt'), 'API_KEY=shh\n')
fs.writeFileSync(path.join(A, 'dist', 'bundle.js'), 'built output\n')
fs.writeFileSync(path.join(A, '.env'), 'DB_PASSWORD=hunter2\n')

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const a = startSync({ relay: RELAY, room: ROOM, dir: A, name: 'A', kind: 'human', log: () => {} })
const b = startSync({ relay: RELAY, room: ROOM, dir: B, name: 'B', kind: 'human', log: () => {} })
await sleep(2500)

assert('normal.js synced to B', has(B, 'normal.js'))
assert('secret.txt (gitignored) did NOT sync', !has(B, 'secret.txt'))
assert('dist/ (gitignored) did NOT sync', !has(B, path.join('dist', 'bundle.js')))
assert('.env (always-ignored secret) did NOT sync', !has(B, '.env'))
assert('.gitignore itself synced (it is a normal file)', has(B, '.gitignore'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
a.stop(); b.stop(); relay.kill()
fs.rmSync(path.resolve('.gi-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
