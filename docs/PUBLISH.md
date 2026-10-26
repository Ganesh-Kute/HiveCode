# Release Runbook: Publishing Hivecode (`hivecode-mcp`)

Runbook for Ganesh executing releases from `C:/Users/G1/Desktop/N`.

---

## Step 0: Merge `team` to `main`

The working branch during collaboration is `team` (in the `N-claude` worktree).

> **Note:** Claude prepares the exact commands to bring `team` to `main` at release time (one commit to drop). Do not invent this merge flow yourself.

Once `main` is updated and active in `C:/Users/G1/Desktop/N`, proceed with the steps below.

---

## Step 1: Run Pre-Release Quality & Deploy Gates

Run the verification suites against the repository:

```bash
npm --prefix C:/Users/G1/Desktop/N test
node C:/Users/G1/Desktop/N/scripts/sync-engine.mjs --check
node C:/Users/G1/Desktop/N/scripts/check-files.mjs
node C:/Users/G1/Desktop/N/scripts/check-deploy.mjs
node C:/Users/G1/Desktop/N/tests/site-cli-usage-test.mjs
node C:/Users/G1/Desktop/N/tests/readme-promises-test.mjs
```

### How to Tell It Worked
- `test`: exits with `ok` for all unit and integration tests.
- `sync-engine`: prints `=== ENGINE IN SYNC: 8 files identical (root <-> packages/icr-merge) ===`.
- `check-files`: prints `=== PACKAGE OK: 48 shipped code file(s), every relative import present in files[] ===`.
- `check-deploy`: prints `=== DEPLOY OK ===`.
- `site-cli-usage-test`: prints `all passed` (commands, flags, line continuations, and guides verified).
- `readme-promises-test`: prints `24 passed, 0 failed`.

### What to Do If It Failed
**Stop immediately.** Fix the specific failing assertion reported in stderr. Never publish a release or bump versions while any gate fails.

---

## Step 2: Version Bump

Update the `"version"` field in `package.json`:

```bash
# Edit package.json in C:/Users/G1/Desktop/N
# e.g., "version": "0.13.0" -> "0.14.0"
```

> **Note on `hive-version.js`:** `hive-version.js` dynamically reads `package.json` (`new URL('./package.json', import.meta.url)`). It does not hardcode the version, so updating `package.json` automatically updates `VERSION` and `VERSION_LABEL`.

> **Note on `docs/ALWAYS_ON.md`:** Confirm that `docs/ALWAYS_ON.md` accurately notes the release version where the 0/1/2 exit-code contract begins (e.g. `hivecode-mcp@0.13.0`), ensuring no unpinned release placeholders remain in the documentation.

Verify the bump:
```bash
node -e "import('C:/Users/G1/Desktop/N/hive-version.js').then(m => console.log('Version:', m.VERSION))"
```

---

## Step 3: Commit, Push, and Verify CI

> **CAUTION:** Never run `git add .` in `C:/Users/G1/Desktop/N`. The working folder contains untracked development scratch files, and `.env` holds real production tokens.

1. Inspect modified files:
   ```bash
   git -C C:/Users/G1/Desktop/N status
   ```
2. Stage only tracked modifications (or add release files by name):
   ```bash
   git -C C:/Users/G1/Desktop/N add -u
   ```
3. Inspect the staged diff before committing:
   ```bash
   git -C C:/Users/G1/Desktop/N diff --cached --stat
   ```
   Confirm that only intended release files (e.g. `package.json`) are staged.
4. Commit and push:
   ```bash
   git -C C:/Users/G1/Desktop/N commit -m "Release vX.Y.Z"
   git -C C:/Users/G1/Desktop/N push origin main
   ```
5. Wait for GitHub Actions CI to pass:
   ```bash
   gh run watch --repo Ganesh-Kute/HiveCode
   ```

### How to Tell It Worked
- `gh run watch` finishes with `✓ Completed` (all jobs green).

### What to Do If It Failed
Do **NOT** proceed to `npm publish`. View failure logs with `gh run view --repo Ganesh-Kute/HiveCode --log-failed`, fix on a new commit, push to `main`, and wait for CI to turn green.

---

## Step 4: Publish to npm (`npm publish`)

1. Preview the published tarball contents:
   ```bash
   npm publish --dry-run C:/Users/G1/Desktop/N
   ```
   Confirm the file list matches `package.json` `files[]`.
2. Publish the package:
   ```bash
   npm publish C:/Users/G1/Desktop/N
   ```

### How to Tell It Worked
npm prints `+ hivecode-mcp@X.Y.Z`.

### What to Do If It Failed
- **403 / ENEEDAUTH:** Run `npm login` to authenticate with your npm publisher account.
- **400 / E400 (Cannot publish over existing version):** Check `npm view hivecode-mcp version` and ensure `package.json` was bumped to an unused version.

---

## Step 5: Confirm Publication on npm and unpkg

Confirm that the npm registry and unpkg CDN serve the new release:

```bash
npm view hivecode-mcp version
curl -I https://unpkg.com/hivecode-mcp@<version>/docs/QUICKSTART.md
```

### How to Tell It Worked
- `npm view` prints the new version (`X.Y.Z`).
- `curl -I` returns `HTTP/1.1 200 OK`.

### What to Do If It Failed
If unpkg returns 404 immediately, wait 30–60 seconds for npm replica synchronization and CDN cache warming, then retry.

---

## Step 6: Site Release Gate & Website Deploy

**ONLY AFTER** Step 5 confirms publication on npm and unpkg, run the pre-deploy site gate:

```bash
node C:/Users/G1/Desktop/N/scripts/check-site-release.mjs
```

### How to Tell It Worked
Exits with code `0` and prints:
```
[check-site-release] OK: all commands, flags, and links on site exist in published hivecode-mcp@X.Y.Z
```

### What to Do If It Failed
- If it exits with code `1`: It lists commands, flags, or unpkg links that 404 in the published release. **Never deploy the website if this check exits 1 or 2.**
- If it exits with code `2`: Network or CDN timeout (`could not check`). Retry once connectivity is stable.

Once exit code `0` is verified, deploy `public/` files to your production web host.

---

## Step 7: Deploy the Relay on Render

> **IMPORTANT:** Render does **NOT** auto-deploy on `git push`. The relay must be manually triggered.

1. Open the Render Dashboard: [dashboard.render.com](https://dashboard.render.com).
2. Select your `hivecode-relay` web service.
3. Click **Manual Deploy** → **Clear build cache & deploy**.
4. Wait ~2 minutes for the build and container startup to complete.
5. Verify the live relay endpoint:
   ```bash
   curl https://hivecode-relay.onrender.com/health
   ```

### How to Tell It Worked
`/health` returns HTTP 200 JSON with `"ok": true`, matching your new version and commit:
```json
{
  "ok": true,
  "version": "X.Y.Z",
  "build": "<commit-sha>",
  "uptimeSec": 12
}
```

### What to Do If It Failed
If `/health` returns the previous version or fails, open the Render deploy logs in the dashboard to inspect build or startup errors.
