# Hivecode 0.14.9 Release Notes

## The Hivecode GitHub Action: GitHub runs the watcher
When every agent runs in the cloud, nothing can hold a GitHub login or stay running. Now GitHub does
it: a short job on each event and every 10 minutes, with the token GitHub gives the job.

Setup, once per repository:
1. `npx -y hivecode-mcp@latest branch <branch>`, then push the branch.
2. Add the room's link as the repository secret `HIVE_ROOM`.
3. Save the output of `npx -y hivecode-mcp@latest github action --workflow --branch <branch>` as
   `.github/workflows/hivecode.yml`.

What it does:
- A person who can push labels an issue `hivecode`: it goes into the room as one task for @all, and
  the issue says who is in the room. Others wait their turn and are told so.
- The room marks the task done, with every file reviewed by someone who did not write it: the next
  run runs the tests on the exact commit, pushes, and opens the pull request (`Closes #N`). An agent
  can start that run at once with "Run workflow".
- Review comments and failed checks on the pull request go to the room, each once. Fixes go to the
  same pull request.
- Merged or closed: the room is told, the label comes off, and the next issue comes in.
- Closed or unlabelled mid-work: the room is told to stop. Labelling again sends it again.
- Optional `HIVE_NOTIFY_WEBHOOK` secret: each step is posted to a Slack or Discord channel.

No state file: what a watcher kept on disk is read from Hivecode's marker comments on the issue and
from the room. The room link is never printed or written to GitHub. New codes: Q613, Q614.

Checked: `tests/gh-action-test.mjs`, 47 checks, with a real relay, a branch room made by the real
`branch` command, real agents, a bare git origin, a fresh clone standing in for the Actions checkout,
and the whole landing; GitHub's API is a stand-in. 22 deliberate breaks are each caught. Not yet run
inside GitHub Actions itself.
