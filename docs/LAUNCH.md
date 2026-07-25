# Hivecode — launch runbook

The single go-live checklist. Work top to bottom. Each item says **[you]** (needs a
human / your accounts) or **[done]** (already built and staged in this repo).

Supporting docs: [PUBLISH.md](PUBLISH.md) (how to publish the extension) ·
[POSITIONING.md](POSITIONING.md) (what to say) · [MARKETING.md](MARKETING.md)
(every post, ready to paste).

---

## Phase 0 — already built & staged  ✅
- [done] Landing page (`public/index.html`), served by the relay at `/`.
- [done] Marketplace listing (`extension/README.md`), icon (`resources/icon.png`),
  polished `extension/package.json`, repackaged `extension/hivecode.vsix` (v0.6.0).
- [done] Real GitHub README + root `LICENSE` (MIT).
- [done] Repo cleaned (prototypes → `legacy/`).
- [done] Full test suite green (95 unit + live security/edge suites).
- [done] Launch kit written (HN, Reddit, X, Product Hunt, demo script, DM template).

## Phase 1 — ship the code  (do first)
- [you] Say **"push"** here → deploys the relay (landing page goes live at
  `https://livecode-xoss.onrender.com`) and updates GitHub.
- [you] Tag the release: I'll run `git tag v0.6.0 && git push --tags` on your word.
- [you] Create a **GitHub Release** for v0.6.0 and attach `extension/hivecode.vsix`
  (so the README's "latest .vsix" link works).
- [verify] Open the website link — confirm the landing page loads.

## Phase 2 — publish the extension  (≈20 min, your accounts)
Full steps in [PUBLISH.md](PUBLISH.md). Summary:
- [you] Create the `hivecode` publisher at marketplace.visualstudio.com/manage.
- [you] Get an Azure PAT (Marketplace → Manage scope).
- [you] `cd extension && npx vsce login hivecode && npx vsce publish`.
- [you] Also publish to Open VSX (`npx ovsx publish …`) so Cursor/Windsurf users
  can install.
- [verify] Search "Hivecode" in the VS Code Extensions panel — it appears and
  installs; host → invite → join works on a fresh install.

## Phase 3 — the demo  (the keystone — everything links to it)
- [you] Record the 60–90s demo (script + voiceover in [MARKETING.md](MARKETING.md) §5).
  Hero shot = an agent **blocked from an out-of-scope file**.
- [you] Upload to YouTube (unlisted is fine) and cut a 6–10s GIF of the blocked
  moment.
- [you] Drop the GIF into the GitHub README (`docs/demo.gif`) and the landing page.

## Phase 4 — launch  (Tue–Thu morning, US time)
Post in this order, spaced out — not all at once:
- [you] **Show HN** (title + first comment in MARKETING.md §1). Reply to every
  comment for the first 3 hours.
- [you] **r/ClaudeAI** + **r/ChatGPTCoding** (§2), a day or two apart.
- [you] **X thread** (§3) with the GIF.
- [you] (later, once you have ~10 happy users) **Product Hunt** (§4).

## Phase 5 — first 10 users  (the part that decides everything)
- [you] DM 10 people who've posted about running multiple agents (template §7).
- [you] Watch each one onboard. Every point of confusion = the next fix.
- [me] I turn that feedback into changes, fast.

---

## Definition of "launched"
Not "posted everywhere." Launched = **10 people have used it and at least a few
keep coming back.** That's the signal that the wedge is real and worth building a
business on. Revenue comes after that — first milestone ~100 paid seats
(≈ ramen-profitable). Don't build billing until people love it free.

## Standing division of labor
- **Me:** every asset, every post, every revision, turning feedback into code.
- **You:** the human acts — recording, posting from your accounts, talking to
  users. I will not post on your behalf or take account credentials.

## Right now, the one blocker
Everything in Phase 0 is uncommitted. **Say "push"** to start Phase 1.
