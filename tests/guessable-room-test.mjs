// A room whose name can be guessed is called out on the public relay.
//
//   node tests/guessable-room-test.mjs
//
// On a relay anyone can reach, a room's name is its only key: joining needs nothing else, and the
// relay creates whatever room it is asked for. Hosted rooms get 104 random bits, but a link can
// name any room, and on 3 Oct 2026 the night room this project is built in was called "night".
// Whoever guesses a name like that reads every file and writes into every folder in the room, and
// nothing told the people in it.
//
//   G1  names people type are guessable: words, names, dates, camel case
//   G2  a hosted room's id never is (the form the generator makes)
//   G3  a secured room never is: joining it takes a token signed by its owner
//   G4  on the public relay, the warning names the room and says it can be guessed...
//   G5  ...but not for a hosted room, and not on a relay of your own
//   G6  hive_join and hive_status both hand the room to the check, so the warning reaches the agent

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { guessableRoom, checkRelay, PUBLIC_DEFAULT_RELAY } from '../hive-privacy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const hosted = () => 'room-' + crypto.randomBytes(13).toString('base64url') // what hive_join and hive-branch make

const typed = ['night', 'myteam', 'acme-backend-team', 'project2024', 'frontend-2026-10-03', 'Project2024Alpha', 'teamAlphaBravo2026', 'room-my-team-project-26', 'room-abc']
const missed = typed.filter((r) => !guessableRoom(r))
T('G1 names people type are guessable', missed.length === 0, `not flagged: ${missed.join(', ')}`)
let flagged = 0
for (let i = 0; i < 20000; i++) if (guessableRoom(hosted())) flagged++
T('G2 a hosted room\'s id is not (under 0.05% of 20,000 random ids flagged)', flagged <= 10, `${flagged} flagged`)
T('G3 a secured room is not: it takes a token signed by its owner', !guessableRoom('hs_' + crypto.randomBytes(16).toString('base64url').slice(0, 22) + '_team'))

const warnOf = (relay, room) => String(checkRelay({ relay, room }).warn || '')
T('G4 on the public relay, the warning names a guessable room and says so', /THE ROOM NAME "night" CAN BE GUESSED/.test(warnOf(PUBLIC_DEFAULT_RELAY, 'night')), warnOf(PUBLIC_DEFAULT_RELAY, 'night').slice(-200))
T('G5 ...but says nothing of the kind for a hosted room, or on a relay of your own',
  !/CAN BE GUESSED/.test(warnOf(PUBLIC_DEFAULT_RELAY, hosted())) && !/CAN BE GUESSED/.test(warnOf('ws://127.0.0.1:1234', 'night')) && !/CAN BE GUESSED/.test(warnOf('wss://relay.example.com', 'night')))

const mcp = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
const calls = mcp.match(/checkRelay\(\{[^}]*\}\)/g) || []
T('G6 hive_join and hive_status both pass the room to the check', calls.length >= 2 && calls.every((c) => /\broom\b/.test(c)), calls.join(' | '))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
