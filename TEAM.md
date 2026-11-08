# Team plan: from tested to usable

**The goal.** A team that has never talked to us can:
- install Hivecode;
- connect Slack and GitHub;
- watch AI agents work as a team on their repo.

The website says exactly that, and nothing it can't back up.

**The team.** Claude (lead, reviews), plus two Antigravity agents. Each picks a name when joining.
This is a DRAFT. Change it in chat before anyone starts: say what you'd do differently, and why.

## The three tracks

| track | owner | what "done" means |
|---|---|---|
| **Slack** | Antigravity (1) | A team connects Slack in under 10 minutes by following one page. The room posts to a channel, one thread per task, and a person can see and stop the agents from Slack. |
| **GitHub** | Claude | Label an issue `hivecode`, and agents send back a tested pull request. The progress shows up in that issue's Slack thread. |
| **Website** | Antigravity (2) | The home page shows the integrations as they really work, with commands that run. Docs have a page each for Slack and GitHub. |

### What already exists: build on it, don't redo it
- **Slack:**
  - `hive-slack.js` posts the room's feed to a channel, one thread per task.
  - `hive-slack-agent.js` is a live panel on Slack's agent surface, with a stop button.
  - `hive-mcp-http.js` is a remote MCP server, so Slackbot can drive a room.
  - Tests for each are in `tests/`.
  - **Missing:** a Slack app manifest, one setup command or page, and a run against a real workspace.
- **GitHub:**
  - `hive-github.js` is the watcher. `docs/GITHUB_WORKFLOW.md` is the spec, with every failure case.
  - `npx -y hivecode-mcp@latest github start --dry-run` shows what it would do and writes nothing.
- **Notifications:** `hive-notify.js` sends "an agent is waiting on you" to a Slack or Discord webhook.
- **Website:** `public/index.html`, `public/docs.html` and `public/status.html`.

## How we work
1. **Design before you write.** Before your first edit on a track, post in chat:
   - who uses it, and when;
   - every way it goes wrong (missing or revoked token, rate limit, offline, run twice, wrong person);
   - what the user sees when it goes wrong. Above all, what would look green but be wrong.
2. **Claim a file before editing it, and release it after.** A refused claim means someone holds the file. Do something else, or @ them.
3. **Agent-to-agent work needs no human OK.** Ask each other directly, by @name. Only Ganesh approves anything that spends his money or publishes.
4. **Tests run before you release a file.** Every new check must fail on the old code first.
5. **Never put a token, key or password in the room.** Use env vars, and name them in docs.
6. **Nothing gets pushed or published from the room.** Claude lands the work with `pr team`, one commit per agent, and Ganesh pushes.

## Order
1. Everyone: read this, then post your track's design in chat.
2. Claude reviews each design, then work starts.
3. Each track ends with a check anyone can run, plus a short note on what a stranger would see.
