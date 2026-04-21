import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractLegacyCustomInstructions, recomposeLegacyTemplate } from './v1-migration.js';

const tempDirs: string[] = [];

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/**
 * Build a minimal v1-shaped project tree: the 6-section manifests plus the
 * YAML "base" template each manifest references. v2 no longer ships the
 * coworker manifest, so the test can't just copy v2's templates — it must
 * reconstruct the v1 layout locally.
 */
function makeLegacyProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-v1-migration-'));
  tempDirs.push(dir);

  const templates = path.join(dir, 'groups', 'templates');

  writeFile(
    path.join(templates, 'manifests', 'main.yaml'),
    ['base: upstream-main', 'sections: []', 'project_overlays: false', ''].join('\n'),
  );
  writeFile(
    path.join(templates, 'manifests', 'global.yaml'),
    ['base: upstream-global', 'sections: []', 'project_overlays: false', ''].join('\n'),
  );
  writeFile(
    path.join(templates, 'manifests', 'coworker.yaml'),
    ['base: upstream-global', 'sections: []', 'project_overlays: false', ''].join('\n'),
  );

  const baseFields = [
    'role: |',
    '  You are the reference v1 coworker.',
    'capabilities: |',
    '  - Reply to messages',
    'workflow: |',
    '  Do the task.',
    'constraints: |',
    '  Stay on topic.',
    'formatting: |',
    '  Plain text.',
    'resources: |',
    '  None.',
    '',
  ].join('\n');
  writeFile(path.join(templates, 'base', 'main.yaml'), baseFields);
  writeFile(path.join(templates, 'base', 'global.yaml'), baseFields);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v1 migration helpers', () => {
  it('reconstructs a v1 coworker from the 6-section manifest and extracts the custom tail', () => {
    // v1 always used the 6-section manifest path — no lego spine existed in
    // v1. We stand up a v1-shaped project manually (v2 no longer ships a
    // coworker manifest) and ask the recomposer to reproduce what v1 would
    // have written to that group's CLAUDE.md.
    const projectRoot = makeLegacyProject();

    const template = recomposeLegacyTemplate(projectRoot, { isMain: false, coworkerType: null });
    expect(template).not.toBeNull();
    expect(template).toContain('## Role');
    expect(template).toContain('## Capabilities');

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
    const projectRoot = makeLegacyProject();
    const template = recomposeLegacyTemplate(projectRoot, { isMain: true });

    expect(template).not.toBeNull();
    expect(extractLegacyCustomInstructions(template!, template!)).toBeNull();
  });
});
