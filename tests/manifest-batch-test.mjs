// tests/manifest-batch-test.mjs — Verify batching of room-doc updates during publish
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSync } from '../sync.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 25400 + Math.floor(Math.random() * 500);

// Helper for test assertions
let failures = 0;
function assert(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name} ${detail}`);
    failures++;
  }
}

async function main() {
  console.log('=== MANIFEST & ROOM-DOC BATCHING TEST ===');

  // Start relay with default free-tier limits (msgsPerSec=60, msgBurst=600)
  const relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await new Promise((resolve) => {
    relay.stdout.on('data', (d) => {
      if (/listening on/.test(d.toString())) resolve();
    });
  });

  const N = 100;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-batch-test-${Date.now()}-`));
  for (let i = 0; i < N; i++) {
    const sub = path.join(tmpDir, `dir_${i % 10}`);
    if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f_${String(i).padStart(4, '0')}.js`), `export const v${i} = ${i};\n`);
  }

  const room = `batch-room-${Date.now()}`;
  let roomDocUpdates = 0;

  const seeder = startSync({
    relay: `ws://127.0.0.1:${PORT}`,
    room,
    dir: tmpDir,
    name: 'Seeder',
    kind: 'ai',
    log: () => {},
  });

  seeder.doc.on('update', (update, origin) => {
    // Only count local transactions emitted by seeder to the relay
    if (origin !== seeder.provider) {
      roomDocUpdates++;
    }
  });

  // Wait until seeder manifests all N files
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (seeder.status().roomFiles >= N) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // Let any trailing microtasks/immediates settle
  await new Promise((r) => setTimeout(r, 200));

  console.log(`Seeder published ${N} files. Emitted roomDocUpdates: ${roomDocUpdates}`);

  // ANTI-VACUITY ASSERTION:
  // Old code emitted 2 updates per file (manifest.set + historyMeta.set) -> 200 updates.
  // Batched code collapses these into batches -> <= Math.ceil(N / 16) + 5 (< 15 updates).
  const maxAllowedUpdates = Math.ceil(N / 16) + 5;
  assert(
    `room-doc updates are batched (<= ${maxAllowedUpdates}, got ${roomDocUpdates})`,
    roomDocUpdates <= maxAllowedUpdates,
    `expected <= ${maxAllowedUpdates}, but got ${roomDocUpdates}`
  );

  assert(`all ${N} files are present in seeder manifest`, seeder.status().roomFiles === N);

  // Test joiner receives all N files from the batched updates
  const joinDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-batch-join-${Date.now()}-`));
  const joiner = startSync({
    relay: `ws://127.0.0.1:${PORT}`,
    room,
    dir: joinDir,
    name: 'Joiner',
    kind: 'ai',
    log: () => {},
  });

  const joinDeadline = Date.now() + 15000;
  while (Date.now() < joinDeadline) {
    if (joiner.status().roomFiles >= N) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  assert(`joiner receives all ${N} files in manifest`, joiner.status().roomFiles === N);

  // Edge case 2: stop() flushes synchronously
  seeder.stop();
  joiner.stop();
  relay.kill();

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(joinDir, { recursive: true, force: true }); } catch {}

  console.log(`\n=== RESULTS: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test threw:', err);
  process.exit(1);
});
