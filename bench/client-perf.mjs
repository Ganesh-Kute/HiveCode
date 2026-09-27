// bench-client.mjs -- Benchmark client sync.js performance on a ~900-file working set
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href);

async function run() {
  console.log('=== CLIENT PERFORMANCE BENCHMARK (sync.js + hive-mcp.js) ===\n');

  // 1. Cold start time for hive-mcp.js
  const tStart0 = performance.now();
  const mcpProc = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, HIVE_PROVENANCE: 'off' },
  });
  
  let mcpReadyTime = 0;
  await new Promise((resolve) => {
    // Send initialize request
    const initReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench', version: '1.0.0' }
      }
    }) + '\n';
    mcpProc.stdin.write(initReq);
    mcpProc.stdout.once('data', (data) => {
      mcpReadyTime = performance.now() - tStart0;
      mcpProc.kill();
      resolve();
    });
  });
  console.log(`1. hive-mcp.js Cold Start Handshake: ${mcpReadyTime.toFixed(1)} ms`);

  // 2. Setup 900-file fixture directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-bench-900-'));
  const NUM_FILES = 900;
  console.log(`\nGenerating ${NUM_FILES} files in ${tmpDir}...`);
  const tGen0 = performance.now();
  for (let i = 0; i < NUM_FILES; i++) {
    const sub = path.join(tmpDir, `dir_${i % 30}`);
    if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
    const fp = path.join(sub, `file_${String(i).padStart(4, '0')}.js`);
    fs.writeFileSync(fp, `// file ${i}\nexport function test_${i}() { return ${i} * 2; }\n`);
  }
  console.log(`Generated ${NUM_FILES} files in ${(performance.now() - tGen0).toFixed(1)} ms.`);

  // 3. Measure startSync + initial scan() time & memory
  // Start a local relay
  const PORT = 24700 + Math.floor(Math.random() * 200);
  const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await new Promise((r) => setTimeout(r, 600));

  const room = 'bench-room-' + crypto.randomBytes(4).toString('hex');
  const wsUrl = `ws://127.0.0.1:${PORT}`;

  const memBefore = process.memoryUsage();
  const tSync0 = performance.now();

  const client = startSync({
    relay: wsUrl,
    room,
    dir: tmpDir,
    name: 'BenchAgent',
    kind: 'ai',
    log: () => {},
  });

  // Wait for initial sync scan to finish
  let initialScanTime = 0;
  for (let i = 0; i < 150; i++) {
    const st = client.status();
    if (st.roomFiles >= NUM_FILES) {
      initialScanTime = performance.now() - tSync0;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const memAfter = process.memoryUsage();

  console.log(`2. Initial 900-file scan & sync time: ${initialScanTime.toFixed(1)} ms`);
  console.log(`   Memory RSS: ${(memAfter.rss / 1024 / 1024).toFixed(1)} MB (delta: +${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`   Heap Used:  ${(memAfter.heapUsed / 1024 / 1024).toFixed(1)} MB (delta: +${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)} MB)`);

  // 4. Measure idle scan() CPU cost AFTER settling (wait 5s for initial shadow & scan timers to settle)
  console.log(`\nWaiting 5s for background timers (saveShadow, initial scans) to settle...`);
  await new Promise((r) => setTimeout(r, 5000));

  const cpuBefore = process.cpuUsage();
  const tIdle0 = performance.now();
  await new Promise((r) => setTimeout(r, 5000));
  const cpuDelta = process.cpuUsage(cpuBefore);
  const tIdle = performance.now() - tIdle0;
  const cpuPercent = ((cpuDelta.user + cpuDelta.system) / 1000 / tIdle) * 100;

  console.log(`3. Settled Steady-State Idle over 900 files (5000 ms window):`);
  console.log(`   CPU User:   ${(cpuDelta.user / 1000).toFixed(1)} ms`);
  console.log(`   CPU System: ${(cpuDelta.system / 1000).toFixed(1)} ms`);
  console.log(`   CPU Total Load: ${cpuPercent.toFixed(2)}%`);

  // 5. Measure load: burst edits across 50 files
  console.log(`\n4. Load test: Burst editing 50 files concurrently...`);
  const tEdit0 = performance.now();
  for (let i = 0; i < 50; i++) {
    const sub = path.join(tmpDir, `dir_${i % 30}`);
    const fp = path.join(sub, `file_${String(i).padStart(4, '0')}.js`);
    fs.appendFileSync(fp, `\n// edit update ${Date.now()}\n`);
  }
  // Wait for edits to register
  await new Promise((r) => setTimeout(r, 2000));
  const tEdit = performance.now() - tEdit0;
  console.log(`   Burst edit processing complete in ${tEdit.toFixed(1)} ms`);

  client.stop();
  relay.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log('\nBenchmark complete.');
}

run().catch(console.error);
