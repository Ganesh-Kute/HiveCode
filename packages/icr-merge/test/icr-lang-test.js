// Proves ICR's merge engine is genuinely LANGUAGE-AGNOSTIC: we register a brand-new,
// non-JavaScript language provider at runtime and the SAME structuralMerge() engine
// merges it by structure â€” no engine changes. This is the foundation of "all languages":
// adding one = writing a provider, not touching the merge logic.
//
//   node icr-lang-test.js

import { structuralMerge, registerLanguage, supports } from '../icr.js'

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

// A tiny toy language: `.kv` files of `key: value` lines. Each line is a unit keyed by
// its key. It implements only the minimal slice of the provider contract (parse + units);
// the engine's intent layers are optional and simply don't run for it.
const keyval = {
  id: 'keyval',
  exts: ['.kv'],
  parses: () => true,
  units: (src) => src.split('\n').filter((l) => l.trim()).map((line, i) => {
    const k = line.split(':')[0].trim()
    return { key: 'kv:' + (k || i), text: line }
  }),
  declaredNames: () => new Set(),
}

console.log('# Before registration, ICR does not claim .kv files')
assert('.kv unsupported until registered', supports('config.kv') === false)

registerLanguage(keyval)

console.log('\n# After registering ONE provider, the same engine merges a new language')
assert('.kv now supported', supports('config.kv') === true)

console.log('\n# Two agents edit DIFFERENT keys â†’ clean structural merge (no JS involved)')
{
  const base = `host: localhost
port: 8080
`
  const a = `host: example.com
port: 8080
`
  const b = `host: localhost
port: 9090
`
  const r = structuralMerge(base, a, b, { filename: 'config.kv' })
  assert('status is auto', r.status === 'auto')
  assert("kept A's host change", /host: example\.com/.test(r.text || ''))
  assert("kept B's port change", /port: 9090/.test(r.text || ''))
}

console.log('\n# Two agents edit the SAME key â†’ semantic conflict, by structure')
{
  const base = `host: localhost
port: 8080
`
  const a = `host: localhost
port: 9090
`
  const b = `host: localhost
port: 7070
`
  const r = structuralMerge(base, a, b, { filename: 'config.kv' })
  assert('status is semantic-conflict', r.status === 'semantic-conflict')
  assert('names the conflicting key (kv:port)', r.conflicts.includes('kv:port'))
}

console.log(`\n=== ${failed === 0 ? 'ALL ICR-LANG CHECKS PASSED' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
