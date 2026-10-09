#!/usr/bin/env node
/**
 * A COMMITTED AGENT CONFIG HAS TO START ON EVERY MACHINE THAT CLONES IT.
 *
 *   node tests/portable-agent-config-test.mjs
 *
 * MEASURED 9 Oct 2026, setting Hivecode up on a second PC: this repo committed a .mcp.json whose
 * hivecode entry launched C:/Users/G1/Desktop/N/hive-mcp.js. Inside a clone, Claude Code ranks a
 * project's .mcp.json above the entry `setup` writes for the user, so on every machine but the one
 * that wrote it the hivecode server failed with "Connection closed". Deleting the entry there did
 * not last: the file was tracked, and a checkout put it back. docs/MCP.md told every user to do the
 * same thing ("`.mcp.json` in your project"), with a path into their own home folder.
 *
 *   C1  no committed file that an agent app loads by itself names a path on one machine
 *   C2  .mcp.json is ignored, so a developer's own copy is neither committed nor synced into a room
 *   C3  no doc tells Claude Code users to put the entry in a project's .mcp.json
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
function T(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })

// What the apps read on their own when a folder is opened. Not every settings.json in a repo:
// only the ones inside an agent app's own folder, plus Claude Code's .mcp.json wherever it is.
const AGENT_CONFIG = /(^|\/)\.mcp\.json$|(^|\/)\.(claude|cursor|vscode|gemini|windsurf|kiro|codex)\/(mcp|mcp_config|settings|settings\.local|hooks)\.json$/
// A drive letter, or a home folder on macOS/Linux, at the start of a JSON string.
const MACHINE_PATH = /"(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)[^"]*"/

console.log('# C. a committed agent config starts on every machine')

// The detector itself, on the line that broke the second PC and on the form docs/MCP.md shows.
// Without this, C1 passing on a tree with no matching file would prove nothing.
T('C0 the check flags the entry that broke the second PC, and not a placeholder path',
  MACHINE_PATH.test('"args": ["C:/Users/G1/Desktop/N/hive-mcp.js"]') && MACHINE_PATH.test('["/Users/ary/.hivecode/x.js"]') &&
  !MACHINE_PATH.test('"args": ["<your home>/.hivecode/runtime/<version>/node_modules/hivecode-mcp/hive-mcp.js"]'))

{
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
  const configs = tracked.filter((f) => AGENT_CONFIG.test(f))
  const bad = []
  for (const f of configs) {
    let src = ''
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    const m = src.match(MACHINE_PATH)
    if (m) bad.push(`${f}: ${m[0]}`)
  }
  T('C1 no committed file an agent app loads by itself names a path on one machine', bad.length === 0,
    bad.length ? bad.join(' | ') : `${configs.length} committed agent config file(s) checked: ${configs.join(', ') || 'none'}`)
}

{
  // --no-index: a tracked file is never reported as ignored, which would hide exactly this case.
  let byGit = false
  try { git('check-ignore', '--no-index', '-q', '.mcp.json'); byGit = true } catch { byGit = false }
  // A room is the other way the file came back: sync.js filters with ALWAYS_IGNORE plus the root
  // .gitignore, through the same library, so ask that filter too.
  const { ALWAYS_IGNORE } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  const { default: ignore } = await import('ignore')
  const bySync = ignore().add(ALWAYS_IGNORE).add(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).ignores('.mcp.json')
  T('C2 .mcp.json is ignored, so a developer\'s own copy is neither committed nor synced into a room', byGit && bySync,
    `git: ${byGit ? 'ignored' : 'NOT ignored'}, room sync: ${bySync ? 'ignored' : 'NOT ignored'}`)
}

{
  const DOCS = ['README.md', 'docs/MCP.md', 'docs/SELF_HOSTING.md', 'docs/JOIN_WITH_AGENT.md', 'public/start.html', 'public/index.html']
  const bad = []
  for (const f of DOCS) {
    let src = ''
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    for (const m of src.matchAll(/`?\.mcp\.json`?\s+in\s+(?:your|the)\s+project/gi)) bad.push(`${f}: ${m[0]}`)
  }
  T('C3 no doc tells Claude Code users to put the hivecode entry in a project\'s .mcp.json', bad.length === 0, bad.join(' | '))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
