import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-py-complex/repo';

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
if (fs.existsSync('demo-recording-py-complex')) {
  fs.rmSync('demo-recording-py-complex', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// Create package.json with the enable script
const packageJson = {
  name: "demo-repo-py-complex",
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
import sys

def complex_decorator(retries=3):
    def decorator(func):
        return func
    return decorator

class DataPipeline:
    def __init__(self, host):
        self.host = host

    @complex_decorator(retries=5)
    def fetch_data(
        self,
        query_string,
        timeout=60,
    ):
        """
        Connects to the database.
        # This comment inside a docstring should not break the scanner!
        class FakeClass: pass
        def fake_def(): return True
        """
        sql = "SELECT * FROM users " \\
              "WHERE active = 1"
        return execute(sql)
`;
fs.writeFileSync(path.join(DIR, 'core.py'), baseCode.trim() + '\n');
run('git add core.py');
run('git commit -m "Base: initial Python Crucible code"');

// 4. ARCHITECT BRANCH (Branch A)
run('git checkout -b architect');
const architectCode = `
import os
import sys

def complex_decorator(retries=3):
    def decorator(func):
        return func
    return decorator

class DataPipeline:
    def __init__(self, host):
        self.host = host

    @complex_decorator(retries=5)
    def fetch_data(
        self,
        query_string,
        timeout=60,
    ):
        """
        Connects to the database.
        # This comment inside a docstring should not break the scanner!
        class FakeClass: pass
        def fake_def(): return True
        """
        sql = "SELECT * FROM users " \\
              "WHERE active = 1"
        return execute(sql)

    def disconnect(self):
        print("Safely disconnecting from database.")

class Metrics:
    def __init__(self):
        self.counts = 0
`;
fs.writeFileSync(path.join(DIR, 'core.py'), architectCode.trim() + '\n');
run('git commit -am "Architect: Added disconnect method and Metrics class"');

// 5. FEATURE TEAM BRANCH (Branch B)
run('git checkout master');
const featureCode = `
import os
import sys

# --- MASSIVE NOISE BLOCK ---
# Shift everything down
# to break line numbers!
# 1
# 2
# 3
# 4
# 5
# 6
# 7
# 8
# 9
# 10
# ---------------------------

def complex_decorator(retries=3):
    def decorator(func):
        return func
    return decorator

class DataPipeline:
    def __init__(self, host):
        self.host = host

    @complex_decorator(retries=5)
    def fetch_data(
        self,
        query_string,
        timeout=60,
    ):
        """
        Connects to the database.
        # This comment inside a docstring should not break the scanner!
        class FakeClass: pass
        def fake_def(): return True
        """
        sql = "SELECT * FROM users " \\
              "WHERE active = 1"
        return execute(sql)

    def ping(self):
        print("Pinging database...")

def run_pipeline():
    print("Starting pipeline run...")
`;
fs.writeFileSync(path.join(DIR, 'core.py'), featureCode.trim() + '\n');
run('git commit -am "Feature: added noise, added ping method, added run_pipeline func"');

console.log('\n======================================================');
console.log('✅ PYTHON CRUCIBLE ENVIRONMENT READY');
console.log('Navigate to demo-recording-py-complex/repo to start.');
console.log('======================================================\n');
