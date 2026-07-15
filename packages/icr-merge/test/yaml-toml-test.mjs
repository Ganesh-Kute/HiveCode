// YAML (indent-mapping structure) + TOML (section/key structure) providers.
import { structuralMerge, languageFor } from '../icr.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// ---------- YAML ----------
console.log('# YAML: structure + parses')
const yl = languageFor('ci.yml')
const yb = 'name: pipeline\n\njobs:\n  build:\n    image: node:20\n    steps:\n      - run: npm ci\n  test:\n    image: node:20\n    steps:\n      - run: npm test\n\nenv:\n  CI: "1"\n'
T('valid yaml parses', yl.parses(yb))
T('bad dedent REFUSED', !yl.parses('a:\n    b: 1\n  c: 2\n'))
T('top-level units keyed', yl.units(yb).map((u) => u.key).join(',') === 'key:name,key:jobs,key:env')

console.log('# YAML: different top-level keys merge')
const ya = yb.replace('name: pipeline', 'name: pipeline-v2')
const ybb = yb.replace('CI: "1"', 'CI: "1"\n  DEBUG: "0"')
const r1 = structuralMerge(yb, ya, ybb, { filename: 'ci.yml' })
T('clean merge', r1.status === 'auto')
T('both edits present', r1.text.includes('pipeline-v2') && r1.text.includes('DEBUG'))
T('result still parses', yl.parses(r1.text))

console.log('# YAML: different JOBS inside the same jobs: block merge (descent)')
const yj1 = yb.replace('image: node:20\n    steps:\n      - run: npm ci', 'image: node:22\n    steps:\n      - run: npm ci')
const yj2 = yb.replace('- run: npm test', '- run: npm test -- --coverage')
const r2 = structuralMerge(yb, yj1, yj2, { filename: 'ci.yml' })
T('different jobs merge clean', r2.status === 'auto' && r2.text.includes('node:22') && r2.text.includes('--coverage'))

console.log('# YAML: same key changed two ways -> conflict')
const yc1 = yb.replace('name: pipeline', 'name: alpha')
const yc2 = yb.replace('name: pipeline', 'name: beta')
T('same-key clash conflicts', structuralMerge(yb, yc1, yc2, { filename: 'ci.yml' }).status === 'semantic-conflict')

console.log('# YAML: block scalar tolerated, not descended')
const ys = 'script: |\n  echo one\n  echo two\nname: x\n'
T('block scalar parses', yl.parses(ys))
const rs = structuralMerge(ys, ys.replace('echo one', 'echo ONE'), ys.replace('name: x', 'name: y'), { filename: 'a.yml' })
T('scalar edit + other key merge', rs.status === 'auto' && rs.text.includes('echo ONE') && rs.text.includes('name: y'))

// ---------- TOML ----------
console.log('# TOML: structure')
const tl = languageFor('Cargo.toml')
const tb = '[package]\nname = "app"\nversion = "1.0.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1", features = ["full"] }\n'
T('valid toml parses', tl.parses(tb))
T('units keyed by section', tl.units(tb).map((u) => u.key).join(',') === 'table:package,table:dependencies')

console.log('# TOML: different sections merge')
const ta = tb.replace('version = "1.0.0"', 'version = "1.1.0"')
const tbb = tb.replace('serde = "1.0"', 'serde = "1.0"\nanyhow = "1.0"')
const r3 = structuralMerge(tb, ta, tbb, { filename: 'Cargo.toml' })
T('clean merge', r3.status === 'auto')
T('both edits present', r3.text.includes('1.1.0') && r3.text.includes('anyhow'))

console.log('# TOML: different keys of the SAME section merge (descent)')
const tk1 = tb.replace('serde = "1.0"', 'serde = "1.2"')
const tk2 = tb.replace('tokio = { version = "1", features = ["full"] }', 'tokio = { version = "1.1", features = ["full"] }')
const r4 = structuralMerge(tb, tk1, tk2, { filename: 'Cargo.toml' })
T('same-section different keys merge', r4.status === 'auto' && r4.text.includes('serde = "1.2"') && r4.text.includes('"1.1"'))

console.log('# TOML: same key changed two ways -> conflict')
const tc1 = tb.replace('"1.0.0"', '"2.0.0"'), tc2 = tb.replace('"1.0.0"', '"3.0.0"')
T('same-key clash conflicts', structuralMerge(tb, tc1, tc2, { filename: 'Cargo.toml' }).status === 'semantic-conflict')

console.log('# TOML: multi-line array values stay one unit')
const tm = '[a]\nx = [\n  1,\n  2,\n]\ny = 3\n'
T('multi-line array parses + units', tl.parses(tm) && tl.units(tm).length === 1)
const r5 = structuralMerge(tm, tm.replace('y = 3', 'y = 4'), tm.replace('  1,', '  1,\n  9,'), { filename: 'a.toml' })
T('array append + other key merge', r5.status === 'auto' && r5.text.includes('9,') && r5.text.includes('y = 4'))

console.log(`\n=== YAML-TOML: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
