// Generates extension/hive-privacy.cjs — a CommonJS copy of hive-privacy.js for the VS Code
// extension, which is CommonJS and packaged on its own.
//
//   node scripts/build-privacy-cjs.cjs
//
// WHY A GENERATED COPY RATHER THAN A SECOND IMPLEMENTATION.
//
// The extension does not import sync.js; it has its own transport. So a guard that lives
// only in sync.js protects agents and leaves every human on whatever relay their settings
// happen to name -- and the extension's `hivecode.relayUrl` DEFAULTS to the public one, so
// "leave it alone" and "send our source to a stranger" are the same action.
//
// The obvious fix is to write the check again in extension.js. This project has already
// paid for that twice: reconcile() exists in two places that share 34 lines and are two
// different functions, and the version reader existed four times until it was extracted.
// A privacy guard that drifts is worse than one that does not exist, because it reports
// PRIVATE while checking a rule the rest of the product has stopped using.
//
// So: one source of truth, mechanically copied, and extension-privacy-parity-test.mjs
// fails if the copy is stale. hive-privacy.js has no imports, which is why this transform
// is a strip-and-append rather than a bundler.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'hive-privacy.js')
const OUT = path.join(ROOT, 'extension', 'hive-privacy.cjs')

// LF ALWAYS. The source arrives with whatever line endings the checkout gave it (CRLF on a Windows
// clone with core.autocrlf), while the header below is LF -- so the output used to depend on the
// machine, and extension-privacy-parity-test failed on every fresh Windows clone (29 Sep 2026)
// while passing in the folder that last ran this script. .gitattributes pins the output to eol=lf.
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

// hive-privacy.js is deliberately dependency-free. If that ever stops being true this
// script would silently emit a file with undefined bindings, which the extension swallows
// in its `try { require(...) } catch {}` -- the guard would then never engage and nothing
// would say so. Refuse instead.
if (/^\s*import\s/m.test(src)) {
  throw new Error('hive-privacy.js now has imports; this bundler would emit a broken file. ' +
    'Either keep it dependency-free or teach this script to resolve them.')
}

const exported = [...src.matchAll(/^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
if (!exported.length) throw new Error('no exports found in hive-privacy.js — bundler would emit an empty module')

const body = src
  .split('\n')
  .map((l) => l.replace(/^(\s*)export\s+/, '$1'))
  .join('\n')

const out = `// AUTO-GENERATED from hive-privacy.js by scripts/build-privacy-cjs.cjs — do not edit by hand.
// Run \`node scripts/build-privacy-cjs.cjs\` after changing hive-privacy.js.
// tests/extension-privacy-parity-test.mjs fails if this file is stale.

${body}
module.exports = { ${exported.join(', ')} }
`

fs.writeFileSync(OUT, out)
console.log(`wrote ${path.relative(ROOT, OUT)} (${out.length} bytes, exports: ${exported.join(', ')})`)
