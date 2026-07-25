import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitHooksPath = path.resolve(__dirname, '../.git/hooks');
const prePushPath = path.join(gitHooksPath, 'pre-push');

const hookContent = `#!/bin/sh
echo "🔍 Running Hivecode Semantic Drift Scan..."
node packages/git-clash/cli.mjs --scan --base=main --head=HEAD
if [ $? -ne 0 ]; then
  echo "❌ Push aborted: Semantic drift detected."
  exit 1
fi
`;

if (fs.existsSync(gitHooksPath)) {
  fs.writeFileSync(prePushPath, hookContent, { mode: 0o755 });
  console.log('? Installed Hivecode pre-push hook');
} else {
  console.log('?? .git/hooks directory not found. Skipping hook installation.');
}

