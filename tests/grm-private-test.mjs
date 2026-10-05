// GRM STAYS PRIVATE: nothing GRM ships in a public package, and the package still works without it.
//
//   node tests/grm-private-test.mjs
//
// Ganesh's standing rule: GRM is private and never goes on the internet. grm-link.cjs -- the glue that
// hands a room's history to a LOCAL GRM -- was listed in hivecode-mcp's "files" and copied into the
// VS Code extension at package time, so it shipped publicly on both channels. It is now loaded only
// when present. The trap this guards is the one that bit before: a static import of a file the
// tarball does not contain dies at boot with ERR_MODULE_NOT_FOUND, and every check that reads the
// source instead of the TARBALL stays green. So this packs the real tarball, unpacks it and boots it.
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 17000))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-grmpriv-'))

console.log('# nothing GRM in a public package')
const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', tmp], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
let info = null
try { info = JSON.parse(packed.stdout)[0] } catch { }
T('npm pack ran', !!info, (packed.stderr || '').slice(-200))
const names = info ? info.files.map((f) => f.path) : []
T('the npm tarball carries no GRM file', info && !names.some((n) => /grm/i.test(n)), names.filter((n) => /grm/i.test(n)).join(', '))
const extPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'package.json'), 'utf8'))
T('the VS Code extension no longer copies grm-link.cjs into its .vsix', !/grm-link/.test(JSON.stringify(extPkg.scripts || {})))
T('sync.js LOADS grm-link.cjs when present instead of importing it',
  !/^import .*grm-link\.cjs/m.test(fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8')))

console.log('# the tarball still boots without it')
let relay, child
try {
  const tgz = path.join(tmp, info.filename)
  const x = spawnSync('tar', ['-xzf', path.basename(tgz)], { cwd: tmp, encoding: 'utf8' })
  const pkgDir = path.join(tmp, 'package')
  T('the tarball unpacks', x.status === 0 && fs.existsSync(path.join(pkgDir, 'sync.js')), (x.stderr || '').slice(-200))
  T('...and grm-link.cjs is really absent from it', !fs.existsSync(path.join(pkgDir, 'grm-link.cjs')))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkgDir, 'node_modules'), 'junction')
  relay = await new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  })
  // A room with files synced, so linkMemory() runs -- the path that used grm-link.
  const script = `
    import { startSync } from './sync.js'
    const h = startSync({ relay: 'ws://localhost:${PORT}', room: 'gp-${crypto.randomBytes(4).toString('hex')}', dir: ${JSON.stringify(path.join(tmp, 'room'))}, name: 'Boot', kind: 'ai', log: () => {} })
    setTimeout(() => { h.say('booted without GRM'); setTimeout(() => { h.stop(); console.log('BOOTED'); process.exit(0) }, 2500) }, 2500)
  `
  fs.writeFileSync(path.join(pkgDir, 'boot.mjs'), script)
  const out = await new Promise((res) => {
    child = spawn(process.execPath, ['boot.mjs'], { cwd: pkgDir })
    let s = ''; child.stdout.on('data', (d) => { s += d }); child.stderr.on('data', (d) => { s += d })
    child.on('exit', (code) => res({ code, s }))
    setTimeout(() => res({ code: 'timeout', s }), 30000)
  })
  T('the packed sync.js imports, joins a room and speaks without grm-link.cjs', out.code === 0 && /BOOTED/.test(out.s), out.s.slice(-300))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { child && child.kill() } catch { }
  try { relay && relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== GRM PRIVATE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
