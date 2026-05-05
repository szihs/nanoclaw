import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { composeCoworkerSpine } from '../src/claude-composer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const checkMode = process.argv.includes('--check');

const targets: { rel: string; coworkerType: string }[] = [
  { rel: 'groups/global/CLAUDE.md', coworkerType: 'global' },
  { rel: 'groups/main/CLAUDE.md', coworkerType: 'main' },
];

let drift = 0;
for (const { rel, coworkerType } of targets) {
  const composed = composeCoworkerSpine({ projectRoot, coworkerType });
  const filePath = path.join(projectRoot, rel);
  if (checkMode) {
    const onDisk = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    if (onDisk !== composed) {
      drift++;
      console.error(`drift ${rel}: on-disk differs from composed output`);
    } else {
      console.log(`ok    ${rel}`);
    }
  } else {
    fs.writeFileSync(filePath, composed);
    console.log(`updated ${rel}`);
  }
}

if (checkMode && drift > 0) {
  console.error(`\n${drift} file(s) drifted. Run 'npm run rebuild:claude' to refresh.`);
  process.exit(1);
}
