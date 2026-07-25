import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-py/repo';

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
if (fs.existsSync('demo-recording-py')) {
  fs.rmSync('demo-recording-py', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// Create package.json with the enable script
const packageJson = {
  name: "demo-repo-py",
  scripts: {
    "enable-icr": "git config merge.icr.name \"Intent-Centric Reconciliation\" && git config merge.icr.driver \"node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P\" && git config merge.default icr && echo ICR Engine Enabled in Git!"
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.py merge=icr\n');
run('git add package.json .gitattributes');

// 3. BASE CODE
const baseCode = `
class PaymentProcessor:
    def __init__(self, key):
        self.key = key

    def process(self, amount):
        print(f"Processing {amount}")

def calculate_tax(amount):
    return amount * 0.2
`;
fs.writeFileSync(path.join(DIR, 'main.py'), baseCode.trim() + '\n');
run('git add main.py');
run('git commit -m "Base: initial Python code"');

// 4. ARCHITECT BRANCH (Branch A)
run('git checkout -b architect');
const architectCode = `
class PaymentProcessor:
    def __init__(self, key):
        self.key = key

    def process(self, amount):
        print(f"Processing {amount}")

    def refund(self, amount):
        print(f"Refunding {amount}")

def calculate_tax(amount):
    return amount * 0.2

def generate_receipt():
    pass
`;
fs.writeFileSync(path.join(DIR, 'main.py'), architectCode.trim() + '\n');
run('git commit -am "Architect: Added refund to class and generate_receipt"');

// 5. FEATURE TEAM BRANCH (Branch B)
run('git checkout master');
const featureCode = `
# --- feature bloat block ---
# bloat 1
# bloat 2
# bloat 3
# bloat 4
# bloat 5
# bloat 6
# bloat 7
# bloat 8
# bloat 9
# bloat 10

class PaymentProcessor:
    def __init__(self, key):
        self.key = key

    def process(self, amount):
        print(f"Processing {amount}")

    def verify_fraud(self, amount):
        print("Checking fraud...")

def calculate_tax(amount):
    return amount * 0.2

def send_email():
    pass
`;
fs.writeFileSync(path.join(DIR, 'main.py'), featureCode.trim() + '\n');
run('git commit -am "Feature: added noise, added verify_fraud to class, added send_email"');

console.log('\n======================================================');
console.log('✅ PYTHON DEMO ENVIRONMENT READY');
console.log('Navigate to demo-recording-py/repo to start.');
console.log('======================================================\n');
