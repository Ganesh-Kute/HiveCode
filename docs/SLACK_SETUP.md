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

## 3. Run `slack check` First, Then Start

Before starting a room bridge or the GitHub watcher, run **`slack check`** once. It verifies each piece of your Slack app in order (`token`, `workspace`, `channel`, `scopes`, `Socket Mode`), then posts `"Hivecode check: reply anything in this thread"` in `#your-channel` and waits up to 2 minutes for your reply so you know outbound posting **and** inbound event subscriptions actually work end to end.

**macOS / Linux (bash, zsh):**
```bash
# Outbound only (3-scope manifest):
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack check --channel C0123456789

# Outbound + inbound stop/retry/replies (Socket Mode manifest):
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack check --channel C0123456789

# Slack AI Agent surface + native stop button (Paid Slack plan manifest):
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack check --channel D0123456789 --agent
```

**Windows (PowerShell):**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-…"
$env:SLACK_APP_TOKEN="xapp-…" # optional: include when using inbound stop/retry/replies or --agent
npx -y hivecode-mcp@latest slack check --channel C0123456789
```

**What Each `slack check` Line Means & the One Fix When It Fails:**

| Failing Step / Line | Cause | The One Fix |
| :--- | :--- | :--- |
| **`Q630 SLACK_BOT_TOKEN is missing` / `rejected by Slack (invalid_auth)`** | `SLACK_BOT_TOKEN` is unset, pasted from the wrong field, or revoked. | Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** in your Slack app settings and export `SLACK_BOT_TOKEN` in the same terminal. |
| **`Q634 Slack auth.test did not return a workspace team_id`** | Slack did not associate the token with a workspace. | Reinstall the app to your workspace under **OAuth & Permissions → Reinstall to Workspace**. |
| **`Q631 @Hivecode is not a member of #channel`** | The bot has not been invited to the target channel. | Open `#channel` in Slack and run `/invite @Hivecode`. |
| **`Q631 Slack channel … could not be accessed (missing_scope: needs groups:read)`** | Target channel is private, or the bot lacks the channel read scope (`needed` scope named in error). | Add the named scope (`groups:read` / `channels:read`) under **OAuth & Permissions → Bot Token Scopes** and click **Reinstall to Workspace**. |
| **`Q634 SLACK_BOT_TOKEN is missing required inbound scope(s): users:read, channels:history`** | `SLACK_APP_TOKEN` is set for inbound `stop`/`retry`, but the app was created from the outbound-only manifest. | Recreate or update the app's manifest from [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json) (Section 5 below) and click **Reinstall to Workspace**. |
| **`Q634 SLACK_BOT_TOKEN is missing required agent scope(s): assistant:write, im:history`** | `--agent` (or `hive-slack-agent.js`) was started with a token from the outbound or inbound-only manifest. | Update the app's manifest from [`slack-app-manifest-agent.json`](../slack-app-manifest-agent.json) (Section 5 below) and click **Reinstall to Workspace**. |
| **`Q634 SLACK_APP_TOKEN was rejected` / `Socket Mode did not open (no hello frame)`** | Socket Mode is disabled in the Slack app, or `SLACK_APP_TOKEN` (`xapp-…`) lacks `connections:write`. | Enable **Socket Mode** in your Slack app settings and generate a new App-Level Token (`xapp-…`) with `connections:write` under **Basic Information → App-Level Tokens**. |
| **`Q634 Slack agents.sessions.setStatus returned warning missing_agent_session_stopped_event_subscription`** | `--agent` checked `agents.sessions.setStatus`, and Slack reported that `agent_session_stopped` is not subscribed (so the native stop button is not rendered). | Subscribe to `agent_session_stopped` by updating your app's manifest from [`slack-app-manifest-agent.json`](../slack-app-manifest-agent.json) and reinstalling. |
| **`Q634 Slack agents.sessions.setStatus failed (feature_disabled)`** | The workspace is on a Free Slack plan or Agents & Assistants is disabled for the workspace. | Use [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json) for typed `stop` / `retry` in channel threads (works on all Slack plans), or enable Agents & Assistants on a paid Slack plan. |
| **`Q634 Slack agents.sessions.setStatus failed (thread_ts_required)`** | Slack rejected `agents.sessions.setStatus` because the DM session requires a valid `thread_ts`. | Run `slack check --channel <D…> --agent` on a DM or channel where `@Hivecode` can post a thread root message first. |
| **`Q634 replies did not arrive. Event subscriptions are probably missing`** | You replied in the check thread, but Slack never sent the event (`message.channels` / `message.groups` / `message.im` not subscribed). | Update your app's manifest with [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json) (or [`slack-app-manifest-agent.json`](../slack-app-manifest-agent.json) for `--agent`) and reinstall the app. |

Once `slack check` passes, you can also run `--dry-run` on `slack start` or `github start` before launching:

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

- **What `slack start` announces, and when**: it watches the room's task list and gate results as well as its chat. A new task opens its thread (and appears in the channel); when the assignee completes it, the "done" reply is also broadcast to the channel. A gate pass or fail is posted inside the shared room thread. The first time a bridge ever attaches to a room it only records what is already there, so starting it never replays the room's history; what it has announced is kept in room state (`slack_seen`), so a restart does not repeat itself. A forced gate release is not posted as a gate result: it is already in room chat.
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

### Free vs Paid Slack Plans & the Slack AI Agent Surface (`hive-slack-agent.js`)
- **Typed `stop` works on every Slack plan (including Free)**: Replying `stop`, `stop all`, `stop <AgentName>`, `resume <AgentName>`, or `retry` in a channel thread requires only standard channel events (`slack-app-manifest-inbound.json`) and works on **all Slack plans**. We keep `slack-app-manifest-inbound.json` separate from `slack-app-manifest-agent.json` so Free-plan workspaces can install inbound `stop`/`retry` without hitting `feature_disabled`.
- **Native AI stop button & streamed plan cards (`hive-slack-agent.js`) require a paid Slack plan**: `hive-slack-agent.js` renders live room tasks as a streamed plan (`chat.startStream` / `chat.appendStream` / `chat.stopStream` with `task_display_mode: "plan"`) and enables Slack's native stop button via `agents.sessions.setStatus` (`status: "processing"` / `"active"`) and `agent_session_stopped`.
- **Who may act on the agent surface (same rules as `slack start`)**: `hive-slack-agent.js` checks every sender with the same `makeSlackActorCheck` rules. Any full workspace member may `stop` / `stop all` (or press Slack's native stop button); if Slack's `users.info` is down it still stops, and says `(stopped; I could not confirm who you are)`. `resume` needs the sender's member ID in `--allow <U123,U456>` (or `SLACK_ALLOW`). Guests and users from other workspaces are refused for everything, `status` included, and are told so in the thread; the room's tasks are never streamed to them. At startup it needs your workspace id from `auth.test` (refused with `Q634` if Slack omits it). A typed message counts only in the configured `--channel` or in a DM with the app (each user's own assistant DM is answered in that DM); messages from any other channel the bot is in are ignored.
- **Official Slack requirements for `hive-slack-agent.js`**:
  - **Bot Token Scopes**: `chat:write` ([`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream)), `assistant:write` ([`agents.sessions.setStatus`](https://docs.slack.dev/reference/methods/agents.sessions.setStatus) and [`agent_session_stopped`](https://docs.slack.dev/reference/events/agent_session_stopped)), `im:history`, `im:read`, `im:write` ([Developing AI Apps](https://docs.slack.dev/ai/developing-ai-apps)), plus `channels:read`, `groups:read`, `channels:history`, `groups:history`, `users:read`.
  - **Bot Events**: `agent_session_stopped` ([`agent_session_stopped` event](https://docs.slack.dev/reference/events/agent_session_stopped)), `assistant_thread_started`, `assistant_thread_context_changed`, `message.im`, `message.channels`, `message.groups`.
  - **App Settings**: `features.assistant_view` (`assistant_description` and `suggested_prompts`) and `settings.socket_mode_enabled: true` ([Agent Sessions](https://docs.slack.dev/ai/agent-sessions)).
  - **Startup & `slack check --agent` verification**:
    - At startup, `hive-slack-agent.js` (`preflightSlackAgent`) checks `x-oauth-scopes` from `auth.test` via `checkAgentScopes` and refuses with `Q634` (naming missing scopes such as `assistant:write, im:history` and `slack-app-manifest-agent.json`) before opening Socket Mode.
    - Running `SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack check --channel D0123456789 --agent` verifies those scopes, posts a check message (`checkTs`), and calls `agents.sessions.setStatus({ status: 'processing', channel_id, thread_ts: checkTs })`. Per Slack's [`agent_session_stopped` docs](https://docs.slack.dev/reference/events/agent_session_stopped), if your app is not subscribed to `agent_session_stopped`, Slack returns a `missing_agent_session_stopped_event_subscription` warning (checked in both top-level `warning` and `response_metadata.warnings[]`) and renders a non-interactive spinner instead of the stop button; `slack check --agent` catches that warning (as well as `feature_disabled` and `thread_ts_required`) and refuses with `Q634`. On every exit path (pass, fail, timeout, or `Ctrl+C`), `slack check --agent` clears the session status back to `active` in a `finally` block so the DM is never left spinning.
    - *(Note: `features.assistant_view` and `suggested_prompts` control the top-bar split-view UI in Slack and cannot be probed via a Web API read call; installing from `slack-app-manifest-agent.json` configures them declaratively.)*

<details>
<summary><strong>Optional Paid-Plan AI Agent Surface Manifest (<code>slack-app-manifest-agent.json</code>)</strong></summary>

Paste the contents of [`slack-app-manifest-agent.json`](../slack-app-manifest-agent.json):

```json
{
  "display_information": {
    "name": "Hivecode",
    "description": "AI agent panel, native stop button, and one Slack thread per task or GitHub issue.",
    "background_color": "#111318"
  },
  "features": {
    "bot_user": {
      "display_name": "Hivecode",
      "always_online": true
    },
    "assistant_view": {
      "assistant_description": "Inspect live Hivecode rooms, stream task plans, and halt or resume AI agents from Slack.",
      "suggested_prompts": [
        {
          "title": "What is running?",
          "message": "status"
        },
        {
          "title": "Stop everything",
          "message": "stop all"
        },
        {
          "title": "What happened overnight?",
          "message": "what happened overnight"
        }
      ]
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "assistant:write",
        "im:history",
        "im:read",
        "im:write",
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
        "agent_session_stopped",
        "assistant_thread_started",
        "assistant_thread_context_changed",
        "message.im",
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

## 7. Troubleshooting (`Q510` – `Q521`, `Q630` – `Q634`)

| Code | Cause | Fix |
| :--- | :--- | :--- |
| **`Q510`** | `hive-mcp-http.js` started in `--auth slack` mode without `SLACK_SIGNING_SECRET`. | Copy your app's **Signing Secret** from **Basic Information → App Credentials** in Slack app settings and set `SLACK_SIGNING_SECRET` (or use `--auth none` on `localhost` only). |
| **`Q511` – `Q513`** | HTTP request to `hive-mcp-http.js` is unsigned (`Q511`), outside the 5-minute replay window (`Q512`), or its HMAC signature does not match (`Q513`). | Ensure `SLACK_SIGNING_SECRET` matches the Slack app calling the endpoint and that the host clock is synced via NTP. |
| **`Q514` - `Q521`** | `hive-mcp-http.js` answered a request it could not act on: `Q514` no participant of that name is in the room; `Q515` unknown tool; `Q516` a tool failed; `Q517` JSON-RPC method not supported; `Q518` the endpoint takes `POST` only; `Q519` request body too large; `Q520` body is not JSON; `Q521` refused by the Slack actor check (guest, other workspace, or not in `--allow`). | `Q514`: use a name from the "Here now" list in the same message. `Q515`/`Q517`: call a tool listed above (`hive_status`, `hive_members`, `hive_tasks`, `hive_claims`, `hive_recent`, `hive_pause`, `hive_resume`, `hive_say`). `Q518`/`Q520`: send a JSON-RPC `POST`. `Q519`: send a smaller body. `Q521`: add the Slack member ID to `--allow` (resume / say), or ask a full workspace member. `Q516`: read the message after it; it names the failure. |
| **`Q630`** | `SLACK_BOT_TOKEN` is missing (required by `slack start` and by `hive-mcp-http.js` in `--auth slack` mode), invalid (`invalid_auth`), or revoked (`token_revoked`) when checked against Slack `auth.test`. | Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** in your Slack app settings and set `SLACK_BOT_TOKEN` in the same terminal session. |
| **`Q631`** | `--channel` is missing, `channel_not_found`, or `@Hivecode` has not been invited to the channel (`is_member: false` / `not_in_channel`). | Open the target channel in Slack and run `/invite @Hivecode`. If it is a private channel, ensure the app has `groups:read` scope and reinstall to workspace. |
| **`Q632`** | Another `SlackBridge` with the same `--name` is already connected to this room. | Stop the existing `slack start` process before starting a new one so events are not posted twice. |
| **`Q633`** | `--slack-channel` was passed to `github start`, but `SLACK_BOT_TOKEN` is not set in the environment. | Set `SLACK_BOT_TOKEN=xoxb-…` (or `$env:SLACK_BOT_TOKEN="xoxb-…"` in PowerShell) before running `github start --slack-channel`. |
| **`Q634`** | Inbound Slack configuration cannot work safely: (1) `SLACK_APP_TOKEN` (`xapp-…`) is missing or rejected by `apps.connections.open`; (2) `--slack-allow` was passed to `github start` without `--slack-channel`, without `SLACK_APP_TOKEN`, or with usernames instead of member IDs (`U…`); or (3) Slack `auth.test` did not return a workspace `team_id` (in `github start` or `hive-mcp-http.js`), so external workspaces could not be refused. | Enable **Socket Mode** and set `SLACK_APP_TOKEN=xapp-…` (`connections:write` scope); pass Slack member IDs (`U…` from **Profile → `⋯` → Copy member ID**) to `--slack-allow` / `--allow`; or pass `--team <T…>` (`SLACK_TEAM_ID`) / reinstall the Slack app if `auth.test` omitted `team_id`. |
