# Always on: agents that work while your laptop is closed

The GitHub watcher (`npx -y hivecode-mcp@latest github start`) does its work on the machine it runs
on. When that is a laptop and the lid closes, everything pauses: no issue is picked up, and a run in
progress stops. On wake, the watcher pushes each deadline back by the time it was asleep, so nothing
is killed for time it never had. But nothing happens overnight either.

For "your agents keep working after you go home", run the watcher on a machine that stays on.

## What the machine needs

- Node.js 18 or newer, git, and the [GitHub CLI](https://cli.github.com).
- An agent CLI that runs headless, such as [Claude Code](https://docs.claude.com/en/docs/claude-code).
- A clone of your repository.
- `npx -y hivecode-mcp@latest setup`, run once, so the agent has its Hivecode tools.

Logins on a machine with no browser:
- **GitHub:** `gh auth login --with-token < token.txt`, using a fine-grained token with access to
  this repository only. It needs read and write on contents, issues and pull requests, and read on
  actions and checks.
- **The agent:** follow its own instructions for a server. Claude Code takes an API key
  (`ANTHROPIC_API_KEY`) from the environment.
- **Slack (optional):** if `--slack-channel` was saved on your test start, `SLACK_BOT_TOKEN` must be
  available in the environment (and `SLACK_APP_TOKEN` if using `--slack-allow`).

---

## The exit-code contract

The watcher (`github start`) reports its exit reason via standardized process exit codes:

| Exit code | Meaning | Service action |
|---|---|---|
| `0` | Clean stop (Ctrl+C, SIGTERM, normal exit) | Do not restart. |
| `1` | Transient failure (boot-time network glitch, `Q603 could not reach GitHub`, transient API drop, unexpected crash) | **Restart.** |
| `2` | Permanent refusal (`Q600` gh not logged in, `Q601` push denied, `Q602` agent not on PATH, `Q605` lock held, `Q633` missing bot token, invalid CLI flags) | **Do not restart.** |

> **Note:** The 0/1/2 exit-code contract was introduced in `hivecode-mcp@0.13.0`. Older versions (such as `0.12.4`) exited `1` for all errors, causing systemd's `RestartPreventExitStatus=2` to be bypassed and falling back on `StartLimit` rate-limiting alone.

Configuring your service to distinguish exit `1` from exit `2` prevents infinite restart loops when a lock is held or credentials are missing.

---

## Linux (systemd service)

First, run the watcher once by hand with your options in the clone to verify it and save settings:

```bash
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --test "npm test"
```

Stop it with Ctrl+C. The options are now saved in the clone's `.git/hivecode/github.json` file.

### 1. Store secrets in an EnvironmentFile (never in the unit file)

Never put API tokens directly into a `.service` file: unit files are typically readable by any user on
the system and leak into `systemctl show`.

Create an environment file readable only by the service user:

```bash
sudo mkdir -p /etc/hivecode
sudo touch /etc/hivecode/watcher.env
sudo chown hive:hive /etc/hivecode/watcher.env
sudo chmod 600 /etc/hivecode/watcher.env
```

Add your credentials to `/etc/hivecode/watcher.env`:

```ini
ANTHROPIC_API_KEY=sk-ant-api03-...
# Optional: if using Slack threads
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### 2. Discover binary paths

systemd runs with a minimal `PATH` that does not include user-installed tools (`nvm`, `fnm`, or
`~/.local/bin`). Run this as the service user to find the exact locations of `npx`, `claude`, and `gh`:

```bash
sudo -u hive -i command -v npx claude gh
```

Copy the directory paths containing these binaries into the `Environment="PATH=..."` line below.

### 3. Create the systemd unit

Write `/etc/systemd/system/hivecode-watcher.service`. Pin the version of `hivecode-mcp` you tested:

```ini
[Unit]
Description=Hivecode GitHub watcher
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=hive
WorkingDirectory=/home/hive/your-repo
EnvironmentFile=/etc/hivecode/watcher.env
Environment="PATH=/home/hive/.nvm/versions/node/v20.18.0/bin:/home/hive/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/hive/.nvm/versions/node/v20.18.0/bin/npx -y hivecode-mcp@<the version you tested> github start
Restart=on-failure
RestartSec=30
RestartPreventExitStatus=2

[Install]
WantedBy=multi-user.target
```

Key settings:
- `Restart=on-failure` with `RestartPreventExitStatus=2`: restarts if the network drops (exit 1), but halts immediately on permanent refusals like missing tokens or lock collisions (exit 2).
- `StartLimitIntervalSec=300` and `StartLimitBurst=5`: rate-limits unexpected crash loops to 5 attempts per 5 minutes.

Enable and inspect:

```bash
sudo systemctl enable --now hivecode-watcher
journalctl -u hivecode-watcher -f
```

---

## macOS (launchd LaunchAgent)

Run the watcher as a user LaunchAgent so it has access to user keychain credentials, git logins, and developer tools.

### 1. Store secrets in an environment file (never in the plist)

`launchd` runs as a system process outside your interactive shell, so it does **not** source `~/.zshrc` or `~/.bash_profile`. Putting API keys directly into the `.plist` file leaves them in plaintext in `~/Library/LaunchAgents`.

Instead, create an environment file owned by you with mode `0600`:

```bash
mkdir -p ~/.config/hivecode
touch ~/.config/hivecode/watcher.env
chmod 600 ~/.config/hivecode/watcher.env
```

Add your keys to `~/.config/hivecode/watcher.env`:

```ini
ANTHROPIC_API_KEY=sk-ant-api03-...
SLACK_BOT_TOKEN=xoxb-...
```

*(Alternatively, macOS Keychain can supply secrets dynamically: `security find-generic-password -w -s "anthropic-api-key"`.)*

### 2. Create the wrapper script

Create `~/.config/hivecode/run-watcher.sh` (`chmod 700 ~/.config/hivecode/run-watcher.sh`):

```bash
#!/bin/bash
set -a
[ -f "$HOME/.config/hivecode/watcher.env" ] && . "$HOME/.config/hivecode/watcher.env"
set +a
exec /usr/local/bin/npx -y hivecode-mcp@<the version you tested> github start
```

### 3. Create the LaunchAgent plist

Create `~/Library/LaunchAgents/com.hivecode.watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hivecode.watcher</string>
    <key>WorkingDirectory</key>
    <string>/Users/youruser/your-repo</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/youruser/.config/hivecode/run-watcher.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>/Users/youruser/Library/Logs/hivecode-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/youruser/Library/Logs/hivecode-watcher.err</string>
</dict>
</plist>
```

> **Note on launchd restart policy:** Unlike systemd, `launchd` does not have a filter like `RestartPreventExitStatus`; `KeepAlive` with `SuccessfulExit: false` restarts on any non-zero exit code. Set `ThrottleInterval` to at least `60` seconds so a permanent error does not burn CPU, and check `~/Library/Logs/hivecode-watcher.err` if the service stops making progress.

Load and monitor:

```bash
launchctl load ~/Library/LaunchAgents/com.hivecode.watcher.plist
tail -f ~/Library/Logs/hivecode-watcher.err
```

To stop: `launchctl unload ~/Library/LaunchAgents/com.hivecode.watcher.plist`.

---

## Windows (Task Scheduler at Logon)

Run the watcher as a scheduled task at user logon. Do not run it as an isolated Windows Service (Session 0), which lacks user credential managers and interactive desktop configurations.

### 1. Set user environment variables (never put keys in scripts)

Do not put API tokens inside `.cmd` or `.ps1` files. Set them as per-user environment variables in Windows Settings (System > About > Advanced system settings > Environment Variables), or via PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-api03-...", "User")
```

The logon task inherits these variables automatically. The wrapper script contains no secrets.

### 2. Create the runner wrapper

Because Task Scheduler's native retry triggers do not inspect process exit codes, create a wrapper script that enforces the rule: **halt only on clean stop (0) and permanent refusal (2); retry on everything else**.

Save as `%USERPROFILE%\.hivecode\run-watcher.cmd`:

```bat
@echo off
setlocal
cd /d "C:\path\to\your-repo"

:loop
call npx -y hivecode-mcp@<the version you tested> github start >> "%USERPROFILE%\.hivecode\watcher.log" 2>&1
set "CODE=%ERRORLEVEL%"

if %CODE% EQU 0 (
  echo [%DATE% %TIME%] Watcher stopped cleanly (exit 0). >> "%USERPROFILE%\.hivecode\watcher.log"
  exit /b 0
)

if %CODE% EQU 2 (
  echo [%DATE% %TIME%] Watcher permanent refusal (exit 2). Halting service. Check logs above. >> "%USERPROFILE%\.hivecode\watcher.log"
  exit /b 2
)

echo [%DATE% %TIME%] Watcher exited with code %CODE%. Retrying in 30s... >> "%USERPROFILE%\.hivecode\watcher.log"
timeout /t 30 /nobreak >nul
goto loop
```

### 3. Register the task (requires Administrator elevation)

> **Elevation required:** Open Command Prompt or PowerShell with **Run as administrator**. Registering a task via `schtasks` modifies `%SystemRoot%\System32\Tasks`; running from a standard (unelevated) prompt fails with `ERROR: Access is denied.`

```cmd
schtasks /Create /TN "HivecodeWatcher" /TR "cmd /c %USERPROFILE%\.hivecode\run-watcher.cmd" /SC ONLOGON /RL LIMITED
```

Inspect output with:

```cmd
type %USERPROFILE%\.hivecode\watcher.log
```

---

## Power and sleep settings

The watcher pauses when the operating system enters sleep. Ensure sleep is disabled when plugged in:

- **Linux:** Server installations typically do not suspend. On desktop Linux, mask sleep targets if needed:
  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```
- **macOS:** In **System Settings > Energy Saver** (or **Displays**), enable **Prevent automatic sleeping when the display is off**. Alternatively, run `caffeinate -s`.
- **Windows:** In **Settings > System > Power & battery**, set **When plugged in, put my device to sleep after** to **Never**.

---

## Status check

Regardless of operating system, you can inspect watcher state from inside the repository clone at any time:

```bash
npx -y hivecode-mcp@latest github status
```

---

## What can go wrong

| what goes wrong | what happens |
|---|---|
| Transient boot network failure (exit 1) | The service waits 30 seconds and retries automatically. |
| Two copies start (exit 2) | The second copy refuses immediately (`Q605`: one watcher per clone) and does not restart. |
| Missing API keys or tokens (exit 2) | The watcher halts with `Q600` or `Q633` and logs the remediation fix. |
| Agent not on PATH (exit 2) | The watcher halts with `Q602` without looping. Check binary directories with `command -v`. |
| `@latest` changes under a running service | Pin a version in the service file (e.g. `hivecode-mcp@<the version you tested>`), as above, and upgrade on purpose. |
| The GitHub token expires | The watcher stops asking and logs `Q600` in the service log. |
| The agent's credits run out | Each issue fails once, waits 15 minutes, fails again, and transitions to `hivecode:needs-human` with the agent's explanation. |
| The disk fills | Finished issue rooms are removed automatically; only the last failed run's directory is preserved for inspection. |
| Service user privileges | An agent can execute commands as the service user. Use a dedicated user (`hive`) with access only to the project repository. |
