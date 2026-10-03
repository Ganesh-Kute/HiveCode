// Generates public/hive-secrets.js and injects patterns & helpers into public/control.html
// from hive-secrets.js.
//
//   node scripts/build-secrets-browser.cjs
//   node scripts/build-secrets-browser.cjs --check
//
// WHY A GENERATED COPY RATHER THAN HAND-COPIED REGEXES.
//
// Like scripts/build-privacy-cjs.cjs: one source of truth (hive-secrets.js), mechanically
// copied, and tests/control-room-walk.mjs fails if the browser copy drifts.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'hive-secrets.js')
const OUT = path.join(ROOT, 'public', 'hive-secrets.js')
const HTML = path.join(ROOT, 'public', 'control.html')

const isCheck = process.argv.includes('--check')

// LF ALWAYS
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')

if (/^\s*import\s/m.test(src)) {
  throw new Error('hive-secrets.js has imports; this bundler would emit a broken file. ' +
    'Keep it dependency-free.')
}

// Strip existing exports so we can format declarations cleanly
const body = src
  .split('\n')
  .map((l) => l.replace(/^(\s*)export\s+/, '$1'))
  .join('\n')

const envHelper = `function envForKind(kind) {
  switch (kind) {
    case 'GitHub token': return 'GITHUB_TOKEN'
    case 'GitLab token': return 'GITLAB_TOKEN'
    case 'AWS access key': return 'AWS_ACCESS_KEY_ID'
    case 'OpenAI API key': return 'OPENAI_API_KEY'
    case 'Anthropic API key': return 'ANTHROPIC_API_KEY'
    case 'Stripe live key': return 'STRIPE_SECRET_KEY'
    case 'Slack token': return 'SLACK_BOT_TOKEN'
    case 'Slack webhook': return 'SLACK_WEBHOOK_URL'
    case 'npm token': return 'NPM_TOKEN'
    case 'Hugging Face token': return 'HF_TOKEN'
    case 'Groq API key': return 'GROQ_API_KEY'
    case 'SendGrid API key': return 'SENDGRID_API_KEY'
    case 'DigitalOcean token': return 'DO_TOKEN'
    case 'private key': return 'PRIVATE_KEY'
    case 'registry credential': return 'NPM_TOKEN'
    default: return 'TOKEN'
  }
}

function secretRefusalNotice(f) {
  if (!f) return ''
  const a = /^(?:[aeiou]|npm\\b)/i.test(f.kind) ? 'an' : 'a'
  const env = envForKind(f.kind)
  return \`Not sent: this message contains \${a} \${f.kind}. Keys never go in the room; say where it is kept (e.g. \${env} in .env).\`
}`

const esmOut = `// AUTO-GENERATED from hive-secrets.js by scripts/build-secrets-browser.cjs — do not edit by hand.
// Run \`node scripts/build-secrets-browser.cjs\` after changing hive-secrets.js.
// tests/control-room-walk.mjs fails if this file is stale.

${body}

${envHelper}

export { PATTERNS, PLACEHOLDER, placeholder, findSecrets, newSecrets, describeSecret, envForKind, secretRefusalNotice }
`

const startTag = '// --- AUTO-GENERATED: hive-secrets ---'
const endTag = '// --- END AUTO-GENERATED: hive-secrets ---'
const injection = `${startTag}
${body}

${envHelper}

window._secrets = { PATTERNS, PLACEHOLDER, placeholder, findSecrets, newSecrets, describeSecret, envForKind, secretRefusalNotice }
${endTag}`

if (isCheck) {
  if (!fs.existsSync(OUT)) {
    console.error('STALE: public/hive-secrets.js missing')
    process.exit(1)
  }
  const curEsm = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n')
  if (curEsm !== esmOut) {
    console.error('STALE: public/hive-secrets.js differs from hive-secrets.js — run `node scripts/build-secrets-browser.cjs`')
    process.exit(1)
  }
  if (!fs.existsSync(HTML)) {
    console.error('STALE: public/control.html missing')
    process.exit(1)
  }
  const curHtml = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
  if (!curHtml.includes(startTag) || !curHtml.includes(endTag)) {
    console.error('STALE: public/control.html missing generated hive-secrets block — run `node scripts/build-secrets-browser.cjs`')
    process.exit(1)
  }
  const currentBlock = curHtml.slice(curHtml.indexOf(startTag), curHtml.indexOf(endTag) + endTag.length)
  if (currentBlock !== injection) {
    console.error('STALE: public/control.html generated hive-secrets block differs — run `node scripts/build-secrets-browser.cjs`')
    process.exit(1)
  }
  console.log('ok: browser secrets copies are up to date')
  process.exit(0)
}

fs.writeFileSync(OUT, esmOut)
console.log(`wrote ${path.relative(ROOT, OUT)} (${esmOut.length} bytes)`)

if (fs.existsSync(HTML)) {
  const htmlSrc = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
  let newHtml
  if (htmlSrc.includes(startTag) && htmlSrc.includes(endTag)) {
    const pre = htmlSrc.slice(0, htmlSrc.indexOf(startTag))
    const post = htmlSrc.slice(htmlSrc.indexOf(endTag) + endTag.length)
    newHtml = pre + injection + post
  } else {
    const marker = '<script type="module">'
    const idx = htmlSrc.indexOf(marker)
    if (idx !== -1) {
      newHtml = htmlSrc.slice(0, idx + marker.length) + '\n' + injection + '\n' + htmlSrc.slice(idx + marker.length)
    } else {
      throw new Error('Could not find <script type="module"> in public/control.html')
    }
  }
  fs.writeFileSync(HTML, newHtml)
  console.log(`updated ${path.relative(ROOT, HTML)} with injected secrets gate`)
}
