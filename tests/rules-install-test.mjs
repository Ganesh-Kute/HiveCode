// `rules install` puts a short Hivecode block in an agent's own instruction file, and nothing else.
//
//   node tests/rules-install-test.mjs
//
// WHY (15 Nov 2026). HIVE_RULES.md is read when an agent decides to read it. AGENTS.md, CLAUDE.md
// and GEMINI.md are loaded into every turn by the agent's own app. An agent that had just answered
// two mentions forgot to start its listener again and dropped out of the room: the rule it needed
// was in a file it was not reading at that moment. So a person can now put the few lines that were
// being forgotten where their agent cannot miss them. It is their file, usually committed, so the
// command changes only what is between its two markers, and takes it out again byte for byte.
//
//   I1  into an existing file: the old text is untouched, the block is there once
//   I2  remove gives back the file byte for byte (LF, CRLF, and no final newline)
//   I3  installing twice changes nothing the second time
//   I4  an older block between the markers is replaced; the text around it is untouched
//   I5  every instruction file that exists gets it; none is created when one exists
//   I6  no instruction file at all: AGENTS.md is created, and remove deletes it again
//   I7  --file names any other file, in a folder or by full path
//   I8  a start marker with no end marker is refused, and the file is left alone
//   I9  show prints the block and changes nothing
//   I10 the block is short, names only tools the server has, and carries the rule that was forgotten
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let passed = 0, failed = 0
const T = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`); ok ? passed++ : failed++ }

const M = await import(new URL('../hive-rules-install.js', import.meta.url).href)
const SRC = await import(new URL('../hive-instructions.js', import.meta.url).href)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rules-install-'))
const dirOf = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d }
const cli = (args, cwd) => spawnSync(process.execPath, [path.join(ROOT, 'hive-mcp.js'), 'rules', ...args], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true })
const count = (s, sub) => s.split(sub).length - 1

// I1
{
  const d = dirOf('i1'); const f = path.join(d, 'CLAUDE.md')
  const before = '# My project\n\nUse pnpm. Never touch `legacy/`.\n'
  fs.writeFileSync(f, before)
  const r = cli(['install'], d)
  const after = fs.readFileSync(f, 'utf8')
  T('I1 into an existing file: the old text is untouched and the block is there once',
    r.status === 0 && after.startsWith(before) && count(after, M.START) === 1 && count(after, M.END) === 1 && after.includes(SRC.AGENT_FILE_BLOCK) && /CLAUDE\.md/.test(r.stdout),
    `exit ${r.status}: ${(r.stdout + r.stderr).trim().slice(0, 160)}`)
}

// I2
{
  const cases = { LF: 'a\nb\n', CRLF: 'a\r\nb\r\n', 'no final newline': 'a\nb', 'CRLF, no final newline': 'a\r\nb', empty: '' }
  const bad = []
  for (const [label, before] of Object.entries(cases)) {
    const added = M.withBlock(before)
    const back = M.withoutBlock(added.text)
    if (added.error || added.changed !== true || !added.text.includes(M.START) || !added.text.includes(M.END)) bad.push(`${label}: nothing was added`)
    if (added.error || back.error || back.text !== before) bad.push(`${label}: ${JSON.stringify(back.text)}`)
    if (/\r\n/.test(before) && /[^\r]\n/.test(added.text)) bad.push(`${label}: a bare LF in a CRLF file`)
  }
  T('I2 remove gives the file back byte for byte (LF, CRLF, no final newline, empty)', bad.length === 0, bad.join(' | '))
}

// I3
{
  const once = M.withBlock('# x\n').text
  const twice = M.withBlock(once)
  T('I3 installing twice changes nothing the second time', once.includes(SRC.AGENT_FILE_BLOCK) && twice.text === once && twice.changed === false)
}

// I4
{
  const old = `# top\n\n${M.START}\n## Hivecode (an older text)\n- old rule\n${M.END}\n\n## My own section\nkeep me\n`
  const out = M.withBlock(old)
  T('I4 an older block is replaced and the text around it is untouched',
    out.changed === true && out.text.startsWith('# top\n\n' + M.START) && out.text.endsWith(M.END + '\n\n## My own section\nkeep me\n') && !/old rule/.test(out.text) && out.text.includes(SRC.AGENT_FILE_BLOCK))
}

// I5
{
  const d = dirOf('i5')
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'agents\n')
  fs.mkdirSync(path.join(d, '.github'))
  fs.writeFileSync(path.join(d, '.github', 'copilot-instructions.md'), 'copilot\n')
  const r = cli(['install'], d)
  const has = (f) => { try { return fs.readFileSync(path.join(d, f), 'utf8').includes(M.START) } catch { return null } }
  T('I5 every instruction file that exists gets it; none is created when one exists',
    r.status === 0 && has('AGENTS.md') === true && has('.github/copilot-instructions.md') === true && has('CLAUDE.md') === null && has('GEMINI.md') === null,
    (r.stdout + r.stderr).trim().slice(0, 200))
}

// I6
{
  const d = dirOf('i6')
  const r = cli(['install'], d)
  const made = fs.existsSync(path.join(d, 'AGENTS.md')) ? fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8') : null
  const r2 = cli(['remove'], d)
  T('I6 no instruction file at all: AGENTS.md is created (and the person is told), and remove deletes it again',
    r.status === 0 && made === M.START + '\n' + SRC.AGENT_FILE_BLOCK + '\n' + M.END + '\n' && /created/i.test(r.stdout) && /CLAUDE\.md/.test(r.stdout) && r2.status === 0 && !fs.existsSync(path.join(d, 'AGENTS.md')),
    `${(r.stdout + r.stderr).trim().slice(0, 200)} / ${(r2.stdout + r2.stderr).trim().slice(0, 120)}`)
}

// I7
{
  const d = dirOf('i7'); const other = dirOf('i7-elsewhere')
  fs.mkdirSync(path.join(d, 'docs'))
  fs.writeFileSync(path.join(d, 'docs', 'prompt.md'), 'system prompt\n')
  fs.writeFileSync(path.join(other, 'my-agent.txt'), 'mine\n')
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'agents\n')
  const r = cli(['install', '--file', 'docs/prompt.md', '--file', path.join(other, 'my-agent.txt')], d)
  const has = (f) => fs.readFileSync(f, 'utf8').includes(M.START)
  T('I7 --file names any other file, and then only the named files are changed',
    r.status === 0 && has(path.join(d, 'docs', 'prompt.md')) && has(path.join(other, 'my-agent.txt')) && !has(path.join(d, 'AGENTS.md')),
    (r.stdout + r.stderr).trim().slice(0, 200))
  const r2 = cli(['install', '--dir', d], other)
  T('I7b --dir points it at another folder', r2.status === 0 && has(path.join(d, 'AGENTS.md')), (r2.stdout + r2.stderr).trim().slice(0, 160))
}

// I8
{
  const d = dirOf('i8'); const f = path.join(d, 'AGENTS.md')
  const broken = `# top\n${M.START}\n## Hivecode\nhalf a block, and the end marker was deleted by hand\n`
  fs.writeFileSync(f, broken)
  const r = cli(['install'], d)
  const r2 = cli(['remove'], d)
  T('I8 a start marker with no end marker is refused, and the file is left alone',
    r.status === 1 && r2.status === 1 && fs.readFileSync(f, 'utf8') === broken && /hivecode:end/.test(r.stderr + r.stdout),
    `exit ${r.status}/${r2.status}: ${(r.stdout + r.stderr).trim().slice(0, 160)}`)
}

// I9
{
  const d = dirOf('i9'); const f = path.join(d, 'CLAUDE.md')
  fs.writeFileSync(f, 'x\n')
  const r = cli(['show'], d)
  T('I9 show prints the block, says which files it would change, and changes nothing',
    r.status === 0 && r.stdout.includes(SRC.AGENT_FILE_BLOCK) && /CLAUDE\.md/.test(r.stdout) && fs.readFileSync(f, 'utf8') === 'x\n')
  const bad = cli(['nonsense'], d)
  T('I9b an unknown word prints the usage and exits 2', bad.status === 2 && /rules install/.test(bad.stderr + bad.stdout))
}

// I10
{
  const block = SRC.AGENT_FILE_BLOCK
  const tools = new Set([...fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8').matchAll(/name: '(hive_[a-z_]+)'/g)].map((m) => m[1]))
  const named = [...new Set([...block.matchAll(/\bhive_[a-z_]+\b/g)].map((m) => m[0]))]
  const unknown = named.filter((t) => !tools.has(t))
  const files = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files)
  T(`I10 the block is short (${block.length} <= 700 chars), names only tools the server has, and carries the rule that was forgotten`,
    block.length <= 700 && named.length >= 2 && unknown.length === 0 && /Never end a turn without/.test(block) && /start it again after every reply/.test(block) && /Join again/.test(block),
    unknown.join(' '))
  T('I10b the command is in the package', files.has('hive-rules-install.js'))
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
console.log(`\n=== RULES INSTALL: ${passed} passed, ${failed} failed ===`)
process.exit(failed ? 1 : 0)
