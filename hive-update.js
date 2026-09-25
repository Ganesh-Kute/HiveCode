// hive-update.js -- tells an agent, and through it its human, that a newer hivecode is out.
//
// WHY THIS EXISTS. `npx -y hivecode-mcp@latest setup` points agent apps at a runtime COPY
// (~/.hivecode/runtime/<version>), which is what made starting fast, offline and free of npx.
// It also means nothing updates any more: every start used to fetch @latest, and now an agent
// stays on the version it was set up with until someone runs setup again. A room with mixed
// builds is the one condition hive_join itself warns can lose data, so the gap must be visible.
//
// IT NEVER GETS IN THE WAY. The check starts with the server, carries a short timeout, and
// hive_join and hive_status use whatever answer has arrived by then. A failed check says
// nothing -- no network is not news. HIVE_PRIVATE=1 and HIVE_NO_UPDATE_CHECK=1 both switch it
// off: a user who asked for privacy did not ask for a request to npm on every start.
import { VERSION } from './hive-version.js'

const REGISTRY_LATEST = 'https://registry.npmjs.org/hivecode-mcp/latest'

/** True when version `a` is newer than `b` (x.y.z; anything unparseable is never "newer"). */
export function newer(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => Number(n))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x !== y) return x > y
  }
  return false
}

let latest = null
let started = false

export function startUpdateCheck({ fetchImpl = globalThis.fetch, timeoutMs = 4000, env = process.env } = {}) {
  if (started) return
  started = true
  if (env.HIVE_NO_UPDATE_CHECK === '1' || env.HIVE_PRIVATE === '1' || typeof fetchImpl !== 'function') return
  Promise.resolve()
    // HIVE_UPDATE_URL exists for tests/update-notice-test.mjs, which serves a fake registry so the
    // wiring is proven end to end through a real server process.
    .then(() => fetchImpl(env.HIVE_UPDATE_URL || REGISTRY_LATEST, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } }))
    .then((r) => (r && r.ok ? r.json() : null))
    .then((j) => { if (j && typeof j.version === 'string') latest = j.version })
    .catch(() => { /* offline, blocked, or slow: say nothing */ })
}

/** The line to show, or '' when this agent is current (or nobody knows yet). */
export function updateNotice(current = VERSION, known = latest) {
  if (!known || !newer(known, current)) return ''
  return `UPDATE AVAILABLE: hivecode ${known} is out; this agent runs ${current}. Tell your human to run ` +
    '`npx -y hivecode-mcp@latest setup` and reload this agent. Mixed versions in one room can lose data.'
}

export const _test = {
  reset() { latest = null; started = false },
  setLatest(v) { latest = v; started = true },
  latest: () => latest,
}
