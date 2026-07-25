import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = '.tasktmp/migration-test/repo';

function run(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: DIR, encoding: 'utf8', stdio: 'pipe' });
    if (out.trim()) console.log(out.trim());
    return out;
  } catch (e) {
    console.log(e.stdout || '');
    console.log(e.stderr || '');
    throw e;
  }
}

// 1. Setup clean repo
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// 2. Setup ICR as the Git Merge Driver
const icrBin = path.resolve('packages/icr-merge/bin/icr-merge-driver.js');
run(`git config merge.icr.name "Intent-Centric Reconciliation"`);
run(`git config merge.icr.driver "node ${icrBin.replace(/\\/g, '/')} %O %A %B %P"`);
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.js merge=icr\n');
run('git add .gitattributes');

// 3. BASE CODE (The old legacy app)
const baseCode = `
// Legacy API
function processData(payload) {
  console.log("Processing payload: ", payload);
  return payload.id;
}

function handleLogin(req) {
  return processData(req.body);
}

module.exports = { handleLogin };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), baseCode.trim() + '\n');
run('git add app.js');
run('git commit -m "Base: initial legacy code"');

// 4. PLATFORM TEAM (The 3-week refactor branch)
run('git checkout -b platform-team');
const platformCode = `
// Legacy API
function processDataV2(payload) {
  console.log("Processing payload: ", payload);
  return payload.id;
}

function handleLogin(req) {
  return processDataV2(req.body);
}

module.exports = { handleLogin };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), platformCode.trim() + '\n');
run('git commit -am "Platform: PURE RENAME processData to processDataV2"');

// 5. REGULAR DEVS (The feature team, unaware of the refactor)
run('git checkout master');
const featureCode = `
// --- 10 lines of new feature bloat added by other devs ---
// bloat 1
// bloat 2
// bloat 3
// bloat 4
// bloat 5
// bloat 6
// bloat 7
// bloat 8
// bloat 9
// bloat 10

// Legacy API
function processData(payload) {
  console.log("Processing payload: ", payload);
  return payload.id;
}

function handleLogin(req) {
  return processData(req.body);
}

// REGULAR DEV ADDS A BRAND NEW FEATURE USING THE OLD API
function handleSignup(req) {
  console.log("Signing up user...");
  // THIS CALL MUST BE REWRITTEN TO processDataV2 BY ICR!
  return processData({ id: 999 });
}

module.exports = { handleLogin, handleSignup };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), featureCode.trim() + '\n');
run('git commit -am "Feature: added bloat AND a new handleSignup feature calling the old API"');

// 6. THE MERGE (The Migration Collision)
console.log('\n======================================================');
console.log('🔥 INITIATING ICR GIT MERGE (Platform Team merging back)');
console.log('======================================================\n');

try {
  run('git merge platform-team');
} catch (e) {
  console.log("Merge had conflicts! Let's see them.");
}

console.log('\n======================================================');
console.log('✅ FINAL MERGED CODE PRODUCED BY ICR:');
console.log('======================================================\n');
console.log(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));

