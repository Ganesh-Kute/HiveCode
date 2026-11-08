// Every shipped program starts when it is run directly, on macOS and Linux too.
//
//   node tests/entry-point-test.mjs
//
// MEASURED 8 Nov 2026 (Mac/Linux CI, first run of the Slack suites): `node hive-slack-agent.js ...`
// exited 0 with no output and did nothing. Six shipped files decided "am I the program being run?"
// with  import.meta.url === `file:///${process.argv[1]}`.  On Windows argv[1] is C:\..., which
// gives file:///C:/... and matches. On macOS and Linux argv[1] is /home/..., which gives
// file:////home/... (four slashes) and never matches, so the program silently skipped main().
// A founder on a Mac starting the Slack agent bridge got no bridge and no error.
//
//   E1  no shipped file uses the file:/// string comparison
//   E2  run directly through a path that is NOT the file's own spelling (a symlink, or on Windows
//       a junction to its folder, which is what npx and node_modules/.bin do), each program
//       actually runs main(): it prints something and does not exit 0 silently
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const shipped = (pkg.files || []).filter((f) => /\.(m?js|cjs)$/.test(f) && fs.existsSync(path.join(ROOT, f)))
const BROKEN = /import\.meta\.url\s*===\s*`file:\/\/\//

console.log('# E1 no string-built file:/// entry checks in shipped files')
const offenders = shipped.filter((f) => BROKEN.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
T(`E1 ${shipped.length} shipped files checked; none compares import.meta.url to a file:/// string`, offenders.length === 0, offenders.join(', '))

// E2: programs a user starts directly, each with arguments that make main() say something and stop
// without a network: missing tokens or a bad flag. What matters is that main() RAN.
console.log('\n# E2 run through another path to the same folder (symlink / junction), main() runs')
const PROGRAMS = [
  ['hive-slack-agent.js', ['ws://127.0.0.1:9|room-entrypoint', '--channel', 'D-TEST'], { SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' }],
  ['hive-slack.js', ['start', 'ws://127.0.0.1:9|room-entrypoint', '--channel', 'C-TEST'], { SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' }],
].filter(([f]) => shipped.includes(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-entry-'))
const link = path.join(tmp, 'pkg')
let linked = false
try { fs.symlinkSync(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true } catch (e) { console.log(`  (could not link: ${e.message})`) }
for (const [file, args, env] of PROGRAMS) {
  for (const [how, base] of [['own path', ROOT], ['linked path', linked ? link : null]]) {
    if (!base) continue
    const r = spawnSync(process.execPath, [path.join(base, file), ...args], {
      cwd: tmp, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, ...env, HIVE_NO_UPDATE_CHECK: '1' },
    })
    const said = `${r.stdout || ''}${r.stderr || ''}`.trim()
    T(`E2 ${file} via ${how}: main() ran (non-zero exit with a message)`, r.status !== 0 && said.length > 0,
      `exit=${r.status} out=${JSON.stringify(said.slice(0, 160))}`)
  }
}
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }

console.log(`\n=== ENTRY POINTS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
