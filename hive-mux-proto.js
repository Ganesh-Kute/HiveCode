// hive-mux-proto.js -- the wire format for ONE socket per participant, shared by relay and client.
//
// WHY: Hivecode opened one WebSocket per FILE. A participant held 1 + min(files, 128) sockets,
// so an agent in a 1000-file repository saw only 128 files on disk, and a relay's connection cap
// divided by 129 per person. The mux carries every file doc of one room over one socket.
//
// The design rule that makes it safe: the relay does not grow a second enforcement path. Each
// OPEN runs the SAME per-doc admission a per-file upgrade runs (token scope for that path, the
// per-room ceiling, the committer limit), and the accepted channel is wrapped in a VirtualConn
// that looks exactly like a ws connection to installUsageLimits, makeReadOnly, installWriteGate
// and setupWSConnection. The bytes inside a MSG frame are the same y-protocols message a
// per-file socket would carry.
//
// Frames are binary, lib0-encoded:
//   client -> relay   OPEN     [0, id, docName]       open this file doc as channel `id`
//                     CLOSE    [1, id]                the client is done with it
//                     MSG      [2, id, ...payload]    a y-protocols message for that doc
//   relay -> client   MSG      [2, id, ...payload]
//                     OPENED   [3, id]                admitted; the relay's sync step 1 follows
//                     REFUSED  [4, id, code, reason]  not admitted -- the HTTP status a per-file
//                                                     upgrade would have answered, and why
//                     CLOSED   [5, id, reason]        the relay closed that channel
//                     BEAT     [6, 0]                 liveness, so a dead socket is noticed
// Channel ids are chosen by the client and are only meaningful on the socket that opened them.
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const MUX_PREFIX = '_hive_mux/'
export const MUX_VERSION = 1
export const F = Object.freeze({ OPEN: 0, CLOSE: 1, MSG: 2, OPENED: 3, REFUSED: 4, CLOSED: 5, BEAT: 6 })

export function encodeFrame(kind, id, a, b) {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, kind)
  encoding.writeVarUint(e, id >>> 0)
  if (kind === F.OPEN) encoding.writeVarString(e, String(a))
  else if (kind === F.MSG) encoding.writeUint8Array(e, a instanceof Uint8Array ? a : new Uint8Array(a))
  else if (kind === F.REFUSED) { encoding.writeVarUint(e, a >>> 0); encoding.writeVarString(e, String(b || '')) }
  else if (kind === F.CLOSED) encoding.writeVarString(e, String(a || ''))
  return encoding.toUint8Array(e)
}

/** Decode one frame. Throws on garbage, which the caller treats as a protocol violation. */
export function decodeFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const d = decoding.createDecoder(u8)
  const kind = decoding.readVarUint(d)
  const id = decoding.readVarUint(d)
  if (kind === F.OPEN) return { kind, id, docName: decoding.readVarString(d) }
  if (kind === F.MSG) return { kind, id, payload: u8.subarray(d.pos) }
  if (kind === F.REFUSED) return { kind, id, code: decoding.readVarUint(d), reason: decoding.readVarString(d) }
  if (kind === F.CLOSED) return { kind, id, reason: decoding.readVarString(d) }
  if (kind === F.CLOSE || kind === F.OPENED || kind === F.BEAT) return { kind, id }
  throw new Error(`unknown mux frame kind ${kind}`)
}

/** The mux upgrade path for a base room, as the relay parses it (pathname minus the slash). */
export function muxPath(room) { return MUX_PREFIX + encodeURIComponent(room) }
