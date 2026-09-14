// hive-map — the room's architecture graph, as a thing agents can edit.
//
// WHY THIS EXISTS. Every project has a picture of itself that lives in someone's head and in
// scattered markdown. It is stale the day after it is drawn and nothing ever tells you. Meanwhile
// the room already knows who holds what and which files changed, but nobody can see the SHAPE of
// the system those files make up.
//
// So the map is not a rendering OF the room. The map is an object IN the room: nodes and edges in
// the same CRDT as everything else, which means agents read it to learn what depends on what, and
// WRITE to it the moment they discover something. Two agents cannot corrupt it, the human sees
// every change within a second, and `public/map.html` draws it in 3D.
//
//   node hive-map.js "<link>" <YourName> add   <id> [--label L] [--kind K] [--state S] [--file F] [--note N]
//   node hive-map.js "<link>" <YourName> link  <from> <to> [--why W]
//   node hive-map.js "<link>" <YourName> state <id> <built|broken|planned|wip>
//   node hive-map.js "<link>" <YourName> note  <id> "<text>"
//   node hive-map.js "<link>" <YourName> rm    <id>
//   node hive-map.js "<link>" <YourName> unlink <from> <to>
//   node hive-map.js "<link>" <YourName> list
//
// STATES, and they mean exactly this:
//   built    verified working. You ran it. Not "should work".
//   broken   verified failing. You ran it and it did not do the thing.
//   wip      someone is on it right now.
//   planned  agreed to exist, no code yet.
//
// `built` is a SAW claim. Setting it because a file exists is the single most damaging thing you
// can do to this map, because the whole point is to be able to trust one glance at it.

import { startSync, parseLink } from './sync.js'

const STATES = new Set(['built', 'broken', 'planned', 'wip'])
const nowMicros = () => Date.now() * 1000

const argv = process.argv.slice(2)
const [LINK = '', NAME = '', ACTION = '', ...rest] = argv

// Flags are pulled out first so positional parsing never has to think about them.
const flags = {}
const pos = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) flags[a.slice(2)] = rest[++i] ?? ''
  else pos.push(a)
}

function die(code, msg) {
  console.error(`${code} ${msg}`)
  process.exit(1)
}

// Keys are prefixed rather than nested so that two agents touching different nodes touch different
// CRDT keys and never contend. A nested object would make the whole graph one write.
export const nodeKey = (id) => `n:${id}`
export const edgeKey = (from, to) => `e:${from}|${to}`
export const isNodeKey = (k) => k.startsWith('n:')
export const isEdgeKey = (k) => k.startsWith('e:')

/** Read the graph map into {nodes, edges}. Exported so the tests can drive it without a relay. */
export function readGraph(graph) {
  const nodes = []
  const edges = []
  graph.forEach((v, k) => {
    if (!v) return
    if (isNodeKey(k)) nodes.push(v)
    else if (isEdgeKey(k)) edges.push(v)
  })
  nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  edges.sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))
  return { nodes, edges }
}

/** Apply one command to a graph map. Pure w.r.t. the network, so tests cover the real logic. */
export function applyCommand(graph, name, action, pos, flags) {
  const stamp = { by: name, at: nowMicros() }

  if (action === 'add') {
    const id = pos[0]
    if (!id) return { ok: false, code: 'Q460', msg: 'add needs an id' }
    const state = flags.state || 'planned'
    if (!STATES.has(state)) return { ok: false, code: 'Q461', msg: `unknown state "${state}" (built|broken|planned|wip)` }
    const prev = graph.get(nodeKey(id)) || {}
    graph.set(nodeKey(id), {
      ...prev,
      id,
      label: flags.label || prev.label || id,
      kind: flags.kind || prev.kind || 'component',
      state,
      file: flags.file || prev.file || '',
      note: flags.note || prev.note || '',
      ...stamp,
    })
    return { ok: true, msg: `${prev.id ? 'updated' : 'added'} node ${id} (${state})` }
  }

  if (action === 'link') {
    const [from, to] = pos
    if (!from || !to) return { ok: false, code: 'Q462', msg: 'link needs <from> <to>' }
    if (from === to) return { ok: false, code: 'Q463', msg: 'a node cannot depend on itself' }
    // Deliberately NOT requiring both nodes to exist. An agent that has just discovered
    // "Director needs timeline" should be able to say so before anyone has added timeline;
    // the renderer draws the missing end as a ghost, which is itself useful information.
    graph.set(edgeKey(from, to), { from, to, why: flags.why || '', ...stamp })
    return { ok: true, msg: `${from} -> ${to}` }
  }

  if (action === 'state') {
    const [id, state] = pos
    if (!id || !state) return { ok: false, code: 'Q464', msg: 'state needs <id> <state>' }
    if (!STATES.has(state)) return { ok: false, code: 'Q461', msg: `unknown state "${state}" (built|broken|planned|wip)` }
    const prev = graph.get(nodeKey(id))
    if (!prev) return { ok: false, code: 'Q465', msg: `no node "${id}"` }
    graph.set(nodeKey(id), { ...prev, state, ...stamp })
    return { ok: true, msg: `${id} -> ${state}` }
  }

  if (action === 'note') {
    const id = pos[0]
    const text = pos.slice(1).join(' ')
    if (!id) return { ok: false, code: 'Q466', msg: 'note needs <id> "<text>"' }
    const prev = graph.get(nodeKey(id))
    if (!prev) return { ok: false, code: 'Q465', msg: `no node "${id}"` }
    graph.set(nodeKey(id), { ...prev, note: text, ...stamp })
    return { ok: true, msg: `noted on ${id}` }
  }

  if (action === 'rm') {
    const id = pos[0]
    if (!id) return { ok: false, code: 'Q467', msg: 'rm needs an id' }
    if (!graph.has(nodeKey(id))) return { ok: false, code: 'Q465', msg: `no node "${id}"` }
    graph.delete(nodeKey(id))
    // Edges to a deleted node would otherwise linger as permanent ghosts nobody can see to remove.
    let dropped = 0
    const keys = []
    graph.forEach((_v, k) => keys.push(k))
    for (const k of keys) {
      if (!isEdgeKey(k)) continue
      const e = graph.get(k)
      if (e && (e.from === id || e.to === id)) { graph.delete(k); dropped++ }
    }
    return { ok: true, msg: `removed ${id}${dropped ? ` and ${dropped} edge(s)` : ''}` }
  }

  if (action === 'unlink') {
    const [from, to] = pos
    if (!from || !to) return { ok: false, code: 'Q462', msg: 'unlink needs <from> <to>' }
    if (!graph.has(edgeKey(from, to))) return { ok: false, code: 'Q468', msg: `no edge ${from} -> ${to}` }
    graph.delete(edgeKey(from, to))
    return { ok: true, msg: `unlinked ${from} -> ${to}` }
  }

  if (action === 'list') {
    const { nodes, edges } = readGraph(graph)
    const lines = []
    const mark = { built: '[built]  ', broken: '[BROKEN] ', wip: '[wip]    ', planned: '[planned]' }
    for (const n of nodes) lines.push(`${mark[n.state] || '[?]      '} ${n.id}${n.label !== n.id ? ` — ${n.label}` : ''}${n.file ? `  (${n.file})` : ''}`)
    if (edges.length) {
      lines.push('')
      for (const e of edges) lines.push(`  ${e.from} -> ${e.to}${e.why ? `   ${e.why}` : ''}`)
    }
    if (!nodes.length && !edges.length) lines.push('(empty map)')
    return { ok: true, msg: lines.join('\n') }
  }

  return { ok: false, code: 'Q469', msg: `unknown action "${action}"` }
}

// Only connect when run directly, so the tests can import the pure half above without this file
// demanding arguments, parsing a link, or opening a socket on import.
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  if (!LINK || !NAME || !ACTION) {
    console.error('usage: node hive-map.js "<relay|room>" <YourName> <add|link|state|note|rm|unlink|list> [args]')
    process.exit(2)
  }
  const { relay, room } = parseLink(LINK)
  const dir = (process.env.TEMP || '.') + '/hive-map-' + NAME

  const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
  const graph = hive.doc.getMap('graph')
  let done = false
  hive.provider.on('sync', (s) => {
    if (!s || done) return
    done = true
    const r = applyCommand(graph, NAME, ACTION, pos, flags)
    if (!r.ok) { console.error(`${r.code} ${r.msg}`); setTimeout(() => { try { hive.stop() } catch {} ; process.exit(1) }, 200); return }
    console.log(r.msg)
    // Same 700ms as hive-say: let the update reach the relay before the socket dies under us.
    setTimeout(() => { try { hive.stop() } catch {} ; process.exit(0) }, ACTION === 'list' ? 0 : 700)
  })
  setTimeout(() => die('Q470', `could not reach the relay at ${relay}`), 20000)
}
