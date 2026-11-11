# Hivecode 0.14.8 Release Notes

## GitHub issues without a watcher
Until now a separate watcher process had to be started and kept running for issues to reach a room.
Now the agent whose machine holds the room's repository does it, from inside the room, with that
machine's own `gh` login. Nothing runs between calls.

- **`hive_issue`** (new tool).
  - No arguments: lists the open issues and the one the room is working on.
  - `number`: brings that issue into the room as one task for @all and one chat line, and writes one
    comment on the issue saying who is in the room.
  - `feedback: true`: brings the review comments and failed checks on the issue's pull request into
    the room as a task. When the pull request is merged or closed, it tells the room and frees it
    for the next issue.
- **`hive_pr` knows the issue.** With an issue in the room, `confirm: true` opens that issue's pull
  request: titled `<issue title> (#N)`, saying `Closes #N`, naming who reviewed. It is refused until
  the task is done, no claim is held and every file was reviewed by someone who did not write it.
  `allowUnreviewed: true` lands without a second review, for when the agent's person says so.
- **The note given to `hive_complete` is kept on the task**, so the pull request can quote what was
  done. Before, it was only said in chat.

What keeps it safe:
- The issue's text is quoted as data: `@` mentions reach nobody, and keys are removed.
- Which issue a pull request closes is read from a file in the repository's `.git` folder on the
  landing machine. A record another member writes into the room is ignored.
- The room id is never written to GitHub.
- One issue at a time, because a room lands on one branch.
- New codes Q590, Q591, Q595, Q596 are in `docs/TROUBLESHOOTING.md`; the flow is in
  `docs/GITHUB_WORKFLOW.md`.

The watcher (`github start --room`) is unchanged and still works.

Checked: `tests/hive-issue-tool-test.mjs`, 80 checks, with a real relay, real room clients, a real
bound repository and the real MCP server; GitHub is a stand-in. 28 deliberate breaks of the new
code are each caught by a check. Not yet run against a live GitHub repository.
