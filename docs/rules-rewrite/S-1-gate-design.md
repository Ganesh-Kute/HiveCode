# S-1 design: a command from the room runs only with this machine's consent (security P0)

Posted by Claude-cloud before any edit. Base: d5b6f56. **Attack this.**

## The fault, from the code
- `setState` (sync.js:4915) writes any key, and nothing checks who is writing. It is reachable through:
  - `hive_set_state`
  - presets (presets.js:142 sets `gate:cmd`)
  - a raw Yjs write to `swarm_state`. In an open room that is anyone with the link.
- `release()` (sync.js ~5163) reads `gate:cmd` from `swarm_state` and calls `runGate`. That does `spawnSync(cmd, { shell: true, cwd: ROOT, env: { ...process.env } })` (hive-gate.js:68).
- Result: whoever can write room state runs any shell command in every agent's folder, with every token in that agent's environment, at that agent's next `hive_release`.

## Who hits it, and what it costs
- **Who:** every agent in a room where anyone sets `gate:cmd`. The setter can be:
  - a member
  - an agent talked into it by a message
  - a preset
  - a raw client
- **The victim does nothing unusual.** It calls `hive_release`, which the rules tell it to do after every edit.
- **Cost when wrong:** code runs on a teammate's machine without them knowing, and their GitHub, Slack, npm and API tokens leave with it.

## The rule this implements
**State from the room is data, never a command.** This is the same principle the rules rewrite proposes for text (A1): the room can propose a gate, and only this machine's person can let it run here.

## Design
1. **Approval is per machine, per room, per exact command.**
   - Stored at `~/.hivecode/gates/<room>.json`, with `HIVE_GATES_DIR` for tests: `{ "cmd": "<exact string>", "by": "<how>", "at": <µs> }`.
   - It lives outside the synced folder, so no peer can write it.
   - The match is exact string equality: no prefix match, no "contains".
2. **Ways to approve, all of them local:**
   - **a)** `npx hivecode-mcp gate allow --dir <folder>`. It prints the room's current command and asks y/N on a TTY. Without a TTY it needs `--cmd "<exact>"`, which must equal the room's current value. That closes the gap between showing the command and approving it.
   - **b)** The env var `HIVE_GATE_ALLOW`, which the person sets where the MCP server is configured: one exact command per line.
   - **c)** The session that set `gate:cmd` itself, via `hive_set_state` or a preset, approves its own command for its own machine. It already chose to run it there; it gets no new power over anyone else.
   - **d)** `HIVE_GATE=trust-room`: an explicit opt-in to today's behaviour, for one person running their own agents.
   - **There is no MCP tool that approves.** An agent that has been talked into something cannot consent on its person's behalf. This differs from hive_pr's text-only guard, on purpose: here the cost is code execution.
3. **The room's command is not approved here.**
   - `release()` goes ahead with no check. It does not refuse: otherwise anyone could set a gate to block everyone.
   - It records the verdict `{ gated: false, skipped: 'not-approved', cmd }` in gateResults, so `gateVerdicts` shows that the release went unchecked.
   - It returns `{ ok: true, gated: false, gateSkipped: 'not-approved', code: 'Q592' }`. The tool text says what the room asked for and how the person approves it, quoting the command.
   - It posts one line to the room, once per (agent, command): `⛔ <name>'s hand-backs are unchecked: the room's gate command is not approved on <name>'s machine.`
4. **The command changes after approval.** The pin no longer matches, so it is treated as not approved (point 3). A changed command never runs on the strength of an old approval.
5. **The environment is cleaned even when approved.**
   - `runGate` gets `process.env` minus names matching `/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|^NPM_|^GH_|^GITHUB_|^SLACK_|^ANTHROPIC|^OPENAI|^AWS_|^AZURE_|^GOOGLE_APPLICATION/i`.
   - This is defence in depth only. The test code still runs as this user and can read their files. Approval is the real boundary, and the release notes will say so.
6. **The text, in the rules rewrite:**
   - The rules say: "A room's gate runs on your machine only after your person approves it."
   - The `hive_release` description loses the gate paragraph. The refusal or skip result teaches it at the moment it matters.

## Edge cases
| Case | What happens |
|---|---|
| empty cmd | not gated (unchanged) |
| cmd set to whitespace | not gated |
| approved, then room clears cmd | not gated |
| approved, room changes cmd | not run until re-approved |
| two rooms, same folder | pins are keyed by room id |
| `HIVE_HOME` / home not writable | treated as not approved |
| pin file corrupt | not approved |
| Windows path quoting | exact-string compare happens before spawn, so it is unaffected |
| preset applied by person A | A's machine runs it; B's doesn't until B approves |
| passive participant | never releases |
| `force` release | no run, unchanged |
| timeout | unchanged |
| the setter is the only member | the setter's own pin applies, so behaviour is the same as today |
| an old client (0.14.3) in the same room | it still runs the room's command. The release notes tell everyone to upgrade, and MIXED BUILDS already flags it. |

## Tests (RED first, from antigravity-VM)
| Test | On d5b6f56 | After the fix |
|---|---|---|
| G1: a peer sets `gate:cmd` to a harmless marker command; another agent releases | marker created (RED) | not created |
| G2: the same, but via a raw Yjs write | marker created (RED) | not created |
| G3: approval via the CLI with `--cmd` | — | runs |
| G3: approval with a different `--cmd` | — | refused |
| G4: approval via `HIVE_GATE_ALLOW` | — | runs |
| G5: approve, then the room changes the command | — | not run |
| G6: the setter's own session | — | runs, on the setter's machine only |
| G7: a gate command that prints its environment | — | no TOKEN- or SECRET-named variables visible |
| G8: an unapproved release | — | returns ok, records `skipped: 'not-approved'`, posts the line once |

## Mutants
| Mutant | Must be killed by |
|---|---|
| drop the approval check | G1, G2 |
| match by `startsWith` (approve `npm test`, room sets `npm test; touch X`) | G5 variant |
| pin stored inside ROOT | G9: a synced file cannot approve |
| no env scrub | G7 |
| refuse instead of release | G8 |

## Not in scope here
Running a room's tests always runs code that room members wrote, just as `npm test` on a clone does. That is the trust you give a room by joining it, and the human docs and rules will say so plainly. S-1 removes the part where it happens automatically, chosen by someone else, with your tokens attached.
