import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-leviathan/repo';

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
if (fs.existsSync('demo-recording-leviathan')) {
  fs.rmSync('demo-recording-leviathan', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

// Create package.json with the enable script
const packageJson = {
  name: "demo-repo-leviathan",
  scripts: {
    "enable-icr": "git config merge.icr.name \"Intent-Centric Reconciliation\" && git config merge.icr.driver \"node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P\" && git config merge.default icr && echo ICR Engine Enabled in Git!"
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.py merge=icr\n');
run('git add package.json .gitattributes');

// Helper to generate a big file
function generateFile(state, fileName, numClasses) {
  let content = `import os\nimport sys\nimport time\nimport math\nimport random\n\n`;
  
  if (state === 'feature') {
    content += `# --- MASSIVE NOISE BLOCK SHIFTING LINES ---\n`;
    for(let i=0; i<150; i++) {
        content += `# bloat ${i}\n`;
    }
    content += `# -------------------------------------------\n\n`;
  }

  for (let c = 0; c < numClasses; c++) {
    content += `class LeviathanComponent_${fileName.replace('.py', '')}_${c}:\n`;
    content += `    """\n    Base Component Definition for ${c}\n    """\n`;
    content += `    def __init__(self, id_val):\n`;
    content += `        self.id_val = id_val\n`;
    content += `        self.status = "INIT"\n\n`;
    
    // Add 10 dummy methods to pad the file
    for (let m = 0; m < 10; m++) {
        content += `    def core_business_logic_${m}(self):\n`;
        content += `        time.sleep(0.01)\n`;
        content += `        return math.sqrt(${m} * random.random())\n\n`;
    }
    
    if (state === 'architect') {
        content += `    def arch_scale_system(self):\n`;
        content += `        print("Architect scaling system...")\n\n`;
    }
    if (state === 'feature') {
        content += `    def feat_add_analytics(self):\n`;
        content += `        print("Feature tracking analytics...")\n\n`;
    }
  }

  if (state === 'architect') {
    content += `def global_architect_init():\n    pass\n\n`;
  }
  if (state === 'feature') {
    content += `def global_feature_flag():\n    pass\n\n`;
  }

  return content;
}

const files = ['app.py', 'models.py', 'services.py', 'utils.py'];

// 3. BASE CODE
files.forEach(file => {
    fs.writeFileSync(path.join(DIR, file), generateFile('base', file, 5));
});
run('git add .');
run('git commit -m "Base: initial Leviathan architecture (1000+ lines)"');

// 4. ARCHITECT BRANCH (Branch A)
run('git checkout -b architect');
files.forEach(file => {
    fs.writeFileSync(path.join(DIR, file), generateFile('architect', file, 5));
});
run('git commit -am "Architect: Added arch_scale_system to 20 classes"');

// 5. FEATURE TEAM BRANCH (Branch B)
run('git checkout master');
files.forEach(file => {
    fs.writeFileSync(path.join(DIR, file), generateFile('feature', file, 5));
});
run('git commit -am "Feature: Added massive line noise and feat_add_analytics to 20 classes"');

console.log('\n======================================================');
console.log('✅ PROJECT LEVIATHAN ENVIRONMENT READY');
console.log('Navigate to demo-recording-leviathan/repo to start.');
console.log('======================================================\n');
