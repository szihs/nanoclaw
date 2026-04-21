import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { composeCoworkerSpine } from '../src/claude-composer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function write(relativePath: string, contents: string): void {
  const filePath = path.join(projectRoot, relativePath);
  fs.writeFileSync(filePath, contents);
  console.log(`updated ${relativePath}`);
}

write(
  'groups/global/CLAUDE.md',
  composeCoworkerSpine({
    projectRoot,
    coworkerType: 'global',
  }),
);

write(
  'groups/main/CLAUDE.md',
  composeCoworkerSpine({
    projectRoot,
    coworkerType: 'main',
  }),
);
