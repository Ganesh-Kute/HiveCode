import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, '..', 'server.js');
const TEST_PORT = 5566;

console.log('=== TESTING REMOTE MCP ENDPOINT IN SERVER.JS ===');

// Start server.js on test port
const srv = spawn(process.execPath, [SERVER_SCRIPT], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(TEST_PORT), HIVE_PERSIST_DIR: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

srv.stderr.on('data', (d) => process.stderr.write(`[srv err] ${d}`));

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(method, pathUrl, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: pathUrl,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  await wait(1000);

  try {
    // 1. Check normal health endpoint (ensure no regression)
    console.log('1. Testing /health endpoint...');
    const health = await request('GET', '/health');
    if (health.status !== 200) throw new Error(`/health returned ${health.status}`);
    const healthJson = JSON.parse(health.data);
    if (!healthJson.ok) throw new Error('/health not ok');
    console.log('  ✓ /health works normally (main Hivecode untouched)');

    // 2. Check OAuth probe
    console.log('2. Testing OAuth probe GET /.well-known/oauth-protected-resource...');
    const oauth = await request('GET', '/.well-known/oauth-protected-resource');
    if (oauth.status !== 404) throw new Error(`OAuth returned ${oauth.status}`);
    console.log('  ✓ /.well-known returns 404 JSON for Gemini');

    // 3. Check HEAD /mcp probe
    console.log('3. Testing HEAD /mcp probe...');
    const head = await request('HEAD', '/mcp');
    if (head.status !== 200) throw new Error(`HEAD returned ${head.status}`);
    if (head.headers['mcp-version'] !== '2024-11-05') {
      throw new Error(`Unexpected Mcp-Version header: ${head.headers['mcp-version']}`);
    }
    console.log('  ✓ HEAD /mcp returns 200 OK with Mcp-Version: 2024-11-05');

    // 4. Check GET /mcp status
    console.log('4. Testing GET /mcp status...');
    const getMcp = await request('GET', '/mcp');
    if (getMcp.status !== 200) throw new Error(`GET /mcp returned ${getMcp.status}`);
    const mcpJson = JSON.parse(getMcp.data);
    if (mcpJson.service !== 'hivecode-remote-mcp') throw new Error('Unexpected service info');
    console.log('  ✓ GET /mcp returns service info JSON');

    // 5. Check POST /mcp initialize
    console.log('5. Testing POST /mcp initialize...');
    const initPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    });
    const initRes = await request('POST', '/mcp', { 'Content-Type': 'application/json' }, initPayload);
    if (initRes.status !== 200) throw new Error(`Init returned ${initRes.status}`);
    const initJson = JSON.parse(initRes.data);
    if (!initJson.result?.serverInfo?.name) throw new Error('Bad init response');
    console.log(`  ✓ Initialize succeeded: server "${initJson.result.serverInfo.name}" v${initJson.result.serverInfo.version}`);

    // 6. Check POST /mcp tools/list (verify hive_commit_file injection)
    console.log('6. Testing POST /mcp tools/list...');
    const listPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const listRes = await request('POST', '/mcp', { 'Content-Type': 'application/json' }, listPayload);
    if (listRes.status !== 200) throw new Error(`tools/list returned ${listRes.status}`);
    const listJson = JSON.parse(listRes.data);
    const tools = listJson.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('No tools returned');
    const commitTool = tools.find((t) => t.name === 'hive_commit_file');
    if (!commitTool) throw new Error('hive_commit_file compound tool not found in tools list');
    console.log(`  ✓ tools/list returned ${tools.length} tools including compound "hive_commit_file"`);

    console.log('\n=== ALL REMOTE MCP ENDPOINT TESTS PASSED! ===');
  } finally {
    srv.kill('SIGTERM');
  }
}

runTests().catch((e) => {
  console.error('\n❌ Test failed:', e);
  srv.kill('SIGKILL');
  process.exit(1);
});
