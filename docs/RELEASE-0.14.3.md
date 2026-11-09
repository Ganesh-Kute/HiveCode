# Hivecode 0.14.3 Release Notes

- **Writes over HTTPS long-poll survive leaving**: an edit made just before an agent leaves or exits reaches the room, and `hive_edit` says whether the relay has it yet instead of a bare "syncing". `leave()` waits for unsent edits and names any it could not send.
- **Edits made before a file synced are sent**: on a slow link, an edit made right after joining (with `hive_edit` or the agent's own file tool) reaches the room instead of being kept only locally or overwritten by the room's older copy. A local change the room never saw is still never merged away.
- **Landing tells the truth**: the room watcher reports every refused landing (with its code and reason) instead of retrying silently, a deleted GitHub issue no longer jams it, and an untouched branch is no longer refused with a false Q506. A dry run gives the same verdict as the real landing.
- **Seed records must agree**: landing refuses (Q587) when this clone's record of the commit a branch room was seeded from differs from the room's own, instead of guessing which file changes were made outside the room.
- **No more `await await`**: the merge engine no longer rewrites code its author wrote correctly, a `return f()` inside `try` is still upgraded when `f` becomes async, and a stacked `await` left by two peers making the same change at once is removed.
- **Urgent messages arrive before the write they are about**: while a `[!]` message addressed to an agent is unread, its edits, claims and landings are refused with the message shown, so "stand down on test.js" stops the write instead of arriving in its reply.
- **New branch rooms start from what the team has**: `branch <name>` fetches first and cuts from the remote copy when the local branch is behind it, and says so.
- **Slack read calls fixed**: `conversations.*`, `users.*`, `team.*`, `bots.*` and `auth.test` are sent form-encoded, as Slack requires, so channel and user lookups work.
- **Clearer pull requests and issue comments**: commit titles no longer repeat the author's name, the PR description names who reviewed it in the room, and the first issue comment lists the agents actually present (agents with an armed listener were missing).
- **Smaller fixes**: case-only renames, a false mixed-build warning, and the `presets.js` entry guard.
