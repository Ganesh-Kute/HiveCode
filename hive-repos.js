// hive-repos.js — Per-machine repo registry (~/.hivecode/repos.json),
// display-only room repo_holder record, and the hive_pr MCP handler (Part A2).
//
// Security invariant:
//   What lands, and from where, is decided strictly on the local machine via
//   ~/.hivecode/repos.json + git config verification. Room data (repo_holder)
//   is display-only ({ branch, holder, host }) and never supplies a local path.
//   Test commands and staleness overrides (force) are never accepted from MCP
//   tool arguments; tests come only from testCommandFor(root, branch) in hive-land.js.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLink } from './sync.js';
import * as HB from './hive-branch.js';
import { landAndOpen, testCommandFor } from './hive-land.js';

export function reposFile() {
  return path.join(HB.hiveHome(), 'repos.json');
}

export function loadRepos() {
  try {
    const raw = fs.readFileSync(reposFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.rooms && typeof parsed.rooms === 'object') {
      return parsed;
    }
  } catch {}
  return { rooms: {} };
}

function normalizeEntries(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(e => e && typeof e === 'object' && e.root && e.branch);
  if (typeof val === 'object' && val.root && val.branch) return [val];
  return [];
}

export function saveRepos(data) {
  try {
    const file = reposFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(data, null, 2);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, payload);
    try {
      fs.renameSync(tmp, file);
    } catch {
      try { fs.writeFileSync(file, payload); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a local git repository + branch binding for a room on this machine.
 * Never throws: a registry write failure must never fail bindBranch or hive_join.
 *
 * Accepts { room, root, cwd, branch, link }.
 */
export function registerRepo(opts = {}) {
  try {
    const rawRoot = opts.root || opts.cwd || '';
    const branch = opts.branch || '';
    const link = opts.link || '';
    const room = opts.room || (link ? parseLink(link).room : '');
    if (!rawRoot || !branch || !room) return false;

    const root = path.resolve(rawRoot);
    const data = loadRepos();
    const list = normalizeEntries(data.rooms[room]);
    const entry = {
      root,
      branch,
      link,
      updatedAt: new Date().toISOString(),
    };
    const idx = list.findIndex(e => path.resolve(e.root) === root);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    data.rooms[room] = list;
    return saveRepos(data);
  } catch {
    return false;
  }
}

function isEntryValidForRoom(entry, roomId) {
  try {
    if (!entry || !entry.root || !entry.branch) return false;
    const root = path.resolve(entry.root);
    if (!fs.existsSync(root) || !HB.repoRoot(root)) return false;
    const binding = HB.readBinding(root, entry.branch);
    if (!binding || !binding.link) return false;
    const boundRoom = parseLink(binding.link).room;
    return boundRoom === roomId;
  } catch {
    return false;
  }
}

/**
 * Look up the local repository bound to `room` on this machine.
 * Verifies every candidate on disk against git config (`hivecode.<branch>.room`).
 *
 * Error codes:
 *   - Q583: no entry registered for this room on this machine
 *   - Q584: registered entry is stale (moved/deleted/rebound) OR multiple clones
 *           on this machine are bound to the same room and no preferredRoot matched
 */
export function lookupRepo(roomOrLink, opts = {}) {
  const roomId = parseLink(String(roomOrLink || '')).room || String(roomOrLink || '').trim();
  if (!roomId) {
    return {
      ok: false,
      code: 'Q583',
      notFound: true,
      entries: [],
      why: 'Q583 — room identifier is missing; cannot resolve a local git repository.',
    };
  }

  const data = loadRepos();
  const rawList = normalizeEntries(data.rooms[roomId]);
  const validEntries = [];
  const staleEntries = [];

  for (const e of rawList) {
    const normalized = { ...e, root: path.resolve(e.root) };
    if (isEntryValidForRoom(normalized, roomId)) {
      validEntries.push(normalized);
    } else {
      staleEntries.push(normalized);
    }
  }

  // If the current session joined by branch, also check its own branchCtx directly
  if (opts.preferredRoot) {
    const prefRoot = path.resolve(opts.preferredRoot);
    const alreadyInValid = validEntries.find(e => path.resolve(e.root) === prefRoot);
    if (alreadyInValid) {
      return { ok: true, entry: alreadyInValid };
    }
    if (opts.preferredBranch) {
      const candidate = { root: prefRoot, branch: opts.preferredBranch, link: opts.preferredLink || '' };
      if (isEntryValidForRoom(candidate, roomId)) {
        return { ok: true, entry: candidate };
      }
    }
  }

  if (validEntries.length === 1) {
    return { ok: true, entry: validEntries[0] };
  }

  if (validEntries.length > 1) {
    return {
      ok: false,
      code: 'Q584',
      ambiguous: true,
      entries: validEntries,
      why:
        `Q584 — ${validEntries.length} repositories on this machine are bound to room ${roomId}:\n` +
        validEntries.map(e => `  - ${e.root} (branch ${e.branch})`).join('\n') +
        `\nRefusing to pick one silently. Join by branch from the clone you want to land from (hive_join with branch + repo), or unbind the extra clone.`,
    };
  }

  if (staleEntries.length > 0) {
    return {
      ok: false,
      code: 'Q584',
      stale: true,
      entries: [],
      why:
        `Q584 — the registered repository for room ${roomId} on this machine (${staleEntries.map(e => `${e.root}#${e.branch}`).join(', ')}) ` +
        `is no longer bound to this room or was moved/deleted. Re-bind with: npx -y hivecode-mcp@latest branch <branch> --join "<link>"`,
    };
  }

  return {
    ok: false,
    code: 'Q583',
    notFound: true,
    entries: [],
    why: `Q583 — room ${roomId} is not bound to a git branch on this machine.`,
  };
}

const ALLOWED_HOLDER_KEYS = ['branch', 'holder', 'host', 'updatedAt'];

/**
 * Write a display-only repo_holder record into the room Y.Doc.
 * Strips all filesystem paths (root, cwd, dir, path). Never throws.
 */
export function writeRepoHolder(doc, info = {}) {
  try {
    if (!doc || typeof doc.getMap !== 'function') return false;
    const map = doc.getMap('repo_holder');
    const branch = typeof info.branch === 'string' ? info.branch.trim() : '';
    const holder = typeof (info.holder || info.name) === 'string' ? String(info.holder || info.name).trim() : '';
    const host = typeof info.host === 'string' && info.host.trim() ? info.host.trim() : os.hostname();
    const updatedAt = new Date().toISOString();

    const apply = () => {
      for (const k of Array.from(map.keys())) {
        if (!ALLOWED_HOLDER_KEYS.includes(k)) map.delete(k);
      }
      if (branch) map.set('branch', branch);
      if (holder) map.set('holder', holder);
      if (host) map.set('host', host);
      map.set('updatedAt', updatedAt);
    };
    if (typeof doc.transact === 'function') doc.transact(apply);
    else apply();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the display-only repo_holder record from the room Y.Doc.
 * Returns only { branch, holder, host, updatedAt } (never any path field), or null.
 */
export function readRepoHolder(doc) {
  try {
    if (!doc || typeof doc.getMap !== 'function') return null;
    const map = doc.getMap('repo_holder');
    const branch = typeof map.get('branch') === 'string' ? map.get('branch') : '';
    const holder = typeof map.get('holder') === 'string' ? map.get('holder') : '';
    const host = typeof map.get('host') === 'string' ? map.get('host') : '';
    const updatedAt = typeof map.get('updatedAt') === 'string' ? map.get('updatedAt') : '';
    if (!branch && !holder && !host) return null;
    const out = { branch, holder, host };
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  } catch {
    return null;
  }
}

/**
 * Factory for the hive_pr MCP tool handler.
 * Accepts an injectable `land` function (defaults to `landAndOpen` from hive-land.js).
 */
export function makeHivePr({
  land = landAndOpen,
  getSession,
  lookup = lookupRepo,
  readHolder = readRepoHolder,
  register = registerRepo,
  writeHolder = writeRepoHolder,
  // The issue this machine brought into the room (hive-issue.js), and the landing that checks a
  // finished issue (hive-room-mode.js). Both imported late: hive-issue.js imports this module.
  issues = null,
  landIssue = null,
} = {}) {
  return async function hivePr(args = {}) {
    const s = typeof getSession === 'function' ? getSession() : null;
    if (!s || !s.hive) {
      return 'Q585 — not in a room. Call hive_join first.';
    }

    const st = typeof s.hive.status === 'function' ? s.hive.status() : {};
    if (st && st.connected === false) {
      return 'Q586 — room connection is currently offline; wait for reconnect before running hive_pr.';
    }

    const linkStr = s.inviteLink || (s.relay && s.room ? `${s.relay}|${s.room}` : '');
    const roomId = s.room || parseLink(linkStr).room;
    const found = lookup(roomId, {
      preferredRoot: s.branchCtx?.root,
      preferredBranch: s.branchCtx?.branch,
      preferredLink: linkStr,
    });

    if (!found || !found.ok) {
      const holder = readHolder(s.hive.doc);
      if (found?.code === 'Q584') {
        const extra = holder && (holder.holder || holder.host)
          ? `\nRoom repo holder record: ${holder.holder || 'unknown'} (${holder.host || 'unknown'}) on branch \`${holder.branch || 'unknown'}\`.`
          : '';
        return `${found.why}${extra}`;
      }
      if (holder && (holder.holder || holder.host)) {
        const who = holder.holder || 'another member';
        const where = holder.host || 'another machine';
        const br = holder.branch || 'unknown';
        return (
          `Q582 — this room's repository is not on this machine. ` +
          `The repo for branch \`${br}\` is on ${who} (${where}). ` +
          `Ask @${who} to run hive_pr, or run it on ${where}.`
        );
      }
      return (
        found?.why ||
        `Q583 — room ${roomId || '(unknown)'} is not bound to a git branch on this machine. ` +
        `Bind a repository first with: npx -y hivecode-mcp@latest branch <branch> --join "${linkStr || '<link>'}"`
      );
    }

    // Strict boolean check: only `confirm: true` lands/pushes/opens a PR.
    // Security: `force`, `test`, and `testMinutes` are never accepted from MCP callers;
    // test command comes from testCommandFor(root, branch) in hive-land.js (saved git config or branch-tip package.json).
    const confirmed = args?.confirm === true;
    const by = s.owner ? `${s.name} for ${s.owner}` : s.name;
    const configuredTest = testCommandFor(found.entry.root, found.entry.branch).command;

    // AN ISSUE IS IN THIS ROOM (hive_issue brought it in from this machine). Its pull request is the
    // issue's: titled from it, "Closes #N", and opened only when its task is done, no claim is held
    // and every landing file was reviewed by someone who did not write it. The record is this
    // machine's own file, never the room's copy.
    const HI = issues || await import('./hive-issue.js');
    const issue = HI.readIssue(found.entry.root, roomId);
    const issueTask = issue ? (() => { try { return s.hive.doc.getMap('tasks').get(issue.taskId) || null; } catch { return null; } })() : null;
    if (issue && issueTask && confirmed) {
      const RM = landIssue ? null : await import('./hive-room-mode.js');
      const lr = await (landIssue || RM.landIssue)({
        link: linkStr,
        taskId: issue.taskId,
        issue: { number: issue.number, title: issue.title },
        root: found.entry.root,
        branch: found.entry.branch,
        syncRunner: async () => s.hive,
        landRunner: land,
        allowUnreviewed: args?.allowUnreviewed === true,
        state: { lastFailedFingerprint: issue.lastFailedFingerprint || '' },
        by,
        closes: true,
        note: args?.summary,
        base: args?.base,
        allowWorkflowChanges: args?.allowWorkflowChanges === true,
        only: args?.only,
      });
      const out = [];
      // Belt and braces: landIssue answers Q589 itself, but "ok" with no pull request must never
      // read as "up for review" here either, whatever landing was passed in.
      if (lr && lr.ok && !(lr.pr && lr.pr.number)) {
        return `Nothing was pushed for issue #${issue.number} (Q589): the landing reported success but opened no pull request.`;
      }
      if (!lr || !lr.ok) {
        const fp = lr && lr.state && lr.state.lastFailedFingerprint;
        if (fp && fp !== issue.lastFailedFingerprint) HI.writeIssue(found.entry.root, roomId, { ...issue, lastFailedFingerprint: fp });
        if (lr && lr.blocked === 'unreviewed') {
          const files = (lr.files || []).join(', ') || 'some files';
          out.push(`Issue #${issue.number} is done, but nothing was pushed: ${files} ${(lr.files || []).length === 1 ? 'has' : 'have'} no review by someone who did not write ${(lr.files || []).length === 1 ? 'it' : 'them'}.`);
          out.push(`Ask a teammate to review (hive_review). Only if your person said to land without a second review: hive_pr with confirm: true and allowUnreviewed: true; the pull request then says which files nobody else reviewed.`);
        } else if (lr && lr.skipped) {
          out.push(`Nothing was pushed for issue #${issue.number}: the last landing failed and neither the room's files nor the branch changed since. Fix the cause in the room, then call hive_pr again.`);
        } else {
          out.push(`Nothing was pushed for issue #${issue.number}${lr && lr.code ? ` (${lr.code})` : ''}: ${(lr && lr.why) || 'the landing gave no reason'}`);
          if (lr && lr.code === 'Q576') out.push('A task to fix the failing tests was given to the room.');
        }
        return out.join('\n');
      }
      register({ room: roomId, root: found.entry.root, branch: found.entry.branch, link: linkStr || found.entry.link });
      writeHolder(s.hive.doc, { branch: found.entry.branch, holder: s.name, host: os.hostname() });
      const next = { ...issue, pr: lr.pr.number, prUrl: lr.pr.url || '', lastFailedFingerprint: '' };
      HI.writeIssue(found.entry.root, roomId, next);
      HI.writeIssueRecord(s.hive.doc, next);
      const made = lr.pr.created || !issue.pr;
      out.push(`Issue #${issue.number} ${made ? 'is up for review' : 'was updated'}: PR #${lr.pr.number} ${lr.pr.url || ''}`.trim());
      for (const group of Array.isArray(lr.plan) ? lr.plan : []) {
        out.push(`  • ${group.agent || 'agent'}: ${Array.isArray(group.files) ? group.files.join(', ') : ''}`);
      }
      if (lr.tests?.ran) out.push(`  • Tests: ${lr.tests.command} -> ${lr.tests.ok ? 'PASS' : 'FAIL'} (${lr.tests.seconds ?? 0}s)`);
      else out.push('  • Tests: NOT RUN (no test command is saved for this branch)');
      if (Array.isArray(lr.orphans) && lr.orphans.length) out.push(`⚠️ Not in the pull request (no signed receipt): ${lr.orphans.join(', ')}`);
      out.push(`The pull request says "Closes #${issue.number}". When a person reviews it, bring their comments into the room with hive_issue { feedback: true }.`);
      try {
        s.hive.say(made
          ? `@all issue #${issue.number} is up for review: PR #${lr.pr.number} ${lr.pr.url || ''}`.trim()
          : `@all PR #${lr.pr.number} for issue #${issue.number} was updated${lr.pr.newCommits ? ` with ${lr.pr.newCommits} new commit(s)` : ''}: ${lr.pr.url || ''}`.trim());
      } catch {}
      return out.join('\n');
    }

    const res = await land({
      cwd: found.entry.root,
      branch: found.entry.branch,
      dry: !confirmed,
      push: confirmed,
      pr: confirmed,
      base: args?.base,
      test: configuredTest,
      title: args?.title,
      summary: args?.summary,
      by,
      allowWorkflowChanges: args?.allowWorkflowChanges === true,
      only: args?.only,
    });

    const lines = [];

    if (!res || !res.ok) {
      if (res?.why) {
        lines.push(res.why);
      } else {
        lines.push(`hive_pr refused${res?.code ? ` (${res.code})` : ''}.`);
      }

      // Check if caller holds claims itself on Q575
      const holders = Array.isArray(res?.holders) ? res.holders : [];
      const selfHeld = holders.filter(h => h && h.by === s.name).map(h => h.file);
      const otherHeld = holders.filter(h => h && h.by !== s.name);
      if (selfHeld.length > 0) {
        for (const f of selfHeld) {
          lines.push(`Note: you hold ${f}, release it first (call hive_release).`);
        }
      }
      if (otherHeld.length > 0) {
        lines.push(
          `Held by teammates: ` +
          otherHeld.map(h => `${h.file} (by ${h.by}${h.intent ? `: ${h.intent}` : ''})`).join(', ')
        );
      }

      if (Array.isArray(res?.orphans) && res.orphans.length > 0) {
        lines.push(
          `Orphan files (changed in room with no verified receipt — will NOT land): ` +
          res.orphans.join(', ')
        );
      }
      return lines.join('\n');
    }

    // Success (either dry-run or confirmed landing)
    if (!confirmed) {
      lines.push(`DRY RUN — hive_pr plan for branch \`${found.entry.branch}\` in ${found.entry.root}:`);
      if (res.why) lines.push(res.why);
      const plan = Array.isArray(res.plan) ? res.plan : [];
      if (plan.length === 0) {
        if (!res.why) {
          lines.push('  (no receipt-verified file changes to land)');
        }
      } else {
        for (const group of plan) {
          const files = Array.isArray(group.files) ? group.files.join(', ') : '';
          const intents = Array.isArray(group.intents) && group.intents.length ? ` — ${group.intents.join('; ')}` : '';
          lines.push(`  • ${group.agent || 'agent'}: ${files}${intents}`);
        }
      }
      if (Array.isArray(res.deletions) && res.deletions.length > 0) {
        lines.push(`  • Deletions: ${res.deletions.join(', ')}`);
      }
      if (Array.isArray(res.orphans) && res.orphans.length > 0) {
        lines.push(
          `⚠️ Orphans (changed in room with no verified receipt — will NOT land): ` +
          res.orphans.join(', ')
        );
      }
      if (issue && issueTask) {
        let wd = null;
        try {
          const RM = await import('./hive-room-mode.js');
          wd = await RM.whenDone({ link: linkStr, taskId: issue.taskId, root: found.entry.root, branch: found.entry.branch, syncRunner: async () => s.hive, landRunner: land, allowUnreviewed: args?.allowUnreviewed === true });
        } catch (e) { wd = { ready: false, why: e.message }; }
        lines.push(`\nIssue #${issue.number} (${issue.title}), task ${issue.taskId}: ` +
          (wd.ready ? `ready. With confirm: true this opens or updates its pull request, titled from the issue, saying "Closes #${issue.number}".` : `not ready to land: ${wd.why}`));
      }
      lines.push(`\nNothing was committed or pushed. Call hive_pr with confirm: true to land, push, and open/update the PR.`);
      return lines.join('\n');
    }

    // Confirmed landing succeeded: refresh local registry + room holder record
    register({
      room: roomId,
      root: found.entry.root,
      branch: found.entry.branch,
      link: linkStr || found.entry.link,
    });
    writeHolder(s.hive.doc, {
      branch: found.entry.branch,
      holder: s.name,
      host: os.hostname(),
    });

    lines.push(`LANDED on branch \`${found.entry.branch}\`${res.tip ? ` (tip ${res.tip})` : ''}.`);
    if (res.why) lines.push(res.why);
    const plan = Array.isArray(res.plan) ? res.plan : [];
    for (const group of plan) {
      const files = Array.isArray(group.files) ? group.files.join(', ') : '';
      const intents = Array.isArray(group.intents) && group.intents.length ? ` — ${group.intents.join('; ')}` : '';
      lines.push(`  • ${group.agent || 'agent'}: ${files}${intents}`);
    }
    if (res.tests?.ran) {
      lines.push(`  • Tests: ${res.tests.command} -> ${res.tests.ok ? 'PASS' : 'FAIL'} (${res.tests.seconds ?? 0}s)`);
    }
    if (Array.isArray(res.orphans) && res.orphans.length > 0) {
      lines.push(
        `⚠️ Orphans (changed in room with no verified receipt — did NOT land): ` +
        res.orphans.join(', ')
      );
    }
    if (res.pr?.url) {
      const action = res.pr.created ? 'opened' : 'updated';
      lines.push(`  • PR #${res.pr.number || ''} ${action}: ${res.pr.url}`);
      try {
        s.hive.say(
          `PR ${action} for branch \`${found.entry.branch}\`: ${res.pr.url}` +
          (res.tip ? ` (tip ${res.tip})` : '')
        );
      } catch {}
    }
    return lines.join('\n');
  };
}
