// hive-map tests — the graph commands, and the two ways this page can silently die.
//
// The renderer is untestable here (canvas, WebGL-free 3D, a browser). What IS testable is the part
// that breaks quietly: the command semantics agents depend on, and the loading rules that made the
// control room deaf for two investigations. Both are asserted, not assumed.

import * as Y from 'yjs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { applyCommand, readGraph, nodeKey, edgeKey } from '../hive-map.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

let pass = 0, fail = 0
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')) }
}
const section = (s) => console.log('\n# ' + s)

const fresh = () => new Y.Doc().getMap('graph')
const run = (g, action, pos = [], flags = {}) => applyCommand(g, 'tester', action, pos, flags)

// ---------------------------------------------------------------------------
section('add')
{
  const g = fresh()
  const r = run(g, 'add', ['relay'], { state: 'built', kind: 'service', file: 'server.js' })
  T('add succeeds', r.ok, JSON.stringify(r))
  const n = g.get(nodeKey('relay'))
  T('node is stored under n:<id>', !!n)
  T('label defaults to the id', n.label === 'relay')
  T('kind is kept', n.kind === 'service')
  T('state is kept', n.state === 'built')
  T('file is kept', n.file === 'server.js')
  T('author is stamped', n.by === 'tester')
  T('timestamp is unix MICROseconds, not millis', n.at > 1.7e15 && n.at < 2e16, String(n.at))

  const r2 = run(g, 'add', ['relay'], { state: 'broken' })
  T('re-adding updates rather than duplicating', r2.ok && g.get(nodeKey('relay')).state === 'broken')
  T('update preserves fields not given again', g.get(nodeKey('relay')).file === 'server.js')

  T('add with no id is refused', run(fresh(), 'add', []).code === 'Q460')
  T('an unknown state is refused', run(fresh(), 'add', ['x'], { state: 'donezo' }).code === 'Q461')
}

// ---------------------------------------------------------------------------
section('link')
{
  const g = fresh()
  run(g, 'add', ['director'])
  run(g, 'add', ['timeline'])
  const r = run(g, 'link', ['director', 'timeline'], { why: 'reads arrivals' })
  T('link succeeds', r.ok)
  const e = g.get(edgeKey('director', 'timeline'))
  T('edge stored under e:<from>|<to>', !!e)
  T('why is kept', e.why === 'reads arrivals')
  T('direction is preserved', e.from === 'director' && e.to === 'timeline')
  T('the reverse edge does NOT exist', !g.get(edgeKey('timeline', 'director')))

  // Deliberate: an agent must be able to record a dependency before the far end is on the map.
  const r2 = run(g, 'link', ['director', 'not-yet-added'])
  T('linking to an unknown node is allowed (it renders as a ghost)', r2.ok)

  T('self-links are refused', run(g, 'link', ['a', 'a']).code === 'Q463')
  T('link with one argument is refused', run(g, 'link', ['a']).code === 'Q462')
}

// ---------------------------------------------------------------------------
section('state / note')
{
  const g = fresh()
  run(g, 'add', ['beat'], { state: 'planned' })
  T('state change works', run(g, 'state', ['beat', 'wip']).ok && g.get(nodeKey('beat')).state === 'wip')
  T('state on a missing node is refused', run(g, 'state', ['ghost', 'built']).code === 'Q465')
  T('an invalid state is refused', run(g, 'state', ['beat', 'nearly']).code === 'Q461')
  T('note attaches text', run(g, 'note', ['beat', 'fires', 'every', '4h']).ok && g.get(nodeKey('beat')).note === 'fires every 4h')
  T('note on a missing node is refused', run(g, 'note', ['nope', 'x']).code === 'Q465')
}

// ---------------------------------------------------------------------------
section('rm / unlink')
{
  const g = fresh()
  run(g, 'add', ['a']); run(g, 'add', ['b']); run(g, 'add', ['c'])
  run(g, 'link', ['a', 'b']); run(g, 'link', ['b', 'c']); run(g, 'link', ['c', 'a'])
  const r = run(g, 'rm', ['b'])
  T('rm succeeds', r.ok)
  T('the node is gone', !g.get(nodeKey('b')))
  // Without this, deleted nodes leave edges nobody can see well enough to remove.
  T('edges INTO the removed node are swept', !g.get(edgeKey('a', 'b')))
  T('edges OUT of the removed node are swept', !g.get(edgeKey('b', 'c')))
  T('unrelated edges survive', !!g.get(edgeKey('c', 'a')))
  T('rm on a missing node is refused', run(g, 'rm', ['zzz']).code === 'Q465')
  T('unlink removes one edge', run(g, 'unlink', ['c', 'a']).ok && !g.get(edgeKey('c', 'a')))
  T('unlink on a missing edge is refused', run(g, 'unlink', ['c', 'a']).code === 'Q468')
}

// ---------------------------------------------------------------------------
section('readGraph / list')
{
  const g = fresh()
  run(g, 'add', ['zeta']); run(g, 'add', ['alpha']); run(g, 'link', ['alpha', 'zeta'])
  const { nodes, edges } = readGraph(g)
  T('readGraph separates nodes from edges', nodes.length === 2 && edges.length === 1)
  T('nodes come back sorted, so output is stable', nodes[0].id === 'alpha')
  T('list renders without throwing', run(g, 'list').ok)
  T('list marks state', run(g, 'list').msg.includes('[planned]'))
  T('an empty map says so', run(fresh(), 'list').msg.includes('(empty map)'))
  T('an unknown action is refused', run(g, 'wibble').code === 'Q469')
}

// ---------------------------------------------------------------------------
section('two agents, one graph (CRDT convergence)')
{
  // The whole premise is that agents edit this concurrently. If two disjoint edits did not
  // converge, the map would quietly disagree between viewers -- the worst possible failure for a
  // thing whose only job is to be trusted at a glance.
  const d1 = new Y.Doc(), d2 = new Y.Doc()
  const g1 = d1.getMap('graph'), g2 = d2.getMap('graph')
  applyCommand(g1, 'vega', 'add', ['relay'], { state: 'built' })
  applyCommand(g2, 'orion', 'add', ['director'], { state: 'wip' })
  applyCommand(g2, 'orion', 'link', ['director', 'relay'], {})
  Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)))
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)))
  T('both agents see both nodes', readGraph(g1).nodes.length === 2 && readGraph(g2).nodes.length === 2)
  T('both agents see the edge', readGraph(g1).edges.length === 1 && readGraph(g2).edges.length === 1)
  T('the two views are identical', JSON.stringify(readGraph(g1)) === JSON.stringify(readGraph(g2)))
}

// ---------------------------------------------------------------------------
section('map.html — the loading rules that made /control deaf')
{
  const html = fs.readFileSync(path.join(root, 'public', 'map.html'), 'utf8')
  // Two module URLs are two Yjs instances. The page then bulk-syncs on join (so it LOOKS right),
  // and silently stops applying incremental updates while reporting a healthy socket. Browser-only,
  // because npm dedupes -- no node test can ever reproduce it. So it is guarded statically.
  T('no CDN yjs import', !/from\s+['"]https?:\/\/[^'"]*yjs/.test(html) && !/import\(['"]https?:/.test(html))
  T('no CDN y-websocket import', !/y-websocket/.test(html) || !/https?:\/\/[^'"]*y-websocket/.test(html))
  T('imports the local bundle', /import\(['"]\.\/hive-crdt\.js['"]\)/.test(html))
  T('no other external script', !/<script[^>]+src=["']https?:/.test(html))

  T('reads the graph map', /getMap\(['"]graph['"]\)/.test(html))
  T('reads the claims map (this is what makes a node pulse)', /getMap\(['"]claims['"]\)/.test(html))
  T('observes the graph deeply, not just the top level', /graph\.observeDeep/.test(html))
  T('escapes node text before putting it in innerHTML', /function esc|const esc\s*=/.test(html))
  // Math.random() in the seed would scatter the layout on every reload, destroying the one thing a
  // spatial map is for: learning where things are.
  //
  // Comments are stripped first. The first version of this assertion failed against a COMMENT that
  // explained why Math.random is not used -- a test that reads prose as code, which is exactly the
  // silent-failure shape these checks exist to catch.
  const code = html.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n')
  T('layout seeding is deterministic, not random', /function seedPos/.test(code) && !/Math\.random\(\)/.test(code))

  const bundle = path.join(root, 'public', 'hive-crdt.js')
  T('hive-crdt.js exists next to the page', fs.existsSync(bundle))
  T('hive-crdt.js is a real bundle, not a stub', fs.existsSync(bundle) && fs.statSync(bundle).size > 50000)

  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  // Without the allowlist entry the relay serves the plain "relay is up" text at /map, which reads
  // exactly like a deploy that did not land.
  T('the relay serves /map', /'\/map':\s*'map\.html'/.test(server))
  T('the relay serves /map.html', /'\/map\.html':\s*'map\.html'/.test(server))
  T('the relay still serves the CRDT bundle', /'\/hive-crdt\.js':\s*'hive-crdt\.js'/.test(server))
}


// ---------------------------------------------------------------------------
section('map.html - readability (the Obsidian borrow)')
{
  const html = fs.readFileSync(path.join(root, 'public', 'map.html'), 'utf8')
  T('has a neighbourhood walk', /function neighbourhood\(/.test(html))
  T('has a lit set (focus dimming)', /function litSet\(/.test(html))
  T('hovering sets the focus, so reading costs no clicks', /if \(!selected\) focusId = hit \? hit\.id : null/.test(html))
  T('selecting pins the focus', /focusId = n \? n\.id : null/.test(html))
  T('node size comes from degree, not a fixed constant', /radiusOf = \(n\) =>[\s\S]{0,120}deg\.get\(n\.id\)/.test(html))
  T('builds adjacency from edges', /adj\.get\(e\.from\)\.add\(e\.to\)/.test(html))
  T('says in words what the graph means', /function renderReading\(/.test(html))
  T('names broken things other things depend on', /broken, and depended on/.test(html))
  T('search box exists', /id="q"/.test(html))
  T('depth control exists', /class="depth"/.test(html))
  T('legend doubles as a state filter', /#legend span\[data-s\]/.test(html))

  // A fixed-width panel plus `display:flex` on every child div made the reading prose run off the
  // side of the screen. The rule it needs is block + wrap; assert the bad one cannot come back.
  T('no flex rule that would stop the reading prose wrapping',
    !/#stats div\{display:flex/.test(html))
  T('reading text is allowed to wrap', /#reading \.r\{display:block;overflow-wrap:anywhere\}/.test(html))
}


// ---------------------------------------------------------------------------
section('edge kinds: needs vs then')
{
  const g = fresh()
  run(g, 'add', ['a']); run(g, 'add', ['b'])
  T('default edge kind is needs', run(g, 'link', ['a', 'b']).ok && g.get(edgeKey('a', 'b')).ekind === 'needs')
  T('then is accepted', run(g, 'link', ['a', 'b'], { kind: 'then' }).ok && g.get(edgeKey('a', 'b')).ekind === 'then')
  T('an unknown edge kind is refused', run(g, 'link', ['a', 'b'], { kind: 'maybe' }).code === 'Q472')
  T('list distinguishes a flow from a dependency', run(g, 'list').msg.includes('a => b'))
  run(g, 'link', ['b', 'a'], { kind: 'needs' })
  T('and still shows -> for a dependency', run(g, 'list').msg.includes('b -> a'))

  const html = fs.readFileSync(path.join(root, 'public', 'map.html'), 'utf8')
  // A step in a process and a dependency are different claims about the world. Drawn the same way
  // a workflow renders as a dependency web and reads as neither.
  T('the renderer tells a flow edge from a dependency', /const flow = e\.ekind === 'then'/.test(html))
  T('flow edges are drawn differently', /flow \?[\s\S]{0,90}rgba\(120,200,255/.test(html))
  T('flow edges animate, so direction is readable without tracing', /lineDashOffset = -\(Date\.now\(\)/.test(html))
}


// ---------------------------------------------------------------------------
section('clear')
{
  const g = fresh()
  run(g, 'add', ['a']); run(g, 'add', ['b']); run(g, 'link', ['a', 'b'])
  T('clear without confirmation is refused', run(g, 'clear').code === 'Q473')
  T('the map survives a refused clear', readGraph(g).nodes.length === 2)
  T('clear yes wipes nodes and edges', run(g, 'clear', ['yes']).ok && readGraph(g).nodes.length === 0 && readGraph(g).edges.length === 0)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
