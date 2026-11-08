// The rules every room is given tell an agent only to do things it can actually do.
//
//   node tests/rules-promises-test.mjs
//
// MEASURED 13 Oct 2026:
//   - The rules sync.js writes into every room said, as the way to announce work,
//       node hive-say.js <yourName> "taking auth.js: adding login validation"
//     hive-say.js is a development script in this repo. It is not in the npm package, so not one
//     stranger's agent had it: the first instruction it was given to follow could not be followed.
//   - The HIVE_RULES.md that ships in the package was a second, hand-kept copy that had drifted. It
//     told agents to call a tool named `recall` "at these four moments, every time" -- a tool from a
//     private memory engine that no Hivecode user has. Nothing loads that file, but it is what a
//     person reading the package sees as the rules.
//
//   R1  the shipped HIVE_RULES.md is exactly the text every room is given: one source, no drift
//   R2  every `node <file>` the rules ask an agent to run is a file the package ships
//   R3  every hive_* tool the rules (and the join card) name is a tool the MCP server has
//   R4  the rules name no tool from outside Hivecode
import fs from 'fs'
import path from 'path'

const ROOT = process.env.RULES_ROOT || path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
let failed = 0
const T = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`); if (!ok) failed++ }
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

/** The rules as sync.js gives them to every room: the HIVE_RULES_TEXT template literal. */
function embeddedRules(src) {
  const start = src.indexOf('const HIVE_RULES_TEXT = `')
  if (start === -1) return ''
  const from = start + 'const HIVE_RULES_TEXT = `'.length
  return src.slice(from, src.indexOf('`', from))
}
const NODE_CMD = /\bnode\s+([\w./-]+\.(?:m?js|cjs))\b/g
const TOOL = /\bhive_[a-z_]+\b/g

{
  const sample = 'e.g.\n   node hive-say.js <yourName> "taking auth.js"\n   call hive_say, then hive_wait'
  T('R0 the checks find a script to run and the tools named in a sample',
    [...sample.matchAll(NODE_CMD)].map((m) => m[1]).join() === 'hive-say.js' && [...sample.matchAll(TOOL)].map((m) => m[0]).join() === 'hive_say,hive_wait')
}

const room = embeddedRules(read('sync.js'))
const shipped = read('HIVE_RULES.md')
T('R1 the shipped HIVE_RULES.md is exactly what every room is given', room.length > 1000 && shipped === room,
  room.length < 1000 ? 'could not find HIVE_RULES_TEXT in sync.js' : `${shipped.split('\n').length} lines shipped vs ${room.split('\n').length} given to rooms`)

const files = new Set(JSON.parse(read('package.json')).files)
const card = (() => { const s = read('hive-instructions.js'); const m = s.match(/export const JOIN_RULES = `([\s\S]*?)`/); return m ? m[1] : '' })()
const texts = { 'the room rules': room, 'HIVE_RULES.md': shipped, 'the join card': card }

const scripts = []
for (const [where, text] of Object.entries(texts)) for (const m of text.matchAll(NODE_CMD)) if (!files.has(m[1])) scripts.push(`${where}: node ${m[1]}`)
T('R2 every script the rules ask an agent to run is in the package', scripts.length === 0, scripts.join(' | '))

const tools = new Set([...read('hive-mcp.js').matchAll(/name: '(hive_[a-z_]+)'/g)].map((m) => m[1]))
const unknown = []
for (const [where, text] of Object.entries(texts)) for (const m of new Set([...text.matchAll(TOOL)].map((x) => x[0]))) if (!tools.has(m)) unknown.push(`${where}: ${m}`)
T(`R3 every hive_* tool the rules name exists (${tools.size} tools)`, tools.size > 20 && unknown.length === 0, unknown.join(' | '))

const outside = []
for (const [where, text] of Object.entries(texts)) if (/\brecall\(|tool called `recall`/.test(text)) outside.push(`${where}: recall`)
T('R4 the rules name no tool from outside Hivecode', outside.length === 0, outside.join(' | '))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
