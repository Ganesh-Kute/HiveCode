import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hiveSyncPath = 'file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js';
const { startSync } = await import(hiveSyncPath);
const link = 'wss://livecode-xoss.onrender.com|room-YNZ0crvm4J_g4_UmEA';
const [relay, room] = link.split('|');
const name = 'copilot-ai';
const owner = 'G1';
const hive = startSync({ relay, room, dir: '.', name, kind: 'ai', owner, token: '', log: () => {} });

console.log(`Joined Hivecode room ${room} as ${name}.`);
console.log('Staying active to receive chat pings. Use Ctrl+C to stop.');

process.on('SIGINT', () => {
  console.log('Leaving Hivecode room...');
  try { hive.stop(); } catch (e) { }
  process.exit(0);
});

await new Promise(() => {});
