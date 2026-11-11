# Hivecode 0.14.10 Release Notes

## Fixes from the first live run of the Hivecode GitHub Action
- **The Action could not open a pull request.** The landing checks its GitHub login by reading
  `/user`, and the token GitHub gives a job is refused there (HTTP 403, "Resource not accessible
  by integration"). So every landing from the Action failed with Q578. The Action now lands with the
  job's own token and skips that check, because there is no person's login to check.
- **A pull request someone else opened on the room's branch is linked to the issue.** For example,
  an agent ran `hive_pr`. The Action puts `Closes #N` at the top of its body and tells the issue,
  the room and Slack. From then on it is that issue's pull request: no second one is opened, review
  comments on it go to the room, and merging it is the issue's merge.

Checked: `tests/gh-action-test.mjs`, 51 checks. Its stand-in GitHub now refuses `/user` the way the
job's token does, and without the fix the landing check fails with the same Q578 seen live.
