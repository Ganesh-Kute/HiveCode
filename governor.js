// governor — the relay's own record of who may work, and how much.
//
// WHY THIS IS NOT IN THE CRDT. The room already has a `controls` map, and until now that map WAS
// the stop button: a client wrote `paused` into it and well-behaved agents stopped asking for
// work. That is cooperative, and cooperative is the wrong shape for this particular control,
// because the thing you are stopping is the thing you are asking to obey. The base room is never
// write-gated (see writeBlockReason: `filePath === null` returns null), so a paused agent could
// simply write `running` over its own entry and carry on. The button could be pressed by the
// person and un-pressed by the agent.
//
// So the authority moves out of the document. The relay keeps its own map, and the CRDT `controls`
// map becomes a MIRROR that clients and UIs read. An agent may scribble in the mirror; the gate
// consults the relay. And because the relay can see who authored any change (y-websocket passes
// the connection as the Yjs transaction origin), a write to `controls` from an AI is reverted
// rather than obeyed.
//
// WHAT PAUSE BLOCKS, AND WHAT IT DELIBERATELY DOES NOT. Paused means: no writes to FILES. It does
// not mean silence -- a paused agent can still post to chat, and it must be able to, or an agent
// stopped mid-task has no way to tell anyone what state it left things in. "Stop working" and
// "stop talking" are different instructions and only the first one is wanted here.
//
// SPEND. The relay cannot see tokens; nothing in a websocket frame says what an inference cost.
// It CAN see bytes, writes, and wall-clock minutes, and those are enforced here. A `tokens` budget
// is also supported but is SELF-REPORTED by the agent, so it is a courtesy, not a guarantee, and
// it is labelled as such everywhere it appears. The enforced dimensions are the backstop: an agent
// that lies about its tokens still runs out of minutes.
//
// The enforcement mechanism for a blown budget is the stop button. That is the whole reason these
// two live in one file: a spend cap is not a separate subsystem, it is an automatic press.

export const GOV_ORIGIN = 'hive-governor'

const nameOf = (conn) => (conn && conn._hive && conn._hive.identity && conn._hive.identity.name) || null
const identOf = (conn) => (conn && conn._hive && conn._hive.identity) || null
const roleOf = (conn) => (conn && conn._hive && conn._hive.role) || null

/** WHO MAY PRESS THE BUTTON — and the exact shape of what this can and cannot promise.
 *
 *  The relay deliberately REFUSES to honour a self-declared `human`: writeBlockReason() exempts
 *  humans from the write gate, so accepting that claim would let any client opt out of every gate
 *  by saying so. The consequence for us is that on an open relay a real person's identity.kind is
 *  `unknown`, not `human` -- so "only humans may control" would revert the stop the moment a
 *  person pressed it. Declaring `ai`, by the same design, only ever ADDS restrictions.
 *
 *  So the rule is the inverse: an AI may never touch the control map, and on an open relay
 *  everyone else may.
 *
 *  BE CLEAR ABOUT THE LIMIT. On an OPEN relay this stops every agent using a normal client
 *  (startSync declares kind 'ai'), and it stops the honest-but-looping agent, which is the case
 *  that actually happens. It does NOT stop an agent that deliberately declines to declare itself,
 *  because an open relay has nothing to check a claim against. The hard guarantee needs
 *  HIVE_AUTH_MODE=required or a secured hs_ room, where kind comes from a signed token -- and
 *  there `strict` turns this into: only a verified human, admin or maintainer. Anything else
 *  would be claiming a guarantee the transport cannot supply.
 */
export function mayControl(identity, role, strict) {
  if (!identity) return !strict                     // unidentified: fine when open, never when strict
  if (identity.kind === 'ai') return false          // the party being stopped never gets the switch
  if (role === 'reader') return false               // a read-only seat controls nothing
  if (strict) return identity.kind === 'human' || role === 'admin' || role === 'maintainer'
  return true
}

/** A budget with only the keys that were actually set. Unset dimensions are unlimited, which is
 *  the honest default: a cap nobody chose is a cap nobody understands. */
export function normalizeBudget(b) {
  if (!b || typeof b !== 'object') return null
  const out = {}
  for (const k of ['minutes', 'writes', 'bytes', 'tokens']) {
    const v = Number(b[k])
    if (Number.isFinite(v) && v > 0) out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** Has this participant run past any dimension of its budget? Returns the FIRST dimension
 *  exceeded, named in the units a person set it in, because "over budget" with no number is
 *  not something anyone can act on at 3am. */
export function overBudget(budget, use, now) {
  if (!budget) return null
  const minutes = use.firstSeen ? (now - use.firstSeen) / 60000 : 0
  if (budget.minutes && minutes >= budget.minutes) return { dim: 'minutes', limit: budget.minutes, used: Math.round(minutes * 10) / 10 }
  if (budget.writes && use.writes >= budget.writes) return { dim: 'writes', limit: budget.writes, used: use.writes }
  if (budget.bytes && use.bytes >= budget.bytes) return { dim: 'bytes', limit: budget.bytes, used: use.bytes }
  if (budget.tokens && use.tokens >= budget.tokens) return { dim: 'tokens', limit: budget.tokens, used: use.tokens, reported: true }
  return null
}

export function makeGovernor({ now = () => Date.now(), audit = () => {}, strict = () => false } = {}) {
  const pauses = new Map()     // room -> Map(name -> { state, by, at, why })
  const budgets = new Map()    // room -> Map(name -> budget)
  const usage = new Map()      // room -> Map(name -> { firstSeen, writes, bytes, tokens })
  const attached = new Map()   // room -> detach fn

  const bucket = (m, room) => { if (!m.has(room)) m.set(room, new Map()); return m.get(room) }

  const control = (room, name, state, by, why = '') => {
    const rec = { state: state === 'paused' ? 'paused' : 'running', by: by || 'relay', at: now(), why }
    bucket(pauses, room).set(name, rec)
    mirror(room, name, rec)
    audit('governor-control', { room, who: name, state: rec.state, by: rec.by, why })
    return rec
  }

  const isPaused = (room, name) => {
    const r = bucket(pauses, room).get(name)
    return !!(r && r.state === 'paused')
  }

  const setBudget = (room, name, b, by = 'relay') => {
    const nb = normalizeBudget(b)
    if (nb) bucket(budgets, room).set(name, nb); else bucket(budgets, room).delete(name)
    audit('governor-budget', { room, who: name, budget: nb, by })
    return nb
  }
  const budgetOf = (room, name) => bucket(budgets, room).get(name) || null

  const useOf = (room, name) => {
    const b = bucket(usage, room)
    if (!b.has(name)) {
      b.set(name, { firstSeen: now(), writes: 0, bytes: 0, tokens: 0 })
      mirrorUsage(room, name, b.get(name))
    }
    return b.get(name)
  }

  /** Record an accepted write and decide whether that was the last one.
   *  Returns the over-budget record if this write tipped it, so the caller can say so. */
  const note = (room, name, bytes = 0, tokens = 0) => {
    const u = useOf(room, name)
    u.writes += 1
    u.bytes += Math.max(0, Number(bytes) || 0)
    u.tokens += Math.max(0, Number(tokens) || 0)
    mirrorUsage(room, name, u)
    return check(room, name)
  }

  /** Check the budget WITHOUT recording anything -- called on a timer too, because a `minutes`
   *  budget must expire on an agent that has gone quiet, not only on its next write. An agent
   *  that stops writing has not stopped spending. */
  const check = (room, name) => {
    const b = budgetOf(room, name)
    if (!b) return null
    const over = overBudget(b, useOf(room, name), now())
    if (!over || isPaused(room, name)) return over
    control(room, name, 'paused', 'relay',
      `budget: ${over.used}/${over.limit} ${over.dim}${over.reported ? ' (self-reported)' : ''}`)
    audit('governor-overspend', { room, who: name, ...over })
    return over
  }

  /** Sweep every participant with a budget. A minutes cap has to fire on wall clock. */
  const sweep = () => {
    for (const [room, b] of budgets) for (const name of b.keys()) check(room, name)
  }

  // ---- the CRDT mirror -----------------------------------------------------------------
  let docs = new Map()   // room -> ydoc

  function mirror(room, name, rec) {
    const doc = docs.get(room)
    if (!doc) return
    try {
      doc.transact(() => { doc.getMap('controls').set(name, { state: rec.state, by: rec.by, at: rec.at, why: rec.why }) }, GOV_ORIGIN)
    } catch { /* the mirror is a convenience; the authority is above */ }
  }

  function mirrorUsage(room, name, u) {
    const doc = docs.get(room)
    if (!doc) return
    try {
      doc.transact(() => {
        doc.getMap('usage').set(name, {
          firstSeen: u.firstSeen,
          writes: u.writes,
          bytes: u.bytes,
          tokens: u.tokens
        })
      }, GOV_ORIGIN)
    } catch { /* convenience mirror */ }
  }

  /** Watch a base room's `controls` and `budgets` maps.
   *
   *  A change authored by a HUMAN is adopted as the new authority. A change authored by an AI is
   *  reverted -- that is the entire point: the agent being stopped is exactly the party with a
   *  motive to write `running` over its own entry, and the base room has never been write-gated.
   *  A change with no identifiable origin (a direct server-side write, persistence replay) is
   *  adopted, because refusing those would make the relay fight its own restore. */
  function attach(room, doc) {
    if (!doc || attached.has(room)) return
    docs.set(room, doc)
    const controls = doc.getMap('controls')
    const budgetMap = doc.getMap('budgets')
    const usageMap = doc.getMap('usage')

    // Seed from what the document already holds, so a relay restart does not silently release
    // every pause. Adopting a PAUSE is always safe; adopting a RESUME is not, because the last
    // thing written before the restart may have been an agent releasing itself. So pauses are
    // taken and resumes are ignored -- on restart, the worst case is an agent stays stopped.
    for (const [name, rec] of controls.entries()) {
      if (rec && rec.state === 'paused') bucket(pauses, room).set(name, { ...rec, at: rec.at || now() })
    }
    for (const [name, b] of budgetMap.entries()) { const nb = normalizeBudget(b); if (nb) bucket(budgets, room).set(name, nb) }

    // Seed usage counters from the document so caps survive relay restart (HIV-12).
    for (const [name, u] of usageMap.entries()) {
      if (u && typeof u === 'object') {
        const existing = bucket(usage, room).get(name) || { firstSeen: 0, writes: 0, bytes: 0, tokens: 0 }
        bucket(usage, room).set(name, {
          firstSeen: u.firstSeen ? (existing.firstSeen ? Math.min(existing.firstSeen, u.firstSeen) : u.firstSeen) : existing.firstSeen || now(),
          writes: Math.max(existing.writes || 0, Number(u.writes) || 0),
          bytes: Math.max(existing.bytes || 0, Number(u.bytes) || 0),
          tokens: Math.max(existing.tokens || 0, Number(u.tokens) || 0),
        })
      }
    }

    // Immediately re-check budgets against restored usage
    for (const name of bucket(budgets, room).keys()) check(room, name)

    const onControls = (event, tr) => {
      if (tr && tr.origin === GOV_ORIGIN) return                 // our own mirror write
      const who = identOf(tr && tr.origin)
      const allowed = tr && tr.origin && tr.origin._hive
        ? mayControl(who, roleOf(tr.origin), !!strict(room))
        : true                                                   // server-side / persistence replay
      for (const [name, change] of event.changes.keys) {
        const wrote = controls.get(name)
        if (!allowed) {
          // An AI touched the control map. Put it back.
          const truth = bucket(pauses, room).get(name)
          audit('governor-control-refused', { room, by: who.name, target: name, attempted: wrote && wrote.state, kind: who.kind })
          try {
            doc.transact(() => {
              if (truth) controls.set(name, { state: truth.state, by: truth.by, at: truth.at, why: truth.why })
              else controls.delete(name)
            }, GOV_ORIGIN)
          } catch { /* best effort */ }
          continue
        }
        if (change.action === 'delete') { bucket(pauses, room).delete(name); continue }
        if (wrote) bucket(pauses, room).set(name, { state: wrote.state === 'paused' ? 'paused' : 'running', by: wrote.by || (who && who.name) || 'unknown', at: wrote.at || now(), why: wrote.why || '' })
      }
    }

    const onBudgets = (event, tr) => {
      if (tr && tr.origin === GOV_ORIGIN) return
      const who = identOf(tr && tr.origin)
      const allowed = tr && tr.origin && tr.origin._hive
        ? mayControl(who, roleOf(tr.origin), !!strict(room))
        : true
      for (const [name] of event.changes.keys) {
        if (!allowed) {
          // An agent setting its own allowance is the same class of problem as unpausing itself.
          const truth = budgetOf(room, name)
          audit('governor-budget-refused', { room, by: (who && who.name) || 'unknown', target: name })
          try {
            doc.transact(() => { if (truth) budgetMap.set(name, truth); else budgetMap.delete(name) }, GOV_ORIGIN)
          } catch { /* best effort */ }
          continue
        }
        const nb = normalizeBudget(budgetMap.get(name))
        if (nb) bucket(budgets, room).set(name, nb); else bucket(budgets, room).delete(name)
      }
    }

    const onUsage = (event, tr) => {
      if (tr && tr.origin === GOV_ORIGIN) return
      const who = identOf(tr && tr.origin)
      const allowed = tr && tr.origin && tr.origin._hive
        ? mayControl(who, roleOf(tr.origin), !!strict(room))
        : true
      for (const [name] of event.changes.keys) {
        const truth = bucket(usage, room).get(name) || { firstSeen: now(), writes: 0, bytes: 0, tokens: 0 }
        const wrote = usageMap.get(name)
        // Monotonicity: spend only ever goes up. A decrease arriving from the doc is either tampering
        // or a stale replica; in both cases the higher number wins and doc is reverted (HIV-12).
        const lower = wrote && typeof wrote === 'object' && (
          (wrote.writes !== undefined && wrote.writes < truth.writes) ||
          (wrote.bytes !== undefined && wrote.bytes < truth.bytes) ||
          (wrote.tokens !== undefined && wrote.tokens < truth.tokens)
        )
        if (!allowed || lower || !wrote || typeof wrote !== 'object') {
          audit('governor-usage-refused', { room, by: (who && who.name) || 'unknown', target: name })
          try {
            doc.transact(() => {
              usageMap.set(name, { firstSeen: truth.firstSeen, writes: truth.writes, bytes: truth.bytes, tokens: truth.tokens })
            }, GOV_ORIGIN)
          } catch { /* best effort */ }
          continue
        }
        bucket(usage, room).set(name, {
          firstSeen: truth.firstSeen,
          writes: Math.max(truth.writes, Number(wrote.writes) || 0),
          bytes: Math.max(truth.bytes, Number(wrote.bytes) || 0),
          tokens: Math.max(truth.tokens, Number(wrote.tokens) || 0)
        })
      }
    }

    controls.observe(onControls)
    budgetMap.observe(onBudgets)
    usageMap.observe(onUsage)
    attached.set(room, () => {
      try { controls.unobserve(onControls) } catch { /* going away */ }
      try { budgetMap.unobserve(onBudgets) } catch { /* going away */ }
      try { usageMap.unobserve(onUsage) } catch { /* going away */ }
      docs.delete(room)
    })
  }

  function detach(room) { const d = attached.get(room); if (d) { d(); attached.delete(room) } }

  /** Everything the relay knows about a room, for /usage and the control room. */
  function snapshot(room) {
    const out = {}
    const names = new Set([...bucket(pauses, room).keys(), ...bucket(budgets, room).keys(), ...bucket(usage, room).keys()])
    for (const n of names) {
      const u = bucket(usage, room).get(n) || { firstSeen: 0, writes: 0, bytes: 0, tokens: 0 }
      out[n] = {
        state: isPaused(room, n) ? 'paused' : 'running',
        why: (bucket(pauses, room).get(n) || {}).why || '',
        budget: budgetOf(room, n),
        used: { minutes: u.firstSeen ? Math.round((now() - u.firstSeen) / 6000) / 10 : 0, writes: u.writes, bytes: u.bytes, tokens: u.tokens },
      }
    }
    return out
  }

  return { control, isPaused, setBudget, budgetOf, note, check, sweep, attach, detach, snapshot, useOf, nameOf }
}
