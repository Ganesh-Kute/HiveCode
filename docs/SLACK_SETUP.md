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

## 5. Stopping Agents & Replying from Slack (Optional — Socket Mode)

By default, `slack-app-manifest.json` requests only the three outbound scopes (`chat:write`, `channels:read`, `groups:read`). If you also want to **stop/resume agents** or **reply in task threads** from Slack (with zero public webhook URL), enable **Socket Mode**:

### Privacy & Scope Notice
Inbound Socket Mode requires adding `channels:history`, `groups:history`, and `users:read` to **Bot Token Scopes**, plus an **App-Level Token** (`SLACK_APP_TOKEN=xapp-…`) with `connections:write` and Event Subscriptions for `message.channels` and `message.groups`.
> **Plain-spoken scope warning:** `channels:history` and `groups:history` let the bot read every message posted in the channels you invite it to. If you only want outbound thread feeds, keep the default 3-scope manifest above.

<details>
<summary><strong>Optional Inbound Manifest (Socket Mode enabled)</strong></summary>

```json
{
  "display_information": {
    "name": "Hivecode",
    "description": "One Slack thread per task or GitHub issue, with inbound stop and thread replies.",
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
        "groups:read",
        "channels:history",
        "groups:history",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "message.channels",
        "message.groups"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```
</details>

### Who May Act (`--allow U123,U456`) & No Impersonation
- **STOP is fail-safe**: Any full member of your Slack workspace may type `stop`, `stop all`, or `stop <AgentName>` in a thread to pause agents immediately.
- **RESUME and thread replies require `--allow`**: Only Slack user IDs explicitly listed in `--allow U123,U456` (find yours in Slack under **Profile → `⋯` → Copy member ID**) may resume agents (`resume`, `resume all`, `resume <AgentName>`) or send replies into the room. If `--allow` is omitted, inbound is **stop-only**.
- **Guests & Slack Connect users are refused**: Single-channel/multi-channel guests (`is_restricted` / `is_ultra_restricted`) and external Slack Connect users from other workspaces (`team_id` mismatch via `users.info`) are refused for all actions (including `stop`) and receive a refusal reply in the thread.
- **No impersonation (`slack:<handle>`)**: Every message delivered from Slack into the room is attributed as `slack:<handle>` (for example, `slack:ganesh`), never as a bare room member name (`Ganesh`), so a Slack display name cannot impersonate the room owner.

### Free vs Paid Slack Plans
- **Typed `stop` works on every Slack plan (including Free)**: Replying `stop`, `stop all`, `stop <AgentName>`, or `resume <AgentName>` in a channel thread via `slack start` requires only standard channel events and works on **all Slack plans**.
- **Native AI stop button requires a paid Slack plan**: Slack's native stop button (`agent_session_stopped` in `hive-slack-agent.js`) belongs to Slack's AI agent surface (`assistant:write`), which requires a paid Slack plan.

**macOS / Linux (bash, zsh):**
```bash
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF --dry-run
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF
```

**Windows (PowerShell):**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-…"
$env:SLACK_APP_TOKEN="xapp-…"
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF --dry-run
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF
```

**Windows (Command Prompt / `cmd.exe`):**
```cmd
set SLACK_BOT_TOKEN=xoxb-…
set SLACK_APP_TOKEN=xapp-…
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF --dry-run
npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF
```

---

## 6. How to Show It (Live Demo Walkthrough)

Use these 5 steps to demonstrate GitHub-to-Slack issue threads and live Slack stop/resume control end to end:

1. **Install the App & Copy Tokens**:
   - Create the Slack app from the **Optional Inbound Manifest** in Section 5 above and install it to your workspace.
   - Copy `SLACK_BOT_TOKEN` (`xoxb-…`) from **OAuth & Permissions**, and generate `SLACK_APP_TOKEN` (`xapp-…` with `connections:write`) under **Basic Information → App-Level Tokens**.
2. **Invite `@Hivecode` & Copy IDs**:
   - In your Slack channel, run `/invite @Hivecode` and copy the **Channel ID** (`C…`) from channel details.
   - Copy your own **Slack Member ID** (`U…`) from your Slack profile (**Profile → `⋯` → Copy member ID**).
3. **Start with `--allow <your-user-id>`**:
   - Run the `--dry-run` check first, then start the bridge with `--allow <your-user-id>`:
     ```powershell
     $env:SLACK_BOT_TOKEN="xoxb-…"
     $env:SLACK_APP_TOKEN="xapp-…"
     npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF
     ```
   - Or for the GitHub issue watcher:
     ```powershell
     $env:SLACK_BOT_TOKEN="xoxb-…"
     npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --slack-channel C0123456789
     ```
4. **Label an Issue `hivecode`**:
   - Add the `hivecode` label to a GitHub issue (or assign a task in the room). Watch Slack open a single thread for that issue/task and post progress inside it.
5. **Type `stop all` in the Thread**:
   - Reply `stop all` (or `stop <AgentName>`) inside the Slack thread from your phone or desktop. Every AI agent in the room is immediately paused on its own client (`controls` map -> `paused`), and the bot confirms in the thread.
   - Reply `resume all` (permitted because your ID is in `--allow`) or reply with instructions (`@AgentName …`, delivered into the room as `slack:<your-handle>`).

---

## 7. Troubleshooting (`Q630` – `Q634`)

| Code | Cause | Fix |
| :--- | :--- | :--- |
| **`Q630`** | `SLACK_BOT_TOKEN` is missing, invalid (`invalid_auth`), or revoked (`token_revoked`). | Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** in your Slack app settings and set `SLACK_BOT_TOKEN` in the same terminal session. |
| **`Q631`** | `--channel` is missing, `channel_not_found`, or `@Hivecode` has not been invited to the channel (`is_member: false` / `not_in_channel`). | Open the target channel in Slack and run `/invite @Hivecode`. If it is a private channel, ensure the app has `groups:read` scope and reinstall to workspace. |
| **`Q632`** | Another `SlackBridge` with the same `--name` is already connected to this room. | Stop the existing `slack start` process before starting a new one so events are not posted twice. |
| **`Q633`** | `--slack-channel` was passed to `github start`, but `SLACK_BOT_TOKEN` is not set in the environment. | Set `SLACK_BOT_TOKEN=xoxb-…` (or `$env:SLACK_BOT_TOKEN="xoxb-…"` in PowerShell) before running `github start --slack-channel`. |
| **`Q634`** | `SLACK_APP_TOKEN` (`xapp-…`) was rejected by `apps.connections.open` at Socket Mode preflight. | Enable **Socket Mode** in your Slack app settings, generate an App-Level Token (`xapp-…`) with `connections:write` scope, and set `SLACK_APP_TOKEN`. |
