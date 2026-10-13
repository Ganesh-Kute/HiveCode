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
- **The agent:** follow its own instructions for a server. Claude Code, for example, takes an API
  key from the environment.

## Run it as a service (Linux, systemd)

First, start it once by hand with your options, in the clone:

```bash
npx -y hivecode-mcp@latest github start --agent "claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode" --test "npm test"
```

Stop it with Ctrl+C. The options are now saved in the clone's `.git` folder, so the service needs
none of them:

```ini
# /etc/systemd/system/hivecode-watcher.service
[Unit]
Description=Hivecode GitHub watcher
After=network-online.target
Wants=network-online.target

[Service]
User=hive
WorkingDirectory=/home/hive/your-repo
ExecStart=/usr/bin/npx -y hivecode-mcp@<the version you tested> github start
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hivecode-watcher
```

```bash
journalctl -u hivecode-watcher -f
```

`npx -y hivecode-mcp@latest github status`, run in the clone, shows what it is doing.

## What can go wrong

| what goes wrong | what happens |
|---|---|
| The service restarts mid-run | The run in progress counts as failed and is tried again. Its agent's processes are killed first. |
| Two copies start (a second service, or you run it by hand too) | The second refuses to start: one watcher per clone. |
| `@latest` changes under a running service | Pin a version in the service file, as above, and upgrade on purpose. |
| The GitHub token expires | The watcher stops asking and says why (Q600) in the journal. With `--notify`, check the channel. |
| The agent's login or credits run out | Each issue fails once, waits 15 minutes, fails again, and goes to `hivecode:needs-human` with the agent's own words. |
| The disk fills | Rooms of finished issues are deleted; only the last failed run's folder is kept, for you to read. |
| The machine can read everything the agent can | An agent can run anything its user can. Give the service its own user, and nothing on the machine you would not hand to the agent. |

## A desktop that stays on

The same command in a terminal works. Turn off sleep for when it is plugged in. On Windows that is
Settings, then System, then Power, then "When plugged in, put my device to sleep after": Never.

## Hosted agents

Hosting the agents themselves, so that neither a laptop nor a server of yours has to stay on, is
the next step. It is not built yet.
