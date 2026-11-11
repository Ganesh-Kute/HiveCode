# Hivecode 0.14.11 Release Notes

## The GitHub Action reads the pull request's checks
- **The workflow file asks for `statuses: read`.** Without it, GitHub refused the job's read of the
  pull request's commit statuses (HTTP 403), and the run failed after it had done its work. This was
  seen on the second live run.
- **A check that cannot be read no longer fails the run.** The run says so in its log and names the
  two permissions to add. Repositories with the older workflow file keep working.

Checked: `tests/gh-action-test.mjs`, 52 checks.
