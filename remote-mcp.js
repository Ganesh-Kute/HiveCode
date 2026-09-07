import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HIVE_MCP_SCRIPT = path.join(__dirname, 'hive-mcp.js');
const HIVE_AGENT_SCRIPT = path.join(__dirname, 'hive-agent.js');

let globalChild = null;
const globalPending = new Map();
const activeSwarm = new Map();
let globalNextId = 1000;
let hasJoinedRoom = false;

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

/** Check if an incoming HTTP request should be routed to the MCP handler */
export function isMcpRequest(req) {
  if (process.env.ENABLE_REMOTE_MCP === 'false') return false;
  const urlPath = (req.url || '').split('?')[0];
  return (
    urlPath === '/mcp' ||
    urlPath.startsWith('/mcp/') ||
    urlPath.startsWith('/.well-known/')
  );
}

/** Ensure the internal hive-mcp child process is active and supervised */
function ensureChild(port) {
  if (globalChild && !globalChild.killed && globalChild.exitCode === null) {
    return globalChild;
  }

  const relayUrl = `ws://127.0.0.1:${port}`;
  console.log(`[mcp-cloud] Spawning internal hive-mcp worker pointing to ${relayUrl}...`);

  globalChild = spawn(process.execPath, [HIVE_MCP_SCRIPT], {
    cwd: __dirname,
    env: {
      ...process.env,
      HIVE_RELAY: relayUrl,
      HIVE_PROVENANCE: 'on',
      HIVE_FORK_GATE: 'on',
    },
  });

  let buf = '';
  globalChild.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) {
          const key = String(msg.id);
          if (globalPending.has(key)) {
            globalPending.get(key)(msg);
            globalPending.delete(key);
          }
        }
      } catch (e) {
        console.error('[mcp-cloud parse error]', e);
      }
    }
  });

  globalChild.stderr.on('data', (d) => {
    process.stderr.write(`[hive-mcp] ${d}`);
  });

  globalChild.on('exit', (code, sig) => {
    console.warn(`[mcp-cloud] hive-mcp exited (code=${code}, sig=${sig}). Resetting state.`);
    globalChild = null;
    hasJoinedRoom = false;
  });

  return globalChild;
}

/** Call an MCP tool directly on the internal worker */
function callToolInternal(port, name, args = {}) {
  const child = ensureChild(port);
  const id = ++globalNextId;
  const key = String(id);

  return new Promise((resolve) => {
    globalPending.set(key, resolve);
    setTimeout(() => {
      if (globalPending.has(key)) {
        globalPending.delete(key);
        resolve({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `Timeout calling ${name}` },
        });
      }
    }, 15000);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }) + '\n'
    );
  });
}

/** Compound tool: one-shot fast commit */
const COMPOUND_COMMIT_TOOL = {
  name: 'hive_commit_file',
  description:
    'ONE-SHOT FAST COMMIT: Automatically claims the file, writes it through the medium with cryptographically stamped provenance, releases the claim, and announces the update in the room chat. Use this instead of separate hive_claim/hive_edit/hive_release calls to complete the entire file lifecycle in a single step with only ONE approval.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'relative file path in the workspace' },
      content: { type: 'string', description: 'complete new file content' },
      intent: { type: 'string', description: 'why you are making this change (signed into provenance)' },
      note: { type: 'string', description: 'optional short note for the room chat (defaults to intent)' },
      room: { type: 'string', description: 'optional room name if not already joined (defaults to personal-agi)' },
    },
    required: ['file', 'content'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Tool to spawn up to 15 real AI agents into the room */
const SWARM_SPAWN_TOOL = {
  name: 'hive_spawn_swarm',
  description:
    'Spawn up to 15 real autonomous AI agents directly into the Hivecode room. Each agent connects as an active peer with its own name and presence, announces itself in chat, and appears in room membership.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'number of agents to spawn (1 to 15, default 4)' },
      room: { type: 'string', description: 'room to join (defaults to personal-agi)' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional custom names for the agents',
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Tool to stop and remove all spawned swarm agents */
const SWARM_STOP_TOOL = {
  name: 'hive_stop_swarm',
  description: 'Stop and disconnect all spawned swarm agents from the room.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Ensure the agent has joined a room before performing operations */
async function ensureJoined(port, defaultRoom = 'personal-agi') {
  if (hasJoinedRoom) return;
  console.log(`[mcp-cloud] Auto-joining room "${defaultRoom}" on local relay...`);
  try {
    const res = await callToolInternal(port, 'hive_join', {
      link: `ws://127.0.0.1:${port}|${defaultRoom}`,
      name: 'gemini-spark',
    });
    if (!res.error) {
      hasJoinedRoom = true;
      console.log(`[mcp-cloud] Successfully auto-joined room "${defaultRoom}"`);
    } else {
      console.warn(`[mcp-cloud] Auto-join warning:`, res.error);
    }
  } catch (err) {
    console.error(`[mcp-cloud] Auto-join error:`, err);
  }
}

/** Primary HTTP request handler for MCP routes */
export function handleMcpRequest(req, res, { port }) {
  setCors(req, res);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // OAuth discovery endpoints (Gemini checks this; 404 indicates no OAuth token required)
  if (url.pathname.startsWith('/.well-known/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  }

  // MCP Probes (HEAD /mcp)
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Version': '2024-11-05',
    });
    return res.end();
  }

  // Browser / GET status
  if (req.method === 'GET') {
    const acceptsSse = (req.headers.accept || '').includes('text/event-stream');

    if (acceptsSse) {
      // SSE transport fallback
      const sessionId = crypto.randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const endpoint = `/mcp?sessionId=${sessionId}`;
      res.write(`event: endpoint\ndata: ${endpoint}\n\n`);

      const child = ensureChild(port);
      const onMsg = (d) => {
        const text = d.toString();
        for (const line of text.split('\n')) {
          if (line.trim()) res.write(`event: message\ndata: ${line.trim()}\n\n`);
        }
      };
      child.stdout.on('data', onMsg);
      req.on('close', () => {
        child.stdout.off('data', onMsg);
      });
      return;
    }

    // Plain GET response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        status: 'ok',
        service: 'hivecode-remote-mcp',
        protocolVersion: '2024-11-05',
        relay: `ws://127.0.0.1:${port}`,
        transports: ['Streamable HTTP (POST /mcp)', 'SSE (GET /mcp)'],
      })
    );
  }

  // Streamable HTTP JSON-RPC channel (POST /mcp) - Used by Gemini Spark
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      }

      // Handle Notifications (no response needed)
      if (parsed.id === undefined || parsed.id === null) {
        const child = ensureChild(port);
        child.stdin.write(JSON.stringify(parsed) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0' }));
      }

      // 1. Initialize
      if (parsed.method === 'initialize') {
        console.log('[mcp-cloud] Client initializing MCP session...');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: true },
              },
              serverInfo: {
                name: 'hivecode-mcp',
                version: '0.11.5',
              },
            },
          })
        );
      }

      // 2. Tools List (inject compound tool hive_commit_file)
      if (parsed.method === 'tools/list') {
        const child = ensureChild(port);
        const key = String(parsed.id);

        const promise = new Promise((resolve) => {
          globalPending.set(key, resolve);
          setTimeout(() => {
            if (globalPending.has(key)) {
              globalPending.delete(key);
              resolve({
                jsonrpc: '2.0',
                id: parsed.id,
                error: { code: -32603, message: 'tools/list timeout' },
              });
            }
          }, 10000);
        });

        child.stdin.write(JSON.stringify(parsed) + '\n');
        const reply = await promise;

        if (reply.result && Array.isArray(reply.result.tools)) {
          const allTools = [COMPOUND_COMMIT_TOOL, SWARM_SPAWN_TOOL, SWARM_STOP_TOOL, ...reply.result.tools];
          reply.result.tools = allTools.map((tool) => {
            const isRead = /read|members|check|status|claims|tasks|state|board|verified/i.test(tool.name);
            return {
              ...tool,
              annotations: {
                readOnlyHint: isRead,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            };
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(reply));
      }

      // 3. Tools Call
      if (parsed.method === 'tools/call') {
        const toolName = parsed.params?.name;
        const args = parsed.params?.arguments || {};

        // A. Handle Swarm Spawning (up to 15 autonomous agents)
        if (toolName === 'hive_spawn_swarm') {
          const count = Math.min(Math.max(Number(args.count) || 4, 1), 15);
          const targetRoom = String(args.room || 'personal-agi');
          const DEFAULT_ROSTER = [
            'Lead-Architect', 'Backend-Dev', 'Frontend-Dev', 'QA-Tester',
            'Security-Auditor', 'Database-Admin', 'DevOps-SRE', 'Data-Pipeline',
            'Code-Reviewer', 'Telegram-Dispatcher', 'Email-Notifier', 'Performance-Engineer',
            'Docs-Writer', 'Sync-Sentinel', 'Release-Manager'
          ];
          const agentNames = Array.isArray(args.names) && args.names.length
            ? args.names.slice(0, count)
            : DEFAULT_ROSTER.slice(0, count);

          console.log(`[mcp-cloud] 🚀 Spawning ${agentNames.length} swarm agents in room "${targetRoom}"...`);

          for (const name of agentNames) {
            if (activeSwarm.has(name)) continue;
            try {
              const tempDir = path.join(os.tmpdir(), 'hive-swarm', name);
              const child = spawn(
                process.execPath,
                [HIVE_AGENT_SCRIPT, `ws://127.0.0.1:${port}|${targetRoom}`, tempDir, name],
                {
                  cwd: __dirname,
                  env: { ...process.env, HIVE_RELAY: `ws://127.0.0.1:${port}` },
                  stdio: 'ignore',
                }
              );
              activeSwarm.set(name, child);
            } catch (err) {
              console.error(`[mcp-cloud] Error spawning ${name}:`, err);
            }
          }

          const msg = `✓ Successfully spawned ${agentNames.length} agents into room "${targetRoom}" under owner "Ganesh":\n` +
            agentNames.map((n, i) => `  ${i + 1}. ${n} (AI Agent)`).join('\n') +
            `\n\nAll agents are now active in the room. Call hive_members to see them in room membership, or hive_read_chat to see their announcements!`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { content: [{ type: 'text', text: msg }] },
            })
          );
        }

        // B. Handle Swarm Shutdown
        if (toolName === 'hive_stop_swarm') {
          const stopped = [];
          for (const [name, child] of activeSwarm.entries()) {
            try {
              child.kill('SIGTERM');
              stopped.push(name);
            } catch {}
          }
          activeSwarm.clear();
          const msg = `✓ Stopped and disconnected ${stopped.length} swarm agents: ${stopped.join(', ') || 'none'}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { content: [{ type: 'text', text: msg }] },
            })
          );
        }

        // C. Handle one-shot compound commit tool
        if (toolName === 'hive_commit_file') {
          const file = String(args.file || '');
          const content = String(args.content ?? '');
          const intent = String(args.intent || 'update file');
          const note = String(args.note || intent);
          const targetRoom = String(args.room || 'personal-agi');

          console.log(`[mcp-cloud] ⚡ [ONE-SHOT COMMIT] ${file} (intent: "${intent}")`);

          await ensureJoined(port, targetRoom);

          // 1. Claim
          await callToolInternal(port, 'hive_claim', { region: file, intent });

          // 2. Edit with provenance
          const editRes = await callToolInternal(port, 'hive_edit', { file, content, intent });

          // 3. Release claim
          await callToolInternal(port, 'hive_release', { region: file });

          // 4. Announce in room chat
          await callToolInternal(port, 'hive_say', { text: `Committed ${file}: ${note}` });

          const summary = `✓ Successfully committed ${file} in 1 single step!\n- Claimed region: ${file}\n- Wrote content with signed provenance\n- Released claim\n- Announced in room chat: "Committed ${file}: ${note}"`;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { content: [{ type: 'text', text: summary }] },
            })
          );
        }

        // B. Handle hive_join rewrite (route internal loopback to avoid hairpin network issues)
        if (toolName === 'hive_join') {
          let link = args.link || '';
          let room = args.room || '';

          if (link) {
            // If link points to any external URL or contains a room name, extract room & rewrite to localhost
            const parts = link.split('|');
            const targetRoom = parts[1] || parts[0].replace(/^wss?:\/\/[^/]+\/?/, '') || 'personal-agi';
            const token = parts[2] || '';
            args.link = `ws://127.0.0.1:${port}|${targetRoom}${token ? '|' + token : ''}`;
          } else if (room) {
            args.link = `ws://127.0.0.1:${port}|${room}`;
          } else {
            args.link = `ws://127.0.0.1:${port}|personal-agi`;
          }

          hasJoinedRoom = true;
          console.log(`[mcp-cloud] hive_join redirected to internal relay: ${args.link}`);
        } else {
          // For any other tool, make sure we've joined if not already
          await ensureJoined(port);
        }

        // Forward to internal worker
        const child = ensureChild(port);
        const key = String(parsed.id);

        const promise = new Promise((resolve) => {
          globalPending.set(key, resolve);
          setTimeout(() => {
            if (globalPending.has(key)) {
              globalPending.delete(key);
              resolve({
                jsonrpc: '2.0',
                id: parsed.id,
                error: { code: -32603, message: `Tool execution timeout for ${toolName}` },
              });
            }
          }, 15000);
        });

        child.stdin.write(JSON.stringify(parsed) + '\n');
        const reply = await promise;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(reply));
      }

      // Default: forward unrecognized methods
      const child = ensureChild(port);
      const key = String(parsed.id);

      const promise = new Promise((resolve) => {
        globalPending.set(key, resolve);
        setTimeout(() => {
          if (globalPending.has(key)) {
            globalPending.delete(key);
            resolve({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32601, message: 'Method not found or timeout' },
            });
          }
        }, 10000);
      });

      child.stdin.write(JSON.stringify(parsed) + '\n');
      const reply = await promise;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(reply));
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
}
