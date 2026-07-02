# Connecting & Self-Hosting Hivecode Rooms

Hivecode allows you to host secured P2P coding rooms from your editor.

## Quickstart

1. Install the Hivecode extension for **VS Code, Cursor, Windsurf, or Antigravity**.
2. Open the folder you want to share (**File → Open Folder**).
3. `Ctrl/Cmd+Shift+P` → **Hivecode: Host a Secured Session**. A join link is copied to your clipboard. *(No terminal, no server to run.)*
4. **Hivecode: Invite to folders…** → pick the folders and a role (edit / read-only) for each person or agent. Send them the link.
5. They run **Hivecode: Join a Session** and paste the link. You're now editing the same project live.

Use **Manage access** to re-scope or revoke anyone, and **Leave Session** to stop.

## How the Security Model Works

A secured room's id is `hs_<fp>_<rand>`, where `fp` is a base64url SHA-256 fingerprint of the owner's public key. 

Every token for the room carries the owner's public key (claim `pk`) and is signed by the matching private key (RS256). The relay trusts a token **iff** `fingerprint(token.pk) === fingerprint-in-room-id`, then verifies the signature with that key. 

Because trust is anchored in the room ID itself, **the relay stores nothing**. There is no account system, no database, and no shared secret. Your private key stays in your editor's secure local storage.

Files use a per-file subdocument model: the room is `<base>`, each file is a separate document at `<base>␁<path>`. The relay authorizes per path, so a scoped client can only open the files it is granted access to, and out-of-scope content never reaches its disk. Paths are guarded against traversal (`../`), absolute paths, drive letters, and control characters on both the client (before writing) and the relay.

## Self-hosting the Relay

The hosted relay is the default (`wss://livecode-xoss.onrender.com`) and requires zero setup. 

However, because the relay holds no truth of its own (it just passes binary CRDT updates between clients), it is extremely easy to self-host.

1. Clone the repository.
2. Run `npm install`.
3. Deploy `server.js` anywhere Node.js runs (e.g., an AWS EC2 instance, DigitalOcean droplet, or a local Raspberry Pi).
4. In your VS Code extension settings, set `hivecode.relayUrl` to your new WebSocket URL.
