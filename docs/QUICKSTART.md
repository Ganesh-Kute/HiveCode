# Quickstart: Zero to a Pull Request in 10 Minutes

Connect an AI coding agent to your GitHub repository so that adding a `hivecode` label to an issue runs the agent in an isolated workspace and opens a tested pull request.

---

## Step 1: Prerequisites

Ensure you have the following installed on your machine:

1. **Node.js** (`>=18`, per `package.json` engines):
   ```bash
   node -v
   ```
2. **GitHub CLI** (`gh`):
   ```bash
   gh --version
   ```
   If missing, install it from [cli.github.com](https://cli.github.com).
3. **An AI coding agent CLI** (such as Claude Code):
   ```bash
   claude --version
   ```

---

## Step 2: Configure Your Agent (`setup`)

Run `setup` to install the runtime and configure the `hivecode` MCP server into your agent apps:

**Bash & PowerShell:**
```bash
npx -y hivecode-mcp@latest setup
```

### What Success Looks Like
`setup` verifies each agent by performing an MCP handshake with its configuration:
```
  Claude Code     READY   configured in ~/.claude.json  (starts in 0.3s)
  stop gate       added to ~/.claude/settings.json: in a room, Claude Code is not let end a turn with no listener running
```

### Likely Failure & Fix
If an agent configuration file cannot be updated:
```
  Claude Code     FAILED  ~/.claude.json
                  written, but it does not start: <error>
```
**Fix:** Add the `hivecode` server entry by hand to your agent's MCP settings:
```json
{
  "mcpServers": {
    "hivecode": {
      "command": "node",
      "args": ["<path-to-runtime>/hive-mcp.js"]
    }
  }
}
```

---

## Step 3: Authenticate with GitHub (`gh auth login`)

Run this inside your local clone of the repository you want to watch:

```bash
gh auth login
```

Follow the interactive prompts to log in via your browser.

### What Success Looks Like
`gh` confirms you're logged in and displays your active account.

### Likely Failure & Fix
If `gh` is not logged in or you run outside a repository:
- `Q600 gh auth login is required. Run: gh auth login`
  **Fix:** Complete `gh auth login`.
- `Q601 <cwd> is not inside a git repository. Run this in your clone of the repo.`
  **Fix:** `cd` into your git clone before running.
- `Q601 origin (<url>) is not a github.com repository.`
  **Fix:** Verify `git remote -v` points to GitHub.
- `Q601 the GitHub account gh is logged in as cannot push to <owner>/<repo>.`
  **Fix:** Ensure your GitHub account has write permissions to push branches.

---

## Step 4 (Optional): Connect Slack

To receive per-issue progress updates and stop runs directly from Slack:

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) by selecting **From a manifest** and pasting [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json).
2. Install the app to your workspace to generate your **Bot User OAuth Token** (`xoxb-...`).
3. Under **Basic Information > App-Level Tokens**, create a token with the `connections:write` scope to generate your **App Token** (`xapp-...`).
4. In Slack, invite the bot to your channel: `/invite @Hivecode`.

Set the tokens in your shell:

**Bash:**
```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

**PowerShell:**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-..."
$env:SLACK_APP_TOKEN="xapp-..."
```

Verify your Slack setup before starting:

**Bash & PowerShell:**
```bash
npx -y hivecode-mcp@latest slack check --channel <channel-id>
```

### What Success Looks Like
```
✓ token: @Hivecode (U0123456789)
✓ workspace: YourTeam (T0123456789)
✓ channel: #dev-feed (C0123456789, member)
✓ scopes (outbound + inbound): chat:write, channels:read, groups:read, channels:history, groups:history, users:read
✓ Socket Mode: connected
This posts one message in #dev-feed (and one reply in its thread)
✓ replies reach Hivecode
```

### Likely Failure & Fix
```
Q631 @Hivecode is not a member of #dev-feed (C0123456789). In Slack, open #dev-feed and run: /invite @Hivecode
```
**Fix:** Open the channel in Slack and type `/invite @Hivecode`.

---

## Step 5: Start the GitHub Watcher

### 1. Test with a Dry Run First
Verify permissions and agent configuration without modifying your repository:

**Bash:**
```bash
npx -y hivecode-mcp@latest github start --dry-run \
  --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode"
```

**PowerShell:**
```powershell
npx -y hivecode-mcp@latest github start --dry-run `
  --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode'
```

#### What Success Looks Like
```
Dry run: reading GitHub once. Nothing is written anywhere.
created the label "hivecode"
claude can use Hivecode (its hivecode MCP server: Connected).
Dry run done: no open issue is labelled "hivecode". Nothing was written.
```

### 2. Start the Live Watcher
Once the dry run succeeds, start the live watcher.

**Bash (standalone):**
```bash
npx -y hivecode-mcp@latest github start \
  --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode"
```

**PowerShell (standalone):**
```powershell
npx -y hivecode-mcp@latest github start `
  --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode'
```

**With Slack Integration:**

**Bash:**
```bash
npx -y hivecode-mcp@latest github start \
  --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" \
  --slack-channel <channel-id> \
  --slack-allow <user-id>
```

**PowerShell:**
```powershell
npx -y hivecode-mcp@latest github start `
  --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode' `
  --slack-channel <channel-id> `
  --slack-allow <user-id>
```

#### What Success Looks Like
```
Hivecode is watching <owner>/<repo> for issues labelled "hivecode". Ctrl+C stops it.
```
With Slack enabled:
```
Slack: `stop` in an issue's thread stops it; `retry` works for <user-id>.
```

### Likely Failure & Fix
- If the agent lacks the MCP server:
  ```
  Q602 claude has no hivecode MCP server, so it cannot join a room: every run would fail after spending tokens.
  Run: npx -y hivecode-mcp@latest setup
  (or --skip-agent-check if it is set up under another name).
  ```
  **Fix:** Run `npx -y hivecode-mcp@latest setup` and restart your terminal.
- If `--allowedTools` is missing `mcp__hivecode`:
  ```
  Q602 the agent command passes --allowedTools without mcp__hivecode, so it may not call hive_join and every run would fail after spending tokens. Add mcp__hivecode to its --allowedTools.
  ```
  **Fix:** Include `mcp__hivecode` in the `--allowedTools` list.

---

## Step 6: Label an Issue, Observe, and Stop

### 1. Label an Issue
Open an issue on GitHub and add the `hivecode` label.

### 2. What You See
- **In your terminal:**
  ```
  <HH:MM:SS> #12: queued (labelled by <user>)
  <HH:MM:SS> #12: run 1 of 6 started (build) in room <room-id>
  <HH:MM:SS> #12: pull request #13 opened
  ```
- **On the GitHub Issue:**
  Hivecode comments immediately upon claiming:
  ```
  Hivecode is working on this. The pull request will be linked here when it is ready.

  To stop, remove the `hivecode` label or comment `/hivecode stop`.
  ```
- **On the Pull Request:**
  Hivecode creates a pull request linked to `#12` containing:
  - A summary of what the agent changed.
  - The test command executed and its output.
  - A table of commits with the agent named as author and a signed trailer.
- **In Slack (if enabled):**
  A dedicated thread opens for the issue posting progress milestones and the pull request link.

### 3. How to Stop
You can cancel an in-progress run or watcher at any time:
- **On GitHub:** Remove the `hivecode` label from the issue, or post a comment containing `/hivecode stop`.
- **In Slack:** Reply `stop` in the issue's Slack thread.
- **In your terminal:** Press `Ctrl+C`. The watcher halts gracefully:
  ```
  <HH:MM:SS> stopping: ending the runs in progress
  ```
