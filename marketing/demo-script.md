# The 15-second demo clip — recording script

The ONLY missing launch asset. Record your terminal (Windows: Xbox Game Bar
Win+Alt+R, or ScreenToGif for a crisp GIF — https://www.screentogif.com).
Practice once, then record take 2. Keep it under 20 seconds.

## Setup (run before recording — not shown in the clip)

```powershell
cd $env:TEMP; mkdir icr-demo; cd icr-demo
git init -q -b main
git config user.email demo@demo; git config user.name Demo
npx --package icr-merge@latest icr-merge-install
'*.js merge=icr' | Out-File -Encoding ascii .gitattributes
@'
function helper() { return 1 }

function main() { return helper() }
'@ | Out-File -Encoding ascii app.js
git add .; git commit -qm base
git checkout -qb teammate
@'
function fetchUser() { return 1 }

function main() { return fetchUser() }
'@ | Out-File -Encoding ascii app.js
git commit -aqm "rename helper -> fetchUser"
git checkout -q main
@'
function helper() { return 1 }

function main() { return helper() }

function report() { return helper() * 2 }
'@ | Out-File -Encoding ascii app.js
git commit -aqm "add report() using helper"
```

## The clip (this is ALL that's on screen)

```powershell
# branch "teammate" renamed helper() -> fetchUser()
# we just added report() ... which calls helper()

git merge teammate

cat app.js
```

Expected on screen — the money shot:

```
icr-merge: rename merge (helper->fetchUser)
Auto-merging app.js
Merge made by the 'ort' strategy.
```

and app.js showing `report()` calling **fetchUser()** — the call site was
rewritten automatically. No conflict. No broken code.

## Caption for the clip (tweet 1 / README)

> Renamed a function. Teammate's branch still called the old name.
> git merge — no conflict, their call site rewritten automatically.

## Optional second clip (10s, for the follow-up post)

Same setup but: teammate DELETES helper() while main adds report() using it.
Plain git merges it silently broken. With icr-merge: `git merge teammate`
exits with a conflict and app.js contains a block explaining
"'helper' was removed or renamed but is still used". Caption:
> This merge is "clean" in plain git. It's also broken. icr-merge catches it.
