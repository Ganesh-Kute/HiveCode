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

// 0.14.4: one source. Every agent-facing text lives in hive-instructions.js; sync.js imports it.
const SRC = await import(new URL('../hive-instructions.js', import.meta.url).href + '?' + Date.now())
const room = SRC.RULES_MD
const shipped = read('HIVE_RULES.md')
T('R1 the shipped HIVE_RULES.md is exactly what every room is given', room.length > 1000 && shipped === room,
  `${shipped.split('\n').length} lines shipped vs ${room.split('\n').length} given to rooms`)

const files = new Set(JSON.parse(read('package.json')).files)
const card = SRC.joinCard()
const texts = { 'the room rules': room, 'HIVE_RULES.md': shipped, 'the join card': card, 'the instructions': SRC.INSTRUCTIONS, 'HIVE_FOR_AGENTS.md': SRC.AGENT_MANUAL }

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

// ── 0.14.4 rules rewrite (docs/rules-rewrite/draft-v1.md) ─────────────────────────────────────
// The tool list as the model sees it, every turn: name, description and schema.
const TOOLS_JSON = (() => {
  const src = read('hive-mcp.js'); const a = src.indexOf('const TOOLS = ['); let i = src.indexOf('[', a), d = 0, j = i
  for (; j < src.length; j++) { const c = src[j]; if (c === '[') d++; else if (c === ']') { d--; if (d === 0) break } }
  const tools = (0, eval)(src.slice(i, j + 1))
  return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })))
})()
T(`R5 the always-on text stays small: instructions ${SRC.INSTRUCTIONS.length} <= 1400 chars, join card ${card.length} <= 800, tools ${TOOLS_JSON.length} <= 13642 (0.14.3's size: it must not grow)`,
  SRC.INSTRUCTIONS.length <= 1400 && card.length <= 800 && TOOLS_JSON.length <= 13642)

// Each pair the review found saying opposite things, or a promise the code does not keep.
const agentTexts = { ...texts, 'the tool list': TOOLS_JSON, 'the Stop hook': read('hive-stop-hook.js') }
const FALSE = [
  [/no lead to route through/i, 'says there is no lead, while a lead is whoever your person names'],
  [/Lead PM|PM only/i, 'claims a PM role the code never checks'],
  [/ending your turn makes you unreachable/i, 'contradicts the listener order on clients that have one'],
  [/hive_verified says whose check passed/i, 'hive_verified reports byte quorum, not checks'],
  [/ACKNOWLEDGE a ping/i, 'orders the bare acknowledgements the rules now forbid'],
  [/Announce a file before you edit/i, 'duplicates the claim'],
]
const contradictions = []
for (const [where, text] of Object.entries(agentTexts)) for (const [re, why] of FALSE) if (re.test(text)) contradictions.push(`${where}: ${why}`)
T('R6 no agent-facing text says what the review found false or contradictory', contradictions.length === 0, contradictions.join(' | '))

let docRules = null; try { docRules = read('docs/HIVE_RULES.md') } catch { /* deleted: good */ }
T('R7 one source: HIVE_FOR_AGENTS.md is generated, docs/HIVE_RULES.md is gone, sync.js holds no copy',
  read('docs/HIVE_FOR_AGENTS.md') === SRC.AGENT_MANUAL && docRules === null && !/const HIVE_RULES_TEXT = `/.test(read('sync.js')))

const marketing = []
for (const [where, text] of Object.entries(texts)) if (/support@|getgrm|\((?:Ganesh|[A-Z][a-z]+), \d{1,2} [A-Z][a-z]{2} 20\d\d\)/.test(text)) marketing.push(where)
T('R8 no support address, product plug or dated attribution in the rules', marketing.length === 0, marketing.join(' | '))

const codeSrc = fs.readdirSync(ROOT).filter((f) => /\.m?js$/.test(f) && f !== 'hive-instructions.js').map((f) => read(f)).join('\n')
const codes = new Set(Object.values(agentTexts).flatMap((t) => [...String(t).matchAll(/\bQ\d{3}\b/g)].map((m) => m[0])))
const missing = [...codes].filter((q) => !codeSrc.includes(q))
T(`R9 every Q-code the agent texts name exists in the code (${codes.size} named)`, missing.length === 0, missing.join(' '))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
