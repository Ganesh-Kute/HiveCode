# Publishing Hivecode to the VS Code Marketplace

This is the one-time setup + the repeatable publish flow. Goal: anyone can find
"Hivecode" in the Extensions panel and install with one click.

The extension lives in [`extension/`](extension/); its listing page is
[`extension/README.md`](extension/README.md); the icon is
[`extension/resources/icon.png`](extension/resources/icon.png).

---

## One-time setup (≈15 min)

### 1. Create a publisher
The `package.json` uses `"publisher": "hivecode"`. You must own that id.

1. Go to https://marketplace.visualstudio.com/manage and sign in with a Microsoft
   account.
2. **Create publisher** → set the ID to `hivecode` (if taken, pick another and
   update `"publisher"` in `extension/package.json`). Display name: `Hivecode`.

### 2. Get a Personal Access Token (PAT)
The token authorizes `vsce` to publish on your behalf.

1. Go to https://dev.azure.com → sign in with the **same** Microsoft account.
2. User settings (top-right) → **Personal access tokens** → **New Token**.
3. Organization: **All accessible organizations**.
   Scopes: **Custom defined** → expand **Marketplace** → check **Manage**.
   Expiry: up to 1 year.
4. Copy the token (you only see it once). Keep it out of git.

### 3. Log in locally
```bash
cd extension
npx vsce login hivecode      # paste the PAT when prompted
```

---

## Publish

```bash
cd extension
npx vsce package             # builds hivecode-<version>.vsix locally (sanity check)
npx vsce publish             # uploads to the Marketplace
```

To bump the version and publish in one step: `npx vsce publish patch` (or
`minor` / `major`). Live within a few minutes at:
`https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode`

### Also publish to Open VSX (Cursor / Windsurf / VSCodium users)
The VS Code Marketplace doesn't serve those editors. Open VSX does.

1. Sign in at https://open-vsx.org with GitHub, create an access token.
2. ```bash
   npx ovsx create-namespace hivecode -p <openvsx-token>   # one-time
   npx ovsx publish hivecode-<version>.vsix -p <openvsx-token>
   ```

---

## Pre-publish checklist
- [ ] `extension/README.md` reads well — it **is** the Marketplace page.
- [ ] `extension/resources/icon.png` exists (128×128, referenced in `package.json`).
- [ ] `version` bumped in `extension/package.json` (Marketplace rejects a re-publish
      of the same version).
- [ ] `repository`, `homepage`, `bugs` URLs are correct.
- [ ] `npx vsce package` produces a clean `.vsix` with no warnings you care about.
- [ ] Installed the local `.vsix` once (`code --install-extension hivecode-x.y.z.vsix`)
      and smoke-tested host → invite → join.
- [ ] Relay (`livecode-xoss.onrender.com`) is deployed with the matching protocol
      version, so a freshly-installed user can actually connect.

## Notes
- The relay also serves the landing page at `/` — pushing `server.js` +
  `public/index.html` redeploys both.
- Keep the extension's relay default (`hivecode.relayUrl`) pointing at the live
  relay so a new install works with zero config.
