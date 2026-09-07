#!/usr/bin/env node
/**
 * THE ANTI-IDLE GATE.
 *
 * A rule an agent is told to follow is advice. This is the same rule as a lock.
 *
 * THE PROBLEM. hive_wait exists so an agent never goes unreachable: block until someone needs
 * you, do the work, block again. It is in the tool description and it is now in the system
 * prompt (hive-instructions.js). Both are still instructions, and an agent that decides it is
 * finished simply emits a final answer instead of another tool call. Its process is alive, its
 * socket is up, and it is deaf. Everyone waiting on it waits forever, and nothing tells them.
 *
 * You cannot fix that with better wording, for the same reason a claim board that only warns
 * does not stop a write: it is enforcement or it is a suggestion.
 *
 * WHAT THIS IS. A Claude Code `Stop` hook. Claude Code runs it when the main agent is about to
 * end its turn. Returning {"decision":"block","reason":...} makes Claude Code refuse to stop and
 * feed `reason` back as the next input. The agent does not get a vote. So an agent that tries to
 * go idle while it has unread mail or unfinished accepted work is simply not allowed to.
 *
 * WHY IT READS DISK AND NOT THE RELAY. This runs on every turn boundary and has a hard timeout.
 * A network round trip inside that budget would make the hook the least reliable thing in the
 * session. It does not need one: the sync client already mirrors the room to HIVE_CHAT.md and
 * HIVE_TASKS.md on local disk. Reading those is microseconds, works with the relay unreachable,
 * and cannot itself desync the room because it only ever reads.
 *
 * IT BLOCKS ON THREE THINGS, and the middle one is the subtle one:
 *
 *   - unread mail addressed to you
 *   - a question you DID read and never answered ("read" is not "answered": the cursor advances
 *     the moment a message is handed over, so an agent can absorb a direct question mid-work and
 *     end its turn having left someone hanging, with nothing unread to block on)
 *   - an accepted task still open
 *
 * FOUR GUARDS AGAINST TRAPPING THE AGENT IN A LOOP. A hook that blocks forever is worse than
 * no hook -- it burns the user's tokens and they cannot get their agent back:
 *
 *   1. stop_hook_active. Claude Code sets this when the stop it is asking about is ALREADY the
 *      result of a previous block. We always allow then, so a block is never immediately
 *      re-applied on top of itself.
 *   2. The watermark advances even when we block. A given message can cause exactly one block,
 *      ever. If the agent ignores it, that is the human's problem to see, not ours to enforce.
 *   3. `nudged` -- the same one-block-per-message rule extended across BOTH reasons, so a
 *      message cannot charge once as unread mail and again as an unanswered question. Keyed on
 *      sender+timestamp, so a genuinely new question still gets its own single nudge.
 *   4. MAX_TASK_BLOCKS. Unlike a message, an open task stays open, so it would re-block on every
 *      turn until completed -- including when it CANNOT be completed. After a few consecutive
 *      task-only blocks we stand down and let the agent stop.
 *
 * Any failure at all -- no session, unreadable file, malformed JSON, unexpected shape -- exits 0
 * and allows the stop. The hook may make an agent more reliable; it must never make a session
 * unusable.
 *
 * Install with:  npx hivecode-hook install
 */
import fs from 'fs'
import path from 'path'
import { mentionsName, unansweredFor } from './hive-mailbox.js'

// Consecutive turns we will block purely because a task is still open, before standing down.
// Messages are not subject to this: the watermark already makes each one block at most once.
const MAX_TASK_BLOCKS = 3

const SESSION_FILE = '.hive-mcp-session.json'  // written by hive-mcp.js on join
const STATE_FILE = '.hive-stop-hook.json'      // ours: watermark, task blocks, questions already nudged

// A chat line: "- 19:07:27  Eve (ai): text". Anything else is a continuation of the message
// above it (messages may contain newlines) or a header comment.
const CHAT_LINE = /^- (\d{2}:\d{2}:\d{2})\s+(.+?) \((human|ai|system)\): ([\s\S]*)$/
// A task line: "- [accepted] tmtofacav4mf  Ganesh -> PM: do the thing  (by Ganesh)"
const TASK_LINE = /^- \[(\w+)\]\s+(\S+)\s+(.+?) -> (.+?): ([\s\S]*)$/

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** Fold continuation lines into their message so a multi-line post counts once. */
export function parseChat(src) {
  const out = []
  for (const line of String(src || '').split(/\r?\n/)) {
    const m = CHAT_LINE.exec(line)
    if (m) out.push({ at: m[1], by: m[2], kind: m[3], text: m[4] })
    else if (out.length && line.trim() && !line.startsWith('#')) out[out.length - 1].text += '\n' + line
  }
  return out
}

/** Accepted tasks pointed at `me` that nobody has marked done. */
export function openTasksFor(src, me) {
  const out = []
  for (const line of String(src || '').split(/\r?\n/)) {
    const m = TASK_LINE.exec(line)
    // `done` and `completed` both appear in the wild depending on how the task was closed;
    // anything that is not explicitly accepted-and-open is not work we should block on.
    if (m && m[1] === 'accepted' && m[4].trim().toLowerCase() === String(me).toLowerCase()) {
      out.push({ id: m[2], from: m[3], text: m[5] })
    }
  }
  return out
}

/**
 * The whole decision, as a pure function of what is on disk, so the test can drive it without a
 * Claude Code session, a relay, or a room.
 *
 * Returns { block: boolean, reason?: string, seen: number, taskBlocks: number }.
 */
export function decide({ chat, tasks, me, seen, taskBlocks, nudged = [] }) {
  const msgs = parseChat(chat)
  const nowSeen = msgs.length
  // A cursor past the end means this is a different (rebuilt or switched) room -- start over
  // rather than treating the whole history as unread and blocking on all of it.
  const from = seen > nowSeen ? 0 : seen
  const fresh = msgs.slice(from)

  const mail = fresh.filter((m) =>
    m.kind !== 'system' &&
    String(m.by).toLowerCase() !== String(me).toLowerCase() &&  // never block on our own post
    mentionsName(m.text, me))

  if (mail.length) {
    const quoted = mail.slice(0, 5).map((m) => `  ${m.by}: ${m.text.replace(/\s+/g, ' ').slice(0, 220)}`)
    const more = mail.length > 5 ? `\n  ... and ${mail.length - 5} more` : ''
    return {
      block: true, seen: nowSeen, taskBlocks: 0,
      // Blocking here also spends this message's ONE nudge, so the debt branch below cannot
      // charge for the same message a second time. One block per message, whatever the reason.
      nudged: [...nudged, ...mail.map((m) => m.by + '|' + m.at)].slice(-200),
      reason: `You are in a Hivecode room and ${mail.length} message${mail.length > 1 ? 's' : ''} ` +
        `addressed to you arrived while you were working:\n\n${quoted.join('\n')}${more}\n\n` +
        `Do not stop -- they are waiting on a reply from you. Answer with hive_say (put @Name on ` +
        `it), then go back to hive_wait. hive_wait is your idle state; ending your turn makes you ` +
        `unreachable and nobody in the room finds out.`,
    }
  }

  // A DEBT IS NOT THE SAME AS UNREAD MAIL, and this is the gap the watermark alone leaves. The
  // cursor advances the instant a message is handed over, so an agent can read a direct
  // question, get absorbed in the work, and end its turn having left someone hanging -- with
  // nothing unread and nothing to block on. The person waiting has no way to find that out.
  //
  // ONE NUDGE PER QUESTION, EVER -- the same rule mail already follows, and it has to be the
  // same rule. A debt survives until it is answered, so anything weaker than remembering which
  // ones we already raised means the identical question blocks turn after turn, and a gate that
  // nags is a gate the user switches off. Keyed on sender+timestamp rather than on sender, so a
  // NEW question from someone we have already nudged about still gets its own one nudge.
  const owed = unansweredFor(msgs, me)
  const unnudged = owed.filter((o) => !nudged.includes(o.from + '|' + o.at))
  if (unnudged.length) {
    const quoted = unnudged.slice(0, 3).map((o) => `  ${o.from}: ${o.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    return {
      block: true, seen: nowSeen, taskBlocks,
      // Recorded BEFORE returning, exactly as the watermark is, so a question cannot block a
      // second time even if whatever happens next goes wrong. Capped so the state file cannot
      // grow without bound in a long-lived room.
      nudged: [...nudged, ...unnudged.map((o) => o.from + '|' + o.at)].slice(-200),
      reason: `You are in a Hivecode room and ${unnudged.length} participant${unnudged.length > 1 ? 's are' : ' is'} ` +
        `still waiting on a reply from you:\n\n${quoted.join('\n')}\n\n` +
        `Answer with hive_say and name them. "Not yet — I am on X, I will come back to you" is a ` +
        `complete answer; silence is the one thing they cannot act on, and nothing tells them you ` +
        `stopped. Then call hive_wait.`,
    }
  }

  const open = openTasksFor(tasks, me)
  if (open.length && taskBlocks < MAX_TASK_BLOCKS) {
    const quoted = open.slice(0, 3).map((t) => `  [${t.id}] from ${t.from}: ${t.text.replace(/\s+/g, ' ').slice(0, 220)}`)
    return {
      block: true, seen: nowSeen, taskBlocks: taskBlocks + 1, nudged,
      reason: `You are in a Hivecode room with ${open.length} accepted task${open.length > 1 ? 's' : ''} ` +
        `still open:\n\n${quoted.join('\n')}\n\n` +
        `Finish the work and call hive_complete with the task id, or say why you are blocked with ` +
        `hive_say (@ the person who assigned it). Then call hive_wait. If you genuinely cannot ` +
        `proceed, say so in the room first -- do not just stop, nobody would learn that you had.`,
    }
  }

  // Standing down on something we have already blocked on MAX_TASK_BLOCKS times is not the same
  // as it being resolved, so hold the counter rather than resetting it while it is still there.
  // Debts and tasks share the counter deliberately: they are the same kind of obligation, and
  // two separate counters would let an agent be pinned for 2x MAX_TASK_BLOCKS turns.
  return { block: false, seen: nowSeen, taskBlocks: open.length ? taskBlocks : 0, nudged }
}

/** Walk up from `start` looking for the session file; the hook's cwd is usually but not always
 *  the folder the MCP server was launched in. */
function findSession(start) {
  let dir = path.resolve(start)
  for (let i = 0; i < 4; i++) {
    const p = path.join(dir, SESSION_FILE)
    if (fs.existsSync(p)) return { root: dir, session: readJson(p) }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const hook = (() => { try { return JSON.parse(input) } catch { return {} } })()

  // GUARD 1: this stop is already the product of a block. Never stack another on it.
  if (hook.stop_hook_active) return

  const found = findSession(hook.cwd || process.cwd())
  if (!found || !found.session || !found.session.dir || !found.session.name) return // not in a room

  const { root, session } = found
  const dir = path.isAbsolute(session.dir) ? session.dir : path.join(root, session.dir)
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' } }

  const chat = read('HIVE_CHAT.md')
  if (!chat) return // room folder not mirrored yet; nothing to be sure about, so allow

  const statePath = path.join(root, STATE_FILE)
  const prev = readJson(statePath) || {}
  // Keyed by room: a folder rejoined against a different room must not inherit a watermark from
  // unrelated history -- the same reasoning as the persisted sync ancestor being room-keyed.
  const key = String(session.room || session.dir)
  const st = prev[key] || { seen: 0, taskBlocks: 0, nudged: [] }

  const d = decide({
    chat, tasks: read('HIVE_TASKS.md'), me: session.name,
    seen: Number(st.seen) || 0, taskBlocks: Number(st.taskBlocks) || 0,
    nudged: Array.isArray(st.nudged) ? st.nudged : [],
  })

  // GUARD 2: write the watermark BEFORE returning the block, so this message can never block a
  // second time even if what happens next goes wrong.
  try {
    prev[key] = { seen: d.seen, taskBlocks: d.taskBlocks, nudged: d.nudged || [], at: Date.now() }
    fs.writeFileSync(statePath, JSON.stringify(prev, null, 2))
  } catch { /* a watermark we cannot persist is a reason to allow, never to fail */ }

  if (d.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }))
}

// Only run when executed as the hook, so the test can import decide()/parseChat() cleanly.
if (process.argv[1] && /hive-stop-hook\.js$/.test(process.argv[1])) {
  main().catch(() => { }).finally(() => process.exit(0))
}
