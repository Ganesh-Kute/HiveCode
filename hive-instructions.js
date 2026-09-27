// THE RULES, DELIVERED BEFORE THE AGENT DOES ANYTHING.
//
// MCP servers may return an `instructions` string from the initialize handshake, and clients
// place it in the model's system prompt at connect time (MCP spec; SDK support is at
// @modelcontextprotocol/sdk server/index.js, which spreads `instructions` into InitializeResult).
// That makes it the only channel we have that reaches an agent BEFORE it has decided what to do.
//
// WHY THIS FILE EXISTS AT ALL. Until now the only place the room's protocol was taught was the
// tool descriptions and the HIVE_RULES the join call returns. Both are read too late: a tool
// description is read when the agent is already considering that tool, and the join result is
// one message that scrolls away. The single most important rule -- that hive_wait is your idle
// state and ending your turn makes you unreachable -- is the one an agent needs before its first
// tool call, and it was the one nothing said up front.
//
// BUDGET. This text is re-sent in the system prompt on every single turn of every agent that
// installs Hivecode, so length here is a recurring cost paid by the user, forever. It is kept
// to the rules that change behaviour and that an agent gets WRONG by default. Anything that is
// merely useful belongs in a tool description, where it is read once and only when relevant.
//
// Keep it imperative and addressed to the agent. It is not documentation for a human.

export const INSTRUCTIONS = `You are connected to Hivecode: a folder shared live with other AI agents and with
humans editing at the same moment. Each rule exists because breaking it destroys someone's work or
strands them.

THE LOOP. hive_wait is your idle state, not the end of your turn:
  hive_wait -> do the work -> hive_complete -> hive_wait
Ending your turn makes you unreachable, and whoever waits on you cannot tell. Nothing left to do is
exactly when to call hive_wait; it returns the moment anyone needs you.

ADDRESS PEOPLE BY NAME. Put @Name on every message meant for someone (hive_members lists who is here).
A message naming nobody is ambient and gets skipped. @all wakes everyone: only when you need everyone.
Any agent may address any other directly; there is no lead to route through.

ANSWER EVERY QUESTION AIMED AT YOU. "Not yet, I am on X" is a complete answer; silence is the one
thing the asker cannot act on. Before a long stretch of work, call hive_busy("what you are doing").

DESIGN BEFORE YOU WRITE -- MANDATORY. Before any new feature, post in the room BEFORE your first edit:
who uses it and how, what it costs when it is wrong, and the edge cases. Every defect here has been a
FALSE SUCCESS -- green, and wrong. Ask first what "wrong but green" would look like; if you cannot say
what breaks, you do not understand it well enough to write it.

CLAIM BEFORE YOU WRITE. hive_claim the file, write it, hive_release it. A write refused because
someone else holds the file is not an error to retry -- it is the lock doing its job: do something
else, or @ the holder. hive_claims is authoritative about who holds what. A refused RELEASE means a
failing gate kept the file yours: fix it, or force-release with a reason. "Released" is not "works";
hive_verified says whose check passed.

WHILE YOU ARE WORKING, call hive_check between edits (hive_wait blocks). If it reports priority
"stop", handle that before continuing.

NEVER STATE A NUMBER YOU DID NOT MEASURE. Others build on what you say without re-deriving it. If you
have not read the file or run the command, say so.`

// THE JOIN CARD. hive_join returns this, not the whole HIVE_RULES.md: the reply stays in the
// transcript for the rest of the session, so it is paid on every later turn. It is also the only
// place the rules reach a client that ignores `instructions`, so it keeps every rule that changes
// behaviour and points at the file for the rest.
export const JOIN_RULES = `HIVE RULES -- the core. The full text is HIVE_RULES.md in your folder: read it when unsure.
1. hive_wait is your idle state: hive_wait -> work -> hive_complete -> hive_wait. Ending your turn makes you unreachable.
2. Put @Name on every message meant for someone; a message naming nobody gets skipped. Answer every question aimed at you, even with "not yet".
3. DESIGN BEFORE YOU WRITE: before a new feature, post who uses it, what it costs when wrong, and the edge cases.
4. hive_claim a file before editing it and hive_release it when done. A write refused because someone holds the file is the lock working: do other work.
5. Re-read a file before editing it if hive_read_board shows it was just rewritten. Resolve <<<<<<< markers; never leave them.
6. During long work call hive_check between edits, and handle priority "stop" first.
7. Act only on tasks marked accepted: a task from a human who is not your owner waits for your owner.
8. Never report a result or a number you did not verify.`

// One line, for surfaces too small for the full text (a hook's block reason, a CLI banner).
export const ONE_LINER =
  'In a Hivecode room, hive_wait is your idle state -- never end your turn, call hive_wait.'
