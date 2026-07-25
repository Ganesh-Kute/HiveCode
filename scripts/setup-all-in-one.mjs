import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-master/repo';

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

if (fs.existsSync('demo-recording-master')) {
  fs.rmSync('demo-recording-master', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

const packageJson = {
  name: "demo-repo-master",
  scripts: {
    "enable-icr": "git config merge.icr.name \"Intent-Centric Reconciliation\" && git config merge.icr.driver \"node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P\" && git config merge.default icr && echo ICR Engine Enabled in Git!"
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.js merge=icr\n*.py merge=icr\n*.cpp merge=icr\n');
run('git add package.json .gitattributes');

// --- BASE CODE ---
const pyBase = `
import os

# --- CRITICAL SYSTEM CLASS ---
# This class manages the entire backend.
class BackendManager:
    def __init__(self):
        self.active = True

    def ping(self):
        return "pong"
`;

const jsBase = `
function formatData(data) {
  return data.trim();
}

function processAll(list) {
  let result = [];
  for (let item of list) {
    result.push(formatData(item));
  }
  return result;
}
`;

const cppBase = `
#include <iostream>

// Standard Payment Processor
bool process_payment(int amount) {
    std::cout << "Initializing payment..." << std::endl;
    // [Add gateway logic here]
    std::cout << "Finalizing charge of " << amount << std::endl;
    return true;
}
`;

const javaBase = `
public class EnterpriseSystem {
    // Core system initialized
    public EnterpriseSystem() {}
}
`;

const sqlBase = `
CREATE TABLE users (
    id INT PRIMARY KEY
);

CREATE TABLE orders (
    id INT PRIMARY KEY
);
`;

fs.writeFileSync(path.join(DIR, 'backend.py'), pyBase.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsBase.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppBase.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaBase.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlBase.trim() + '\n');
run('git add .');
run('git commit -m "Base: initial codebase"');

// --- ARCHITECT BRANCH ---
run('git checkout -b architect');

const pyArch = pyBase.replace('return "pong"', 'return "pong"\n\n    def scale_up(self):\n        print("Scaling up instances!")');
fs.writeFileSync(path.join(DIR, 'backend.py'), pyArch.trim() + '\n');

const jsArch = `
function formatDataV2(data) {
  return data.trim().toLowerCase();
}

function processAll(list) {
  let result = [];
  for (let item of list) {
    result.push(formatDataV2(item));
  }
  return result;
}
`;
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsArch.trim() + '\n');

const cppArch = `
#include <iostream>

// Standard Payment Processor
bool process_payment(int amount) {
    std::cout << "Initializing payment..." << std::endl;
    std::cout << "Connecting to STRIPE API..." << std::endl;
    // [Add gateway logic here]
    std::cout << "Finalizing charge of " << amount << std::endl;
    return true;
}
`;

const javaArch = `
public class EnterpriseSystem {
    // Core system initialized
    public EnterpriseSystem() {}
    
    // Auth System
    public void authenticate() {
        System.out.println("Auth OK");
    }
}
`;

const sqlArch = `
CREATE TABLE users (
    id INT PRIMARY KEY,
    email VARCHAR(100)
);

CREATE TABLE orders (
    id INT PRIMARY KEY
);
`;

fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppArch.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaArch.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlArch.trim() + '\n');
run('git commit -am "Architect: added scale_up, renamed to formatDataV2, added Stripe, Auth, and Email"');

// --- FEATURE BRANCH ---
run('git checkout master');

const pyFeat = `
import os
# noise 1
# noise 2
# noise 3
# noise 4
# noise 5
# noise 6
# noise 7
# noise 8
# noise 9
# noise 10

# --- CRITICAL SYSTEM CLASS ---
# This class manages the entire backend.
class BackendManager:
    def __init__(self):
        self.active = True

    def ping(self):
        return "pong"

    def add_metrics(self):
        print("Metrics active!")
`;
fs.writeFileSync(path.join(DIR, 'backend.py'), pyFeat.trim() + '\n');

const jsFeat = `
function formatData(data) {
  return data.trim();
}

function processAll(list) {
  let result = [];
  for (let item of list) {
    result.push(formatData(item));
    console.log(formatData(item));
    if (formatData(item) === 'error') throw new Error();
  }
  return result;
}
`;
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsFeat.trim() + '\n');

const cppFeat = `
#include <iostream>

// Standard Payment Processor
bool process_payment(int amount) {
    std::cout << "Initializing payment..." << std::endl;
    // [Add gateway logic here]
    std::cout << "Connecting to PAYPAL API..." << std::endl;
    std::cout << "Finalizing charge of " << amount << std::endl;
    return true;
}
`;

const javaFeat = `
public class EnterpriseSystem {
    // Core system initialized
    public EnterpriseSystem() {}
    
    // Shutdown Hook
    public void shutdown() {
        System.out.println("Shutting down");
    }
}
`;

const sqlFeat = `
CREATE TABLE users (
    id INT PRIMARY KEY
);

CREATE TABLE orders (
    id INT PRIMARY KEY,
    total DECIMAL
);
`;

fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppFeat.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaFeat.trim() + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlFeat.trim() + '\n');
run('git commit -am "Feature: added py metrics, added js logs, added paypal, shutdown hook, and total col"');

console.log('\n======================================================');
console.log('✅ MASTER CRUCIBLE ENVIRONMENT READY');
console.log('Navigate to demo-recording-master/repo to start.');
console.log('======================================================\n');
