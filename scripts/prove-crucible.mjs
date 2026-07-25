import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = '.tasktmp/crucible/repo';

function run(cmd, allowFail = false) {
  console.log(`\n> ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: DIR, encoding: 'utf8', stdio: 'pipe' });
    if (out.trim()) console.log(out.trim());
    return out;
  } catch (e) {
    if (allowFail) {
      console.log(e.stdout || '');
      console.log(e.stderr || '');
      return null;
    }
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

// 3. BASE CODE
const baseCode = `
function processPayment(amount) {
  console.log("Legacy charge: " + amount);
}

function calculateTax(amount) {
  return amount * 0.2;
}

function checkout(cart) {
  let total = cart.total;
  total += calculateTax(total);
  processPayment(total);
}

module.exports = {
  checkout: checkout,
  version: "1.0"
};
`;
fs.writeFileSync(path.join(DIR, 'app.js'), baseCode.trim() + '\n');
run('git add app.js');
run('git commit -m "Base: initial E-Commerce code"');

// 4. PLATFORM ARCHITECT (Branch A)
run('git checkout -b architect');
const architectCode = `
// RENAME processPayment -> processPaymentV2
function processPaymentV2(amount) {
  console.log("Legacy charge: " + amount);
}

// DELETED calculateTax entirely (moved to a microservice)

function checkout(cart) {
  let total = cart.total;
  // using new external tax service
  processPaymentV2(total);
}

// FALSE CONFLICT SETUP: Adding function at bottom
function refund(id) {
  console.log("Refunding " + id);
}

// DEEP OBJECT FUSION: Added init hook
module.exports = {
  checkout: checkout,
  version: "1.0",
  init: function() { console.log("Init A"); }
};
`;
fs.writeFileSync(path.join(DIR, 'app.js'), architectCode.trim() + '\n');
run('git commit -am "Architect: Async refactor, deleted calculateTax, added init hook and refund"');

// 5. FEATURE TEAM (Branch B)
run('git checkout master');

let bloat = "";
for (let i = 0; i < 50; i++) {
  bloat += `// This is noise line ${i} to shift line numbers drastically.\n`;
}

const featureCode = bloat + `
function processPayment(amount) {
  console.log("Legacy charge: " + amount);
}

function calculateTax(amount) {
  return amount * 0.2;
}

function checkout(cart) {
  let total = cart.total;
  total += calculateTax(total);
  processPayment(total);
}

// RENAME PROPAGATION TEST: Calling renamed processPayment
function processSubscription() {
  processPayment(9.99);
}

// DANGLING REF TEST: Calling deleted calculateTax
function calculateSubscriptionTax() {
  return calculateTax(9.99);
}

// FALSE CONFLICT SETUP: Adding function at bottom (same line as architect's refund)
function notifyUser(id) {
  console.log("Notifying " + id);
}

// DEEP OBJECT FUSION: Added teardown hook
module.exports = {
  checkout: checkout,
  version: "1.0",
  teardown: function() { console.log("Teardown B"); }
};
`;
fs.writeFileSync(path.join(DIR, 'app.js'), featureCode.trim() + '\n');
run('git commit -am "Feature: Added 50 lines noise, new features using old APIs, teardown hook"');

// 6. THE MERGE (The Crucible)
console.log('\n======================================================');
console.log('🔥 TEST 1: THE DANGLING REFERENCE BLOCKER');
console.log('======================================================');
console.log('Merging Architect into Feature Team. Expecting a hard SEMANTIC CONFLICT block because Feature Team is calling the deleted calculateTax function.');

run('git merge architect', true); // allow fail

console.log('\n======================================================');
console.log('🔥 TEST 2: THE FLAWLESS FUSION');
console.log('======================================================');
console.log('Removing the dangling call to calculateTax to simulate a developer fixing the semantic bug, then re-merging to show the successful 4-way fusion.');

run('git merge --abort');

const fixedFeatureCode = featureCode.replace(
  /function calculateSubscriptionTax\(\) \{\n  return calculateTax\(9\.99\);\n\}/, 
  'function calculateSubscriptionTax() {\n  return 1.99; // fixed\n}'
);
fs.writeFileSync(path.join(DIR, 'app.js'), fixedFeatureCode.trim() + '\n');
run('git commit -am "Feature: Fixed the calculateTax dangling reference bug"');

run('git merge architect');

console.log('\n======================================================');
console.log('✅ FINAL MERGED CODE PRODUCED BY ICR:');
console.log('======================================================\n');
console.log(fs.readFileSync(path.join(DIR, 'app.js'), 'utf8'));
