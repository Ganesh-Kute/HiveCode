// tests/fs-watch-targeted-test.mjs — Anti-vacuity test for targeted fs.watch reconciliation
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { startSync } from '../sync.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 28100 + Math.floor(Math.random() * 500);

async function main() {
  console.log('=== TEST: TARGETED FS.WATCH RECONCILIATION ===');
  const relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise((r) => relay.stdout.on('data', (d) => { if (/listening on/.test(d.toString())) r(); }));

  const N = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `targeted-watch-test-`));

  for (let i = 0; i < N; i++) {
    const sub = path.join(dir, `d_${i % 40}`);
    if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f_${String(i).padStart(4, '0')}.js`), `export const v = ${i};\n`);
  }

  const room = `targeted-watch-${Date.now()}`;
  const seeder = startSync({
    relay: `ws://127.0.0.1:${PORT}`,
    room,
    dir,
    name: 'Seeder',
    kind: 'ai',
    log: () => {},
  });

  // Wait for initial publish
  while (seeder.status().roomFiles < N) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 200));

  const scansBefore = seeder._scanCount ? seeder._scanCount() : 0;

  // Track statSync calls
  let statCalls = 0;
  const origStat = fs.statSync;
  fs.statSync = function(...args) {
    statCalls++;
    return origStat.apply(this, args);
  };

  const targetFile = path.join(dir, 'd_12', 'f_0012.js');
  console.log('Editing 1 file in 1000-file folder...');
  fs.appendFileSync(targetFile, `// edited at ${Date.now()}\n`);

  // Wait for the 40ms debounce to fire and reconcile
  await new Promise((r) => setTimeout(r, 250));

  fs.statSync = origStat;
  const scansAfter = seeder._scanCount ? seeder._scanCount() : 0;
  const deltaScans = scansAfter - scansBefore;

  console.log(`Results for 1 edited file:`);
  console.log(`- statSync calls: ${statCalls}`);
  console.log(`- full scan() invocations: ${deltaScans}`);

  // ANTI-VACUITY ASSERTION:
  // On unoptimized code, editing 1 file triggers a full scan() which stats all 1000 files.
  // With targeted reconciliation, only the edited path (and possibly its parent dir event) is inspected.
  assert.ok(
    statCalls < 50,
    `Anti-vacuity violation: editing 1 file in 1000 files caused ${statCalls} statSync calls (expected < 50, ideally <= 5)`
  );
  assert.strictEqual(
    deltaScans,
    0,
    `Anti-vacuity violation: editing 1 file invoked full scan() ${deltaScans} times (expected 0)`
  );
  console.log('PASS: Single file edit bypassed full tree scan.');

  // Test 2: Creating a new file in an existing directory should also be targeted
  const scansBeforeNew = seeder._scanCount ? seeder._scanCount() : 0;
  const newFilePath = path.join(dir, 'd_12', 'f_brand_new.js');
  fs.writeFileSync(newFilePath, 'export const brandNew = true;\n');
  await new Promise((r) => setTimeout(r, 250));
  const scansAfterNew = seeder._scanCount ? seeder._scanCount() : 0;
  assert.strictEqual(scansAfterNew - scansBeforeNew, 0, 'New file in existing dir should not trigger full scan');
  assert.strictEqual(seeder.status().roomFiles, N + 1, 'New file must be published to room');
  console.log('PASS: New file in existing directory reconciled targetedly.');

  // Test 3: Deleting a single file should be targeted
  const scansBeforeDel = seeder._scanCount ? seeder._scanCount() : 0;
  fs.unlinkSync(newFilePath);
  await new Promise((r) => setTimeout(r, 250));
  const scansAfterDel = seeder._scanCount ? seeder._scanCount() : 0;
  assert.strictEqual(scansAfterDel - scansBeforeDel, 0, 'Deleting single file should not trigger full scan');
  assert.strictEqual(seeder.status().roomFiles, N, 'Deleted file must be removed from room');
  console.log('PASS: Single file deletion reconciled targetedly.');

  // Test 4: Creating a new directory with files falls back to full scan
  const scansBeforeDir = seeder._scanCount ? seeder._scanCount() : 0;
  const newDir = path.join(dir, 'new_dir_test');
  fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(newDir, 'nested.js'), 'export const nested = 1;\n');
  // Wait for full scan and publish to complete
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && seeder.status().roomFiles < N + 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const scansAfterDir = seeder._scanCount ? seeder._scanCount() : 0;
  assert.ok(scansAfterDir - scansBeforeDir >= 1, 'Creating new directory must fall back to full scan');
  assert.strictEqual(seeder.status().roomFiles, N + 1, 'File in new directory must be published');
  console.log('PASS: Directory creation correctly falls back to full scan.');

  seeder.stop();
  relay.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
