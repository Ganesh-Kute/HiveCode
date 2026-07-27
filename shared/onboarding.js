// The canonical "what do I do now" instructions, in one place.
//
// A customer meets these steps three times: in the dialog right after paying, in the licence
// email, and on the website. They were previously written (and worded differently) in each of
// those places, and one of them told people to run a command that does not exist —
// "Hivecode: Set Licence Key" instead of "Hivecode: Enter License Key". A wrong command name
// is indistinguishable from a broken product to the person who just paid.
//
// There are TWO ways to start, not one, and the difference matters commercially: an
// agents-only customer never installs the editor extension at all, so telling them to install
// it is telling them to do the wrong thing first. Both tracks live here.
//
// Plain JavaScript with JSDoc so the serverless functions can import it with no build step,
// the same arrangement as shared/license.js.

export const SITE_URL = 'https://hivecode.vercel.app'
export const MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode'
export const AGENT_GUIDE_URL =
  'https://github.com/Ganesh-Kute/HiveCode/blob/main/docs/JOIN_WITH_AGENT.md'
export const WORKFLOW_GUIDE_URL =
  'https://github.com/Ganesh-Kute/HiveCode/blob/main/docs/WORKFLOW.md'

/** The hosted relay also serves the browser Control Room — no install, works on a phone. */
export const CONTROL_ROOM_URL = 'https://livecode-xoss.onrender.com/control'

/** Self-service key recovery, keyed on the payment reference from the Razorpay receipt. */
export const RECOVER_URL = `${SITE_URL}/recover`

/** Registers the MCP server for Claude Code. One line, once per machine. */
export const MCP_ADD_COMMAND = 'claude mcp add hivecode -- npx -y hivecode-mcp'

/** The same registration for clients without a CLI (Claude Desktop, Cursor). */
export const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp"] }
  }
}`

/** Exact command titles as contributed in extension/package.json. Keep them identical —
 *  these strings are what the customer types into the Command Palette. */
export const COMMANDS = Object.freeze({
  enterLicense: 'Hivecode: Enter License Key',
  hostSecured: 'Hivecode: Host a Secured Session',
  hostOpen: 'Hivecode: Host an Open Session',
  controlRoom: 'Hivecode: Open Control Room (browser / phone)',
})

/**
 * @typedef {object} Step
 * @property {string} title       imperative, five words or fewer
 * @property {string} body        one or two plain sentences
 * @property {'link'|'command'|'shell'|'say'} [kind] what `literal` is, so each surface can style it
 * @property {string} [literal]   the exact text to click, type, run, or say
 * @property {string} [url]       destination when kind is 'link'
 * @property {string} [note]      the bit people get wrong
 */

/** Agents only: no editor, no account, no server. The agent creates the room itself. */
/** @type {readonly Step[]} */
export const AGENT_STEPS = Object.freeze([
  Object.freeze({
    title: 'Register the tools once',
    body: 'One line in the terminal, once per machine. Nothing to install afterwards — your agent gains a set of room tools it can call natively.',
    kind: 'shell',
    literal: MCP_ADD_COMMAND,
    note: 'Claude Desktop and Cursor read a config file instead; restart the client so it picks up the tools.',
  }),
  Object.freeze({
    title: 'Tell an agent to join',
    body: 'In plain English. No room exists yet, so it creates one for that folder and hands you back an invite link.',
    kind: 'say',
    literal: 'Join a hivecode room for this folder. Your name is Ana, I am your owner.',
    note: 'The owner is the human accountable for that agent — only you can approve work aimed at it.',
  }),
  Object.freeze({
    title: 'Paste the link to the others',
    body: 'Same sentence, a different name. Every agent is now working in one shared folder, announcing and claiming files instead of overwriting each other.',
    kind: 'say',
    literal: 'Join this hivecode room: <the link>. Your name is Ben, I am your owner.',
  }),
  Object.freeze({
    title: 'Watch from any browser',
    body: 'Open the Control Room and paste the same link to see the crew, their chat, what each one is holding, and to steer or roll back work. Works on a phone.',
    kind: 'link',
    literal: 'The browser Control Room',
    url: CONTROL_ROOM_URL,
  }),
])

/** You and your team in editors, with agents alongside. This is the licensed path today. */
/** @type {readonly Step[]} */
export const EDITOR_STEPS = Object.freeze([
  Object.freeze({
    title: 'Install the extension',
    body: 'One click, and nothing else to install — no relay to run, no account to create.',
    kind: 'link',
    literal: 'Hivecode for VS Code',
    url: MARKETPLACE_URL,
  }),
  Object.freeze({
    title: 'Paste your licence key',
    // Deliberately not "the key from your email" — this same sentence is rendered inside
    // that email, where it would be circular.
    body: 'Open the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on a Mac), run this, and paste in your licence key.',
    kind: 'command',
    literal: COMMANDS.enterLicense,
    note: 'The key is stored in VS Code, per machine — you only do this once.',
  }),
  Object.freeze({
    title: 'Host a room',
    body: 'From the same Command Palette. Your project folder becomes the room, and you get one invite link back.',
    kind: 'command',
    literal: COMMANDS.hostSecured,
    note: 'A secured room only admits clients holding that link. Everything stays in your workspace.',
  }),
  Object.freeze({
    title: 'Hand the link to your agent',
    body: 'Register the Hivecode tools with your agent once per machine, then simply tell it to join and paste the link.',
    kind: 'shell',
    literal: MCP_ADD_COMMAND,
    note: 'Then, in plain English: “join this hivecode room: <your link>”. Claude Desktop and Cursor use a config file instead of this command.',
  }),
])

/** The two ways in, in the order we recommend reading them. */
export const TRACKS = Object.freeze([
  Object.freeze({
    id: 'agents',
    name: 'Agents only',
    when: 'You want a crew of AI agents working the same project, and you watch from a browser.',
    steps: AGENT_STEPS,
  }),
  Object.freeze({
    id: 'editor',
    name: 'You and your team',
    when: 'People are editing too, in their own editors, with agents alongside them.',
    steps: EDITOR_STEPS,
  }),
])

/** For a self-hosted relay, the key goes in the environment instead of the editor. */
export const SELF_HOST_NOTE =
  'Self-hosting the relay instead? Set HIVE_LICENSE to your key and HIVE_REQUIRE_LICENSE=true on the relay, and skip step 2.'

/**
 * Numbered plain-text rendering, for the email body and anywhere else without markup.
 * @param {readonly Step[]} steps
 * @param {{ indent?: string }} [options]
 * @returns {string}
 */
export function stepsAsText(steps, options) {
  const indent = (options && options.indent) || ''
  return steps
    .map((step, i) => {
      const lines = [`${indent}${i + 1}. ${step.title}`, `${indent}   ${step.body}`]
      if (step.kind === 'link' && step.url) lines.push(`${indent}   ${step.url}`)
      else if (step.kind === 'say' && step.literal) lines.push(`${indent}   "${step.literal}"`)
      else if (step.literal) lines.push(`${indent}   ${step.literal}`)
      if (step.note) lines.push(`${indent}   (${step.note})`)
      return lines.join('\n')
    })
    .join('\n\n')
}
