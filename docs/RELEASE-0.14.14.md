# Hivecode 0.14.14 Release Notes

## Slack with one link, no tokens
Connecting Slack took about eight steps: a Slack app made from a manifest, a bot token and a signing
secret copied into a terminal. A person who only works with cloud agents has no terminal for that.
Now, on a relay whose owner has turned it on, it is one link.

- **`slack connect "<room link>"` prints one link.** The person opens it, picks a channel on Slack's
  own approval screen and clicks Allow. A public channel connects at once; a private one connects
  after `/invite @Hivecode`. No manifest, no token, no signing secret, nothing to keep running.
- **It ends from Slack.** Removing the bot from the channel, or the app from the workspace, turns the
  connection off, and the room is told once. `slack disconnect` on the computer that connected also
  ends it. The same link connects the room again.
- **`slack status "<room link>"`** says whether a room is connected, waiting for the invite, or ended.
  `slack connect --no-wait` prints the link and returns, for an agent that hands the link to a person.
- **Relay owners** turn it on with one Slack app of their own: `slack app-manifest "https://<relay>"`
  prints its manifest; the app's client id, client secret and signing secret go into
  `HIVE_SLACK_CLIENT_ID`, `HIVE_SLACK_CLIENT_SECRET` and `HIVE_SLACK_APP_SECRET`. Without them
  nothing changes: `slack connect` prints the manifest steps as before. `docs/SLACK_SETUP.md` has the
  steps.
- **What stays as it was:** connections made from a manifest keep working without being set up
  again, and `slack connect --manifest` forces that route. On a relay with one-link setup on,
  `slack connect` prints the link even when `SLACK_BOT_TOKEN` is set; a script that relies on the
  tokens needs `--manifest`.
- **Open only a link your own agent gave you.** Whoever opens a link and approves it connects their
  channel to the room the link was made for. The bot's first message in the channel names who is in
  that room.
- **Behind an HTTPS proxy**, "Q666 could not reach the relay" now names the fix
  (`NODE_USE_ENV_PROXY=1`, Node 22.21 or later).

Checked: `tests/slack-oauth-test.mjs` (78 checks, the relay against a stand-in Slack),
`tests/slack-connect-test.mjs` (50), `tests/slack-one-click-e2e-test.mjs` (10, the real command
against the real relay). New codes Q669 to Q673 are in `docs/TROUBLESHOOTING.md`.

## Two fixes to the GitHub Action (both were in 0.14.13)
- **`github action --workflow` read the wrong lockfile** when the home directory is itself a git
  repository: run in a folder that is not a repository of its own, it printed `npm ci` from the home
  directory's lockfile. It now reads the folder it is run in.
- **The landing's tests were rerun on every run, silently.** After "a dependency is missing", once
  the install step was added and the tests then failed for an ordinary reason, the Action kept
  trying again on every scheduled run without saying anything. It now says the new failure once and
  stops until the plan changes.

Checked: `tests/gh-action-retry-test.mjs` (24 checks); the new ones fail on 0.14.13.

## Docs check
`npm run test:docs` passes again: its check of `docs/TROUBLESHOOTING.md` now also reads the relay's
own files, so codes that only the relay prints count as shipped.
