# Deploy the relay (permanent address, no more tunnels)

Goal: run `server.js` in the cloud so it has a fixed URL like
`wss://livecode-relay.onrender.com`. Then you never touch cloudflared again —
everyone just connects to that address.

You only deploy ONCE. After that it stays up.

---

## Option A — Render (recommended, no command line)

1. Put this project on GitHub:
   - Create a free account at https://github.com
   - Create a new empty repository (e.g. `livecode`).
   - In this folder, run:
     ```
     git init
     git add .
     git commit -m "livecode relay"
     git branch -M main
     git remote add origin https://github.com/<you>/livecode.git
     git push -u origin main
     ```
2. Go to https://render.com, sign up (free), click **New > Web Service**.
3. Connect your GitHub and pick the `livecode` repo.
4. Render reads `render.yaml` automatically. Just click **Create Web Service**.
5. Wait ~2 min. You get a URL like `https://livecode-relay.onrender.com`.
   Your relay address is the same with `wss://`:
   ```
   wss://livecode-relay.onrender.com
   ```

Note: the FREE Render service sleeps after ~15 min idle (first connection then
takes ~30s to wake). Fine for testing. For real use, switch it to a paid
instance (~$7/mo) so it never sleeps.

---

## Option B — Fly.io (command line, no GitHub needed)

1. Install flyctl: https://fly.io/docs/hctl/install/
2. In this folder:
   ```
   fly launch        # accept defaults; it detects the Dockerfile
   fly deploy
   ```
3. Your relay is at `wss://<app-name>.fly.dev`.

---

## Using the hosted relay

Once you have the address, nobody needs cloudflared. Host a session with:

```
node go.js host ./workspace Jeevan --relay wss://livecode-relay.onrender.com
```

It prints the join line (with that relay baked in) for your friend, exactly
like before — but now the address never changes and your laptop doesn't have
to be the server.

Friend joins normally:
```
node go.js join wss://livecode-relay.onrender.com room-XXXX ./workspace Friend
```

---

## Quick check it's alive

Open the `https://...` version of your relay URL in a browser. You should see:
```
livecode relay is up. Connect a client to ws://<this-host>:PORT/<room>
```
