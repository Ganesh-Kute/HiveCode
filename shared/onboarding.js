// The canonical "what do I do now" instructions, in one place.
//
// A buyer meets these steps three times: in the dialog right after paying, in the licence
// email, and on the website. They were previously written (and worded differently) in each
// of those places, and one of them told people to run a command that does not exist —
// "Hivecode: Set Licence Key" instead of "Hivecode: Enter License Key". A wrong command
// name is indistinguishable from a broken product to the person who just paid.
//
// So the steps live here, as data, and every surface renders the same array. Plain
// JavaScript with JSDoc so the serverless functions can import it with no build step, the
// same arrangement as shared/license.js.

export const SITE_URL = 'https://hivecode.vercel.app'
export const MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode'
export const AGENT_GUIDE_URL =
  'https://github.com/Ganesh-Kute/HiveCode/blob/main/docs/JOIN_WITH_AGENT.md'

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
 * @typedef {object} SetupStep
 * @property {string} title       imperative, four words or fewer
 * @property {string} body        one or two plain sentences
 * @property {'link'|'command'|'shell'} [kind] what `literal` is, so each surface can style it
 * @property {string} [literal]   the exact text to click, type, or run
 * @property {string} [url]       destination when kind is 'link'
 * @property {string} [note]      the bit people get wrong
 */

/** @type {readonly SetupStep[]} */
export const SETUP_STEPS = Object.freeze([
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

/** For a self-hosted relay, the key goes in the environment instead of the editor. */
export const SELF_HOST_NOTE =
  'Self-hosting the relay instead? Set HIVE_LICENSE to your key and HIVE_REQUIRE_LICENSE=true on the relay, and skip step 2.'

/**
 * Numbered plain-text rendering, for the email body and anywhere else without markup.
 * @param {{ indent?: string }} [options]
 * @returns {string}
 */
export function setupStepsAsText(options) {
  const indent = (options && options.indent) || ''
  return SETUP_STEPS.map((step, i) => {
    const lines = [`${indent}${i + 1}. ${step.title}`, `${indent}   ${step.body}`]
    if (step.kind === 'link' && step.url) lines.push(`${indent}   ${step.url}`)
    else if (step.literal) lines.push(`${indent}   ${step.literal}`)
    if (step.note) lines.push(`${indent}   (${step.note})`)
    return lines.join('\n')
  }).join('\n\n')
}
