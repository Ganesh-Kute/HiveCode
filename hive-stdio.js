// hive-stdio.js -- the MCP stdio server Hivecode actually needs, without the SDK's web stack.
//
// WHY THIS EXISTS. @modelcontextprotocol/sdk is a client AND a server AND three HTTP transports,
// so installing it installs express, hono, cors, jose, zod, ajv and ~85 other packages -- 25 MB,
// most of a stranger's first `npx hivecode-mcp` download (36.7s measured cold, 25 Sep 2026). A
// load trace of a full session (join, claim, write, release, say, wait) showed the client uses
// exactly one slice of it: newline-delimited JSON-RPC over stdin/stdout, `initialize`, `ping`,
// `tools/list`, `tools/call`, and two outgoing notifications. That slice is this file.
//
// IT MUST BEHAVE EXACTLY LIKE THE SDK WHERE A CLIENT CAN TELL. The SDK is still a devDependency,
// and tests/mcp-conformance-test.mjs drives this server with the SDK's own CLIENT -- the one
// Claude Code and the Gemini CLI are built on. Specifically, as in the SDK (1.30):
//   - protocol version: echo the client's if supported, else answer with the newest we know;
//   - `ping` -> {}; an unknown method -> error -32601; a handler that throws -> its own numeric
//     `code` if it has one, else -32603, with the error's message;
//   - a request the client CANCELLED gets no response (the spec: "SHOULD NOT send a response");
//   - a line that is not JSON is logged to stderr and otherwise ignored, never answered.
// And one thing the SDK does not do: when stdin closes, the server says so (onclose), so the
// process can EXIT. The spec asks exactly that of a stdio server; the SDK left it running, and a
// Hivecode server that outlives its agent app keeps a seat in the room for a member who is gone.

export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']

// Same shape hive-mcp.js used to import from '@modelcontextprotocol/sdk/types.js': something
// setRequestHandler can take the method name from.
export const ListToolsRequestSchema = Object.freeze({ method: 'tools/list' })
export const CallToolRequestSchema = Object.freeze({ method: 'tools/call' })

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

export class Server {
  constructor(serverInfo, { capabilities = {}, instructions } = {}) {
    this._serverInfo = serverInfo
    this._capabilities = capabilities
    this._instructions = instructions
    // Keyed by method, called as handler(request, extra) -- the SDK's own internal shape, which
    // the test seam in hive-mcp.js reaches into on purpose.
    this._requestHandlers = new Map()
    this._transport = null
    this._inflight = new Map() // request id -> AbortController, so a cancel can find it
    this.onclose = null
    this.oninitialized = null
    this._requestHandlers.set('initialize', (req) => {
      const requested = req.params && req.params.protocolVersion
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: this._capabilities,
        serverInfo: this._serverInfo,
        ...(this._instructions ? { instructions: this._instructions } : {}),
      }
    })
    this._requestHandlers.set('ping', () => ({}))
  }

  setRequestHandler(schema, handler) {
    const method = typeof schema === 'string' ? schema : schema && schema.method
    if (!method) throw new Error('setRequestHandler needs a method')
    this._requestHandlers.set(method, handler)
  }

  async connect(transport) {
    this._transport = transport
    transport.onmessage = (msg) => this._onmessage(msg)
    transport.onclose = () => { this._transport = null; if (this.onclose) this.onclose() }
    await transport.start()
  }

  /** Send a notification to the client. Rejects when there is nobody to send it to. */
  notification({ method, params }) {
    if (!this._transport) return Promise.reject(new Error('Not connected'))
    return this._transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  _onmessage(msg) {
    if (Array.isArray(msg)) {
      // JSON-RPC batches: the 2025-03-26 revision allowed them. Answer each request in the batch;
      // the replies go back one per line, which every client matches by id.
      for (const m of msg) this._onmessage(m)
      return
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return
    if (msg.method === undefined) return // a response to a request we never send
    if (msg.id === undefined || msg.id === null) return this._onnotification(msg)
    this._onrequest(msg)
  }

  _onnotification(msg) {
    if (msg.method === 'notifications/initialized') { if (this.oninitialized) this.oninitialized(); return }
    if (msg.method === 'notifications/cancelled') {
      const id = msg.params && msg.params.requestId
      const ac = this._inflight.get(id)
      if (ac) ac.abort()
    }
    // every other notification is ignorable by spec
  }

  async _onrequest(msg) {
    const { id, method } = msg
    const handler = this._requestHandlers.get(method)
    if (!handler) return this._reply({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } })
    if (method === 'tools/call' && (!msg.params || typeof msg.params !== 'object' || typeof msg.params.name !== 'string')) {
      return this._reply({ jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: 'tools/call needs params.name' } })
    }
    const ac = new AbortController()
    this._inflight.set(id, ac)
    let reply
    try {
      const result = await handler({ method, params: msg.params }, { signal: ac.signal, requestId: id })
      reply = { jsonrpc: '2.0', id, result: result === undefined ? {} : result }
    } catch (e) {
      const code = e && Number.isSafeInteger(e.code) ? e.code : INTERNAL_ERROR
      reply = { jsonrpc: '2.0', id, error: { code, message: (e && e.message) || 'Internal error' } }
    } finally {
      this._inflight.delete(id)
    }
    if (ac.signal.aborted) return // cancelled by the client: it is no longer waiting for this
    this._reply(reply)
  }

  _reply(message) {
    if (!this._transport) return
    Promise.resolve(this._transport.send(message)).catch((e) => process.stderr.write(`[hive-stdio] could not reply: ${e && e.message}\n`))
  }
}

export class StdioServerTransport {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    this._stdin = stdin
    this._stdout = stdout
    this._buf = ''
    this._closed = false
    this.onmessage = null
    this.onclose = null
  }

  async start() {
    this._stdin.setEncoding('utf8') // a multi-byte character split across two chunks stays whole
    this._stdin.on('data', (chunk) => {
      this._buf += chunk
      let i
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).replace(/\r$/, '')
        this._buf = this._buf.slice(i + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch {
          process.stderr.write(`[hive-stdio] ignored a line that is not JSON (${line.length} chars)\n`)
          continue
        }
        try { if (this.onmessage) this.onmessage(msg) } catch (e) { process.stderr.write(`[hive-stdio] ${e && e.stack}\n`) }
      }
    })
    const close = () => { if (this._closed) return; this._closed = true; if (this.onclose) this.onclose() }
    this._stdin.on('end', close)
    this._stdin.on('close', close)
    this._stdin.on('error', close)
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (this._closed && !this._stdout.writable) return reject(new Error('stdout is closed'))
      this._stdout.write(JSON.stringify(message) + '\n', (err) => (err ? reject(err) : resolve()))
    })
  }
}
