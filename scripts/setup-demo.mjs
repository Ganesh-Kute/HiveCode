import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording/repo';

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
if (fs.existsSync('demo-recording')) {
  fs.rmSync('demo-recording', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// Create package.json with the enable script
const packageJson = {
  name: "demo-repo",
  scripts: {
    "enable-icr": "git config merge.icr.name 'Intent-Centric Reconciliation' && git config merge.icr.driver 'node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P' && git config merge.default icr && echo '✅ ICR Engine Enabled in Git!'"
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.js merge=icr\n');
run('git add package.json .gitattributes');

// 3. BASE CODE
const baseCode = `
// Legacy API Module
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

// 4. ARCHITECT BRANCH (Branch A)
run('git checkout -b architect');
const architectCode = `
// Legacy API Module
function processDataV2(payload) {
  console.log("Processing payload: ", payload);
  return payload.id;
}

function handleLogin(req) {
  return processDataV2(req.body);
}

module.exports = { handleLogin };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), architectCode.trim() + '\n');
run('git commit -am "Architect: renamed processData to processDataV2"');

// 5. FEATURE TEAM BRANCH (Branch B)
run('git checkout master');
const featureCode = `
// --- feature bloat block ---
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

// Legacy API Module
function processData(payload) {
  console.log("Processing payload: ", payload);
  return payload.id;
}

function handleLogin(req) {
  return processData(req.body);
}

// FEATURE TEAM ADDS NEW FUNCTION USING OLD API
function handleSignup(req) {
  console.log("Signing up user...");
  // WARNING: THIS CALL WILL BREAK IF processData IS RENAMED!
  return processData({ id: 999 });
}

module.exports = { handleLogin, handleSignup };
`;
fs.writeFileSync(path.join(DIR, 'app.js'), featureCode.trim() + '\n');
run('git commit -am "Feature: added bloat and handleSignup using old API"');

console.log('\n======================================================');
console.log('✅ DEMO ENVIRONMENT READY');
console.log('Navigate to demo-recording/repo to start the demo.');
console.log('======================================================\n');
