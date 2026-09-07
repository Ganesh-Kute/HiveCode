// ONE Yjs, chosen at BUILD time instead of by a CDN at run time.
//
// The browser control room used to load its libraries as two independent esm.sh imports:
//
//     import('https://esm.sh/yjs@13.6.18')        -> .../yjs@13.6.18/es2022/yjs.mjs
//     import('https://esm.sh/y-websocket@2.0.4')  -> pulls yjs@^13.0.0 / ^13.5.6
//                                                 -> .../yjs@13.6.32/es2022/yjs.mjs
//
// Two module URLs are two module instances. The page built its Y.Doc with one and the
// provider applied incoming updates with the other, so every cross-instance constructor
// check failed -- yjs issue 438, which the browser reports as "Yjs was already imported.
// This breaks constructor checks and will lead to issues!"
//
// The symptom that produced was the deaf panel: the bulk sync on join lands (which is why
// the room appears correct the moment you open it, and why reloading "fixes" it), the
// outbound path keeps working (it only ever touches the local doc), and then incremental
// updates stop being applied while wsconnected, synced and wsUnsuccessfulReconnects all
// keep saying the socket is perfectly healthy. Measured 2026-09-07: a panel synced at 54
// messages, received 11 more, and then sat at 65 while the room went past 340.
//
// Bundling from node_modules makes that unrepresentable -- npm has already deduped yjs to
// one copy, so there is exactly one instance and it is the same one every other Hivecode
// client uses. It also removes a hard runtime dependency on a third-party CDN from the one
// page a human uses to watch a room.
export * as Y from 'yjs'
export { WebsocketProvider } from 'y-websocket'
