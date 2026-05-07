/**
 * One-shot migration: legacy 6-section coworker templates → lego model.
 *
 * This script is idempotent (safe to re-run). For each group folder under
 * groups/<folder>/ whose agent is a typed coworker, it regenerates the
 * CLAUDE.md by composing a thin spine from container/skills/*.
 *
 * Untyped coworker CLAUDE.md files are left as-is (they already track
 * .instructions.md under the legacy path).
 *
 * Run:
 *   npx tsx scripts/migrate-to-lego-templates.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { composeCoworkerSpine, readCoworkerTypes } from '../src/claude-composer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function readInstructions(groupDir: string): string | null {
  const p = path.join(groupDir, '.instructions.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function regenerateGroup(folder: string, coworkerType: string): void {
  const groupDir = path.join(projectRoot, 'groups', folder);
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupDir)) {
    console.log(`skip ${folder} — group directory missing`);
    return;
  }
  const composed = composeCoworkerSpine({
    projectRoot,
    coworkerType,
    extraInstructions: readInstructions(groupDir),
  });
  fs.writeFileSync(claudeMd, composed);
  console.log(`regenerated ${path.relative(projectRoot, claudeMd)} (type: ${coworkerType})`);
}

function main(): void {
  const types = readCoworkerTypes(projectRoot);
  console.log(`Loaded ${Object.keys(types).length} coworker types: ${Object.keys(types).sort().join(', ')}`);

  const groupsDir = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsDir)) {
    console.log('No groups/ dir — nothing to migrate.');
    return;
  }

  // We don't have DB access here; migrate by scanning exported coworkers for
  // the (folder → coworkerType) mapping. Each coworkers/*.yaml bundle carries
  // agent.folder and agent.coworkerType.
  const coworkersDir = path.join(projectRoot, 'coworkers');
  const mapping: { folder: string; coworkerType: string }[] = [];
  if (fs.existsSync(coworkersDir)) {
    for (const name of fs.readdirSync(coworkersDir)) {
      if (!name.endsWith('.yaml')) continue;
      const body = fs.readFileSync(path.join(coworkersDir, name), 'utf-8');
      const folderMatch = body.match(/^\s*folder:\s*(\S+)/m);
      const typeMatch = body.match(/^\s*coworkerType:\s*(\S+)/m);
      if (folderMatch && typeMatch && typeMatch[1] !== 'null') {
        mapping.push({ folder: folderMatch[1], coworkerType: typeMatch[1] });
      }
    }
  }

  if (mapping.length === 0) {
    console.log('No typed coworker exports found under coworkers/. Nothing to regenerate.');
    return;
  }

  for (const { folder, coworkerType } of mapping) {
    try {
      regenerateGroup(folder, coworkerType);
    } catch (err) {
      console.error(`failed ${folder}: ${(err as Error).message}`);
    }
  }
}

main();
