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
5. In the left sidebar under **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`). (After inviting `@Hivecode` to your channel in Step 2, run `SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack check --channel C0123456789` to verify the app end to end.)

---

## 2. Invite `@Hivecode` to Your Channel & Copy the Channel ID (1 minute)

1. In Slack, open the channel where you want threads posted and invite the bot:
   ```text
   /invite @Hivecode
   ```
2. Right-click the channel name (or click the channel header at the top) → **View channel details**.
3. Scroll to the bottom of the dialog and copy the **Channel ID** (looks like `C0123456789`).
4. Run **`slack check`** to prove your token, workspace, channel membership, scopes, and (when `SLACK_APP_TOKEN` is set) inbound Socket Mode event subscriptions work end to end before starting any workflow:
   ```bash
   SLACK_BOT_TOKEN=xoxb-… [SLACK_APP_TOKEN=xapp-…] npx -y hivecode-mcp@latest slack check --channel C0123456789
   ```
   *(This posts one message in `#your-channel` — `"Hivecode check: reply anything in this thread"` — and one reply in its thread once your reply arrives.)*

---

## 3. Verify with `--dry-run`, Then Start

Always run `--dry-run` first. It calls Slack's `auth.test` and `conversations.info` to verify your token (`Q630`) and that `@Hivecode` has been invited to the channel (`Q631`) before starting any work.

### Option A — Bridge a Live Hivecode Room (`slack start`)

> **Where do I get the `"wss://…|room-…"` link?** Running `npx -y hivecode-mcp@latest branch <name>` or `npx -y hivecode-mcp@latest setup` prints your room's `wss://…|room-…` link.

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

When running the GitHub issue watcher (`docs/GITHUB_WORKFLOW.md`), pass `--slack-channel <id>` with `SLACK_BOT_TOKEN` set in your environment. Each labelled issue opens one Slack thread; PR ready for review, waiting on a person, and merged/closed are posted in the thread and broadcast to the channel (`reply_broadcast`), while run start, CI failures, the tester's verdict, fixes pushed to the PR, resumed, and stopped stay inside the thread only.

If you also set `SLACK_APP_TOKEN=xapp-…` (see Section 5), replying `stop` in an issue's Slack thread stops that issue's run (and posts `/hivecode stop` on GitHub), and replying `retry` re-runs it for Slack user IDs listed in `--slack-allow <U123,U456>`.

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
npx -y hivecode-mcp@latest github start --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode' --slack-channel C0123456789 --dry-run
npx -y hivecode-mcp@latest github start --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode' --slack-channel C0123456789
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
<summary><strong>Optional Inbound Manifest (Socket Mode enabled — <code>slack-app-manifest-inbound.json</code>)</strong></summary>

Paste the contents of [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json):

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

### Generating the App-Level Token (`SLACK_APP_TOKEN`)
1. In your Slack app settings, go to **Basic Information** and scroll down to **App-Level Tokens**.
2. Click **Generate Token and Scopes**.
3. Enter `socket-mode` as the **Token Name** (required by Slack), click **Add Scope**, select `connections:write`, and click **Generate**.
4. Copy the resulting `xapp-…` token and set it as `SLACK_APP_TOKEN`.

### Who May Act (`--allow` / `--slack-allow`) & No Impersonation
- **STOP is fail-safe**: Any full member of your Slack workspace may type `stop`, `stop all`, or `stop <AgentName>` in a thread to pause agents (or stop an active GitHub issue run) immediately. If Slack's `users.info` endpoint fails during an outage, `stop` still succeeds and notes `(stopped; I could not confirm who you are)`.
- **RESUME, RETRY, and thread replies require the allowlist (`--allow U123,U456` on `slack start`, or `--slack-allow U123,U456` on `github start`)**: Only Slack user IDs explicitly listed in the allowlist (find yours in Slack under **Profile → `⋯` → Copy member ID**) may resume agents (`resume`, `resume all`, `resume <AgentName>`), retry a GitHub issue run (`retry`), or send replies into the room. If the allowlist is omitted, inbound is **stop-only**.
- **Guests & Slack Connect users are refused**: Single-channel/multi-channel guests (`is_restricted` / `is_ultra_restricted`) and external Slack Connect users from other workspaces (`team_id` mismatch via `users.info`) are refused for all actions (including `stop`) and receive a refusal reply in the thread.
- **No impersonation (`slack:<handle>`)**: Every message delivered from Slack into the room is attributed as `slack:<handle>` (for example, `slack:ganesh`), never as a bare room member name (`Ganesh`), so a Slack display name cannot impersonate the room owner.

### Free vs Paid Slack Plans
- **Typed `stop` works on every Slack plan (including Free)**: Replying `stop`, `stop all`, `stop <AgentName>`, `resume <AgentName>`, or `retry` in a channel thread requires only standard channel events and works on **all Slack plans**.
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

### Slackbot Remote MCP Server (`hive-mcp-http.js`)

If you connect Slackbot's remote MCP client over Streamable HTTP (`hive-mcp-http.js`), it exposes fast room inspection and control tools (`hive_status`, `hive_members`, `hive_tasks`, `hive_claims`, `hive_recent`, `hive_pause`, `hive_resume`, `hive_say`).

- **Requires both `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`**: In `--auth slack` mode (the default), `hive-mcp-http.js` refuses to start without `SLACK_SIGNING_SECRET` (`Q510`, copied from **Basic Information → App Credentials → Signing Secret**) **and** `SLACK_BOT_TOKEN` (`Q630`, `xoxb-…` with `users:read` scope so `users.info` can verify callers).
- **Discovers your workspace (`team_id`) from Slack at startup**: When you start `hive-mcp-http.js` without `--team` (`SLACK_TEAM_ID`), it calls Slack's `auth.test` using `SLACK_BOT_TOKEN` before serving requests. If `auth.test` rejects the token (`Q630`) or does not return a `team_id` (`Q634`), startup is refused immediately so external Slack Connect workspace users can never slip through by default.
- **Same access rules (`makeSlackActorCheck`)**:
  - **Every request is HMAC-verified first** (`X-Slack-Signature` + 5-minute replay window, `Q511`–`Q513`) before `_meta.slack.user_id` is read.
  - **Guests and other workspaces are refused** for all tools (`hive_pause`, `hive_resume`, `hive_say`).
  - **`hive_pause` (`stop`) is fail-safe** for any full member of your workspace (and fails open with `(stopped; I could not confirm who you are)` if `users.info` is unreachable during a Slack outage).
  - **`hive_resume` and `hive_say` require `--allow <U123,U456>`** (or `SLACK_ALLOW`). Messages sent via `hive_say` are recorded in room chat as `slack:<handle>`.

**macOS / Linux (bash, zsh):**
```bash
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… node hive-mcp-http.js "wss://hivecode-relay.onrender.com|room-abc123" --port 8790 --allow U012ABCDEF
```

**Windows (PowerShell):**
```powershell
$env:SLACK_SIGNING_SECRET="…"
$env:SLACK_BOT_TOKEN="xoxb-…"
node hive-mcp-http.js "wss://hivecode-relay.onrender.com|room-abc123" --port 8790 --allow U012ABCDEF
```

**What a First-Time User Sees Step by Step (`hive-mcp-http.js`):**
1. **If `SLACK_SIGNING_SECRET` is missing**: Process exits immediately (`code 2`) with:
   `Q510 --auth slack needs SLACK_SIGNING_SECRET. Use --auth none only on localhost.`
2. **If `SLACK_BOT_TOKEN` is missing**: Process exits immediately (`code 2`) with:
   `Q630 --auth slack needs SLACK_BOT_TOKEN. Set SLACK_BOT_TOKEN=xoxb-… in your environment (docs/SLACK_SETUP.md).`
3. **When both are set**: `hive-mcp-http.js` calls Slack `auth.test`, locks in your workspace `team_id`, joins the room, and prints:
   `[hive-mcp-http] room room-abc123 on :8790/  auth=slack`
4. **When someone asks Slackbot what is happening (`hive_status`)**: Returns the live room name, agent count, paused list, and task counts.
5. **When a coworker triggers `hive_pause`**: Pauses the named agent (or `all`) on its own client (`paused AgentA — it will finish its current step and then stop picking up work`), while a guest or Slack Connect user from another workspace gets `:no_entry: Refused: guests and external Slack Connect users cannot control or message this room.`
6. **When someone not in `--allow` triggers `hive_resume` or `hive_say`**: Refused with `:no_entry: Refused: only Slack user IDs listed in --allow may resume/retry agents or send replies into the room (your ID: U…). Any full workspace member may still type stop.` When a user listed in `--allow` calls `hive_say`, it lands in the room attributed as `slack:<handle>`.

---

## 6. How to Show It (Live Demo Walkthrough)

> **Running from a local checkout before npm publish:** Until the latest release is published to npm (`npx -y hivecode-mcp@latest` on npm is `0.12.4` prior to release), replace `npx -y hivecode-mcp@latest` in the commands below with `node C:/Users/G1/Desktop/N-team/hive-mcp.js` (or `node ./hive-mcp.js` from your repo root).

Use these 5 steps to demonstrate either **GitHub-to-Slack issue threads** (`github start --slack-channel --slack-allow`) or a **live room bridge** (`slack start --channel --allow`) end to end:

1. **Install the App & Copy Tokens**:
   - Create the Slack app from the **Optional Inbound Manifest** in Section 5 above and install it to your workspace.
   - Copy `SLACK_BOT_TOKEN` (`xoxb-…`) from **OAuth & Permissions**, and generate `SLACK_APP_TOKEN` (`xapp-…`, named `socket-mode` with `connections:write`) under **Basic Information → App-Level Tokens**.
2. **Invite `@Hivecode` & Copy IDs**:
   - In your Slack channel, run `/invite @Hivecode` and copy the **Channel ID** (`C…`) from channel details.
   - Copy your own **Slack Member ID** (`U…`) from your Slack profile (**Profile → `⋯` → Copy member ID**).
3. **Start the Watcher or Room Bridge**:
   - **Flow A — GitHub Issue Threads + Slack `stop` / `retry` (PowerShell):**
     ```powershell
     $env:SLACK_BOT_TOKEN="xoxb-…"
     $env:SLACK_APP_TOKEN="xapp-…"
     npx -y hivecode-mcp@latest github start --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode' --slack-channel C0123456789 --slack-allow U012ABCDEF --dry-run
     npx -y hivecode-mcp@latest github start --agent 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode' --slack-channel C0123456789 --slack-allow U012ABCDEF
     ```
   - **Flow B — Live Room Bridge + Slack `stop` / `resume` / Thread Replies (PowerShell):**
     ```powershell
     $env:SLACK_BOT_TOKEN="xoxb-…"
     $env:SLACK_APP_TOKEN="xapp-…"
     npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF --dry-run
     npx -y hivecode-mcp@latest slack start "wss://hivecode-relay.onrender.com|room-abc123" --channel C0123456789 --allow U012ABCDEF
     ```
4. **Trigger a Thread**:
   - **In Flow A**: Add the `hivecode` label to a GitHub issue. Watch Slack open a single thread (`#12 — Title`) for that issue and post run progress inside it.
   - **In Flow B**: Assign a task in the room. Watch Slack open a thread for that task and post gate checks and task chat inside it.
5. **Control from the Slack Thread**:
   - **In Flow A (`github start`)**: Reply `stop` inside the issue's Slack thread to stop the active run (posts `/hivecode stop` on GitHub and ends the room). Reply `retry` (permitted because your ID is in `--slack-allow`) to post `/hivecode retry` and start a fresh run.
   - **In Flow B (`slack start`)**: Reply `stop all` (or `stop <AgentName>`) inside the thread to pause agents on their own clients (`controls` map -> `paused`). Reply `resume all` or reply with instructions (`@AgentName …`, delivered into the room as `slack:<your-handle>`).

---

## 7. Troubleshooting (`Q510` – `Q513`, `Q630` – `Q634`)

| Code | Cause | Fix |
| :--- | :--- | :--- |
| **`Q510`** | `hive-mcp-http.js` started in `--auth slack` mode without `SLACK_SIGNING_SECRET`. | Copy your app's **Signing Secret** from **Basic Information → App Credentials** in Slack app settings and set `SLACK_SIGNING_SECRET` (or use `--auth none` on `localhost` only). |
| **`Q511` – `Q513`** | HTTP request to `hive-mcp-http.js` is unsigned (`Q511`), outside the 5-minute replay window (`Q512`), or its HMAC signature does not match (`Q513`). | Ensure `SLACK_SIGNING_SECRET` matches the Slack app calling the endpoint and that the host clock is synced via NTP. |
| **`Q630`** | `SLACK_BOT_TOKEN` is missing (required by `slack start` and by `hive-mcp-http.js` in `--auth slack` mode), invalid (`invalid_auth`), or revoked (`token_revoked`) when checked against Slack `auth.test`. | Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** in your Slack app settings and set `SLACK_BOT_TOKEN` in the same terminal session. |
| **`Q631`** | `--channel` is missing, `channel_not_found`, or `@Hivecode` has not been invited to the channel (`is_member: false` / `not_in_channel`). | Open the target channel in Slack and run `/invite @Hivecode`. If it is a private channel, ensure the app has `groups:read` scope and reinstall to workspace. |
| **`Q632`** | Another `SlackBridge` with the same `--name` is already connected to this room. | Stop the existing `slack start` process before starting a new one so events are not posted twice. |
| **`Q633`** | `--slack-channel` was passed to `github start`, but `SLACK_BOT_TOKEN` is not set in the environment. | Set `SLACK_BOT_TOKEN=xoxb-…` (or `$env:SLACK_BOT_TOKEN="xoxb-…"` in PowerShell) before running `github start --slack-channel`. |
| **`Q634`** | Inbound Slack configuration cannot work safely: (1) `SLACK_APP_TOKEN` (`xapp-…`) is missing or rejected by `apps.connections.open`; (2) `--slack-allow` was passed to `github start` without `--slack-channel`, without `SLACK_APP_TOKEN`, or with usernames instead of member IDs (`U…`); or (3) Slack `auth.test` did not return a workspace `team_id` (in `github start` or `hive-mcp-http.js`), so external workspaces could not be refused. | Enable **Socket Mode** and set `SLACK_APP_TOKEN=xapp-…` (`connections:write` scope); pass Slack member IDs (`U…` from **Profile → `⋯` → Copy member ID**) to `--slack-allow` / `--allow`; or pass `--team <T…>` (`SLACK_TEAM_ID`) / reinstall the Slack app if `auth.test` omitted `team_id`. |
