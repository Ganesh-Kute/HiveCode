# Hivecode 0.14.7 Release Notes

## A finished issue that lands nothing now says so
When every file of a finished GitHub issue was written by a client that signs nothing, the landing
had nothing it could commit. It opened no pull request and pushed nothing, and the room was still
told `issue #N landed as PR #undefined`. The watcher then counted the issue as finished and never
tried again.

- **Q588: a done task whose only changes are unsigned is refused.** The refusal names the files and
  says how to fix them: put the branch's version back, then make the change again from a client
  that signs (`HIVE_PROVENANCE=on`). The issue stays open in the room and is tried again.
- **Q589: a landing that opened no pull request is a failure.** It is never reported as landed, in
  the landing step or in the watcher's message to the room.
- Files left out of a pull request because they carry no signed receipt are returned by the
  readiness check, so the caller can see them.

Both codes are in `docs/TROUBLESHOOTING.md`.

Checked: the new tests fail on 0.14.6 and pass here, and twelve deliberate breaks of the fix are
each caught by a test.
