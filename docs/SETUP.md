# livecode — setup & run

Multiplayer for AI coding. Two people (and AI agents) edit the same project
folder live, across the internet. No git push/pull in the loop.

Your IDE does not matter — this syncs files on disk, so one person can use
Antigravity and the other VS Code; both auto-reload changed files.

---

## A) HOST laptop (Jeevan) — you already have the project

You only do the install steps once.

1. Install Node.js (once): https://nodejs.org (LTS), or:
   ```
   winget install OpenJS.NodeJS.LTS
   ```
2. Install cloudflared (once) — this makes your relay reachable over the internet:
   ```
   winget install --id Cloudflare.cloudflared
   ```
3. In the project folder, install dependencies (once):
   ```
   npm install
   ```
4. Put the code you want to share into a folder named `workspace`
   (create it if needed). Anything in there gets shared.

5. Start a session:
   ```
   node go.js host ./workspace Jeevan
   ```
   It prints a box with a command like:
   ```
   node go.js join wss://xxxx.trycloudflare.com room-ab12cd ./workspace Friend
   ```
   Send that whole line to your friend (WhatsApp/Telegram/email).

Keep this terminal open — closing it ends the session.

---

## B) FRIEND laptop — first-time setup

1. Install Node.js (once): https://nodejs.org (LTS), or:
   ```
   winget install OpenJS.NodeJS.LTS
   ```
2. Get the project files from Jeevan:
   - Jeevan zips the project folder **without** `node_modules` and sends it.
   - Unzip it anywhere, e.g. `Desktop\livecode`.
3. Open a terminal in that folder and install dependencies (once):
   ```
   npm install
   ```
   (The friend does NOT need cloudflared.)

4. Join the session — paste the exact line Jeevan sent you:
   ```
   node go.js join wss://xxxx.trycloudflare.com room-ab12cd ./workspace Friend
   ```
   Your `workspace` folder will fill up with Jeevan's project. Open that
   folder in VS Code and start editing.

---

## C) Add an AI agent (either laptop)

The host's box also prints an agent line. Run it in a new terminal:
```
node agent-coord.js wss://xxxx.trycloudflare.com room-ab12cd MyAI
```

---

## Notes / gotchas

- The `wss://...trycloudflare.com` address changes every time the host
  restarts the session. Just resend the new join line.
- The host's laptop must stay on for the session to work (it runs the relay).
- Edits sync within ~1 second. Save the file to push your changes.
- node_modules, .git, binary files, and files over 1 MB are not synced.
