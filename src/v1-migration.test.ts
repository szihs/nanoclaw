import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractLegacyCustomInstructions, recomposeLegacyTemplate } from './v1-migration.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-v1-migration-'));
  tempDirs.push(dir);

  fs.mkdirSync(path.join(dir, 'groups', 'templates'), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'groups', 'templates'), path.join(dir, 'groups', 'templates'), {
    recursive: true,
  });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v1 migration helpers', () => {
  it('reconstructs a typed coworker from the lego spine and extracts only the legacy custom tail', () => {
    const projectRoot = makeTempProject();

    // Wire up a minimal lego registry for type "leaf": one spine identity
    // fragment + one capability skill. This mirrors the real container/skills/
    // layout that readCoworkerTypes + readSkillCatalog scan.
    const legoDir = path.join(projectRoot, 'container', 'skills', 'leaf-spine');
    fs.mkdirSync(legoDir, { recursive: true });
    fs.writeFileSync(
      path.join(legoDir, 'identity.md'),
      'You are Leaf Role, the reference coworker for the migration test.',
    );
    fs.writeFileSync(
      path.join(legoDir, 'coworker-types.yaml'),
      [
        'leaf:',
        '  identity: container/skills/leaf-spine/identity.md',
        '  skills: [leaf-cap]',
        '',
      ].join('\n'),
    );
    const capDir = path.join(projectRoot, 'container', 'skills', 'leaf-cap');
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(
      path.join(capDir, 'SKILL.md'),
      ['---', 'name: leaf-cap', 'description: Leaf capability.', '---', '', '# Leaf cap body', ''].join('\n'),
    );

    const template = recomposeLegacyTemplate(projectRoot, { isMain: false, coworkerType: 'leaf' });
    expect(template).not.toBeNull();
    expect(template).toContain('# Leaf');
    expect(template).toContain('## Identity');
    expect(template).toContain('Leaf Role, the reference coworker');
    expect(template).toContain('## Skills Available');

    const legacyCustomTail = [
      '### Legacy custom instructions',
      '',
      '- Keep this raw markdown block intact',
      '- Do not force it into the spine sections during export',
    ].join('\n');

    const actualClaudeMd = `${template!.trimEnd()}\n\n---\n\n${legacyCustomTail}\n`;
    const extracted = extractLegacyCustomInstructions(actualClaudeMd, template!);

    expect(extracted).toBe(legacyCustomTail);
  });

  it('returns null when there is no custom legacy tail beyond the composed template', () => {
    const projectRoot = makeTempProject();
    const template = recomposeLegacyTemplate(projectRoot, { isMain: true });

    expect(template).not.toBeNull();
    expect(extractLegacyCustomInstructions(template!, template!)).toBeNull();
  });
});
