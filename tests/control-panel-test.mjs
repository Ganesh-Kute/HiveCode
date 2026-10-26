// THE BROWSER CONTROL ROOM'S LOADING CONTRACT.
//
// Offline and static on purpose: every check here is a thing that was WRONG in production
// while every runtime signal said the panel was healthy. That is the whole reason this file
// exists -- the deaf-panel bug survived two investigations because nothing failed loudly.
//
//   1. Two CDN imports resolved to two different yjs builds (13.6.18 for the page,
//      13.6.32 pulled in by y-websocket's own `yjs@^13.0.0` range). Two module URLs are two
//      module instances, so every cross-instance constructor check failed -- yjs issue 438.
//      The panel synced on join, kept writing fine, and silently stopped APPLYING incoming
//      updates, with wsconnected/synced/retries all still reporting a perfect socket.
//   2. The mitigation for that, resyncAfterWrite, dropped the socket after every message the
//      panel sent. It turned a suspected intermittent fault into a guaranteed ~950ms blackout
//      that emptied the crew list, and that is the bug the operator actually reported.
//   3. An asset missing from the relay's STATIC allowlist or re-included in .vercelignore is
//      absent in production and fine locally. Both files say so in their own comments,
//      because both have already shipped that way.
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name) } }
const section = (s) => console.log('\n# ' + s)

const panel = read('public/control.html')
const server = read('server.js')
const relayStatic = read('relay-static.js')
const vign = read('.vercelignore')

section('one Yjs, chosen at build time')
{
  // The trap is not "a CDN is slow", it is that a CDN resolves the TRANSITIVE range itself.
  // Any remote yjs or y-websocket import can reintroduce a second instance, so none are allowed.
  const remoteCrdt = /https?:\/\/[^'"]*\b(yjs|y-websocket|y-protocols)\b/i.test(panel)
  T('the panel imports NO yjs/y-websocket/y-protocols over the network', !remoteCrdt)
  T('...and imports the local bundle instead', /import\(\s*'\.\/hive-crdt\.js'\s*\)/.test(panel))
  T('the bundle exists', fs.existsSync(path.join(root, 'public/hive-crdt.js')))

  const bundle = read('public/hive-crdt.js')
  // Both names the page destructures. A bundle that built but exported nothing useful would
  // otherwise fail only in a browser, at connect time.
  T('the bundle exports Y', /\bY\b/.test(bundle) && /export/.test(bundle))
  T('the bundle exports WebsocketProvider', /WebsocketProvider/.test(bundle))
  // yjs+y-websocket minifies to ~100 KB. A few hundred bytes means esbuild resolved the
  // imports to nothing (externals left in place) and the page will fail at run time.
  T('the bundle is a real bundle, not a stub', bundle.length > 50_000)
  T('its source is committed so it can be rebuilt', fs.existsSync(path.join(root, 'web/crdt.js')))
}

section('the bundle actually reaches both deploy targets')
{
  // The relay serves the site as well as the websocket, from a hand-maintained allowlist.
  T('the relay serves /hive-crdt.js', /'\/hive-crdt\.js':\s*'hive-crdt\.js'/.test(server) || /'\/hive-crdt\.js':\s*'hive-crdt\.js'/.test(relayStatic))
  T('...and knows the .js content type', /'\.js':\s*'text\/javascript/.test(server))
  // Vercel: `*.html` IS a blanket exclude with a re-include list, and every page that was
  // missing from it answered 404 in production. If a `*.js` rule is ever added, the bundle
  // needs the same treatment -- so fail here rather than in a browser.
  const blanketJs = vign.split(/\r?\n/).some((l) => {
    const t = l.trim()
    return t && !t.startsWith('#') && !t.startsWith('!') && /^\*\.js$|^\*\.js\b/.test(t)
  })
  const reincluded = /^!public\/hive-crdt\.js\s*$/m.test(vign)
  T('.vercelignore does not strip the bundle', !blanketJs || reincluded)
  T('control.html is re-included in .vercelignore', /^!public\/control\.html\s*$/m.test(vign))
}

section('the reconnect-on-every-message mitigation stays gone')
{
  T('resyncAfterWrite is not defined', !/function\s+resyncAfterWrite/.test(panel))
  T('...and is not called', !/resyncAfterWrite\s*\(/.test(panel))
  // The specific shape that caused it: tearing down a HEALTHY provider on a timer.
  T('nothing disconnects the provider on a timer',
    !/setTimeout\([^)]*provider\.disconnect/.test(panel) && !/provider\.disconnect\(\);?\s*setTimeout/.test(panel))
  // What replaced it must still be wired in, or a genuinely dead socket never recovers.
  T('the dead-socket watchdog exists', /function\s+reviveIfDead/.test(panel))
  T('...and it only fires when the socket is NOT healthy', /wsconnected\s*&&\s*p\.synced/.test(panel))
  T('...and runs on the existing sweep', /setInterval\(\(\)=>\{reviveIfDead\(\);render\(\)\},1000\)/.test(panel))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
