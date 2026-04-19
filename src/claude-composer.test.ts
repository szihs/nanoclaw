import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeClaudeMd,
  readCoworkerTypes,
  readSkillCatalog,
  resolveCoworkerManifest,
  resolveTypeChain,
  type CoworkerTypeEntry,
} from './claude-composer.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-lego-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeSkill(projectRoot: string, dir: string, frontmatter: Record<string, unknown>, body = ''): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (typeof v === 'string') {
      lines.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [subk, subv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${subk}: ${JSON.stringify(subv)}`);
      }
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  writeFile(path.join(projectRoot, 'container', 'skills', dir, 'SKILL.md'), lines.join('\n') + '\n');
}

function writeTypes(projectRoot: string, dir: string, yamlBody: string): void {
  writeFile(path.join(projectRoot, 'container', 'skills', dir, 'coworker-types.yaml'), yamlBody);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Lego coworker CLAUDE.md composition', () => {
  describe('readCoworkerTypes', () => {
    it('discovers types from container/skills/*/coworker-types.yaml', () => {
      const root = makeTempProject();
      writeTypes(
        root,
        'base-spine',
        `
base-common:
  description: "Base spine"
`,
      );
      writeTypes(
        root,
        'slang-spine',
        `
slang-common:
  project: slang
  extends: base-common
  description: "Slang spine"
`,
      );

      const types = readCoworkerTypes(root);
      expect(Object.keys(types).sort()).toEqual(['base-common', 'slang-common']);
      expect(types['slang-common'].project).toBe('slang');
    });

    it('throws on duplicate type names across directories', () => {
      const root = makeTempProject();
      writeTypes(root, 'a', `dup:\n  description: "A"`);
      writeTypes(root, 'b', `dup:\n  description: "B"`);
      expect(() => readCoworkerTypes(root)).toThrow('Duplicate coworker type "dup"');
    });

    it('returns an empty registry when container/skills is missing', () => {
      const root = makeTempProject();
      expect(readCoworkerTypes(root)).toEqual({});
    });
  });

  describe('readSkillCatalog', () => {
    it('parses SKILL.md frontmatter including type, allowed-tools, and uses', () => {
      const root = makeTempProject();
      writeSkill(
        root,
        'alpha-workflow',
        {
          name: 'alpha',
          type: 'workflow',
          description: 'Alpha workflow.',
          'allowed-tools': 'Bash, Read, mcp__foo__bar, mcp__foo__baz',
          uses: { skills: ['beta'], workflows: [] },
        },
        '# body',
      );
      writeSkill(root, 'beta', {
        name: 'beta',
        description: 'Beta skill.',
        'allowed-tools': 'Read, mcp__foo__qux',
      });

      const catalog = readSkillCatalog(root);
      expect(Object.keys(catalog).sort()).toEqual(['alpha', 'beta']);
      expect(catalog.alpha.type).toBe('workflow');
      expect(catalog.beta.type).toBe('capability');
      expect(catalog.alpha.allowedTools.sort()).toEqual(['mcp__foo__bar', 'mcp__foo__baz']);
      expect(catalog.alpha.uses.skills).toEqual(['beta']);
    });

    it('throws on duplicate skill names', () => {
      const root = makeTempProject();
      writeSkill(root, 'one', { name: 'shared', description: 'first' });
      writeSkill(root, 'two', { name: 'shared', description: 'second' });
      expect(() => readSkillCatalog(root)).toThrow('Duplicate skill name "shared"');
    });
  });

  describe('resolveCoworkerManifest', () => {
    function setupBasic(root: string): void {
      writeFile(path.join(root, 'spine/safety.md'), 'Never ship without a test.\n');
      writeFile(path.join(root, 'spine/workspace.md'), 'Work under /workspace/group.\n');
      writeFile(path.join(root, 'spine/identity.md'), 'You are a Slang engineer.\n');

      writeSkill(root, 'base-nanoclaw', {
        name: 'base-nanoclaw',
        description: 'Host tools.',
        'allowed-tools': 'mcp__nanoclaw__send_message',
      });
      writeSkill(root, 'slang-build', {
        name: 'slang-build',
        description: 'Build Slang.',
        'allowed-tools': 'Bash, mcp__deepwiki__ask_question',
      });
      writeSkill(root, 'slang-triage-workflow', {
        name: 'slang-triage',
        type: 'workflow',
        description: 'Triage.',
        uses: { skills: ['slang-build'], workflows: [] },
        'allowed-tools': 'Read',
      });
      writeTypes(
        root,
        'base-spine',
        `
base-common:
  description: "Base spine"
  invariants:
    - spine/safety.md
  context:
    - spine/workspace.md
  skills:
    - base-nanoclaw
`,
      );
      writeTypes(
        root,
        'slang-spine',
        `
slang-common:
  project: slang
  extends: base-common
  description: "Slang spine"
  identity: spine/identity.md
  skills:
    - slang-build
slang-triage:
  project: slang
  extends: slang-common
  description: "Slang triage"
  workflows:
    - slang-triage
`,
      );
    }

    it('resolves leaf identity + appended invariants/context + skill+workflow index + derived tools', () => {
      const root = makeTempProject();
      setupBasic(root);

      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'slang-triage', catalog, root);

      expect(manifest.typeName).toBe('slang-triage');
      expect(manifest.title).toBe('Slang Triage');
      expect(manifest.identity).toBe('You are a Slang engineer.');
      expect(manifest.invariants).toEqual(['Never ship without a test.']);
      expect(manifest.context).toEqual(['Work under /workspace/group.']);
      expect(manifest.skills.map((s) => s.name).sort()).toEqual(['base-nanoclaw', 'slang-build']);
      expect(manifest.workflows.map((w) => w.name)).toEqual(['slang-triage']);
      expect(manifest.workflows[0].uses).toEqual(['slang-build']);
      expect(manifest.tools).toEqual(['mcp__deepwiki__ask_question', 'mcp__nanoclaw__send_message']);
    });

    it('rejects references to missing skills or workflows', () => {
      const root = makeTempProject();
      writeTypes(
        root,
        'base-spine',
        `
base-common:
  description: "base"
  workflows:
    - does-not-exist
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'base-common', catalog, root)).toThrow(
        /references unknown skill\/workflow: does-not-exist/,
      );
    });

    it('dedupes diamond inheritance across invariants and context fragments', () => {
      const root = makeTempProject();
      writeFile(path.join(root, 'spine/shared.md'), 'shared invariant');
      writeFile(path.join(root, 'spine/a.md'), 'alpha only');
      writeFile(path.join(root, 'spine/b.md'), 'beta only');

      writeTypes(
        root,
        'base-spine',
        `
base:
  description: "base"
  invariants: [spine/shared.md]
alpha:
  extends: base
  description: "alpha"
  invariants: [spine/a.md]
beta:
  extends: base
  description: "beta"
  invariants: [spine/b.md]
leaf:
  extends: [alpha, beta]
  description: "leaf"
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'leaf', catalog, root);

      // shared appears once (diamond dedup), alpha + beta appended in chain order.
      expect(manifest.invariants).toEqual(['shared invariant', 'alpha only', 'beta only']);
    });

    it('rejects cross-project extends', () => {
      const root = makeTempProject();
      writeTypes(
        root,
        'one',
        `
alpha:
  project: graphics
  description: "a"
beta:
  project: slang
  extends: alpha
  description: "b"
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'beta', catalog, root)).toThrow(/Cross-project extends/);
    });
  });

  describe('composeClaudeMd (typed coworker → spine)', () => {
    function setupSpineProject(): string {
      const root = makeTempProject();
      writeFile(path.join(root, 'spine/identity.md'), 'You are Stetson, a Slang triage specialist.');
      writeFile(path.join(root, 'spine/safety.md'), 'Do not silence failing tests.');
      writeFile(path.join(root, 'spine/layout.md'), 'Slang lives under source/slang/.');

      writeSkill(root, 'base-nanoclaw', {
        name: 'base-nanoclaw',
        description: 'Host tools.',
        'allowed-tools': 'mcp__nanoclaw__send_message',
      });
      writeSkill(root, 'slang-github', {
        name: 'slang-github',
        description: 'Fetch Slang issues.',
        'allowed-tools': 'Bash, mcp__slang-mcp__github_get_issue',
      });
      writeSkill(root, 'slang-triage-workflow', {
        name: 'slang-triage',
        type: 'workflow',
        description: 'Triage a Slang issue.',
        uses: { skills: ['slang-github'], workflows: [] },
      });

      writeTypes(
        root,
        'base-spine',
        `
base-common:
  description: "base"
  invariants:
    - spine/safety.md
  skills:
    - base-nanoclaw
`,
      );
      writeTypes(
        root,
        'slang-spine',
        `
slang-common:
  project: slang
  extends: base-common
  description: "slang spine"
  identity: spine/identity.md
  context:
    - spine/layout.md
  skills:
    - slang-github
slang-triage:
  project: slang
  extends: slang-common
  description: "triage"
  workflows:
    - slang-triage
`,
      );
      return root;
    }

    it('emits identity / invariants / context / workflows / skills sections', () => {
      const root = setupSpineProject();
      const out = composeClaudeMd({
        projectRoot: root,
        manifestName: 'coworker',
        coworkerType: 'slang-triage',
      });

      expect(out).toContain('# Slang Triage');
      expect(out).toContain('## Identity');
      expect(out).toContain('You are Stetson');
      expect(out).toContain('## Invariants');
      expect(out).toContain('Do not silence failing tests.');
      expect(out).toContain('## Context');
      expect(out).toContain('Slang lives under source/slang/.');
      expect(out).toContain('## Workflows Available');
      expect(out).toContain('- `/slang-triage` — Triage a Slang issue.');
      expect(out).toContain('Uses: slang-github.');
      expect(out).toContain('## Skills Available');
      expect(out).toContain('- `/base-nanoclaw` — Host tools.');
      expect(out).toContain('- `/slang-github` — Fetch Slang issues.');
      expect(out).toContain('Bodies load on demand.');

      // The 6-section headings must NOT appear — this is the spine model.
      expect(out).not.toContain('## Capabilities');
      expect(out).not.toContain('## Workflow\n');
      expect(out).not.toContain('## Resources');
    });

    it('appends Additional Instructions when supplied', () => {
      const root = setupSpineProject();
      const extra = '# Local override\n\nDo this specific thing.';
      const out = composeClaudeMd({
        projectRoot: root,
        manifestName: 'coworker',
        coworkerType: 'slang-triage',
        extraInstructions: extra,
      });
      expect(out).toContain('## Additional Instructions');
      expect(out).toContain('Do this specific thing.');
    });

    it('produces a bounded-length spine (no procedural bodies inlined)', () => {
      const root = setupSpineProject();
      const out = composeClaudeMd({
        projectRoot: root,
        manifestName: 'coworker',
        coworkerType: 'slang-triage',
      });
      // Spine should be a small document — well under 3kB for this fixture.
      expect(out.length).toBeLessThan(3000);
    });
  });

  describe('composeClaudeMd (legacy main/global path still works)', () => {
    it('reconstructs the checked-in main and global CLAUDE.md files for the current tree', () => {
      const generatedGlobal = composeClaudeMd({ projectRoot: process.cwd(), manifestName: 'global' });
      const generatedMain = composeClaudeMd({ projectRoot: process.cwd(), manifestName: 'main' });

      expect(generatedGlobal).toBe(fs.readFileSync(path.join(process.cwd(), 'groups', 'global', 'CLAUDE.md'), 'utf-8'));
      expect(generatedMain).toBe(fs.readFileSync(path.join(process.cwd(), 'groups', 'main', 'CLAUDE.md'), 'utf-8'));
    });
  });

  describe('resolveTypeChain', () => {
    it('stops inheritance walk on cycles', () => {
      const types: Record<string, CoworkerTypeEntry> = {
        alpha: { extends: ['beta'], description: 'a' },
        beta: { extends: ['alpha'], description: 'b' },
      };
      const chain = resolveTypeChain(types, 'alpha');
      expect(chain).toHaveLength(2);
    });
  });

  describe('traits, bindings, overrides, overlays', () => {
    function setupTraitProject(): string {
      const root = makeTempProject();
      writeFile(path.join(root, 'spine/identity.md'), 'You are a trait-composed coworker.');
      writeFile(path.join(root, 'spine/safety.md'), 'Never delete tests.');

      writeSkill(root, 'repo-skill', {
        name: 'repo-skill',
        description: 'Git + PRs.',
        provides: ['vcs-pr', 'issue-tracker'],
        'allowed-tools': 'Bash(git:*), mcp__foo__gh',
      });
      writeSkill(root, 'edit-skill', {
        name: 'edit-skill',
        description: 'Edit code.',
        provides: ['code-edit'],
        'allowed-tools': 'Read, Edit',
      });
      writeSkill(root, 'explore-skill', {
        name: 'explore-skill',
        description: 'Read code.',
        provides: ['code-read'],
        'allowed-tools': 'Grep, Glob',
      });
      writeSkill(root, 'runner-skill', {
        name: 'runner-skill',
        description: 'Run tests.',
        provides: ['test-run'],
        'allowed-tools': 'Bash',
      });
      writeSkill(root, 'critic-skill', {
        name: 'critic-skill',
        description: 'External critique.',
        provides: ['critique'],
        'allowed-tools': 'mcp__codex__review',
      });

      writeSkill(
        root,
        'base-fix-workflow',
        {
          name: 'base-fix',
          type: 'workflow',
          description: 'Base fix.',
          requires: ['vcs-pr', 'code-edit', 'code-read', 'test-run'],
          uses: { skills: [], workflows: [] },
        },
        [
          '## Steps',
          '',
          '1. **Reproduce** {#reproduce} — make it fail.',
          '2. **Patch** {#patch} — minimal change.',
          '3. **Commit** {#commit} — ship it.',
          '',
        ].join('\n'),
      );
      writeSkill(
        root,
        'crit-overlay',
        {
          name: 'crit-overlay',
          type: 'overlay',
          description: 'Insert a critique after patch-like steps.',
          'applies-to': { workflows: ['base-fix'], traits: ['code-edit'] },
          'insert-after': ['patch'],
        },
        '**Critique** — run /critic-skill and block on must-fix.',
      );
      return root;
    }

    it('validates traits: directly-provided skills satisfy `requires` without an explicit binding', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
basic:
  description: "direct-provides"
  identity: spine/identity.md
  invariants: [spine/safety.md]
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
  workflows:
    - base-fix
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'basic', catalog, root);

      expect(manifest.bindings['vcs-pr']).toBe('repo-skill');
      expect(manifest.bindings['code-edit']).toBe('edit-skill');
      expect(manifest.bindings['code-read']).toBe('explore-skill');
      expect(manifest.bindings['test-run']).toBe('runner-skill');
      expect(manifest.workflows[0].requires).toEqual(['vcs-pr', 'code-edit', 'code-read', 'test-run']);
    });

    it('errors when a required trait has no binding and no provider in the skill set', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
broken:
  description: "missing code-edit"
  skills:
    - repo-skill
    - explore-skill
    - runner-skill
  workflows:
    - base-fix
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'broken', catalog, root)).toThrow(
        /requires trait\(s\) with no binding: code-edit/,
      );
    });

    it('errors when a binding points at a skill that does not declare provides for that trait', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
misbound:
  description: "wrong mapping"
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
  workflows:
    - base-fix
  bindings:
    code-edit: runner-skill
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'misbound', catalog, root)).toThrow(
        /does not declare `provides: \[code-edit\]`/,
      );
    });

    it('overlay (applies-to.workflows) emits a customization line and derives its tools', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
with-overlay:
  description: "fix + critique"
  identity: spine/identity.md
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
    - critic-skill
  workflows:
    - base-fix
  overlays:
    - crit-overlay
  bindings:
    critique: critic-skill
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'with-overlay', catalog, root);

      const overlayCust = manifest.customizations.find((c) => c.kind === 'overlay');
      expect(overlayCust).toBeDefined();
      expect(overlayCust!.workflow).toBe('base-fix');
      expect(overlayCust!.summary).toContain('after step `patch`');
      expect(manifest.tools).toContain('mcp__codex__review');
    });

    it('renders Trait Bindings and Workflow Customizations into the spine markdown', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
render-check:
  description: "render"
  identity: spine/identity.md
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
    - critic-skill
  workflows:
    - base-fix
  overlays:
    - crit-overlay
  bindings:
    critique: critic-skill
`,
      );
      const out = composeClaudeMd({ projectRoot: root, manifestName: 'coworker', coworkerType: 'render-check' });

      expect(out).toContain('## Trait Bindings');
      expect(out).toContain('`vcs-pr` → `/repo-skill`');
      expect(out).toContain('## Workflow Customizations');
      expect(out).toContain('`/base-fix` is augmented by `crit-overlay` after step `patch`.');
    });

    it('extends + overrides are surfaced as customizations on the derived workflow', () => {
      const root = setupTraitProject();
      writeSkill(
        root,
        'slang-patch-workflow',
        {
          name: 'slang-patch',
          type: 'workflow',
          description: 'Slang-specific fix.',
          extends: 'base-fix',
          requires: ['vcs-pr', 'code-edit', 'code-read', 'test-run'],
          uses: { skills: [], workflows: ['base-fix'] },
          overrides: { patch: 'Run slang-specific code formatter before committing.' },
        },
        '# Slang Patch\n',
      );
      writeTypes(
        root,
        'spine',
        `
slang-fix:
  description: "slang"
  identity: spine/identity.md
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
  workflows:
    - slang-patch
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'slang-fix', catalog, root);

      const kinds = manifest.customizations.map((c) => c.kind).sort();
      expect(kinds).toContain('extends');
      expect(kinds).toContain('override');

      const extendsCust = manifest.customizations.find((c) => c.kind === 'extends');
      expect(extendsCust!.summary).toContain('`/slang-patch` extends `/base-fix`');
      const overrideCust = manifest.customizations.find((c) => c.kind === 'override');
      expect(overrideCust!.summary).toContain('step `patch` is overridden');
      expect(overrideCust!.detail).toContain('slang-specific code formatter');
    });

    it('bindings in an ancestor type are inherited by descendants (leaf wins on conflict)', () => {
      const root = setupTraitProject();
      writeSkill(root, 'patched-edit', {
        name: 'patched-edit',
        description: 'Specialized edit.',
        provides: ['code-edit'],
        'allowed-tools': 'Read, Edit',
      });
      writeTypes(
        root,
        'spine',
        `
parent:
  description: "parent"
  identity: spine/identity.md
  skills:
    - repo-skill
    - edit-skill
    - explore-skill
    - runner-skill
  bindings:
    code-edit: edit-skill
child:
  extends: parent
  description: "child"
  skills:
    - patched-edit
  bindings:
    code-edit: patched-edit
  workflows:
    - base-fix
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'child', catalog, root);
      expect(manifest.bindings['code-edit']).toBe('patched-edit');
    });
  });
});
