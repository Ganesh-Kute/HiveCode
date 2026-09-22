// hive-version.js — one place that knows what build this is.
//
// WHY THIS FILE EXISTS, and it is not tidiness.
//
// VERSION is load-bearing, not cosmetic. hive_join instructs every arriving agent to announce its
// version in chat, because two clients running different builds in one room corrupt each other's
// files with no error on either side — both writes succeed, both are green, and the disagreement
// surfaces only as lost bytes. That announcement is the ONLY channel that makes a mixed build
// visible from inside the room. So a version string is not a label; it is the input to the one
// detector we have.
//
// On 20 Sep 2026 three entry points were found reporting a version package.json does not contain:
// remote-mcp.js said '0.11.5' while live on the hosted relay, hive-mcp-http.js and hive-linear.js
// both said '1.0.0'. hive-mcp.js had already been fixed months earlier, with a comment explaining
// exactly why hardcoding it is dangerous — and that fix was never carried to the other three.
// A detector that lies is strictly worse than no detector, because it is trusted.
//
// HIV-P7 closed that by giving each of the four files its own runtime read. Which produced the
// next defect, and it was measured rather than predicted: with the reader duplicated four times,
// corrupting ONE copy's fallback string to '9.9.9-DRIFTED' left tests/version-truth-test.mjs at
// 16 passed, 0 failed. The property guards the version that gets REPORTED and says nothing about
// the mechanism that produces it, so three of four copies could rot in silence.
//
// This codebase has watched that happen before. The extension's reconcile() and the engine's were
// the same function once; they now share 34 lines and behave differently. Eight lines is not too
// small to drift — it is exactly small enough that nobody feels the need to check.
//
// So the fix is DELETION, not another assertion. One definition, imported by all four. The
// property becomes true by construction instead of by policing, and a fifth entry point written
// next year gets it right by importing rather than by remembering.
//
// TWO DECISIONS WORTH KEEPING:
//
// It READS package.json rather than being told. package.json always ships beside these files —
// in the repo and in the published tarball — so `new URL('./package.json', import.meta.url)`
// resolves in both. Anything else (a constant, a build step, a generated file) can disagree with
// the package the moment `npm version` runs, which is precisely the failure being fixed.
//
// IT NEVER THROWS. A version read is not worth a server that will not boot, and a server that
// refuses to start is a worse outcome than one that says it does not know which build it is. So
// an unreadable or malformed package.json yields '0.0.0-unknown' — a value that is obviously
// wrong to a human, will never match a real release, and cannot be mistaken for a true answer.
// Silence or an empty string could be read as "no mixed build here"; this cannot.

import fs from 'fs'

/** Recomputed never: a running process cannot change which build it is. */
export const VERSION = (() => {
  try {
    const v = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
    if (typeof v === 'string' && v) return v
  } catch { /* fall through — see IT NEVER THROWS above */ }
  return '0.0.0-unknown'
})()

/** The sentinel, exported so callers and tests can name it instead of retyping the literal. */
export const UNKNOWN_VERSION = '0.0.0-unknown'

export default VERSION
