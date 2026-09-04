// hive-coord.js — the Hive coordination layer (v0 prototype).
//
// The bet: AI coding agents work fast and BLIND — they collide because, unlike a human
// team, they have no way to coordinate BEFORE they edit. Merging (ICR) cleans up after a
// collision. This prevents the collision in the first place.
//
// The design is a real hive: NO central controller, no conductor, no extra agent. Order
// emerges from each agent following one local rule against a shared medium — exactly how
// bees coordinate via traces in the environment (stigmergy), and how millions of Ethernet
// devices share one wire with no master (carrier-sense / collision-detect / backoff).
//
// The shared medium is a CRDT map living IN the codebase doc (a Y.Map in Hivecode; a plain
// Map in tests). Each region of work (a file, or a unit) can hold one CLAIM:
//     { by: agentId, intent: string, at: time, ttl: ms }
//
// An agent's entire protocol — no coordinator anywhere:
//   1. SENSE   — read the shared map. Is my target region claimed and fresh?
//   2. FLOW    — if taken, move to open space (pick another free region). This is the
//                emergent load-balancing: agents spread across the codebase on their own.
//   3. CLAIM   — write my claim to the free region.
//   4. VERIFY  — re-read (collision-detect): if a concurrent claim beat mine, BACK OFF and
//                retry later. (Like Ethernet: listen, send, detect collision, back off.)
//   5. RELEASE — when done, delete my claim and (optionally) leave a "done" trace.
//
// EVAPORATION: claims carry a TTL. A crashed or stalled agent's claim simply expires, and
// the region frees itself — no central garbage collector, no deadlock. (The pheromone fades.)
//
// `shared` is any object with get(key)/set(key,val)/delete(key)/entries() — so the same
// code runs on a JS Map (tests) and a Yjs Y.Map (production). `now` is injectable so tests
// can drive a deterministic virtual clock.

export function makeCoordinator(shared, self, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : 5000
  // A holder may RENEW its own claim, because a long edit should not lose the file mid-write.
  // But renewal cannot be unbounded, or the lease stops being a lease. MEASURED on a 12-agent
  // run: one agent re-claimed site/pricing.md eight times and legal/terms.md seven times and
  // released twice, and since `claim` reset `at` on every call the 60s TTL never once elapsed.
  // Six other agents sensed a live owner for the whole run; sixteen messages asked it to let go.
  // `since` records the FIRST acquisition and survives renewal, so what caps a claim is total
  // hold time rather than time since the holder last touched it.
  const maxHold = opts.maxHold != null ? opts.maxHold : ttl * 3
  const now = opts.now || (() => Date.now())
  const held = (c) => now() - (c.since != null ? c.since : c.at) // total, across renewals
  const cap = (c) => (c.maxHold != null ? c.maxHold : maxHold)
  const overheld = (c) => !!c && held(c) >= cap(c)
  const expired = (c) => !c || (now() - c.at) >= c.ttl || overheld(c)

  // SENSE: the live, non-expired claim on a region (or null if open).
  const sense = (region) => { const c = shared.get(region); return expired(c) ? null : c }

  // Is this region open to ME? (free, expired, or already mine)
  const free = (region) => { const c = shared.get(region); return expired(c) || c.by === self }

  // A renewal keeps the original `since`; a fresh acquisition starts a new one. Claims written
  // before `since` existed fall back to `at`, so an older room stays readable.
  const claim = (region, intent) => {
    const prev = shared.get(region)
    const renewing = !!prev && prev.by === self && !expired(prev)
    shared.set(region, {
      by: self, intent, at: now(), ttl, maxHold,
      since: renewing ? (prev.since != null ? prev.since : prev.at) : now(),
    })
  }
  const release = (region) => { const c = shared.get(region); if (c && c.by === self) shared.delete(region) }

  // ACQUIRE one region: sense → claim → verify. Returns true iff I now hold it.
  // The verify step is the collision-detector: if a concurrent writer won the region,
  // I see their id on re-read and concede.
  const acquire = (region, intent) => {
    const c = shared.get(region)
    if (c && !expired(c) && c.by !== self) return false // sensed an owner → defer
    // Once total hold is exhausted the region is open to everyone — INCLUDING the outgoing
    // holder, which could then win the re-claim race indefinitely and starve the waiters that
    // maxHold exists to admit. So the overrunning holder stands down for a full maxHold, which
    // is a window every waiter is guaranteed to poll inside. A single-ttl cooldown was tried
    // first and is NOT enough: the holder just waits it out and opens a fresh `since`.
    // The bar lapses on its own, so a file nobody else wants returns to its owner.
    if (c && c.by === self && overheld(c) && held(c) < 2 * cap(c)) return false
    claim(region, intent)
    const after = shared.get(region)
    return !(after && after.by !== self) // verify: did my claim survive?
  }

  // FLOW to open space: try my preferred regions in order, take the first I can acquire.
  // This is what makes the swarm spread out with nobody assigning work.
  const acquireAny = (candidates, intent) => {
    for (const r of candidates) if (acquire(r, intent)) return r
    return null
  }

  // Everything currently claimed (live), as a snapshot — for awareness / a Control Room.
  const board = () => {
    const out = []
    for (const [region, c] of shared.entries()) if (!expired(c)) out.push({ region, ...c })
    return out
  }

  return { sense, free, claim, release, acquire, acquireAny, board }
}
