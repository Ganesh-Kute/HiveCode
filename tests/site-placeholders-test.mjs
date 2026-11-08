// No public page says "[your registered name]".
//
//   node tests/site-placeholders-test.mjs
//
// MEASURED 13 Oct 2026: the live terms of service named the party to the contract as "[your
// registered name] of [your city, state], India" and gave "[your city]" as the courts with
// jurisdiction. The contact page said the same. A template line that ships reads as a company that
// does not exist, on the one page a careful customer reads before paying.
//
// It also catches the other shapes a template leaves: TODO, TBD, lorem ipsum, and {{handlebars}}.
import fs from 'fs'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PUBLIC = path.join(ROOT, 'public')
let failed = 0
const T = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`); if (!ok) failed++ }

// Visible text only: a script's `{ ... }` or a comment is not something a reader sees.
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
const SHAPES = [/\[your [^\]]{1,60}\]/gi, /\bTODO\b/g, /\bTBD\b/g, /lorem ipsum/gi, /\{\{[^}]{1,40}\}\}/g]

T('P0 the check finds the line that shipped, and not ordinary text', SHAPES.some((re) => { re.lastIndex = 0; return re.test('between you and [your registered name] of [your city, state]') }) &&
  !SHAPES.some((re) => { re.lastIndex = 0; return re.test('Your code is yours. We claim no rights over your registered work.') }))

const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))
const bad = []
for (const f of pages) {
  const text = visible(fs.readFileSync(path.join(PUBLIC, f), 'utf8'))
  for (const re of SHAPES) { re.lastIndex = 0; for (const m of text.matchAll(re)) bad.push(`${f}: ${m[0]}`) }
}
T(`P1 no public page shows template text (${pages.length} pages read)`, bad.length === 0, bad.join(' | '))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
