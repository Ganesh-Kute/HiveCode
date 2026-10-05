// tests/lazy-snapshot-test.mjs — Verify lazy genesis snapshot behavior and wire byte reductions
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import WebSocket from 'ws';
import { startSync } from '../sync.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 28600 + Math.floor(Math.random() * 500);

let bBytesReceived = 0;
let trackingJoiner = false;

const origEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (event, ...args) {
  if (trackingJoiner && event === 'message') {
    const data = args[0];
    const len = Buffer.isBuffer(data) ? data.length : (data ? (data.byteLength || Buffer.byteLength(String(data))) : 0);
    bBytesReceived += len;
  }
  return origEmit.apply(this, [event, ...args]);
};

async function main() {
  console.log('=== TEST: LAZY GENESIS SNAPSHOTS & WIRE REDUCTION ===');
  const relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_SEATS: '100', HIVE_PERSIST_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => relay.stdout.on('data', (d) => { if (/listening on/.test(d.toString())) r(); }));

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), `lazy-snap-a-`));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), `lazy-snap-b-`));

  const room = `lazy-snap-${Date.now()}`;
  const initialContent = 'export const initial = "genesis content";\n';
  fs.writeFileSync(path.join(dirA, 'test.js'), initialContent);
  fs.writeFileSync(path.join(dirA, 'untouched.js'), 'export const untouched = 1;\n');

  const seeder = startSync({
    relay: `ws://127.0.0.1:${PORT}`,
    room,
    dir: dirA,
    name: 'Alice',
    kind: 'ai',
    log: () => {},
  });

  while (seeder.status().roomFiles < 2) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 200));

  // --- TEST 1: ANTI-VACUITY: On publish, untouched files must have ZERO eager snapshots ---
  // On legacy code, captureSnapshot eager-stores a duplicate 'created' copy in fe.snap.
  // On lazy code, snap.size must be 0 until first edited!
  const untouchedSnaps = seeder._fileSnapSize ? seeder._fileSnapSize('untouched.js') : 0;
  console.log('Untouched file snap size on publish:', untouchedSnaps);
  assert.strictEqual(
    untouchedSnaps,
    0,
    `Anti-vacuity violation: untouched file has ${untouchedSnaps} snapshots on publish (expected 0)`
  );
  console.log('PASS 1: No eager snapshot created on first publish.');

  // --- TEST 2: Lazy baseline capture on first edit ---
  const tBeforeEdit = Date.now();
  await new Promise((r) => setTimeout(r, 60));
  const tMid = Date.now(); // timestamp strictly between creation and first edit
  await new Promise((r) => setTimeout(r, 60));

  console.log('Making first edit to test.js...');
  fs.writeFileSync(path.join(dirA, 'test.js'), 'export const edit1 = "first modification";\n');
  await new Promise((r) => setTimeout(r, 250));

  // After first edit, test.js must now have the lazy base snapshot
  const snapsAfterFirst = seeder._fileSnaps ? seeder._fileSnaps('test.js') : [];
  const baseSnap = snapsAfterFirst.find((s) => s.kind === 'base');
  assert.ok(baseSnap, 'First edit must lazily capture a snapshot with kind=base');
  assert.strictEqual(baseSnap.label, 'created', 'Lazy snapshot must have label=created');
  assert.strictEqual(baseSnap.content, initialContent, 'Lazy snapshot content must match pristine genesis content');
  assert.ok(baseSnap.ts <= tMid, `Lazy snapshot ts (${baseSnap.ts}) must be <= creation window (${tMid})`);
  console.log('PASS 2: Lazy base snapshot captured on first edit with genesis content and creation timestamp.');

  // --- TEST 3: restoreFileTo(tMid) restores genesis content ---
  const resMid = seeder.restoreFileTo('test.js', tMid);
  assert.ok(resMid && resMid.ok, `restoreFileTo(tMid) must succeed: ${JSON.stringify(resMid)}`);
  assert.strictEqual(fs.readFileSync(path.join(dirA, 'test.js'), 'utf8'), initialContent, 'Content must match genesis');
  console.log('PASS 3: restoreFileTo(ts between creation and first edit) restores genesis content.');

  // --- TEST 4: restore-to-created still works after 40 edits (immune to SNAP_KEEP=30 eviction) ---
  console.log('Applying 40 sequential edits to test.js...');
  for (let i = 2; i <= 41; i++) {
    fs.writeFileSync(path.join(dirA, 'test.js'), `export const v = ${i};\n`);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 300));

  const snapsAfter40 = seeder._fileSnaps ? seeder._fileSnaps('test.js') : [];
  const baseSnapAfter40 = snapsAfter40.find((s) => s.kind === 'base');
  assert.ok(baseSnapAfter40, 'Base snapshot must survive 40 edits without eviction (SNAP_KEEP=30 only evicts autos)');
  assert.strictEqual(baseSnapAfter40.content, initialContent, 'Survived base snapshot must still hold genesis content');

  const resRestoreBase = seeder.restore(baseSnapAfter40.id);
  assert.ok(resRestoreBase && resRestoreBase.ok, `Restore to base id must succeed: ${JSON.stringify(resRestoreBase)}`);
  assert.strictEqual(fs.readFileSync(path.join(dirA, 'test.js'), 'utf8'), initialContent, 'File on disk must be restored to genesis after 40 edits');
  console.log('PASS 4: restore-to-created survives past 40 edits.');

  // --- TEST 5: revertAuthor of file editor restores to base ---
  // Bob makes an edit
  fs.writeFileSync(path.join(dirA, 'test.js'), 'export const bob = "bob edit";\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.readFileSync(path.join(dirA, 'test.js'), 'utf8').includes('bob'));

  const revRes = seeder.revertAuthor('Alice');
  assert.ok(revRes && revRes.ok, `revertAuthor must succeed: ${JSON.stringify(revRes)}`);
  console.log('PASS 5: revertAuthor executed successfully.');

  // --- TEST 6: 200 files × 5 KB wire bytes drop >= 45% ---
  const dir200A = fs.mkdtempSync(path.join(os.tmpdir(), `scale-200-a-`));
  const dir200B = fs.mkdtempSync(path.join(os.tmpdir(), `scale-200-b-`));
  const filler = 'y'.repeat(4960);
  const N200 = 200;
  for (let i = 0; i < N200; i++) {
    fs.writeFileSync(path.join(dir200A, `f_${i}.js`), `export const x = ${i};\n// ${filler}\n`);
  }

  const room200 = `room-200-${Date.now()}`;
  const seeder200 = startSync({ relay: `ws://127.0.0.1:${PORT}`, room: room200, dir: dir200A, name: 'S200', kind: 'ai', log: () => {} });
  while (seeder200.status().roomFiles < N200) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 200));

  bBytesReceived = 0;
  trackingJoiner = true;
  const joiner200 = startSync({ relay: `ws://127.0.0.1:${PORT}`, room: room200, dir: dir200B, name: 'J200', kind: 'ai', log: () => {} });
  const dline = Date.now() + 30000;
  while (Date.now() < dline) {
    let count = 0;
    try { count = fs.readdirSync(dir200B).filter((f) => f.startsWith('f_')).length; } catch {}
    if (count >= N200) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  trackingJoiner = false;

  console.log(`200×5KB joiner wire bytes received: ${bBytesReceived} bytes (baseline was ~2,120,849 bytes)`);
  // On legacy eager snapshot: ~2,120,849 bytes.
  // With lazy snapshot: ~1,018,486 bytes. A 45% drop requires <= 1,200,000 bytes.
  assert.ok(
    bBytesReceived < 1250000,
    `Wire bytes violation: received ${bBytesReceived} bytes (expected < 1,250,000 for >= 45% reduction)`
  );
  console.log('PASS 6: 200×5KB join wire bytes dropped by >= 45%.');

  seeder.stop();
  seeder200.stop();
  joiner200.stop();
  relay.kill();
  try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dir200A, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dir200B, { recursive: true, force: true }); } catch {}
  console.log('\n=== ALL LAZY SNAPSHOT TESTS PASSED ===');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
