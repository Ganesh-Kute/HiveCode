// WHICH RELAY IS THIS, AND DID ANYBODY CHOOSE IT?
//
// Every byte of a team's source leaves their machines through one URL: the relay. The
// client has always printed that URL and stopped there -- a bare `relay: wss://...` line
// that says nothing about what it MEANS. That is the whole defect this file exists for,
// and it is the product's highest-stakes false success:
//
//   An agent starts with no link and no .hive.json. resolveRoom() falls through to the
//   shipped default -- a relay the team does not run. The agent joins. hive_status says
//   connected. filesSynced climbs. Every signal is green, and the company's source code
//   is now on a stranger's server. Nothing crashed, so nothing reports it.
//
// Two separate things are needed and they are NOT the same thing:
//
//   1. A VERDICT on every join, so "am I private?" is answered without being asked.
//      Printing the URL is not a verdict. A person who has never run a relay cannot tell
//      wss://livecode-xoss.onrender.com from wss://relay.theircompany.com by looking.
//
//   2. A PIN that REFUSES. A verdict you have to read is a verdict that gets skimmed, and
//      an agent does not read banners at all. HIVE_RELAY_PIN says "this machine may only
//      ever talk to these relays" -- set once in the MCP config, and no stale link, no
//      typo'd host and no forgotten env var can send a file anywhere else. The refusal
//      happens BEFORE the socket opens, so a refused join publishes nothing.
//
// Comparison is on ORIGIN, never on the raw string. wss://r.co, wss://r.co/ and
// wss://R.co:443 are one relay; a string compare would refuse a correct configuration,
// and a guard that fires on the healthy path is a guard people disable.

// The relay this build falls back to when nobody chose one -- THE ONE PLACE IT IS WRITTEN.
//
// It used to be written four times: here, hive-mcp.js, hive-agent.js and hive-say.js, each a
// literal. On 23 Sep 2026 the hosted relay's Render account was suspended and a new one stood
// up at a new address, and moving meant hunting down every copy -- any one missed would have
// sent that client to a dead host, or made this module call the live default "YOUR RELAY".
// Every client now imports it from here. The extension's JSON setting cannot import, so
// extension-privacy-parity-test pins it equal to this value instead.
export const PUBLIC_DEFAULT_RELAY = 'wss://hivecode-relay.onrender.com'

// Relays this project has run publicly and retired. A .hive.json written before a move still
// names the old one, and if that host ever answers again (a reactivated account, a squatter
// on the name) the verdict must still say PUBLIC -- not "YOUR RELAY", which is what any host
// outside this list is called.
export const RETIRED_PUBLIC_RELAYS = ['wss://livecode-xoss.onrender.com']

/**
 * The relay a client should actually dial for a URL it was handed.
 *
 * A RETIRED PUBLIC RELAY IS FOLLOWED TO ITS REPLACEMENT, and nothing else is ever rewritten.
 * Measured 23 Sep 2026 on 0.12.1 -- a build that already shipped the new default: a project
 * folder whose .hive.json was written before the move still named the retired host, the client
 * obeyed it, and a returning user got "NOT JOINED ... 503" exactly as if nothing had been fixed.
 * The same held for HIVE_RELAY set to the old host, which docs/MCP.md told people to do.
 *
 * That address was never the user's choice -- it was this project's default, copied into their
 * config by the client and by our own docs -- so following it to the current default honours
 * what they actually chose (the public relay), and moves nobody from anyone to anyone else.
 * A relay the user runs is never in RETIRED_PUBLIC_RELAYS and is returned untouched.
 *
 * Returns { relay, migratedFrom } -- migratedFrom is the retired URL when a move happened,
 * so the caller can say so on screen instead of changing someone's destination silently.
 */
export function currentRelayFor(url) {
  const origin = relayOrigin(url)
  if (origin && RETIRED_PUBLIC_RELAYS.some((r) => relayOrigin(r) === origin)) {
    return { relay: PUBLIC_DEFAULT_RELAY, migratedFrom: String(url).trim() }
  }
  return { relay: url, migratedFrom: null }
}

const DEFAULT_PORT = { 'ws:': '80', 'wss:': '443', 'http:': '80', 'https:': '443' }

/**
 * Normalise a relay URL to a comparable origin: scheme://host:port, lowercased, with the
 * scheme's default port made explicit. Returns null for anything that is not a URL --
 * callers must treat null as "unknown", never as "fine".
 */
export function relayOrigin(url) {
  const s = String(url || '').trim()
  if (!s) return null
  let u
  try { u = new URL(s) } catch { return null }
  const proto = u.protocol.toLowerCase()
  if (!DEFAULT_PORT[proto]) return null
  const port = u.port || DEFAULT_PORT[proto]
  // ws:// and wss:// to the same host:port are the SAME relay reached two ways, and a pin
  // written as https:// (which is what a person copies out of a browser) must match the
  // wss:// the client actually dials. Scheme is reported separately by classifyRelay so
  // the plaintext warning still fires; it deliberately does not participate in identity.
  const secureScheme = proto === 'wss:' || proto === 'https:'
  return `${secureScheme ? 'wss' : 'ws'}://${u.hostname.toLowerCase()}:${port}`
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]'])

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK.has(h)) return true
  return /^127\./.test(h)
}

function isPrivateLan(host) {
  const h = String(host || '').toLowerCase()
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/\.local$/.test(h) || /\.lan$/.test(h) || /\.internal$/.test(h)) return true
  // A PRIVATE MESH (Tailscale and friends) IS A PRIVATE NETWORK, and the first version of this
  // file called it "the public internet in plaintext". 100.64.0.0/10 is the shared address space
  // Tailscale hands out and *.ts.net is its MagicDNS; the transport underneath is WireGuard,
  // end-to-end encrypted between the two devices, and nothing outside the tailnet can even
  // route to the relay. Warning a remote team that chose the most private setup available
  // that their source was travelling in the clear would have taught them to ignore the verdict.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true
  if (/\.ts\.net$/.test(h)) return true
  return false
}

// PUBLIC TUNNELS decrypt at their own edge. A relay on a laptop behind cloudflared or ngrok is
// the team's relay -- nobody else runs it -- but the tunnel provider terminates TLS and can read
// every frame, and anyone holding the URL can reach the port. Both facts matter to a team that
// picked a tunnel *for privacy*, and neither is visible in a URL that starts with wss://.
const PUBLIC_TUNNEL = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io|ngrok-free\.dev|loca\.lt|serveo\.net|localhost\.run)$/

function isPublicTunnel(host) {
  return PUBLIC_TUNNEL.test(String(host || '').toLowerCase())
}

/**
 * What kind of relay is this, and does traffic to it leave the machine in the clear?
 *
 *   kind: 'public-default' | 'loopback' | 'private-lan' | 'tunnel' | 'own' | 'unknown'
 *
 * 'own' does not mean audited -- it means "not the relay we ship". A team that pastes a
 * link from a blog post lands in 'own' too, which is exactly why the pin exists.
 */
// Where a PERSON opens a room: the relay's own Control Room, with the room's link in the hash.
// The host comes from the link, never from a default -- a self-hosted room printed with the
// public panel's address would send them to the wrong relay -- and a URL hash is never sent to
// any server, so a token in the link stays in the browser. null when there is no room to open.
export function controlUrl(link) {
  const s = String(link || '').trim()
  const [relay = '', room = ''] = s.split('|')
  if (!/^wss?:\/\//i.test(relay.trim()) || !room.trim()) return null
  return `${relay.trim().replace(/^ws/i, 'http').replace(/\/+$/, '')}/control#${encodeURIComponent(s)}`
}

export function classifyRelay(url) {
  const origin = relayOrigin(url)
  if (!origin) return { kind: 'unknown', origin: null, host: null, encrypted: false, url: String(url || '') }
  const u = new URL(String(url).trim())
  const host = u.hostname.toLowerCase()
  const encrypted = u.protocol === 'wss:' || u.protocol === 'https:'
  let kind
  if (origin === relayOrigin(PUBLIC_DEFAULT_RELAY) ||
    RETIRED_PUBLIC_RELAYS.some((r) => relayOrigin(r) === origin)) kind = 'public-default'
  else if (isLoopback(host)) kind = 'loopback'
  else if (isPrivateLan(host)) kind = 'private-lan'
  else if (isPublicTunnel(host)) kind = 'tunnel'
  else kind = 'own'
  return { kind, origin, host, encrypted, url: String(url).trim() }
}

/**
 * The pin, from the environment or from <dir>/.hive.json's `pinnedRelay`. Comma-separated,
 * because a team legitimately has a staging relay and a production one.
 *
 * A pin that cannot be parsed is an ERROR, never an empty pin. That distinction is the
 * whole value of the feature: a typo silently collapsing to "no pin" leaves somebody
 * believing they are locked to their own relay while the client dials the public one --
 * the same absence-rendered-as-a-value shape the room has been bitten by before.
 */
export function readPin({ env = process.env, dir = null, fs = null } = {}) {
  let raw = String((env && env.HIVE_RELAY_PIN) || '').trim()
  let from = 'HIVE_RELAY_PIN'
  if (!raw && dir && fs) {
    try {
      const cfg = JSON.parse(fs.readFileSync(`${dir}/.hive.json`, 'utf8'))
      if (cfg && cfg.pinnedRelay) { raw = String(cfg.pinnedRelay).trim(); from = '.hive.json pinnedRelay' }
    } catch { /* no config, or not JSON -- that is "no pin", not "bad pin" */ }
  }
  if (!raw) return { pinned: false, origins: [], from: null, raw: '' }
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const origins = []
  const bad = []
  for (const p of parts) {
    const o = relayOrigin(p)
    if (o) origins.push(o); else bad.push(p)
  }
  if (bad.length || !origins.length) {
    return { pinned: true, origins, from, raw, error: `not a relay URL: ${bad.join(', ') || raw}` }
  }
  return { pinned: true, origins, from, raw }
}

const HEADLINE = {
  'public-default': 'PUBLIC RELAY — not yours',
  loopback: 'PRIVATE — relay on this machine',
  'private-lan': 'PRIVATE — relay on your network',
  tunnel: 'YOUR RELAY — through a public tunnel',
  own: 'YOUR RELAY',
  unknown: 'UNKNOWN RELAY',
}

/**
 * A ROOM'S NAME IS ITS ONLY KEY ON A RELAY ANYONE CAN REACH (3 Oct 2026). Joining needs nothing but
 * the name, and a relay creates whatever room it is asked for. A hosted room's id is 104 random bits;
 * a name somebody typed -- "night", "acme-backend" -- can be guessed, and whoever guesses it reads
 * every file and writes into every member's folder.
 *
 * A string cannot prove it is random, but the generator can be recognised: hosted rooms and branch
 * rooms are always `room-` + exactly 18 random base64url characters, which switch between lower
 * case, upper case and digits at least twice in all but 3 of 100,000 (measured). That form is
 * trusted. Any other name was typed by someone, and passes only with a long run that keeps
 * switching the way generated strings do. Measured: a switch threshold low enough to pass every
 * random id also passed camel-case words ("teamAlphaBravo2026"), and one high enough to stop the
 * words flagged 367 in 100,000 random hosted ids -- hence trusting the form, not the threshold.
 */
const charClass = (ch) => (/[a-z]/.test(ch) ? 'l' : /[A-Z]/.test(ch) ? 'u' : /[0-9]/.test(ch) ? 'd' : '')
function classSwitches(run) { let n = 0, prev = ''; for (const ch of run) { const c = charClass(ch); if (!c) continue; if (prev && c !== prev) n++; prev = c } return n }
export function guessableRoom(room) {
  const id = String(room || '')
  if (/^hs_/.test(id)) return false // a secured room: joining it takes a token signed by its owner
  if (/^room-[A-Za-z0-9_-]{18}$/.test(id) && new Set(id.slice(5)).size >= 8 && classSwitches(id.slice(5)) >= 2) return false // the hosted form
  const runs = id.match(/[A-Za-z0-9_-]{16,}/g) || []
  return !runs.some((r) => new Set(r).size >= 10 && classSwitches(r) >= 8)
}

/**
 * The one call a client makes before opening a socket.
 *
 * Returns { ok, code, headline, detail, classification, pin }. `ok:false` means DO NOT
 * CONNECT -- the caller must not open the socket and must not publish anything, because
 * publishing is the leak this prevents. A warning (ok:true with `warn`) is printed and
 * proceeds: a team on a plaintext LAN relay has made a choice, and refusing it would be
 * this guard deciding policy it was not given.
 *
 *   Q550  the relay is not one this machine is pinned to
 *   Q551  HIVE_PRIVATE is set and this is the public relay we ship
 *   Q552  the pin itself is malformed, so nothing is actually pinned
 */
export function checkRelay({ relay, env = process.env, dir = null, fs = null, room = null } = {}) {
  const c = classifyRelay(relay)
  const pin = readPin({ env, dir, fs })
  const strict = String((env && env.HIVE_PRIVATE) || '') === '1'

  if (pin.pinned && pin.error) {
    return {
      ok: false, code: 'Q552', classification: c, pin,
      headline: 'Q552 THE RELAY PIN IS MALFORMED — REFUSING TO CONNECT',
      detail: [
        `${pin.from} = ${pin.raw}`,
        `problem: ${pin.error}`,
        '',
        'A pin that cannot be parsed is refused rather than ignored. Ignoring it would leave',
        'you believing this machine is locked to your relay while it dials whatever it likes.',
        'Write it as a full URL, e.g. HIVE_RELAY_PIN=wss://relay.yourcompany.com',
      ].join('\n'),
    }
  }

  if (pin.pinned && c.origin && !pin.origins.includes(c.origin)) {
    return {
      ok: false, code: 'Q550', classification: c, pin,
      headline: 'Q550 THIS RELAY IS NOT THE ONE THIS MACHINE IS PINNED TO — REFUSING TO CONNECT',
      detail: [
        `asked to connect to : ${c.url}   (${c.origin})`,
        `pinned to           : ${pin.origins.join(', ')}   (via ${pin.from})`,
        '',
        'Nothing was opened and nothing was published, so no file has left this machine.',
        c.kind === 'public-default'
          ? 'The relay asked for is the PUBLIC one this build ships as a fallback — which is what\nyou get when a link is missing, a .hive.json was not found, or HIVE_RELAY is unset.'
          : 'Check the join link you were given, and HIVE_RELAY in this process\'s environment.',
      ].join('\n'),
    }
  }

  if (!pin.pinned && strict && c.kind === 'public-default') {
    return {
      ok: false, code: 'Q551', classification: c, pin,
      headline: 'Q551 HIVE_PRIVATE=1 AND THIS IS THE PUBLIC RELAY — REFUSING TO CONNECT',
      detail: [
        `relay: ${c.url}`,
        '',
        'This is the relay this build falls back to when nobody chose one. Under HIVE_PRIVATE',
        'that fallback is an error rather than a default, because it is reached by omission —',
        'a missing link or an unset HIVE_RELAY — and never by anybody deciding on it.',
        '',
        'Point HIVE_RELAY at your own relay, or unset HIVE_PRIVATE if you meant to use ours.',
      ].join('\n'),
    }
  }

  // Connecting. Say what that means, in one line, every time.
  let warn = null
  if (c.kind === 'public-default') {
    warn = 'Your files are being sent to a relay run by the Hivecode author, not by you. ' +
      'Anyone who learns this room id can read them. For private work run your own relay ' +
      '(npx hivecode-relay) and set HIVE_RELAY.'
    if (room && guessableRoom(room)) {
      warn += ` THE ROOM NAME "${room}" CAN BE GUESSED: anyone who tries it joins, reads every file, ` +
        'and writes into every folder in it. For real code, host a new room (its id is random) and share that link instead.'
    }
  } else if (c.kind === 'tunnel') {
    warn = `${c.host} is a public tunnel. The relay is yours, but the tunnel provider decrypts ` +
      'traffic at its edge and can read it, and anyone with this URL can reach the relay. Fine for ' +
      'a trial with --secret set; for private remote work use a private network (e.g. Tailscale) ' +
      'or a server you control.'
  } else if (c.kind === 'own' && !c.encrypted) {
    warn = `ws:// to ${c.host} is NOT encrypted — your source travels the public internet in ` +
      'plaintext. Put TLS in front of the relay and use wss://.'
  } else if (c.kind === 'unknown') {
    warn = `"${c.url}" does not parse as a relay URL — the client will almost certainly fail ` +
      'to connect, and if it does connect you cannot tell where to.'
  }

  return {
    ok: true, code: null, classification: c, pin, warn,
    headline: `${HEADLINE[c.kind]}${c.encrypted ? '' : c.kind === 'loopback' ? '' : ' (UNENCRYPTED)'}`,
    detail: warn || '',
  }
}

/** One line for a join banner / status block: the URL plus what it means. */
export function privacyLine(relay, opts = {}) {
  const v = checkRelay({ relay, ...opts })
  return `relay: ${relay}  [${v.headline}]`
}
