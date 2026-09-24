# A default nobody chose

**The value is real, the code is correct, and nobody agreed to it.** A default is reached by
omission — an unset variable, a setting left alone, a link that was never pasted. There is no
moment where anyone decides, so there is no moment where anyone could have decided
differently. The system then behaves exactly as designed, and the consequence lands on
somebody who never saw the choice.

This is not `absence-rendered-as-a-value.md`. There, "I do not know" gets written down as a
number and the number is believed. Here the value is genuine and the code is right. What is
missing is **consent**, and consent is not a thing a test can assert about a variable.

## Four instances on this repo

| the default | how you arrive at it | what it costs |
|---|---|---|
| the relay URL the client falls back to | no join link, no `HIVE_RELAY` | the team's source is published to a server they do not run, with every status green |
| the same URL as the editor's setting default | install the extension, change nothing | same, for every human on the team |
| persistence off in the relay | start the relay the documented way | the day works perfectly; the last client disconnects and the room is gone by morning |
| auth mode `open` | start the relay the documented way | an "invite-only" relay that admits anyone who guesses a room id |

Three of the four are in the same feature, which is the tell: **defaults cluster around the
thing that is hardest to set up**, because that is exactly where an author is tempted to make
something work out of the box.

## Why it survives review

Because there is nothing wrong to see. Every other class here has a defect you can point at —
a wrong assertion, a swallowed error, a second copy. This one has correct code doing the
documented thing. A reviewer reading the fallback line agrees with it, because a fallback that
makes the product work on first run is good engineering, and the harm is not in that line. It
is in the distance between that line and the person it affects, who is not in the review.

It also survives because the default is usually right. The public relay is a genuinely good
first-run experience. Persistence off is right for a unit test. `open` is right on a laptop.
Every instance above is defensible in the case its author had in mind — and indefensible in
the case the author was not thinking about, which is the one that reaches a customer.

## Why the obvious fix makes it worse

**"Change the default."** Flip it to the safe value and the first-run experience dies: the
client now refuses to start until somebody runs a relay, and the product's first impression is
a setup error. You will also have moved the problem rather than removed it — the new default
is also one nobody chose, and now the people it surprises are the ones who wanted the old one.

**"Document it."** Documentation is read by the person who already suspects there is something
to read. The whole population at risk is the population that did not look. And documentation
is an untested API surface in its own right, so the sentence describing the default outlives
the default itself.

**"Warn on every run."** A warning printed unconditionally is read once and skipped forever,
and it trains people to skip the next one, which will matter.

## What actually works: make it say what it is, and make it pinnable

Two mechanisms, and both are needed because they answer different questions.

**1. A verdict, not a value.** Wherever the default's consequence is decided, report what it
MEANS, not what it is. `relay: wss://…` is a value; `[PUBLIC RELAY — not yours]` is a verdict.
The verdict costs one line, appears whether or not anybody asked, and is legible to somebody
who has never run the thing. `checkRelay()` in `hive-privacy.js` exists for exactly this: the
URL was always printed and nobody could read it.

**2. A pin that refuses.** A verdict still depends on being read, and an agent reads nothing.
So an operator must be able to state the choice ONCE, out of band, and have every later
omission become a refusal. `HIVE_RELAY_PIN` is that: with it set, arriving at the default is
an error (`Q550`) rather than an outcome. Note the shape — the pin does not change the
default, it changes what happens when you reach it by accident.

And the refusal has to happen **before the irreversible act**, not after. A pin checked after
the socket opened reports a leak; checked before, it prevents one. In `sync.js` and
`hive-mcp.js` the check sits ahead of both the connection and the config write, so a refused
join leaves nothing behind for the next process to find.

## How to catch it before you ship

Take every default in the system and ask one question:

> **What would somebody have had to do to arrive at this deliberately?**

If the answer is "nothing" — if the default is reached by not acting — then ask the second
question: **what does it cost when the person who reached it did not want it?** A default whose
wrong case is cheap needs nothing. A default whose wrong case is irreversible, invisible, or
somebody else's data needs both mechanisms above.

Concrete things to grep for:

- `process.env.X || '<a real value>'` where the literal is a network address, a directory, or
  a credential scope. A fallback to `''`, `null` or a number is usually fine; a fallback to a
  *destination* is where this class lives.
- A settings schema with a non-empty `default` that points somewhere. In
  `extension/package.json` that was one line, and it aimed every untouched install at a
  third-party server.
- A feature that is off unless an env var is set, where "off" means a guarantee the product
  advertises is not being provided. The relay prints its own claim-enforcement state at boot
  for this reason, and the line says what off means rather than just saying `off`.

## What it is not

It is not an argument against defaults. A product with no defaults is a product nobody
finishes installing. It is an argument that **a default with a consequence owes the user a
sentence and an off switch** — and that the off switch has to be a refusal, because anything
weaker is another thing to read.

It is also not solved by asking. A prompt on first run is a default with extra steps: people
click through, and agents cannot click at all.

## Worked example

21 Sep 2026. `hive_status` reported `relay: wss://livecode-xoss.onrender.com` and
`connected: true`, and had reported it for weeks. The relay is the author's own free-tier
box. Nobody on the project had ever decided that a customer's source should go there — it is
simply what `hive-mcp.js` falls back to when `HIVE_RELAY` is unset and no link was pasted,
which is the state a fresh agent starts in.

Measured the same day, on the same build:

- **31 files** in the published package, and the relay was not one of them — so the only
  documented way to self-host was to clone the repository. `npx hivecode-mcp` shipped the
  client that connects to our relay and nothing that lets you replace it.
- **`docs/SELF_HOSTING.md` never mentioned `HIVE_RELAY` at all.** It told a team to set
  `hivecode.relayUrl` in VS Code. Follow it exactly and your humans move to your relay, your
  agents stay on ours, both report success, and the room name is the same on both.
- **`extension/package.json`** declared `"default": "wss://livecode-xoss.onrender.com"` for
  `hivecode.relayUrl`, so every untouched install pointed at it too.

The fix was not a better default. `hive-privacy.js` reports a verdict on every join — the
line now reads `[PUBLIC RELAY — not yours]` or `[PRIVATE — relay on your network]` — and
`HIVE_RELAY_PIN` turns arriving at the fallback into a `Q550` refusal, raised before the
socket opens and before `.hive.json` is written. `npx hivecode-relay` exists so the safe
choice is one command rather than a clone and four environment variables.

`tests/self-host-test.mjs` is what keeps it true: it starts a real relay, syncs a real file
between two real clients through it, asserts that relay's own counters moved, and asserts a
pinned client REFUSES the public one. That last assertion is the whole class in one line —
everything before it proves a private relay works, and only it proves you cannot end up
somewhere else while believing otherwise.
