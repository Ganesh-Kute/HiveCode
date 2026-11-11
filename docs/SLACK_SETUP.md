# Slack Setup

Hivecode connects Slack and your swarm rooms so humans and agents collaborate where they already work.

There are two ways to connect:
1. **Relay Connection (`slack connect`) — Recommended (2 minutes):** Zero processes running on anyone's machine. The relay securely routes events between Slack and the room.
2. **Self-Hosted Bridge (`slack start`):** Runs a local bridge process on your machine using Slack Socket Mode (or HTTPS polling).

---

## 1. Fast Setup with `slack connect` (Under 2 Minutes, Zero Local Processes)

With `slack connect`, you don't need to keep a terminal running or worry about laptops sleeping. The Hivecode relay handles event routing directly between Slack webhooks and room state.

### Step 1: Run `slack connect` & Create the App from the Manifest
Run the connect command with your room link:
```bash
npx -y hivecode-mcp@latest slack connect "wss://livecode-xoss.onrender.com|room-<id>"
```
*(On Windows PowerShell, quote the room link as shown).*

The CLI contacts the relay (`POST /slack/prepare`), generates a dedicated connection ID and event URL (`https://<relay>/slack/events/<id>`), and outputs a ready-to-paste Slack application manifest:
1. Open [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From a manifest**.
2. Select your Slack workspace and switch to the **JSON** tab.
3. Paste the JSON manifest printed in your terminal and click **Next** → **Create**.
4. Click **Install to Workspace** and authorize the bot.

The manifest configures:
- **Bot Scopes**: `chat:write`, `channels:read`, `groups:read`, `channels:history`, `groups:history`, `users:read`.
- **Event Subscriptions**: `message.channels`, `message.groups` pointing directly to your relay's `/slack/events/<id>` URL.
- **No Socket Mode required** (no `xapp-…` token needed).

### Step 2: Invite `@Hivecode` to Your Channel
In Slack, open the channel you want to bridge and invite the newly created bot:
```text
/invite @Hivecode
```

### Step 3: Enter Tokens & Select Channel
Now return to your terminal. The CLI securely prompts for your credentials (input is hidden with no terminal echo):
1. **Bot User OAuth Token (`xoxb-…`)**: In Slack app settings under **OAuth & Permissions**, copy the Bot User OAuth Token.
2. **Signing Secret**: Under **Basic Information → App Credentials**, copy the Signing Secret.
*(Alternatively, you can provide them via environment variables `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`).*

3. **Choose Channel**:
   The CLI queries the channels the bot belongs to. Since you invited the bot in Step 2, your channel appears immediately. If running in an interactive terminal, it lists them for you to pick. In non-interactive environments, pass `--channel <id>` (or if the bot is in only one channel, that channel is selected automatically).

### Step 4: Done!
The relay verifies the bot token with `auth.test`, validates channel membership, stores the credentials encrypted (`AES-256-GCM` using `HIVE_SLACK_KEY`), and posts:
`✓ Slack is connected to this room (#channel)` in both the Slack channel and the room.

### Disconnecting
To remove the connection and wipe the stored credentials from the relay:
```bash
npx -y hivecode-mcp@latest slack disconnect "wss://livecode-xoss.onrender.com|room-<id>"
```
Only the holder of the same `SLACK_SIGNING_SECRET` can disconnect the room.

---

## 2. What Gets Posted (and What Is Scrubbed)

Hivecode posts room activity into Slack and forwards Slack messages into the room:

| Source | Posting Model | Description |
| :--- | :--- | :--- |
| **Relay Connection (`slack connect`)** | Direct channel messages | Each room chat line is posted directly into the channel with `chat.postMessage`, and messages posted in Slack are added to room chat. |
| **Room Bridge (`slack start`)** | One thread per task | Dedicated threads for tasks (`task-open` and `task-done` broadcast to channel), plus a shared room thread for untasked chatter. |
| **GitHub Watcher (`--slack-channel`)** | One thread per issue | Issue threads with broadcast replies for PR ready, waiting on human, and merged/closed. |

- **Security & Scrubbing**: Before lines leave the relay, API keys and tokens are scrubbed, and the room ID is replaced with `[room]`.
- **Deduplication & Deadlines**: The relay acknowledges Slack event webhooks (`HTTP 200`) immediately to satisfy Slack's 3-second deadline, deduplicates `X-Slack-Retry-Num` and `event_id`, and avoids echoing bot or Slack-origin messages.
- **Attribution**: Messages originating from Slack are attributed in room chat as `slack:<handle>` (e.g. `slack:ganesh`), preventing impersonation of local room participants.

---

## 3. Controlling Agents from Slack

Full workspace members can control agents directly from Slack:
- **`stop` / `pause` / `halt`** (or `stop all`, `stop <AgentName>`): Pauses agents on their clients immediately.
- **`resume` / `unpause`** (or `resume all`, `resume <AgentName>`): Resumes paused agents.

---

## 4. Self-Hosted Fallback (`slack start`)

If you run your own private relay or prefer running a dedicated local bridge process on your machine, use `slack start`:

### Setup Steps:
1. Create a Slack app using [`slack-app-manifest-inbound.json`](../slack-app-manifest-inbound.json) with Socket Mode enabled.
2. Under **Basic Information → App-Level Tokens**, create an app token with `connections:write` scope (`SLACK_APP_TOKEN=xapp-…`).
3. Under **OAuth & Permissions**, copy `SLACK_BOT_TOKEN=xoxb-…`.
4. Invite `@Hivecode` to your channel (`/invite @Hivecode`).
5. Run the bridge:

**macOS / Linux:**
```bash
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack start "wss://relay|room-…" --channel C0123456789
```

**Windows (PowerShell):**
```powershell
$env:SLACK_BOT_TOKEN="xoxb-…"
$env:SLACK_APP_TOKEN="xapp-…"
npx -y hivecode-mcp@latest slack start "wss://relay|room-…" --channel C0123456789
```

### Preflight Check (`slack check`)
You can test your tokens, channel permissions, and Socket Mode connectivity anytime:
```bash
SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack check --channel C0123456789
```

### Self-Hosted Manifest Templates

#### 1. Outbound Manifest (`slack-app-manifest.json`)
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

#### 2. Inbound Socket Mode Manifest (`slack-app-manifest-inbound.json`)
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

#### 3. Agent Surface Manifest (`slack-app-manifest-agent.json`)
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

---

## 5. Troubleshooting Reference

For complete error explanations and remedies, refer to [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

| Code | Component | Cause & Remedy |
| :--- | :--- | :--- |
| **`Q660`** | Relay | `HIVE_SLACK_KEY` encryption key is not configured on the relay (HTTP 503). Set a 32-byte hex secret on the relay server. |
| **`Q661`** | Relay / CLI | Connection ID is unknown or expired. Re-run `slack connect`. |
| **`Q662`** | CLI / Relay | Slack rejected the bot token (`auth.test` failed). Ensure token begins with `xoxb-` and the app is installed. |
| **`Q663`** | Relay | Bad Slack signature or timestamp outside 5-minute replay window (HTTP 401). Verify Signing Secret. |
| **`Q664`** | Relay | Bot is not in the channel. In Slack, run `/invite @Hivecode` in the target channel. |
| **`Q665`** | CLI | Invalid room join link syntax provided to `slack connect` or `slack disconnect`. |
| **`Q666`** | CLI | Network failure reaching relay HTTP endpoint. |
| **`Q667`** | CLI | Required `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` was not provided. |
| **`Q668`** | CLI | Bot is in no channel (run `/invite @Hivecode`), or multiple channels without `--channel` in non-interactive mode. |
| **`Q630`** | `slack start` | `SLACK_BOT_TOKEN` missing or revoked. |
| **`Q631`** | `slack start` | Bot not invited to `--channel`. Run `/invite @Hivecode`. |
| **`Q632`** | `slack start` | Another bridge with the same name is already running in this room. |
| **`Q634`** | `slack start` | Missing `SLACK_APP_TOKEN` (`xapp-…`) or required scopes for Socket Mode. |
| **`Q635`** | `slack start` | Multiple active processes sharing the same `SLACK_APP_TOKEN`. |
