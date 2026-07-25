import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-semantic/repo';

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
if (fs.existsSync('demo-recording-semantic')) {
  fs.rmSync('demo-recording-semantic', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// Create package.json with the enable script
const packageJson = {
  name: "demo-repo-semantic",
  scripts: {
    "enable-icr": "git config merge.icr.name \"Intent-Centric Reconciliation\" && git config merge.icr.driver \"node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P\" && git config merge.default icr && echo ICR Engine Enabled in Git!"
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.py merge=icr\n');
run('git add package.json .gitattributes');

// 3. BASE CODE
const baseCode = `
import os

def process_payment(amount):
    print("Initializing payment...")
    
    # [Insert Gateway Logic Here]
    
    print(f"Finalizing charge of {amount}")
    return True
`;
fs.writeFileSync(path.join(DIR, 'main.py'), baseCode.trim() + '\n');
run('git add main.py');
run('git commit -m "Base: initial payment processor"');

// 4. ARCHITECT BRANCH (Branch A)
run('git checkout -b architect');
const architectCode = `
import os

def process_payment(amount):
    print("Initializing payment...")
    
    print("Connecting to STRIPE API...")
    stripe_charge(amount)
    
    # [Insert Gateway Logic Here]
    
    print(f"Finalizing charge of {amount}")
    return True
`;
fs.writeFileSync(path.join(DIR, 'main.py'), architectCode.trim() + '\n');
run('git commit -am "Architect: Added Stripe integration"');

// 5. FEATURE TEAM BRANCH (Branch B)
run('git checkout master');
const featureCode = `
import os

def process_payment(amount):
    print("Initializing payment...")
    
    # [Insert Gateway Logic Here]
    
    print("Connecting to PAYPAL API...")
    paypal_charge(amount)
    
    print(f"Finalizing charge of {amount}")
    return True
`;
fs.writeFileSync(path.join(DIR, 'main.py'), featureCode.trim() + '\n');
run('git commit -am "Feature: Added PayPal integration"');

console.log('\n======================================================');
console.log('✅ SEMANTIC CONFLICT ENVIRONMENT READY');
console.log('Navigate to demo-recording-semantic/repo to start.');
console.log('======================================================\n');
