import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeClaudeMd,
  readCoworkerTypes,
  resolveTypeChain,
  resolveTypeFields,
  type CoworkerTypeEntry,
} from './claude-composer.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-compose-'));
  tempDirs.push(dir);

  fs.mkdirSync(path.join(dir, 'groups', 'templates'), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'groups', 'templates'), path.join(dir, 'groups', 'templates'), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(process.cwd(), 'groups', 'coworker-types.json'),
    path.join(dir, 'groups', 'coworker-types.json'),
  );
  return dir;
}

function writeYaml(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents.trim()}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLAUDE.md composition', () => {
  it('reconstructs the checked-in global and main CLAUDE.md files for the current tree', () => {
    const generatedGlobal = composeClaudeMd({ projectRoot: process.cwd(), manifestName: 'global' });
    const generatedMain = composeClaudeMd({ projectRoot: process.cwd(), manifestName: 'main' });

    expect(generatedGlobal).toBe(fs.readFileSync(path.join(process.cwd(), 'groups', 'global', 'CLAUDE.md'), 'utf-8'));
    expect(generatedMain).toBe(fs.readFileSync(path.join(process.cwd(), 'groups', 'main', 'CLAUDE.md'), 'utf-8'));
  });

  it('skips sections that remain empty after composition', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base role.
workflow: |
  Base workflow.
`,
    );
    fs.rmSync(path.join(projectRoot, 'groups', 'templates', 'projects'), { recursive: true, force: true });

    const generated = composeClaudeMd({ projectRoot, manifestName: 'global' });

    expect(generated).toContain('# Global');
    expect(generated).toContain('## Role');
    expect(generated).toContain('## Workflow');
    expect(generated).not.toContain('## Capabilities');
    expect(generated).not.toContain('## Constraints');
    expect(generated).not.toContain('## Formatting');
    expect(generated).not.toContain('## Resources');
  });

  it('merges project sections and manifest overlays into named sections instead of appending raw trailing blocks', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'main.yaml'),
      `
role: |
  Base role.
capabilities: |
  Base capabilities.
workflow: |
  Base workflow.
constraints: |
  Base constraints.
formatting: |
  Base formatting.
resources: |
  Base resources.
`,
    );
    const dashboardDir = path.join(projectRoot, 'groups', 'templates', 'projects', 'dashboard');
    const slangDir = path.join(projectRoot, 'groups', 'templates', 'projects', 'slang');
    writeYaml(
      path.join(dashboardDir, 'formatting.yaml'),
      `
formatting: |
  Dashboard formatting.
`,
    );
    writeYaml(
      path.join(slangDir, 'main-overlay.yaml'),
      `
capabilities: |
  Slang capabilities.
workflow: |
  Slang workflow.
resources: |
  Slang resources.
`,
    );

    const generated = composeClaudeMd({ projectRoot, manifestName: 'main' });

    expect(generated).toBe(
      [
        '# Main',
        '',
        '## Role',
        '',
        'Base role.',
        '',
        '## Capabilities',
        '',
        'Base capabilities.',
        '',
        'Slang capabilities.',
        '',
        '## Workflow',
        '',
        'Base workflow.',
        '',
        'Slang workflow.',
        '',
        '## Constraints',
        '',
        'Base constraints.',
        '',
        '## Formatting',
        '',
        'Base formatting.',
        '',
        'Dashboard formatting.',
        '',
        '## Resources',
        '',
        'Base resources.',
        '',
        'Slang resources.',
        '',
      ].join('\n'),
    );
  });

  it('applies project shared section files to every composed manifest', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Global role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'main.yaml'),
      `
role: |
  Main role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'projects', 'dashboard', 'formatting.yaml'),
      `
formatting: |
  Dashboard formatting.
`,
    );

    const generatedGlobal = composeClaudeMd({ projectRoot, manifestName: 'global' });
    const generatedMain = composeClaudeMd({ projectRoot, manifestName: 'main' });

    expect(generatedGlobal).toContain('Dashboard formatting.');
    expect(generatedMain).toContain('Dashboard formatting.');
  });

  it('rejects template-level extends as an unknown key', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
extends: some-other.yaml
role: |
  Base role.
`,
    );

    expect(() => composeClaudeMd({ projectRoot, manifestName: 'global' })).toThrow(
      'Unknown prompt template key "extends"',
    );
  });

  it('rejects prompt template keys outside the six supported sections', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
title: Global
role: |
  Base role.
`,
    );

    expect(() => composeClaudeMd({ projectRoot, manifestName: 'global' })).toThrow(
      'Unknown prompt template key "title"',
    );
  });

  it('supports multi-parent coworker inheritance and dedupes repeated ancestors', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'sections', 'coworker-extensions.yaml'),
      `
workflow: |
  Shared coworker workflow.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'foundation-role.yaml'),
      `
capabilities: |
  Common capabilities.
workflow: |
  Foundation workflow.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'review-role.yaml'),
      `
capabilities: |
  Common capabilities.
constraints: |
  Review constraints.
`,
    );
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'leaf-role.yaml'),
      `
role: |
  Leaf role.
`,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'groups', 'coworker-types.json'),
      JSON.stringify(
        {
          foundation: {
            template: 'groups/templates/foundation-role.yaml',
            focusFiles: ['a.cpp'],
            allowedMcpTools: ['mcp__tool__common'],
          },
          reviewer: {
            extends: 'foundation',
            template: 'groups/templates/review-role.yaml',
            focusFiles: ['b.cpp'],
            allowedMcpTools: ['mcp__tool__review'],
          },
          specialist: {
            extends: ['foundation', 'reviewer'],
            template: 'groups/templates/leaf-role.yaml',
            focusFiles: ['a.cpp', 'c.cpp'],
            allowedMcpTools: ['mcp__tool__common', 'mcp__tool__leaf'],
          },
        },
        null,
        2,
      ),
    );

    const generated = composeClaudeMd({ projectRoot, manifestName: 'coworker', coworkerType: 'specialist' });
    const types = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'groups', 'coworker-types.json'), 'utf-8'),
    ) as Record<string, CoworkerTypeEntry>;
    const resolved = resolveTypeFields(types, 'specialist');

    expect(generated).toContain('# Leaf Role');
    expect(generated).toContain('Common capabilities.');
    expect(generated).toContain('Foundation workflow.');
    expect(generated).toContain('Review constraints.');
    expect(generated).toContain('Leaf role.');
    expect(resolved.templates).toEqual([
      'groups/templates/foundation-role.yaml',
      'groups/templates/review-role.yaml',
      'groups/templates/leaf-role.yaml',
    ]);
    expect(resolved.focusFiles).toEqual(['a.cpp', 'b.cpp', 'c.cpp']);
    expect(resolved.allowedMcpTools).toEqual(['mcp__tool__common', 'mcp__tool__review', 'mcp__tool__leaf']);
  });

  it('stops inheritance walk on cycles instead of looping forever', () => {
    const types: Record<string, CoworkerTypeEntry> = {
      alpha: { extends: ['beta'], template: 'alpha.yaml' },
      beta: { extends: ['alpha'], template: 'beta.yaml' },
    };

    const chain = resolveTypeChain(types, 'alpha');
    expect(chain).toHaveLength(2);

    const resolved = resolveTypeFields(types, 'alpha');
    expect(resolved.templates).toEqual(['beta.yaml', 'alpha.yaml']);
  });

  it('discovers coworker types from distributed YAML files in container/skills/', () => {
    const projectRoot = makeTempProject();
    // Remove legacy JSON
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'coworker-types.yaml'),
      `
base-build:
  description: "Build system"
  template: container/skills/base-templates/templates/base-build.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'coworker-types.yaml'),
      `
slang-build:
  project: slang
  extends: base-build
  description: "Slang build"
  template: container/skills/slang-templates/templates/slang-setup.yaml
  focusFiles: [CMakeLists.txt]
`,
    );

    const types = readCoworkerTypes(projectRoot);
    expect(Object.keys(types)).toEqual(['base-build', 'slang-build']);
    expect(types['slang-build'].project).toBe('slang');
    expect(types['base-build'].project).toBeUndefined();
  });

  it('throws on duplicate type names across YAML files', () => {
    const projectRoot = makeTempProject();
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'alpha', 'coworker-types.yaml'),
      `
duplicate-type:
  description: "First"
  template: a.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'beta', 'coworker-types.yaml'),
      `
duplicate-type:
  description: "Second"
  template: b.yaml
`,
    );

    expect(() => readCoworkerTypes(projectRoot)).toThrow('Duplicate coworker type "duplicate-type"');
  });

  it('throws on cross-project extends', () => {
    const projectRoot = makeTempProject();
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'coworker-types.yaml'),
      `
base-build:
  description: "Build"
  template: container/skills/base-templates/templates/base-build.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'templates', 'base-build.yaml'),
      `
role: |
  Base build role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'coworker-types.yaml'),
      `
slang-quality:
  project: slang
  description: "Slang quality"
  template: container/skills/slang-templates/templates/quality.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'quality.yaml'),
      `
role: |
  Slang quality.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'gfx-templates', 'coworker-types.yaml'),
      `
gfx-test:
  project: graphics
  extends: slang-quality
  description: "Graphics test"
  template: container/skills/gfx-templates/templates/test.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'gfx-templates', 'templates', 'test.yaml'),
      `
role: |
  Graphics test.
`,
    );

    expect(() => composeClaudeMd({ projectRoot, manifestName: 'coworker', coworkerType: 'gfx-test' })).toThrow(
      'Cross-project extends',
    );
  });

  it('allows project types to extend base types (no project)', () => {
    const projectRoot = makeTempProject();
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'coworker-types.yaml'),
      `
base-build:
  description: "Build"
  template: container/skills/base-templates/templates/base-build.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'templates', 'base-build.yaml'),
      `
capabilities: |
  Build capabilities from base.
workflow: |
  Build workflow from base.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'coworker-types.yaml'),
      `
slang-build:
  project: slang
  extends: base-build
  description: "Slang build"
  template: container/skills/slang-templates/templates/slang-build.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'slang-build.yaml'),
      `
role: |
  Slang build specialist.
capabilities: |
  Slang-specific build capabilities.
`,
    );

    const generated = composeClaudeMd({ projectRoot, manifestName: 'coworker', coworkerType: 'slang-build' });

    // Role is leaf-only: only slang-build's role appears
    expect(generated).toContain('Slang build specialist.');
    // Capabilities append: base then slang
    expect(generated).toContain('Build capabilities from base.');
    expect(generated).toContain('Slang-specific build capabilities.');
    // Workflow from base appears
    expect(generated).toContain('Build workflow from base.');
  });

  it('applies leaf-only merge for role section in type chains', () => {
    const projectRoot = makeTempProject();
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Global base.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'coworker-types.yaml'),
      `
base-understand:
  description: "Understand"
  template: container/skills/base-templates/templates/understand.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'templates', 'understand.yaml'),
      `
role: |
  You analyze problems.
capabilities: |
  Problem analysis capabilities.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'coworker-types.yaml'),
      `
slang-triage:
  project: slang
  extends: base-understand
  description: "Triage"
  template: container/skills/slang-templates/templates/triage.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'triage.yaml'),
      `
role: |
  You triage Slang issues.
capabilities: |
  Slang triage capabilities.
`,
    );

    const generated = composeClaudeMd({ projectRoot, manifestName: 'coworker', coworkerType: 'slang-triage' });

    // Role: leaf-only — only slang-triage's role, NOT base-understand's
    expect(generated).toContain('You triage Slang issues.');
    expect(generated).not.toContain('You analyze problems.');
    // Capabilities: append — both appear
    expect(generated).toContain('Problem analysis capabilities.');
    expect(generated).toContain('Slang triage capabilities.');
  });

  it('deduplicates diamond inheritance (base-build via two paths)', () => {
    const projectRoot = makeTempProject();
    fs.rmSync(path.join(projectRoot, 'groups', 'coworker-types.json'));

    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'coworker-types.yaml'),
      `
base-build:
  description: "Build"
  template: container/skills/base-templates/templates/build.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'base-templates', 'templates', 'build.yaml'),
      `
capabilities: |
  Base build capabilities.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'coworker-types.yaml'),
      `
slang-build:
  project: slang
  extends: base-build
  description: "Slang build"
  template: container/skills/slang-templates/templates/build.yaml
slang-compiler:
  project: slang
  extends: slang-build
  description: "Compiler"
  template: container/skills/slang-templates/templates/compiler.yaml
slang-language:
  project: slang
  extends: slang-build
  description: "Language"
  template: container/skills/slang-templates/templates/language.yaml
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'build.yaml'),
      `
capabilities: |
  Slang build capabilities.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'compiler.yaml'),
      `
role: |
  Compiler specialist.
capabilities: |
  Compiler capabilities.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'language.yaml'),
      `
role: |
  Language specialist.
capabilities: |
  Language capabilities.
`,
    );

    const generated = composeClaudeMd({
      projectRoot,
      manifestName: 'coworker',
      coworkerType: 'slang-compiler+slang-language',
    });

    // Base build appears only once (diamond dedup)
    expect(generated.match(/Base build capabilities\./g)).toHaveLength(1);
    // Slang build appears only once
    expect(generated.match(/Slang build capabilities\./g)).toHaveLength(1);
    // Both leaf capabilities appear
    expect(generated).toContain('Compiler capabilities.');
    expect(generated).toContain('Language capabilities.');
    // Role is leaf-only: last template wins
    expect(generated).toContain('Language specialist.');
  });

  it('falls back to legacy JSON when no YAML files exist', () => {
    const projectRoot = makeTempProject();
    // Keep JSON, ensure no container/skills/ dir with YAML
    fs.rmSync(path.join(projectRoot, 'container'), { recursive: true, force: true });

    const types = readCoworkerTypes(projectRoot);
    // Should load from JSON — check that slang-build exists
    expect(types['slang-build']).toBeDefined();
  });

  it('preserves full extra instructions when workflow templates are used', () => {
    const projectRoot = makeTempProject();
    writeYaml(
      path.join(projectRoot, 'groups', 'templates', 'base', 'global.yaml'),
      `
role: |
  Base role.
`,
    );
    writeYaml(
      path.join(projectRoot, 'container', 'skills', 'slang-templates', 'templates', 'fix-workflow.yaml'),
      `
workflow: |
  Shared issue workflow.
constraints: |
  Fix constraints.
`,
    );
    fs.writeFileSync(
      path.join(projectRoot, 'groups', 'coworker-types.json'),
      JSON.stringify(
        {
          base: {
            template: 'groups/templates/base/global.yaml',
          },
          fixer: {
            extends: 'base',
            template: 'container/skills/slang-templates/templates/fix-workflow.yaml',
          },
        },
        null,
        2,
      ),
    );

    const extraInstructions = ['# Original Export', '', 'Keep every line from the export body.'].join('\n');
    const generated = composeClaudeMd({
      projectRoot,
      manifestName: 'coworker',
      coworkerType: 'fixer',
      extraInstructions,
    });

    expect(generated).toContain('Shared issue workflow.');
    expect(generated).toContain('Fix constraints.');
    expect(generated).toContain('### Additional Instructions');
    expect(generated).toContain(extraInstructions);
  });
});
