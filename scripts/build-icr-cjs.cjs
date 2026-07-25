// Generates extension/icr.cjs — a CommonJS bundle of the ICR engine (lang-js.js + icr.js)
// for the VS Code extension, which is CommonJS and packaged on its own. Each source file
// is wrapped in its own scope (so internal names like `parses` don't collide), ESM
// import/export is stripped, and acorn is required once at the top.
//
//   node build-icr-cjs.cjs
//
// Re-run this whenever lang-js.js or icr.js changes, so the extension stays in sync.

const fs = require('fs')
const path = require('path')
const ROOT = __dirname

const strip = (src) => src.split('\n')
  .filter((l) => !/^\s*import\s/.test(l))         // drop ESM imports (acorn/javascript supplied by wrapper)
  .map((l) => l.replace(/^(\s*)export\s+/, '$1'))  // `export function/const` -> plain declaration
  .join('\n')

const lang = strip(fs.readFileSync(path.join(ROOT, 'lang-js.js'), 'utf8'))
const eng = strip(fs.readFileSync(path.join(ROOT, 'icr.js'), 'utf8'))

const out = `// AUTO-GENERATED from lang-js.js + icr.js by build-icr-cjs.cjs — do not edit by hand.
// CommonJS bundle of the ICR merge engine for the (CommonJS, separately-packaged) extension.
const acorn = require('acorn')

const { javascript } = (function () {
${lang}
  return { javascript }
})()

const ICR = (function (javascript) {
${eng}
  return { structuralMerge, supports, parses, registerLanguage, languageFor }
})(javascript)

module.exports = ICR
`

fs.writeFileSync(path.join(ROOT, 'extension', 'icr.cjs'), out)
console.log('wrote extension/icr.cjs (' + out.length + ' bytes)')
