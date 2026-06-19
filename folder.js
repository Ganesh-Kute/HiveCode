// Whole-folder live sync for a HUMAN teammate — share a project directory.
//
//   node folder.js <relay-url> <room> <dir> [name]
//   e.g. node folder.js ws://localhost:1234 myroom ./my-project Jeevan
//
// Thin CLI over the shared sync engine (sync.js). Joins as a 'human' participant
// (the identity is implicit in running THIS client — no manual declaration). For
// an autonomous AI participant, see hive-agent.js, which runs the same engine
// and joins as 'ai'.

import { startSync } from './sync.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', DIR = '.', NAME = 'anon'] = process.argv
startSync({ relay: RELAY, room: ROOM, dir: DIR, name: NAME, kind: 'human', token: process.env.HIVE_TOKEN || '' })
