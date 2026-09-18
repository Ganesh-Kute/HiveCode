// hive-linear — Linear issues become room tasks, and finished room work reports back.
//
//   node hive-linear.js "<relay|room>" --label hivecode [--assign AgentA,AgentB] [--once]
//   env: LINEAR_MCP_TOKEN, optional LINEAR_MCP_URL (default https://mcp.linear.app/mcp)
//
// WHY THIS IS NOT THE GRAPHQL CLIENT I FIRST SPEC'D. The original plan was an OAuth app against
// api.linear.app/graphql plus a webhook on issue create/update -- and webhooks need a public
// HTTPS URL, which a self-hosted relay behind a company firewall cannot have. That was the single
// biggest architectural trap in the integration plan. Linear now ships an official REMOTE MCP
// SERVER, so the direction reverses: we are the CLIENT, we reach out, and nothing has to reach
// in. The firewall problem disappears rather than being worked around.
//
// The same reversal does NOT apply to Slack, which is why hive-mcp-http.js exists and is a
// server: Slackbot connects out to us. Two integrations, opposite directions, on purpose.
//
// IDEMPOTENCY IS THE WHOLE JOB. Polling means seeing the same issue again on every pass. The map
// from issue -> task lives in ROOM STATE, not in this process, so a bridge that restarts (or a
// second one started by mistake) does not fill the board with duplicates of work already running.

import { startSync, parseLink } from './sync.js'

const DEFAULT_URL = 'https://mcp.linear.app/mcp'
// Linear exposes a read-only endpoint. It is the DEFAULT here on purpose: the first run of this
// against a real company's ticket system should not be able to write to it, whatever the key says.
export const READONLY_URL = 'https://mcp.linear.app/mcp/readonly'

/** A minimal Streamable HTTP MCP client -- enough to talk to a hosted server like Linear's.
 *
 *  Two details here are what make it work against a real server rather than a toy one:
 *  the response may be framed as SSE rather than JSON, and the session id handed back by
 *  `initialize` must be echoed on every later request or the server treats each call as a
 *  fresh unknown client. */
export function mcpClient({ url = DEFAULT_URL, token = '', fetchImpl = fetch } = {}) {
  let id = 0
  let session = null

  function parse(body, contentType) {
    if (/text\/event-stream/.test(contentType || '')) {
      const data = String(body).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      if (!data) throw new Error('Q530 empty event stream from the MCP server')
      return JSON.parse(data)
    }
    return JSON.parse(body || '{}')
  }

  async function rpc(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      // Ask for both framings. A client that only advertises JSON gets refused by servers that
      // stream, and one that only advertises SSE cannot read a plain reply.
      Accept: 'application/json, text/event-stream',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (session) headers['Mcp-Session-Id'] = session
    const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    const sid = r.headers && r.headers.get && r.headers.get('mcp-session-id')
    if (sid) session = sid
    const msg = parse(await r.text(), r.headers && r.headers.get && r.headers.get('content-type'))
    if (msg.error) throw new Error(`Q531 ${method}: ${msg.error.message || 'failed'}`)
    return msg.result
  }

  return {
    init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hivecode', version: '1.0.0' } }),
    tools: () => rpc('tools/list', {}),
    call: (name, args) => rpc('tools/call', { name, arguments: args || {} }),
    sessionId: () => session,
  }
}

/** MCP tool results are content blocks, not data. Linear returns its issues as a JSON string
 *  inside a text block, so anything that reads them has to go through here rather than assuming
 *  a shaped object -- and has to survive a server that returns prose instead. */
export function unwrap(result) {
  const blocks = (result && result.content) || []
  for (const b of blocks) {
    if (b.type !== 'text') continue
    try { return JSON.parse(b.text) } catch { /* not JSON -- try the next block */ }
  }
  return null
}

// THE FIELD NAMES BELOW WERE MEASURED AGAINST THE REAL SERVER, NOT GUESSED, AND THE GUESSES WERE
// WRONG. Linear's MCP returns `status` as a plain string ("Todo") -- there is no `state.name`, so
// the first version of this filter rejected every issue in a real workspace while passing its own
// tests against a fixture I had invented. It also returns `id` as the HUMAN identifier ("HIV-1")
// and a separate `uuid` for the database id, which is the opposite of the usual convention.
export const statusOf = (i) => String((i && i.status) || (i && i.state && i.state.name) || (i && i.state) || '')

/** The stable key for an issue. The uuid, not "HIV-1": identifiers can be re-keyed when an issue
 *  moves team, and write-back tools address issues by uuid. */
export const idOf = (i) => String((i && i.uuid) || (i && i.id) || '')

/** Which issues become work. Deliberately narrow: a team will not hand its whole backlog to a
 *  room, and an integration that does that on day one gets uninstalled on day one.
 *
 *  `statusTypes` is the robust filter and `states` the exact one. Linear's TYPES (unstarted,
 *  started, completed, canceled, backlog) are fixed by Linear; the NAMES are whatever the team
 *  renamed them to. Matching on names alone is how this silently returns nothing for a team that
 *  calls its Todo column "Up Next". */
export function pickIssues(issues, { label = 'hivecode', states = null, statusTypes = ['unstarted', 'started'] } = {}) {
  return (issues || []).filter((i) => {
    if (!i || !idOf(i)) return false
    if (label) {
      const labels = (i.labels || []).map((l) => String((l && l.name) || l).toLowerCase())
      if (!labels.includes(String(label).toLowerCase())) return false
    }
    if (states && states.length) {
      const s = statusOf(i)
      return states.some((x) => String(x).toLowerCase() === s.toLowerCase())
    }
    if (statusTypes && statusTypes.length && i.statusType) {
      return statusTypes.includes(String(i.statusType))
    }
    return true
  })
}

/** Linear issue -> the sentence an agent is actually given.
 *  The identifier goes FIRST so a human reading the room board can find the ticket, and so the
 *  write-back can recover it from the task text alone if the map is ever lost. */
export function taskTextOf(issue) {
  const head = issue.identifier || issue.id
  const title = issue.title || '(untitled)'
  return issue.description ? `${head}: ${title} — ${String(issue.description).split('\n')[0].slice(0, 200)}` : `${head}: ${title}`
}

/** Pick who gets it. An explicit Linear-assignee -> room-participant map wins; otherwise spread
 *  across the agents that are here, fewest open tasks first, so one agent does not take the lot. */
export function chooseAssignee(issue, { agents, identity = {}, openCount = () => 0 }) {
  if (!agents || !agents.length) return null
  const who = issue.assignee && (issue.assignee.email || issue.assignee.name)
  if (who && identity[who]) return identity[who]
  return [...agents].sort((a, b) => openCount(a) - openCount(b) || String(a).localeCompare(String(b)))[0]
}

// `room` is passed in rather than read off the sync handle: startSync returns no room field, so
// `hive.room` is undefined and interpolating it posted "in room `undefined`" into a real ticket.
// A comment on somebody's Linear issue is the most externally visible thing this file does.
export function makeBridge({ hive, linear, room = '', label = 'hivecode', states = null, statusTypes, identity = {}, assignAs, readOnly = false, team = null, limit = 50, maxPages = 20 }) {
  // issue id -> room task id. In ROOM state so a restart cannot duplicate the board.
  const seen = hive.doc.getMap('linear_tasks')
  const tasks = hive.doc.getMap('tasks')
  const openCount = (name) => [...tasks.values()].filter((t) => t.to === name && (t.status === 'accepted' || t.status === 'pending')).length
  const agentsHere = () => (hive.members ? hive.members() : []).filter((p) => p.kind === 'ai').map((p) => p.name)

  /** One pass: read Linear, put anything new on the board. Safe to run on a timer. */
  async function pull({ agents, team: teamOverride } = {}) {
    const filterTeam = teamOverride !== undefined ? teamOverride : team
    // `limit`, NOT the GraphQL-style `first` this originally sent. Linear answered a `first`
    // query with an empty list rather than an error, so the bridge reported "0 tickets" against a
    // workspace that had four -- a wrong parameter name that looked exactly like an empty backlog.
    // list_issues also takes server-side team/label/state filters, but the fetch is deliberately
    // left BROAD so that when nothing matches, pull() can still say what labels and statuses it
    // actually saw. A server-side filter returns an empty list and takes the diagnosis with it.
    // HIV-14: Paginate and filter by team; keep the label/status filtering local.
    const issues = []
    let cursor = undefined
    let pageCount = 0
    const pageCap = maxPages > 0 ? maxPages : 20

    while (pageCount < pageCap) {
      pageCount++
      const args = { limit, ...(filterTeam ? { team: filterTeam } : {}) }
      if (cursor) args.cursor = cursor
      const res = await linear.call('list_issues', args)
      const payload = unwrap(res)
      const pageIssues = Array.isArray(payload) ? payload : (payload && payload.issues) || []
      issues.push(...pageIssues)

      let nextCursor = null
      if (payload && !Array.isArray(payload)) {
        if (payload.hasNextPage !== false) {
          nextCursor = payload.cursor || (payload.pageInfo && payload.pageInfo.endCursor) || payload.nextCursor || null
        }
      }
      if (!nextCursor || pageIssues.length === 0 || nextCursor === cursor) {
        break
      }
      cursor = nextCursor
    }

    const wanted = pickIssues(issues, { label, states, statusTypes })
    const roster = agents || agentsHere()
    const made = []
    for (const issue of wanted) {
      const key = idOf(issue)
      if (seen.has(key)) continue                // already on the board -- this is the whole point
      const to = chooseAssignee(issue, { agents: roster, identity, openCount })
      if (!to) continue                          // nobody to give it to; leave it in Linear
      const taskId = hive.assign(to, taskTextOf(issue), assignAs)
      seen.set(key, { task: taskId, to, identifier: issue.id || key })
      made.push({ issue: issue.id || key, to, task: taskId })
    }
    // A silent zero is the failure mode of this whole integration: it looks identical whether the
    // label is misspelled, the statuses were renamed, or there is genuinely no work. So say WHICH.
    const why = !issues.length ? 'Linear returned no issues at all'
      : !wanted.length ? `${issues.length} issue(s) seen, none matched` +
        (label ? ` label "${label}"` : '') +
        (label && (states || statusTypes) ? ' and' : '') +
        (states ? ` status ${states.join('/')}` : statusTypes ? ` status type ${statusTypes.join('/')}` : '') +
        `. Seen: ${[...new Set(issues.map((i) => statusOf(i) || '?'))].join(', ')}` +
        ` | labels present: ${[...new Set(issues.flatMap((i) => (i.labels || []).map((l) => (l && l.name) || l)))].join(', ') || '(none)'}`
      : !roster.length ? 'no AI agents are in the room to take the work'
      : ''
    return { considered: issues.length, eligible: wanted.length, created: made, why }
  }

  /** A room task finished -> say so on the ticket. Comment rather than close: a room's gate is a
   *  pre-handoff check in one folder, not the team's definition of done, and silently closing
   *  someone's ticket is how an integration loses trust in week one. */
  async function report(taskId, note = '') {
    // A read-only key (or the /readonly endpoint) is the right way to trial this against a real
    // company's Linear -- but then every write-back fails, and the retry in watch() would hammer
    // the API forever over something that is working as configured. Say so once and stop.
    if (readOnly) return { ok: false, why: 'Q533 read-only: nothing was written back to Linear' }
    for (const [issueId, rec] of seen.entries()) {
      if (!rec || rec.task !== taskId) continue
      const t = tasks.get(taskId) || {}
      const where = room ? ` in room \`${room}\`` : ''
      const body = `Hivecode: **${t.to || rec.to}** finished this${where}.${note ? `\n\n${note}` : ''}`
      // `save_comment`, NOT `create_comment`. Linear's MCP uses save_* upsert naming for every
      // write (save_issue, save_comment, save_document) -- the create_* names in third-party
      // directory listings do not exist on the server, and calling one fails at the first real
      // write-back with an unknown-tool error. Found by listing the live server's 66 tools.
      await linear.call('save_comment', { issueId, body })   // issueId IS the uuid -- see idOf()
      return { ok: true, issue: rec.identifier }
    }
    return { ok: false, why: 'Q532 that task did not come from Linear' }
  }

  /** Watch the board and report each task the moment it is marked done. */
  function watch() {
    const reported = new Set()
    const onChange = () => {
      for (const [id, rec] of seen.entries()) {
        const t = tasks.get(rec && rec.task)
        if (!t || t.status !== 'done' || reported.has(rec.task)) continue
        reported.add(rec.task)
        if (readOnly) continue
        report(rec.task).catch(() => { reported.delete(rec.task) })   // let a failed post retry
      }
    }
    tasks.observe(onChange)
    return () => tasks.unobserve(onChange)
  }

  return { pull, report, watch, seen }
}

// ---- main -------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const argv = process.argv.slice(2)
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  const LINK = argv.find((a) => !a.startsWith('--')) || ''
  const TOKEN = process.env.LINEAR_MCP_TOKEN || ''
  if (!LINK || !TOKEN) {
    console.error('usage: LINEAR_MCP_TOKEN=… node hive-linear.js "<relay|room>" [--label hivecode] [--team team] [--limit N] [--max-pages N] [--once]')
    process.exit(2)
  }
  const { relay, room } = parseLink(LINK)
  const hive = startSync({
    relay, room, dir: (process.env.TEMP || '.') + '/hive-linear-' + room,
    name: flag('name', 'Linear'), kind: 'human', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {},
  })
  const URL_ = process.env.LINEAR_MCP_URL || (argv.includes('--write') ? DEFAULT_URL : READONLY_URL)
  const READ_ONLY = /\/readonly\/?$/.test(URL_)
  const linear = mcpClient({ url: URL_, token: TOKEN })
  const LABEL = argv.includes('--any-label') ? null : flag('label', 'hivecode')
  const bridge = makeBridge({
    hive, linear, room, readOnly: READ_ONLY, label: LABEL,
    team: flag('team') || null, assignAs: flag('name', 'Linear'),
    limit: flag('limit') ? Number(flag('limit')) : 50,
    maxPages: flag('max-pages') ? Number(flag('max-pages')) : 20,
  })
  console.log(`[hive-linear] ${URL_}${READ_ONLY ? '  (read-only: tickets come in, nothing is written back)' : '  (read-write)'}`)

  await linear.init()
  bridge.watch()
  const once = argv.includes('--once')
  const tick = async () => {
    try {
      const r = await bridge.pull()
      if (r.created.length) console.log(`[hive-linear] ${r.created.map((c) => `${c.issue}->${c.to}`).join(', ')}`)
      else if (r.why) console.log(`[hive-linear] nothing created: ${r.why}`)
    } catch (e) { console.error(e.message) }
  }
  await tick()
  if (once) process.exit(0)
  setInterval(tick, Number(flag('every', '60')) * 1000)
  console.log(`[hive-linear] ${room} <- Linear (label "${flag('label', 'hivecode')}")`)
}
