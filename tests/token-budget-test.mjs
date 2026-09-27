// TOKEN BUDGET (27 Sep 2026). What Hivecode hands an agent is paid for in its context, and most of it
// on every turn: the tool list and the instructions ride along with every request, and a result
// stays in the transcript for the rest of the session. bench/token-cost.mjs measures it through the
// scenarios agents live in; this pins the ceilings, so a change that grows them fails the day it
// lands instead of being noticed on somebody's bill a month later.
//
// Numbers when the ceilings were set, and what they were before the cuts that day:
//   carried on every request  3,319 tok  (was 4,619)
//   hive_join reply             402      (was 1,945)
//   10 long reports, read back  830      (was 3,018)
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

console.log('\n=== TOKEN BUDGET ===')
const r = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'token-cost.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 240000, windowsHide: true })
let j = null
try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()) } catch { }
T('the bench ran and measured every scenario (anti-vacuity)', !!j && j.rows.length >= 29 && ['every turn', 'join', 'ask/answer', 'idle', 'busy room', 'long reports', 'new project'].every((s) => j.byScenario[s] > 0), j ? `${j.rows.length} rows` : String(r.stderr || '').slice(0, 300))
if (j) {
  const tok = (call) => { const x = j.rows.find((row) => row.call === call); return x ? x.tokens : Infinity }
  const within = (label, call, max) => T(`${label} <= ${max} tok`, tok(call) <= max, `${tok(call)} tok`)
  T('carried on EVERY request (tool list + instructions) <= 3500 tok', j.perTurn <= 3500, `${j.perTurn} tok`)
  within('server instructions', 'server instructions', 600)
  within('hive_join reply, which stays in the transcript', 'hive_join (host a room)', 450)
  within('asking a question with needsReply', 'hive_say (question, needsReply)', 125)
  within("the asker's check after an answer (no false 'still waiting')", 'hive_check (the asker)', 60)
  within('an idle check', 'hive_check (nothing new)', 40)
  within('catching up on 10 long reports', 'hive_read_chat (10 long reports)', 1000)
  within('ten claims of files not in the room yet (explained once, then one line)', 'hive_claim x10 (files not in the room yet)', 750)
  T('...and full:true still returns them whole (the cut is a default, not a loss)', tok('  same, full:true (the old behaviour)') > 2 * tok('hive_read_chat (10 long reports)'))
}
console.log(`\n=== TOKEN BUDGET: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
