// A stand-in for an agent CLI, for tests/github-watcher-test.mjs. It does what a real agent does with
// the watcher's task: reads it on stdin, joins the room through the real MCP server code, edits
// files in its folder, leaves, and ends its reply with SUMMARY and TESTS. What it does is steered by
// FAKE: lines in the part of the task that is new to it: the issue on a first run, the FEEDBACK
// (CI logs, review comments, answers) on a later one. So a test drives it through GitHub data,
// exactly as a person drives a real agent.
//
//   FAKE:write <path> <content, \n for newlines>
//   FAKE:summary <text>        FAKE:blocked <question>     FAKE:fail <message>
//   FAKE:hang                  FAKE:nojoin                 FAKE:fast (exit without leaving)
//
// As the tester (its task has a <<<DIFF), it reads TESTER: lines from the issue instead:
//   TESTER:write <path> <content>        TESTER:touch <path> <content>   (a file that is not a test)
//   TESTER:fail-until <path> <content>   TESTER:noverdict   TESTER:fail-always
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
if (process.env.FAKE_PROMPT_LOG) {
  fs.mkdirSync(process.env.FAKE_PROMPT_LOG, { recursive: true })
  fs.writeFileSync(path.join(process.env.FAKE_PROMPT_LOG, `${Date.now()}-${process.pid}.txt`), prompt)
}

const section = (tag) => { const m = prompt.match(new RegExp(`<<<${tag}\\n([\\s\\S]*?)\\n${tag}>>>`)); return m ? m[1] : '' }
const now = prompt.includes('<<<FEEDBACK') ? section('FEEDBACK') : section('ISSUE')
const says = [...now.matchAll(/FAKE:(\w+)(?:[ \t]+([^\n]*))?/g)].map((m) => ({ verb: m[1], arg: (m[2] || '').trim() }))
const has = (v) => says.find((s) => s.verb === v)

// THE TESTER. Its task carries the builder's diff; its own instructions are TESTER: lines in the
// issue, which the builder never acts on. `fail-until <path> <content>` reads the room's copy of the
// file and fails until it says exactly that -- with the fix in its report, as a real tester's would.
if (prompt.includes('<<<DIFF\n')) {
  const t = [...section('ISSUE').matchAll(/TESTER:([\w-]+)(?:[ \t]+([^\n]*))?/g)].map((m) => ({ verb: m[1], arg: (m[2] || '').trim() }))
  const tjoin = JSON.parse(prompt.match(/hive_join tool with exactly these arguments: (\{.*\})/)[1])
  const M = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-mcp.js`)
  const r = await M._test.callTool('hive_join', tjoin)
  if (!/joined|HOSTED/i.test((r && r.content && r.content[0] && r.content[0].text) || '')) { console.error('join failed'); process.exit(3) }
  await sleep(1500)
  const split = (arg) => { const sp = arg.indexOf(' '); return [arg.slice(0, sp), arg.slice(sp + 1)] }
  for (const s of t.filter((x) => x.verb === 'write' || x.verb === 'touch')) {
    const [rel, raw] = split(s.arg)
    const file = path.join(tjoin.dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, raw.replace(/\\n/g, '\n'))
  }
  let verdict = 'PASS'
  let report = 'checked it, and it does what the issue asks'
  for (const s of t.filter((x) => x.verb === 'fail-until')) {
    const [rel, raw] = split(s.arg)
    let have = null
    try { have = fs.readFileSync(path.join(tjoin.dir, ...rel.split('/')), 'utf8') } catch { }
    if (have !== raw.replace(/\\n/g, '\n')) { verdict = 'FAIL'; report = `${rel} is not right yet. FAKE:write ${rel} ${raw}` }
  }
  if (t.some((x) => x.verb === 'fail-always')) {
    // Never satisfied, but always with something for the builder to change, so every round lands.
    let n = 0
    try { n = Number(fs.readFileSync(path.join(tjoin.dir, 'attempts.txt'), 'utf8')) || 0 } catch { }
    verdict = 'FAIL'
    report = `still wrong (attempt ${n + 1}). FAKE:write attempts.txt ${n + 1}`
  }
  await sleep(2500)
  await M._test.callTool('hive_leave', {})
  await sleep(300)
  if (t.some((x) => x.verb === 'noverdict')) { console.log('Looked at it. Seems mostly fine.\nTESTS: fake: 1 passed'); process.exit(0) }
  console.log(`VERDICT: ${verdict}\nREPORT: ${report}\nTESTS: fake tester: 1 ${verdict === 'PASS' ? 'passed' : 'failed'}`)
  process.exit(0)
}

if (has('fail')) { console.error(has('fail').arg || 'usage limit reached'); process.exit(1) }
if (has('hang')) { setInterval(() => { }, 1 << 30); await new Promise(() => { }) }
if (has('blocked')) { console.log(`I need to know something first.\nBLOCKED: ${has('blocked').arg}`); process.exit(0) }

const join = JSON.parse(prompt.match(/hive_join tool with exactly these arguments: (\{.*\})/)[1])
let wrote = []
if (!has('nojoin')) {
  const M = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-mcp.js`)
  const r = await M._test.callTool('hive_join', join)
  const text = (r && r.content && r.content[0] && r.content[0].text) || ''
  if (!/joined|HOSTED/i.test(text)) { console.error(`join failed: ${text.slice(0, 300)}`); process.exit(3) }
  await sleep(1500)
  for (const s of says.filter((x) => x.verb === 'write')) {
    const sp = s.arg.indexOf(' ')
    const rel = s.arg.slice(0, sp)
    const content = s.arg.slice(sp + 1).replace(/\\n/g, '\n')
    const file = path.join(join.dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    wrote.push(rel)
  }
  if (has('fast')) {
    // Gone the moment the file is written: what reaches the room is the watcher's flush to find.
    console.log(`SUMMARY: ${has('summary') ? has('summary').arg : `wrote ${wrote.join(', ')}`}\nTESTS: fake: 1 passed`)
    process.exit(0)
  }
  await sleep(2500)
  await M._test.callTool('hive_leave', {})
  await sleep(300)
}
console.log(`Done.\nSUMMARY: ${has('summary') ? has('summary').arg : wrote.length ? `wrote ${wrote.join(', ')}` : 'nothing to change'}\nTESTS: fake: ${wrote.length} passed, 0 failed`)
process.exit(0)
