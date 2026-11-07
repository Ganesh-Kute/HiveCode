// hive-poll-proto.js -- the wire format of the HTTPS long-poll transport (relay-poll.js on the
// relay, hive-transport.js in clients). It exists for networks that refuse WebSocket upgrades but
// pass ordinary HTTPS: Antigravity's cloud VMs (their egress proxy answers "403 WebSocket upgrades
// are not allowed", 7 Nov 2026) and many company proxies.
//
// It carries EXACTLY the bytes a WebSocket would: each message is one frame, in order, so every
// gate on the relay (claims, read-only, the governor, rate limits) sees what it always sees.
//
//   POST /_hive_poll/open        JSON {path, v}  -> 200 {sid, holdMs, idleMs, v} | the refusal an upgrade would get
//   POST /_hive_poll/<sid>/send  frames, header x-hive-seq: the first frame's number (1, 2, 3, ...)
//                                -> 204 once delivered. A retry of the same numbers is ignored, so a
//                                lost answer never applies a message twice; a gap is a 409.
//   POST /_hive_poll/<sid>/recv  header x-hive-ack: the last frame received, x-hive-hold: ms to wait
//                                -> 200 frames (x-hive-seq: the first one's number) | 204 nothing yet
//                                Frames up to the ack are forgotten; the rest are sent again, so a
//                                lost answer loses nothing.
//   POST /_hive_poll/<sid>/close -> 204
//   An unknown or ended session answers 404 {gone:true}: the client reconnects and resyncs.
//
// The room, the token and the name travel in the open request's BODY, never in a URL: a proxy logs
// URLs, and a room id is the key to the room.
export const POLL_PREFIX = '/_hive_poll/'
export const POLL_VERSION = 1

/** Frames to one buffer: for each, a 4-byte big-endian length, then its bytes. */
export function packFrames(frames) {
  let total = 0
  for (const f of frames) total += 4 + f.length
  const out = Buffer.allocUnsafe(total)
  let o = 0
  for (const f of frames) {
    out.writeUInt32BE(f.length, o); o += 4
    Buffer.from(f.buffer, f.byteOffset, f.length).copy(out, o); o += f.length
  }
  return out
}

/** One buffer back to its frames. Throws on anything malformed, so nothing half-read is delivered. */
export function unpackFrames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const out = []
  let o = 0
  while (o < b.length) {
    if (o + 4 > b.length) throw new Error('truncated frame length')
    const n = b.readUInt32BE(o); o += 4
    if (o + n > b.length) throw new Error('truncated frame')
    out.push(b.subarray(o, o + n)); o += n
  }
  return out
}
