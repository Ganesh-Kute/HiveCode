import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = '.tasktmp/hard-test/repo';

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
function fetchData(id) {
  console.log("Fetching legacy sync: " + id);
  return [];
}

function getUser(id) {
  return fetchData("USER_" + id);
}

function getSettings(id) {
  return fetchData("SETTING_" + id);
}

module.exports = { getUser, getSettings };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), baseCode.trim() + '\n');
run('git add app.js');
run('git commit -m "Base: initial legacy code"');

// 4. PLATFORM TEAM (The 3-week refactor branch)
run('git checkout -b platform-team');
const platformCode = `
// RENAME: fetchData -> fetchDataAsync
async function fetchDataAsync(id) {
  console.log("Fetching MODERN async: " + id);
  return await Promise.resolve([]);
}

// All old functions updated to the new name by the refactoring script
async function getUser(id) {
  return await fetchDataAsync("USER_" + id);
}

async function getSettings(id) {
  return await fetchDataAsync("SETTING_" + id);
}

module.exports = { getUser, getSettings };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), platformCode.trim() + '\n');
run('git commit -am "Platform: rename fetchData to fetchDataAsync across the board"');

// 5. REGULAR DEVS (The feature team, unaware of the refactor)
run('git checkout master');
const featureCode = `
// --- 10 lines of new feature bloat added by other devs ---
// feature A
// feature B
// feature C
// feature D
// feature E
// feature F
// feature G
// feature H
// feature I
// feature J

function fetchData(id) {
  console.log("Fetching legacy sync: " + id);
  return [];
}

function getUser(id) {
  return fetchData("USER_" + id);
}

// A REGULAR DEV ADDS A BRAND NEW FUNCTION USING THE OLD API
function createNewUser(name) {
  console.log("Creating user...");
  // THIS WILL BREAK IF fetchData IS DELETED!
  return fetchData("NEW_USER_" + name);
}

function getSettings(id) {
  return fetchData("SETTING_" + id);
}

module.exports = { getUser, createNewUser, getSettings };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), featureCode.trim() + '\n');
run('git commit -am "Feature: added 10 lines of bloat AND a new createNewUser feature calling the old API"');

// 6. THE MERGE (The Moving Target Collision)
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

