// tests/mcp-conformance-test.mjs -- MCP protocol conformance test suite
//
// Drives hive-mcp.js with the official @modelcontextprotocol/sdk Client and StdioClientTransport,
// verifying the exact behaviour expected by Claude Code, Gemini CLI, Cursor, and other MCP hosts:
//   - Protocol version negotiation (current, drafts, and future unknown)
//   - Handshake: serverInfo { name: 'hivecode', version }, instructions
//   - Tools listing: every tool has valid inputSchema (type: 'object')
//   - Tool calling: hive_status responds correctly
//   - Ping handling
//   - Unknown method: returns JSON-RPC -32601 Method not found
//   - Unknown notification: ignored gracefully without crashing the server
//   - Stdin EOF: server process exits cleanly within 3s

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MCP_PATH = path.join(ROOT, 'hive-mcp.js');
const { VERSION } = await import('../hive-version.js');

let pass = 0, fail = 0;
const T = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? '\n         ' + extra : ''}`);
  }
};
const section = (s) => console.log(`\n# ${s}`);

// -----------------------------------------------------------------------------
section('A. Official MCP SDK Client handshake and tool operations');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [MCP_PATH],
  cwd: ROOT,
  env: { ...process.env, HIVE_PROVENANCE: 'on' },
  stderr: 'pipe',
});

const client = new Client({ name: 'mcp-conformance-tester', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  T('A1 Client connected via StdioClientTransport', true);

  const serverVersion = client.getServerVersion();
  T('A2 serverInfo.name is "hivecode"', serverVersion?.name === 'hivecode', JSON.stringify(serverVersion));
  T('A3 serverInfo.version matches package VERSION', serverVersion?.version === VERSION, `${serverVersion?.version} vs ${VERSION}`);

  const instructions = client.getInstructions();
  T('A4 instructions are present and non-empty', typeof instructions === 'string' && instructions.length > 50, `length: ${instructions?.length}`);

  const pingRes = await client.ping();
  T('A5 ping() succeeds', pingRes && typeof pingRes === 'object', JSON.stringify(pingRes));

  const listRes = await client.listTools();
  const tools = listRes?.tools || [];
  T('A6 listTools returns a non-empty toolset (at least 20 tools)', tools.length >= 20, `count: ${tools.length}`);

  const badSchemas = tools.filter(t => !t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object');
  T('A7 every tool has name, description, and inputSchema of type object', badSchemas.length === 0, `bad: ${badSchemas.map(b => b.name).join(', ')}`);

  const hasStatusTool = tools.some(t => t.name === 'hive_status');
  T('A8 listTools includes "hive_status"', hasStatusTool);

  const statusCall = await client.callTool({ name: 'hive_status', arguments: {} });
  const textOut = statusCall?.content?.[0]?.text || '';
  T('A9 callTool("hive_status") responds with content text', typeof textOut === 'string' && textOut.length > 0, textOut.slice(0, 100));

  let unknownError = null;
  try {
    await client.request({ method: 'non_existent_method_xyz' }, { parse: (x) => x });
  } catch (err) {
    unknownError = err;
  }
  const is32601 = unknownError && (unknownError.code === -32601 || unknownError.error?.code === -32601 || /Method not found|-32601/i.test(unknownError.message));
  T('A10 unknown method returns JSON-RPC -32601 Method not found', is32601, JSON.stringify(unknownError));

  let aliveAfterNotif = false;
  try {
    await client.notification({ method: 'notifications/some_custom_future_event', params: { foo: 'bar' } });
    const ping2 = await client.ping();
    aliveAfterNotif = ping2 && typeof ping2 === 'object';
  } catch (e) {
    aliveAfterNotif = false;
  }
  T('A11 unknown notification is ignored without killing the server', aliveAfterNotif);

} finally {
  try { await transport.close(); } catch {}
}

// -----------------------------------------------------------------------------
section('B. Protocol version negotiation across versions');

const versionsToTest = ['2024-11-05', '2025-03-26', '2025-06-18', '2099-01-01'];

for (const v of versionsToTest) {
  const child = spawn(process.execPath, [MCP_PATH], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const res = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.id === 1) return resolve(parsed);
        } catch {}
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: v,
        capabilities: {},
        clientInfo: { name: 'version-test', version: '1.0' },
      },
    }) + '\n');
    setTimeout(() => resolve(null), 3000);
  });
  child.kill();

  const answeredVersion = res?.result?.protocolVersion;
  const noError = !res?.error;
  const validVersion = typeof answeredVersion === 'string' && answeredVersion.length > 0;
  T(`B. version negotiation with client version "${v}" answers without error`, noError && validVersion, `answered: ${answeredVersion}, err: ${JSON.stringify(res?.error)}`);
}

// -----------------------------------------------------------------------------
section('C. Lifecycle: closing stdin makes server exit cleanly within 3s');

const exitChild = spawn(process.execPath, [MCP_PATH], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
const initMsg = await new Promise((resolve) => {
  let buf = '';
  exitChild.stdout.on('data', (d) => {
    buf += d.toString();
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.id === 1) return resolve(parsed);
      } catch {}
    }
  });
  exitChild.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'exit-test', version: '1.0' },
    },
  }) + '\n');
  setTimeout(() => resolve(null), 3000);
});

T('C1 (setup) server initialized before stdin close', initMsg?.result !== undefined);

const tClose0 = Date.now();
exitChild.stdin.end();

const exitResult = await new Promise((resolve) => {
  exitChild.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - tClose0 }));
  setTimeout(() => resolve({ timeout: true, ms: Date.now() - tClose0 }), 3500);
});

const exitedInTime = !exitResult.timeout && exitResult.ms <= 3000;
T(`C2 process exits cleanly on stdin EOF within 3s (took ${exitResult.ms}ms, code ${exitResult.code})`, exitedInTime, JSON.stringify(exitResult));

// C3: With an active room connection, closing stdin must exit within 3s and release the seat
const RELAY_PORT = 24556;
const RELAY_SCRIPT = path.join(ROOT, 'server.js');
const c3ScratchDir = path.join(os.tmpdir(), `hive-c3-${Date.now()}`);
fs.mkdirSync(c3ScratchDir, { recursive: true });

function getHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${RELAY_PORT}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('health timeout')); });
  });
}

const relayProc = spawn(process.execPath, [RELAY_SCRIPT], {
  env: { ...process.env, PORT: String(RELAY_PORT), HIVE_SEATS: '10' },
  stdio: ['ignore', 'ignore', 'ignore'],
});

try {
  let relayReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const h = await getHealth();
      if (h.ok) { relayReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!relayReady) throw new Error('Relay failed to start within 4s');

  const preHealth = await getHealth();
  const preConns = preHealth.connections;

  const roomChild = spawn(process.execPath, [MCP_PATH], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let roomStdout = '';
  roomChild.stdout.on('data', (d) => { roomStdout += d.toString(); });

  const sendRpc = (obj) => roomChild.stdin.write(JSON.stringify(obj) + '\n');
  const waitForId = (id, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const interval = setInterval(() => {
      const lines = roomStdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.id === id) {
            clearInterval(interval);
            return resolve(parsed);
          }
        } catch {}
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for response id ${id}`));
      }
    }, 50);
  });

  sendRpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'c3-test', version: '1.0' },
    },
  });
  await waitForId(10);
  sendRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  sendRpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'hive_join',
      arguments: {
        link: `ws://127.0.0.1:${RELAY_PORT}|c3-conformance-room`,
        dir: c3ScratchDir,
        name: 'C3Agent',
      },
    },
  });
  await waitForId(11, 8000);

  let joinedConns = preConns;
  for (let i = 0; i < 20; i++) {
    const h = await getHealth();
    if (h.connections > preConns) {
      joinedConns = h.connections;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  T('C3a (setup) joined room and opened relay connection', joinedConns > preConns, `connections: ${preConns} -> ${joinedConns}`);

  const tCloseC3 = Date.now();
  roomChild.stdin.end();

  const c3ExitResult = await new Promise((resolve) => {
    roomChild.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - tCloseC3, exited: true }));
    setTimeout(() => resolve({ timeout: true, ms: Date.now() - tCloseC3, exited: false }), 3500);
  });

  const c3ExitedCleanly = c3ExitResult.exited && c3ExitResult.ms <= 3000;
  T(`C3b process with open room socket exits cleanly on stdin EOF within 3s (took ${c3ExitResult.ms}ms, code ${c3ExitResult.code})`, c3ExitedCleanly, JSON.stringify(c3ExitResult));

  let postConns = joinedConns;
  for (let i = 0; i < 20; i++) {
    const h = await getHealth();
    if (h.connections <= preConns) {
      postConns = h.connections;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  T('C3c relay connections drop back to pre-join count', postConns <= preConns, `connections: ${joinedConns} -> ${postConns} (pre was ${preConns})`);

  roomChild.kill();
} finally {
  relayProc.kill();
  try { fs.rmSync(c3ScratchDir, { recursive: true, force: true }); } catch {}
}

// -----------------------------------------------------------------------------
console.log(`\n=== MCP CONFORMANCE: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
