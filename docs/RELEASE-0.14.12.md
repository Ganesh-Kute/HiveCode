# Hivecode 0.14.12 Release Notes

## The GitHub Action sends every comment to the room
Before, a plain comment on the issue did not reach the agents; only review comments and comments
starting with `/hivecode` did. Now every comment from someone who can push goes to the room, on the
issue and on its pull request, before the pull request exists and after.

- Quoted as data, with its `@` mentions neutralised; each comment is sent once.
- Comments from bots and from people who cannot push are still left out.
- The watcher (`github start`) is unchanged: there, a plain comment still starts nothing.

Checked: `tests/gh-action-test.mjs`, 55 checks. The new checks fail without the change.
