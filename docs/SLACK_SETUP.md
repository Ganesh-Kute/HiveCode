# Slack Setup (Under 10 Minutes)

Hivecode posts to Slack using **one thread per task** (for a live room) or **one thread per GitHub issue** (for the GitHub watcher). Only the opening message and the final outcome appear in the main channel; intermediate claims, gate checks, CI runs, and untasked room chatter stay inside threads so your channel is never flooded.

---

## 1. Create the Slack App from the Manifest (2 minutes)

1. Open [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From a manifest**.
2. Pick your Slack workspace and switch the tab to **JSON**.
3. Paste the contents of [`slack-app-manifest.json`](../slack-app-manifest.json):

```json
{
  "display_information": {
    "name": "Hivecode",
    "description": "One Slack thread per task or GitHub issue for Hivecode rooms.",
    "background_color": "#111318"
  },
  "features": {
    "bot_user": {
      "display_name": "Hivecode",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:read",
        "groups:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

4. Click **Next** → **Create**, then click **Install to Workspace** and **Allow**.
5. In the left sidebar under **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).

---

## 2. Invite `@Hivecode` to Your Channel & Copy the Channel ID (1 minute)

1. In Slack, open the channel where you want threads posted and invite the bot:
   ```text
   /invite @Hivecode
   ```
2. Right-click the channel name (or click the channel header at the top) → **View channel details**.
3. Scroll to the bottom of the dialog and copy the **Channel ID** (looks like `C0123456789`).

---

## 3. Verify with `--dry-run`, Then Start

Always run `--dry-run` first. It calls Slack's `auth.test` and `conversations.info` to verify your token (`Q630`) and that `@Hivecode` has been invited to the channel (`Q631`) before starting any work.

### Option A — Bridge a Live Hivecode Room (`slack start`)

**macOS / Linux (bash, zsh):**
```bash
# 1. Verify token and channel membership first
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --dry-run

# 2. Start the live bridge
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789
```

**Windows (PowerShell):**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-…"
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --dry-run
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789
```

**Windows (Command Prompt / `cmd.exe`):**
```cmd
set SLACK_BOT_TOKEN=xoxb-…
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --dry-run
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789
```

---

### Option B — One Slack Thread per GitHub Issue (`github start --slack-channel`)

When running the GitHub issue watcher (`docs/GITHUB_WORKFLOW.md`), pass `--slack-channel <id>` with `SLACK_BOT_TOKEN` set in your environment. Each labelled issue opens one Slack thread; PR ready for review, waiting on a person, and merged/closed are posted in the thread and broadcast to the channel (`reply_broadcast`), while run start, CI failures, the tester's verdict, resumed, and stopped stay inside the thread only.

**macOS / Linux (bash, zsh):**
```bash
# 1. Dry-run first (checks gh auth, repo, and Slack token/channel)
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789 --dry-run

# 2. Start watching issues
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789
```

**Windows (PowerShell):**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-…"
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789 --dry-run
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789
```

**Windows (Command Prompt / `cmd.exe`):**
```cmd
set SLACK_BOT_TOKEN=xoxb-…
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789 --dry-run
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789
```

---

## 4. What Gets Posted (and What Is Scrubbed)

| Source | Shown in Channel | Inside the Thread Only |
| :--- | :--- | :--- |
| **GitHub Watcher (`--slack-channel`)** | Thread opening post (`#12 — Title`), plus thread replies broadcast to the channel (`reply_broadcast`): PR ready for review, waiting on a person (`hivecode:needs-human`), merged / closed | Run started, CI failed, the tester's verdict, resumed, stopped |
| **Room Bridge (`slack start`)** | `task-open` and `task-done` | Gate pass/fail (`gate-pass`, `gate-fail`), task chat, and all untasked room chat (grouped inside one shared room thread so chatter never floods the channel) |

- **Secret & Room Link Scrubbing**: Every message passes through `scrubSlack()` before leaving your machine. API keys, tokens, bearer headers, room capability links (`wss://…|room-…`), and room IDs (`room-…`) are stripped automatically.
- **Rate Limits & Retries**: Slack's ~1 message/second per-channel pacing is enforced by a single outbound queue. HTTP `429` (`ratelimited`) responses are retried up to 5 times honouring `Retry-After`.
- **Durable Thread State**: Thread timestamps (`thread_ts`) are stored in room state (`slack_threads` map) for `slack start` and in `.git/hivecode/github.json` for `github start --slack-channel`, so restarting the process continues posting into the existing Slack thread.

---

## 5. Troubleshooting (`Q630` – `Q633`)

| Code | Cause | Fix |
| :--- | :--- | :--- |
| **`Q630`** | `SLACK_BOT_TOKEN` is missing, invalid (`invalid_auth`), or revoked (`token_revoked`). | Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** in your Slack app settings and set `SLACK_BOT_TOKEN` in the same terminal session. |
| **`Q631`** | `--channel` is missing, `channel_not_found`, or `@Hivecode` has not been invited to the channel (`is_member: false` / `not_in_channel`). | Open the target channel in Slack and run `/invite @Hivecode`. If it is a private channel, ensure the app has `groups:read` scope and reinstall to workspace. |
| **`Q632`** | Another `SlackBridge` with the same `--name` is already connected to this room. | Stop the existing `slack start` process before starting a new one so events are not posted twice. |
| **`Q633`** | `--slack-channel` was passed to `github start`, but `SLACK_BOT_TOKEN` is not set in the environment. | Set `SLACK_BOT_TOKEN=xoxb-…` (or `$env:SLACK_BOT_TOKEN="xoxb-…"` in PowerShell) before running `github start --slack-channel`. |
