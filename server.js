// Relay server — the "meeting point" in the middle.
// It holds no truth of its own. It just passes CRDT updates between
// everyone connected to the same room. Humans and AI agents are equal here.
//
// Run this on any machine both teammates can reach (a cheap VPS, Railway,
// Fly.io, even a home PC with a tunnel). Everyone connects to it by URL.

import http from 'http'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from 'y-websocket/bin/utils'

const PORT = process.env.PORT || 1234

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('livecode relay is up. Connect a client to ws://<this-host>:' + PORT + '/<room>\n')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (conn, req) => {
  // The room is the URL path, e.g. ws://host:1234/my-project
  const room = (req.url || '/').slice(1).split('?')[0] || 'default'
  console.log(`[relay] a client joined room "${room}"`)
  setupWSConnection(conn, req, { docName: room })
})

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`)
  console.log(`[relay] room URL pattern: ws://localhost:${PORT}/<room-name>`)
})
