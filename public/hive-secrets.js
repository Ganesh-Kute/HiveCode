// AUTO-GENERATED from hive-secrets.js by scripts/build-secrets-browser.cjs — do not edit by hand.
// Run `node scripts/build-secrets-browser.cjs` after changing hive-secrets.js.
// tests/control-room-walk.mjs fails if this file is stale.

// LIVE CREDENTIALS ARE NOT SENT TO THE ROOM (3 Oct 2026).
//
// A file in a room goes to the relay and to every participant's disk. ALWAYS_IGNORE keeps the
// files that are secrets by NAME at home (.env, *.pem, id_rsa, ...), but a secret inside an
// ordinary file went out with it: an agent that pastes an API key into config.js to try
// something shares that key with everyone in the room, and with whoever runs the relay.
//
// So a file whose content holds a credential the room does not already have is held on this
// machine (see sync.js, withheld) until the credential is moved out. Only formats a provider
// stamps on its keys are matched -- a fixed prefix plus enough random characters -- and private
// key blocks. Nothing here guesses from entropy alone: a false match holds back real work, and
// the people who hit it would be right to switch this off.
//
// The matched value never leaves this module's callers in any form: not in a log line, not in
// the room, not in status. Only its kind and its line number do.

const PATTERNS = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,100})\b/g },
  { kind: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[0-9]{6,}-[0-9A-Za-z-]{10,}/g },
  { kind: 'Slack webhook', re: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g },
  { kind: 'Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/g },
  { kind: 'Anthropic API key', re: /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{60,}/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,40}\b/g },
  { kind: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{40,60}\b/g },
  { kind: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { kind: 'DigitalOcean token', re: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  // .npmrc and friends: a registry password or token written out literally. `${NPM_TOKEN}` is the
  // documented way to keep one out of the file, so a reference to the environment is not a secret.
  { kind: 'registry credential', re: /(?:^|\n)[ \t]*(?:\/\/[^\s=]+:)?_(?:authToken|auth|password)[ \t]*=[ \t]*(?!\$\{)[^\s'"]{8,}/g },
]

// Documentation and tests are full of keys that look real and are not: AWS's own example id,
// and placeholders like sk_live_XXXXXXXXXXXXXXXXXXXXXXXX. A provider's key is random, so a match
// with few distinct characters, or that says it is an example, is a placeholder.
const PLACEHOLDER = /EXAMPLE|example|XXXX|xxxx|0{8}|1234567890|your[_-]?(?:key|token|secret)/i
function placeholder(value, kind) {
  if (kind === 'private key' || kind === 'registry credential') return false
  if (PLACEHOLDER.test(value)) return true
  return new Set(value).size < 10
}

// A SIGNED ACCESS TOKEN -- a JWT, which is what Hivecode's own room tokens are -- is a person: whoever
// holds it joins as them, with their access. It is kept out of the room's chat and tasks
// ({ tokens: true }). It is NOT a reason to hold a FILE back: auth code and its tests are full of
// sample tokens, most of them expired or fake, and holding each such file would stop real work.
const TOKEN_PATTERNS = [
  { kind: 'access token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
]

/** Every credential in `text`: [{ kind, line, value }]. `value` is for comparing, never for showing.
 *  `tokens: true` adds signed access tokens, for what goes into the room's chat and tasks. */
function findSecrets(text, { tokens = false } = {}) {
  const s = String(text || '')
  if (!s) return []
  const out = []
  for (const { kind, re } of tokens ? [...PATTERNS, ...TOKEN_PATTERNS] : PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      const value = m[0].replace(/^\s+/, '')
      if (!placeholder(value, kind)) {
        const at = m.index + (m[0].length - m[0].replace(/^\s+/, '').length)
        out.push({ kind, line: s.slice(0, at).split('\n').length, value })
      }
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/** Credentials in `local` that `shared` does not already contain: what sharing `local` would leak. */
function newSecrets(local, shared) {
  const found = findSecrets(local)
  if (!found.length) return []
  const room = String(shared || '')
  return found.filter((f) => !room.includes(f.value))
}

/** "an OpenAI API key (line 12)" -- the only form a finding is ever shown in. */
function describeSecret(f) {
  if (!f) return ''
  const a = /^(?:[aeiou]|npm\b)/i.test(f.kind) ? 'an' : 'a'
  return `${a} ${f.kind} (line ${f.line})`
}


function envForKind(kind) {
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
    case 'access token': return 'HIVE_TOKEN'
    default: return 'TOKEN'
  }
}

function secretRefusalNotice(f) {
  if (!f) return ''
  const a = /^(?:[aeiou]|npm\b)/i.test(f.kind) ? 'an' : 'a'
  if (f.kind === 'access token') {
    return 'Not sent: this message contains an access token. A token is a person, and whoever holds it joins as them. Whoever needs access gets a token of their own (hivecode-token).'
  }
  const env = envForKind(f.kind)
  return `Not sent: this message contains ${a} ${f.kind}. Keys never go in the room; say where it is kept (e.g. ${env} in .env).`
}

export { PATTERNS, TOKEN_PATTERNS, PLACEHOLDER, placeholder, findSecrets, newSecrets, describeSecret, envForKind, secretRefusalNotice }
