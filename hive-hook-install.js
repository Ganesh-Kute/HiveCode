#!/usr/bin/env node
/**
 * INSTALL THE ANTI-IDLE GATE.
 *
 *   npx -y -p hivecode-mcp@latest hivecode-hook install            # this project  (.claude/settings.json)
 *   npx -y -p hivecode-mcp@latest hivecode-hook install --global   # every project (~/.claude/settings.json)
 *   npx -y -p hivecode-mcp@latest hivecode-hook status
 *   npx -y -p hivecode-mcp@latest hivecode-hook uninstall
 *
 * Writes a Claude Code `Stop` hook entry pointing at hive-stop-hook.js. See that file for what
 * the gate does and why prompt text alone cannot do it.
 *
 * MERGES, NEVER CLOBBERS. Settings files are shared: this machine already runs a Stop hook for
 * something else entirely, and a writer that assumed it owned `hooks.Stop` would silently delete
 * it. So we read what is there, append one entry to the existing array, and key it by command so
 * re-running is idempotent rather than additive.
 *
 * Project-local by default. A global install would arm the gate inside every repo the user opens,
 * including ones with no room in them -- harmless (the hook exits immediately without a session
 * file) but it is still their machine, so it takes an explicit flag.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Forward slashes: this string is written into JSON and handed to a shell. Windows accepts them
// and it avoids a backslash-escaping round trip through the settings file.
const HOOK = path.join(HERE, 'hive-stop-hook.js').split(path.sep).join('/')
const COMMAND = `node "${HOOK}"`
const TIMEOUT = 10

const cmd = (process.argv[2] || 'status').toLowerCase()
const GLOBAL = process.argv.includes('--global')
const settingsPath = GLOBAL
  ? path.join(os.homedir(), '.claude', 'settings.json')
  : path.join(process.cwd(), '.claude', 'settings.json')

const read = () => {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return null }
}
// A settings file we cannot parse is not ours to overwrite -- it is more likely hand-edited and
// briefly invalid than genuinely empty, and clobbering it would lose the user's own config.
const load = () => {
  if (!fs.existsSync(settingsPath)) return {}
  const j = read()
  if (j && typeof j === 'object') return j
  console.error(`refusing to touch ${settingsPath}: it exists but is not valid JSON.`)
  console.error('fix or move it, then run this again.')
  process.exit(1)
}

// Ours is any Stop entry whose command mentions hive-stop-hook, so an install from a previous
// version (a different absolute path) is recognised and replaced rather than duplicated.
const isOurs = (entry) =>
  (entry?.hooks || []).some((h) => typeof h?.command === 'string' && h.command.includes('hive-stop-hook'))

function install() {
  const s = load()
  s.hooks = s.hooks || {}
  const stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : []
  const kept = stop.filter((e) => !isOurs(e))
  const dropped = stop.length - kept.length
  kept.push({
    hooks: [{ type: 'command', command: COMMAND, timeout: TIMEOUT, statusMessage: 'Checking the room (Hivecode)...' }],
  })
  s.hooks.Stop = kept
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')

  console.log(`\n  ${dropped ? 'updated' : 'installed'}  ${settingsPath}`)
  console.log(`  command    ${COMMAND}`)
  if (kept.length > 1) console.log(`  alongside  ${kept.length - 1} other Stop hook(s), left untouched`)
  console.log('\n  An agent in a room can no longer end its turn while it has unread mail')
  console.log('  addressed to it, or an accepted task still open.\n')
  console.log('  Restart Claude Code for it to pick this up.\n')
}

function uninstall() {
  const s = load()
  const stop = Array.isArray(s.hooks?.Stop) ? s.hooks.Stop : []
  const kept = stop.filter((e) => !isOurs(e))
  if (kept.length === stop.length) { console.log(`\n  not installed in ${settingsPath}\n`); return }
  if (kept.length) s.hooks.Stop = kept; else delete s.hooks.Stop
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  console.log(`\n  removed from ${settingsPath}\n`)
}

function status() {
  const s = read() || {}
  const mine = (s.hooks?.Stop || []).filter(isOurs)
  const others = (s.hooks?.Stop || []).length - mine.length
  console.log(`\n  settings   ${settingsPath}${fs.existsSync(settingsPath) ? '' : '  (does not exist)'}`)
  console.log(`  hivecode   ${mine.length ? 'INSTALLED' : 'not installed'}`)
  if (others) console.log(`  other      ${others} unrelated Stop hook(s)`)
  console.log(`\n  install with:  npx -y -p hivecode-mcp@latest hivecode-hook install${GLOBAL ? ' --global' : ''}\n`)
}

if (cmd === 'install') install()
else if (cmd === 'uninstall' || cmd === 'remove') uninstall()
else status()
