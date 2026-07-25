import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js');

const link = 'wss://livecode-xoss.onrender.com|room-YNZ0crvm4J_g4_UmEA';
const { relay, room } = parseLink(link);
const name = 'copilot-ai';
const owner = 'G1';
const hive = startSync({ relay, room, dir: '.', name, kind: 'ai', owner, token: '', log: console.log });

const mentionRegex = new RegExp(`@${name}\\b`, 'i');
let lastSeenLine = -1;
let handling = false;
process.setMaxListeners(50);

function parseTasks() {
  try {
    const content = fs.readFileSync(path.resolve('./HIVE_TASKS.md'), 'utf8');
    return content.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const m = line.match(/^\- \[([^\]]+)\] ([^\s]+)  ([^:]+): (.*)$/);
      if (!m) return null;
      return { status: m[1], id: m[2], to: m[3], text: m[4] };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function decideNextAction(message) {
  const txt = String(message.text || '');
  
  // Check for AI→AI coordination: direct tool calls
  if (/hive_claim|claim\(/.test(txt)) {
    const m = txt.match(/hive_claim\(.*?region\s*=\s*["']([^"']+)["']/i) || txt.match(/claim.*?["']([^"']+)["']/i);
    if (m) {
      const region = m[1];
      const got = hive.claim(region, 'round1 test');
      hive.say(`${name}: executed hive_claim("${region}", "round1 test") — result: ${got === false ? 'DENIED (someone holds it)' : 'GRANTED (you got it)'}`);
      const board = hive.claimsBoard();
      hive.say(`${name}: hive_claims board: ${board.map((c) => `${c.region} (${c.by})`).join('; ') || '(empty)'}`);
      return;
    }
  }
  
  const tasks = parseTasks();
  const myAccepted = tasks.filter((t) => t.to === name && t.status.toLowerCase() === 'accepted');
  if (myAccepted.length) {
    const task = myAccepted[0];
    hive.say(`${name}: I found accepted task ${task.id} assigned to me. I will begin it and report back when done.`);
    return;
  }
  if (/review|read|look|check/.test(txt)) {
    hive.say(`${name}: I will review the current room state and stay ready for approved work.`);
    return;
  }
  if (/task|do it|please|fix|change|update|add/.test(txt)) {
    hive.say(`${name}: I will monitor tasks and act when one is approved for me.`);
    return;
  }
  hive.say(`${name}: I have been mentioned. I will stay active, read the room, and await further instructions or approved work.`);
}

function handleMention(message) {
  if (handling) return;
  handling = true;
  try {
    hive.say(`${name}: saw mention from ${message.by}. Reading room state now.`);
    const otherMembers = hive.members().filter((u) => u.name !== name).map((u) => `${u.name}(${u.kind})`).join(', ') || 'none';
    hive.say(`${name}: current members: ${otherMembers}`);
    decideNextAction(message);
  } catch (err) {
    console.error('handleMention error', err);
  } finally {
    handling = false;
  }
}

function pollChat() {
  try {
    const chatPath = path.resolve('./HIVE_CHAT.md');
    const text = fs.readFileSync(chatPath, 'utf8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const match = line.match(/^\-\s+([^\s]+)\s+([^\s]+)\s+\(([^)]+)\):\s+(.*)$/);
      if (!match) continue;
      if (i <= lastSeenLine) break;
      const [, at, by, kind, msg] = match;
      if (mentionRegex.test(msg) && by !== name) {
        handleMention({ at, by, kind, text: msg });
        lastSeenLine = i;
        return;
      }
      lastSeenLine = i;
    }
  } catch {
    // no chat file yet or read issue
  }
}

const chatWatch = setInterval(pollChat, 5000);

console.log(`Joined ${room} as ${name} and watching chat mentions.`);
process.on('SIGINT', () => {
  clearInterval(chatWatch);
  hive.stop();
  process.exit(0);
});
await new Promise(() => {});
