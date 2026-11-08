// A private sandbox repository for trying the GitHub watcher for real: a tiny project, its CI, and
// two labelled issues for the agent. Creates things on GitHub, so it does nothing without --yes.
//
//   node scripts/github-sandbox.mjs <owner>/<name> --dir <empty folder> --yes
//
// Then, in that folder:
//   npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --test "npm test"
//
// Afterwards: gh repo delete <owner>/<name>   (it asks you to confirm)
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const argv = process.argv.slice(2)
const repo = argv.find((a) => /^[\w.-]+\/[\w.-]+$/.test(a))
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i === -1 ? '' : argv[i + 1] || '' }
const dir = flag('dir')
if (!repo || !dir) { console.error('usage: node scripts/github-sandbox.mjs <owner>/<name> --dir <empty folder> --yes'); process.exit(2) }
if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error(`${dir} is not empty`); process.exit(2) }

const FILES = {
  'package.json': JSON.stringify({ name: 'hivecode-sandbox', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/slug.js': [
    '// slug("Hello, World") -> "hello-world"',
    'export function slug(text) {',
    "  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-')",
    '}',
    '',
  ].join('\n'),
  'test/slug.test.js': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { slug } from '../src/slug.js'",
    '',
    "test('lowercases and joins words with dashes', () => {",
    "  assert.equal(slug('Hello World'), 'hello-world')",
    '})',
    '',
  ].join('\n'),
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: [push, pull_request]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    '      - run: npm test',
    '',
  ].join('\n'),
  'README.md': '# hivecode-sandbox\n\nA throwaway repository for trying the Hivecode GitHub watcher.\n',
}
const ISSUES = [
  { title: 'slug() leaves dashes at the start and end', body: "`slug('  Hello, World!  ')` returns `-hello-world-`. It should return `hello-world`.\n\nAdd a test for it." },
  { title: 'Add a maxLength option to slug()', body: "`slug(text, { maxLength })` should cut the result to at most `maxLength` characters, at a word boundary, and never end with a dash.\n\nFor example `slug('the quick brown fox', { maxLength: 12 })` is `the-quick`. Add tests." },
]

const plan = [
  `create the PRIVATE repository ${repo} on GitHub`,
  `push ${Object.keys(FILES).length} files to it (a tiny project with a CI workflow)`,
  `open ${ISSUES.length} issues and label them "hivecode"`,
]
if (!argv.includes('--yes')) {
  console.log(`This would:\n${plan.map((p) => `  - ${p}`).join('\n')}\n\nNothing was done. Add --yes to do it.`)
  process.exit(0)
}

const run = (cmd, args, cwd = dir) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`); process.exit(1) }
  return (r.stdout || '').trim()
}
fs.mkdirSync(dir, { recursive: true })
for (const [rel, text] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
run('git', ['init', '-q', '-b', 'main'])
run('git', ['add', '-A'])
run('git', ['commit', '-qm', 'a tiny project to try Hivecode on'])
run('gh', ['repo', 'create', repo, '--private', '--source', '.', '--push'])
run('gh', ['label', 'create', 'hivecode', '--color', '7057ff', '--description', 'Hivecode: agents build this and open a pull request', '--force'], dir)
for (const i of ISSUES) console.log(run('gh', ['issue', 'create', '--title', i.title, '--body', i.body, '--label', 'hivecode'], dir))
console.log(`\nReady: ${repo}, cloned at ${path.resolve(dir)}, with ${ISSUES.length} labelled issues.`)
