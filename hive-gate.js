// hive-gate — a handoff that cannot complete while your own check is failing.
//
// THE PROBLEM THIS EXISTS FOR. Claims stop two agents writing the same file. They say nothing
// about whether what you wrote is CORRECT, so the honest description of the room until now was:
// agent A writes something wrong, releases it, agent B picks it up and builds on it, and the lock
// made the corruption orderly rather than absent. Ganesh put it exactly right -- "one agent makes
// a mistake and writes wrong code, others build upon it and it gets worse".
//
// The answer is the same move that solved collisions, applied one layer up. Collisions were not
// solved by asking agents to coordinate; the transport refuses the second write. Correctness is
// not solved by asking agents to check each other's work either. The transport refuses the
// HANDOFF: release runs the room's check, and a failing check means the claim stays yours.
//
// WHAT THIS HONESTLY DOES AND DOES NOT DO. It does not stop the bad content existing in other
// folders -- the CRDT syncs continuously, so the bytes are already everywhere the moment they are
// written, and nothing short of abandoning live sync changes that. What it stops is the SILENT
// HANDOFF: "I am done, it is yours." The file stays visibly held, by a named agent, with a
// recorded reason. Anyone who reaches for it is told who is holding it and that their check
// failed, rather than quietly inheriting a broken file that looked finished.
//
// AND THE RULE THAT SHAPES THE WHOLE DESIGN. @Claude-Engine caught a real bug in the path-state
// registry: `path:engine/brain/llm.js = POISONED` was FALSE in its folder, where that path held
// the correct file while another folder held a wreck. Marking it globally broadcast ONE FOLDER'S
// REALITY as room truth. A gate result is exactly that kind of fact -- I ran the tests in MY
// folder, on MY copy -- so it is recorded PER AGENT, keyed by name the way hive_attest is, and it
// never sets a global path flag. Two agents disagreeing about whether a file passes stays visible
// as a disagreement instead of converging on whoever wrote last.

import { spawnSync } from 'child_process'

export const GATE_CMD = 'gate:cmd'          // the room's check, in shared state
export const GATE_TIMEOUT = 'gate:timeout'  // ms; a hung test suite must not wedge the room
export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_OUTPUT = 4000              // what we keep of the output, for the record

/**
 * The room's gate, read from shared state. `get` is any (key) => value — the swarm_state map, or
 * a plain object in tests.
 *
 * Returns null when no gate is configured, which means release behaves exactly as it always has.
 * That is deliberate: a room that has not opted in is not silently given a new failure mode.
 */
export function gateConfig(get) {
  const read = typeof get === 'function' ? get : (k) => get[k]
  const cmd = read(GATE_CMD)
  if (cmd == null || String(cmd).trim() === '') return null
  const raw = Number(read(GATE_TIMEOUT))
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600000) : DEFAULT_TIMEOUT_MS
  return { cmd: String(cmd), timeoutMs }
}

/** Trim command output to something that belongs in a CRDT, keeping the END — that is where a
 *  test runner puts the failures. Keeping the head would record the banner and drop the reason. */
export function trimOutput(s, max = MAX_OUTPUT) {
  const t = String(s == null ? '' : s).replace(/\r\n/g, '\n').trim()
  if (t.length <= max) return t
  return '…(' + (t.length - max) + ' chars trimmed)\n' + t.slice(-max)
}

/**
 * Run the check in a folder. Exit code 0 is a pass; anything else, including the command not
 * existing, is a fail.
 *
 * A command that cannot be RUN is a failure and not a pass. Treating "spawn failed" as success
 * would mean a typo in the gate silently disables it for the whole room, which is the worst
 * outcome available here: everyone would believe they were gated and nobody would be.
 */
export function runGate({ cmd, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, run = spawnSync, env = {} }) {
  const started = Date.now()
  let r
  // Isolated test port per gate run so concurrent gates on the same machine never collide over fixed ports (HIV-24).
  const isolatedPort = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 10000) + Math.floor(Math.random() * 10000))
  const gateEnv = {
    ...process.env,
    HIVE_TEST_PORT: String(isolatedPort),
    ...env,
  }
  try {
    r = run(cmd, {
      cwd, shell: true, encoding: 'utf8', timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: gateEnv,
    })
  } catch (e) {
    return { ok: false, code: null, timedOut: false, ms: Date.now() - started, out: trimOutput('could not run the gate: ' + e.message) }
  }
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(r.error.message || ''))
  const out = trimOutput([r.stdout, r.stderr].filter(Boolean).join('\n') || (r.error ? r.error.message : ''))
  return {
    ok: !r.error && r.status === 0,
    code: r.status == null ? null : r.status,
    timedOut: !!timedOut,
    ms: Date.now() - started,
    out,
  }
}

/** The record stored under this agent's name. Timestamps are unix MICROseconds, per project rule. */
export function verdictRecord({ region, by, cmd, result, forced = false, why = '' }) {
  return {
    region, by, cmd,
    pass: !!(result && result.ok),
    exit: result ? result.code : null,
    timedOut: !!(result && result.timedOut),
    ms: result ? result.ms : 0,
    out: result ? result.out : '',
    forced: !!forced,
    why: String(why || ''),
    at: Date.now() * 1000,
  }
}

/**
 * What the releasing agent is told. It has to say the three things an agent needs to act, because
 * a refusal that does not say what to do next just gets retried: what failed, that the claim is
 * still theirs (so this is not a collision to back off from), and the one honest way out.
 */
export function refusalMessage({ region, cmd, result }) {
  const why = result.timedOut
    ? `Q491 the gate timed out after ${Math.round(result.ms / 1000)}s`
    : result.code == null
      ? 'Q490 the gate could not be run'
      : `Q490 the gate failed (exit ${result.code})`
  return [
    `${why}: \`${cmd}\``,
    `${region} is STILL YOURS — nobody else can take it, so this is not a collision and retrying the release will not help.`,
    'Fix what the gate is reporting and release again, or release with force and a reason if you are abandoning the work.',
    result.out ? '\n' + result.out : '',
  ].join('\n')
}

/** A forced release is legitimate — abandoning work is real — but it is never silent. */
export function forcedMessage({ region, by, why }) {
  return `Q492 ${by} force-released ${region} without passing the gate${why ? `: ${why}` : ' (no reason given)'}`
}
