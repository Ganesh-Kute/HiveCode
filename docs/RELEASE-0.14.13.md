# Hivecode 0.14.13 Release Notes

## The GitHub Action works on its first run in a new repository
Three things went wrong on the first run in a repository that had never used the Action.

- **The printed workflow installs the repository's dependencies.** `github action --workflow` looks
  for a lockfile and adds the install step before the Hivecode step: `npm ci` for `package-lock.json`
  or `npm-shrinkwrap.json`, `pnpm install --frozen-lockfile` for `pnpm-lock.yaml`,
  `yarn install --frozen-lockfile` for `yarn.lock`, `npm install` for a bare `package.json`. With
  none of these it leaves a commented placeholder. When a landing's tests fail because a dependency
  is missing, the issue comment now names the fix (add an install step to
  `.github/workflows/hivecode.yml`), and the landing is tried again once the workflow has changed.
- **A pull request that is not the issue's is left alone.** Before, any open pull request on the
  room's branch was linked to the issue ("Closes #N"), even one opened for something else before the
  agents had landed anything. Now a pull request is linked only once the issue's work is on the
  branch.
- **"Pushed, but the pull request could not be opened" says so.** When GitHub refuses the pull
  request because *Allow GitHub Actions to create and approve pull requests* is off (Q574, HTTP 403),
  the comment used to say "Nothing was pushed", which was wrong, and the room was asked to fix
  something that was not broken. Now the comment says the work is pushed, names the setting
  (Settings → Actions → General → Workflow permissions), and every later run tries again, so the pull
  request opens on the next run after the setting is turned on. A pull request opened by hand from
  the branch is linked to the issue.

Checked: `tests/gh-action-test.mjs` (66 checks), `tests/gh-action-workflow-test.mjs` (21) and
`tests/gh-action-retry-test.mjs` (18). The new checks fail without the change.

## Slack ↔ room through the relay
`slack connect "<relay|room>"` links a Slack channel to a room on the relay itself, so nothing has to
keep running on anyone's machine. `slack disconnect` removes it. See `docs/SLACK_SETUP.md`.

- It needs a relay running this release or later, with `HIVE_SLACK_KEY` set. A relay on an older
  build does not have the Slack endpoints.
- `slack start` (the bridge that runs on your machine) is unchanged and still works with any relay.
