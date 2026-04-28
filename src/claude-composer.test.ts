import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeCoworkerSpine,
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
        'spine-base',
        `
base-common:
  description: "Base spine"
`,
      );
      writeTypes(
        root,
        'spine-slang',
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

    it('merges duplicate type names across directories — arrays union, leaf scalars win', () => {
      // Additive skills (e.g. dashboard-base) contribute `context:` to an
      // existing type (main/global) without owning it. Discovery order is
      // alphabetical by skill dir — "b" wins scalar conflicts over "a".
      const root = makeTempProject();
      writeTypes(
        root,
        'a',
        `dup:\n  description: "A"\n  flat: true\n  identity: spine/a-id.md\n  context:\n    - spine/a-ctx.md\n`,
      );
      writeTypes(root, 'b', `dup:\n  description: "B"\n  context:\n    - spine/b-ctx.md\n`);

      const types = readCoworkerTypes(root);
      expect(types.dup.description).toBe('B');
      expect(types.dup.flat).toBe(true);
      expect(types.dup.identity).toBe('spine/a-id.md');
      expect(types.dup.context).toEqual(['spine/a-ctx.md', 'spine/b-ctx.md']);
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
        'spine-base',
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
        'spine-slang',
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
        'spine-base',
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
        'spine-base',
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

  describe('composeCoworkerSpine', () => {
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
        'spine-base',
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
        'spine-slang',
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
      const out = composeCoworkerSpine({
        projectRoot: root,
        coworkerType: 'slang-triage',
      });

      expect(out).toContain('# Slang Triage');
      expect(out).toContain('## Identity');
      expect(out).toContain('You are Stetson');
      expect(out).toContain('## Invariants');
      expect(out).toContain('Do not silence failing tests.');
      expect(out).toContain('## Context');
      expect(out).toContain('Slang lives under source/slang/.');
      expect(out).toContain('## Workflows');
      expect(out).toContain('### /slang-triage');
      expect(out).toContain('Triage a Slang issue.');
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
      const out = composeCoworkerSpine({
        projectRoot: root,
        coworkerType: 'slang-triage',
        extraInstructions: extra,
      });
      expect(out).toContain('## Additional Instructions');
      expect(out).toContain('Do this specific thing.');
    });

    it('produces a bounded-length spine (no procedural bodies inlined)', () => {
      const root = setupSpineProject();
      const out = composeCoworkerSpine({
        projectRoot: root,
        coworkerType: 'slang-triage',
      });
      // Spine should be a small document — well under 3kB for this fixture.
      expect(out.length).toBeLessThan(3000);
    });
  });

  describe('flat mode (main/global upstream parity)', () => {
    // Pin the invariant: with ONLY nanoclaw-base installed, main and global
    // CLAUDE.md equal upstream/v2 byte-for-byte. The fixture files are
    // checked-in captures of the upstream repo's main/global prompts.
    it('emits upstream main/global verbatim when only nanoclaw-base is in container/skills', () => {
      const root = makeTempProject();

      const mainFixture = fs.readFileSync(path.join(process.cwd(), 'test-fixtures', 'upstream-v2', 'main.md'), 'utf-8');
      const globalFixture = fs.readFileSync(
        path.join(process.cwd(), 'test-fixtures', 'upstream-v2', 'global.md'),
        'utf-8',
      );

      writeFile(path.join(root, 'container/skills/nanoclaw-base/prompts/main-body.md'), mainFixture);
      writeFile(path.join(root, 'container/skills/nanoclaw-base/prompts/global-body.md'), globalFixture);
      writeTypes(
        root,
        'nanoclaw-base',
        `
main:
  flat: true
  description: "upstream main"
  identity: container/skills/nanoclaw-base/prompts/main-body.md
global:
  flat: true
  description: "upstream global"
  identity: container/skills/nanoclaw-base/prompts/global-body.md
`,
      );

      expect(composeCoworkerSpine({ projectRoot: root, coworkerType: 'main' })).toBe(mainFixture);
      expect(composeCoworkerSpine({ projectRoot: root, coworkerType: 'global' })).toBe(globalFixture);
    });

    it('appends additive context fragments under --- when addon skills contribute to the same type', () => {
      // Two skills both declare `main`: the base owns identity, the addon
      // contributes context. Expect identity body + `\n\n---\n\n` + addon body.
      const root = makeTempProject();
      writeFile(path.join(root, 'container/skills/nanoclaw-base/prompts/main-body.md'), '# Main\n\nHello.\n');
      writeFile(
        path.join(root, 'container/skills/dashboard-base/prompts/formatting.md'),
        '### Dashboard\n\nMarkdown.\n',
      );
      writeTypes(
        root,
        'nanoclaw-base',
        `main:\n  flat: true\n  description: "base"\n  identity: container/skills/nanoclaw-base/prompts/main-body.md\n`,
      );
      writeTypes(
        root,
        'dashboard-base',
        `main:\n  context:\n    - container/skills/dashboard-base/prompts/formatting.md\n`,
      );
      const out = composeCoworkerSpine({ projectRoot: root, coworkerType: 'main' });
      expect(out).toBe('# Main\n\nHello.\n\n---\n\n### Dashboard\n\nMarkdown.\n');
    });

    it('suppresses structured sections and auto-title in flat mode', () => {
      const root = makeTempProject();
      writeFile(path.join(root, 'container/skills/nanoclaw-base/prompts/main-body.md'), '# Main\n\nBody only.\n');
      writeTypes(
        root,
        'nanoclaw-base',
        `main:\n  flat: true\n  description: "base"\n  identity: container/skills/nanoclaw-base/prompts/main-body.md\n`,
      );
      const out = composeCoworkerSpine({ projectRoot: root, coworkerType: 'main' });
      expect(out).not.toContain('## Identity');
      expect(out).not.toContain('## Invariants');
      expect(out).not.toContain('## Workflows');
      expect(out).not.toContain('Bodies load on demand.');
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
        provides: ['repo.pr', 'issues.read'],
        'allowed-tools': 'Bash(git:*), mcp__foo__gh',
      });
      writeSkill(root, 'edit-skill', {
        name: 'edit-skill',
        description: 'Edit code.',
        provides: ['code.edit'],
        'allowed-tools': 'Read, Edit',
      });
      writeSkill(root, 'explore-skill', {
        name: 'explore-skill',
        description: 'Read code.',
        provides: ['code.read'],
        'allowed-tools': 'Grep, Glob',
      });
      writeSkill(root, 'runner-skill', {
        name: 'runner-skill',
        description: 'Run tests.',
        provides: ['test.run'],
        'allowed-tools': 'Bash',
      });
      writeSkill(root, 'critic-skill', {
        name: 'critic-skill',
        description: 'External critique.',
        provides: ['critique.review'],
        'allowed-tools': 'mcp__codex__review',
      });

      writeSkill(
        root,
        'implement-workflow',
        {
          name: 'implement',
          type: 'workflow',
          description: 'Base fix.',
          requires: ['repo.pr', 'code.edit', 'code.read', 'test.run'],
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
          'applies-to': { workflows: ['implement'], traits: ['code'] },
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
    - implement
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'basic', catalog, root);

      expect(manifest.bindings['repo']).toBe('repo-skill');
      expect(manifest.bindings['code']).toBe('edit-skill');
      expect(manifest.bindings['test']).toBe('runner-skill');
      expect(manifest.workflows[0].requires).toEqual(['repo.pr', 'code.edit', 'code.read', 'test.run']);
    });

    it('errors when a required trait has no binding and no provider in the skill set', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
broken:
  description: "missing code.edit"
  skills:
    - repo-skill
    - explore-skill
    - runner-skill
  workflows:
    - implement
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'broken', catalog, root)).toThrow(
        /requires trait\(s\) with no binding: code\.edit/,
      );
    });

    it('errors when no skill provides a required qualified trait', () => {
      const root = setupTraitProject();
      writeTypes(
        root,
        'spine',
        `
misbound:
  description: "no code.edit provider in skill set"
  skills:
    - repo-skill
    - explore-skill
    - runner-skill
  workflows:
    - implement
  bindings:
    code: explore-skill
    test: runner-skill
    repo: repo-skill
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'misbound', catalog, root)).toThrow(
        /requires trait\(s\) with no binding: code\.edit/,
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
    - implement
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
      expect(overlayCust!.workflow).toBe('implement');
      expect(overlayCust!.summary).toContain('after step `patch`');
      expect(manifest.tools).toContain('mcp__codex__review');
    });

    it('renders Gates (compact) and inline gate markers into the spine markdown', () => {
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
    - implement
  overlays:
    - crit-overlay
  bindings:
    critique: critic-skill
`,
      );
      const out = composeCoworkerSpine({ projectRoot: root, coworkerType: 'render-check' });

      expect(out).not.toContain('## Trait Bindings');
      expect(out).toContain('## Gates');
      expect(out).toContain('CRIT OVERLAY GATE (mandatory)');
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
          extends: 'implement',
          requires: ['repo.pr', 'code.edit', 'code.read', 'test.run'],
          uses: { skills: [], workflows: ['implement'] },
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
      expect(extendsCust!.summary).toContain('`/slang-patch` extends `/implement`');
      const overrideCust = manifest.customizations.find((c) => c.kind === 'override');
      expect(overrideCust!.summary).toContain('step `patch` is overridden');
      expect(overrideCust!.detail).toContain('slang-specific code formatter');
    });

    it('bindings in an ancestor type are inherited by descendants (leaf wins on conflict)', () => {
      const root = setupTraitProject();
      writeSkill(root, 'patched-edit', {
        name: 'patched-edit',
        description: 'Specialized edit.',
        provides: ['code.edit'],
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
    code: edit-skill
child:
  extends: parent
  description: "child"
  skills:
    - patched-edit
  bindings:
    code: patched-edit
  workflows:
    - implement
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'child', catalog, root);
      expect(manifest.bindings['code']).toBe('patched-edit');
    });
  });

  describe('project-scoped binding resolution', () => {
    function setupCrossProject(root: string): void {
      writeFile(path.join(root, 'container', 'skills', 'spine-base', 'inv.md'), 'safety');
      writeTypes(
        root,
        'spine-base',
        `
base-common:
  description: "Base"
  invariants:
    - container/skills/spine-base/inv.md
`,
      );
      writeSkill(root, 'base-nanoclaw', { name: 'base-nanoclaw', type: 'capability', provides: ['ops.send'] });
      writeSkill(root, 'code-reader-slang', {
        name: 'code-reader-slang',
        type: 'capability',
        provides: ['code.read', 'code.search'],
      });
      writeSkill(root, 'code-reader-py', {
        name: 'code-reader-py',
        type: 'capability',
        provides: ['code.read', 'code.search'],
      });
      writeSkill(root, 'investigate-wf', {
        name: 'investigate',
        type: 'workflow',
        requires: ['code.read'],
        description: 'investigate',
      });
      writeFile(path.join(root, 'container', 'skills', 'spine-slang', 'id.md'), 'slang engineer');
      writeTypes(
        root,
        'spine-slang',
        `
slang-common:
  project: slang
  extends: base-common
  identity: container/skills/spine-slang/id.md
  skills:
    - code-reader-slang
  workflows:
    - investigate
  bindings:
    code: code-reader-slang
`,
      );
      writeFile(path.join(root, 'container', 'skills', 'spine-slangpy', 'id.md'), 'slangpy engineer');
      writeTypes(
        root,
        'spine-slangpy',
        `
slangpy-common:
  project: slangpy
  extends: base-common
  identity: container/skills/spine-slangpy/id.md
  skills:
    - code-reader-py
    - code-reader-slang
  workflows:
    - investigate
`,
      );
    }

    it('auto-binds to same-project skill over cross-project skill', () => {
      const root = makeTempProject();
      setupCrossProject(root);
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'slangpy-common', catalog, root);
      expect(manifest.bindings['code']).toBe('code-reader-py');
    });

    it('explicit binding from same project resolves normally', () => {
      const root = makeTempProject();
      setupCrossProject(root);
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'slang-common', catalog, root);
      expect(manifest.bindings['code']).toBe('code-reader-slang');
    });

    it('base skill (no project) binds to any project type', () => {
      const root = makeTempProject();
      writeFile(path.join(root, 'container', 'skills', 'spine-base', 'inv.md'), 'safety');
      writeTypes(
        root,
        'spine-base',
        `
base-common:
  description: "Base"
  invariants:
    - container/skills/spine-base/inv.md
`,
      );
      writeSkill(root, 'base-tool', { name: 'base-tool', type: 'capability', provides: ['code.read'] });
      writeSkill(root, 'wf', { name: 'wf', type: 'workflow', requires: ['code.read'], description: 'wf' });
      writeFile(path.join(root, 'container', 'skills', 'spine-py', 'id.md'), 'py');
      writeTypes(
        root,
        'spine-py',
        `
py-type:
  project: pyproject
  extends: base-common
  identity: container/skills/spine-py/id.md
  skills:
    - base-tool
  workflows:
    - wf
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      const manifest = resolveCoworkerManifest(types, 'py-type', catalog, root);
      expect(manifest.bindings['code']).toBe('base-tool');
    });

    it('throws when only a cross-project skill provides a required trait', () => {
      const root = makeTempProject();
      writeFile(path.join(root, 'container', 'skills', 'spine-base', 'inv.md'), 'safety');
      writeTypes(
        root,
        'spine-base',
        `
base-common:
  description: "Base"
  invariants:
    - container/skills/spine-base/inv.md

shared-base:
  extends: base-common
  skills:
    - slang-only-reader
`,
      );
      writeSkill(root, 'slang-only-reader', { name: 'slang-only-reader', type: 'capability', provides: ['code.read'] });
      writeSkill(root, 'wf', { name: 'wf', type: 'workflow', requires: ['code.read'], description: 'wf' });
      // slang-type (project: slang) lists the skill → skillProjectSets = {slang}.
      // shared-base has no project → doesn't contribute to skillProjectSets.
      writeTypes(
        root,
        'spine-slang',
        `
slang-type:
  project: slang
  extends: shared-base
  skills:
    - slang-only-reader
`,
      );
      writeFile(path.join(root, 'container', 'skills', 'spine-py', 'id.md'), 'py');
      // py-type extends shared-base which lists slang-only-reader. The skill
      // enters py-type's chain, but skillProjectSets only records slang for it.
      writeTypes(
        root,
        'spine-py',
        `
py-type:
  project: pyproject
  extends: shared-base
  identity: container/skills/spine-py/id.md
  workflows:
    - wf
`,
      );
      const types = readCoworkerTypes(root);
      const catalog = readSkillCatalog(root);
      expect(() => resolveCoworkerManifest(types, 'py-type', catalog, root)).toThrow(/no binding.*code\.read/);
    });

    it('warns when multiple skills provide same trait without explicit binding', () => {
      const root = makeTempProject();
      setupCrossProject(root);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const types = readCoworkerTypes(root);
        const catalog = readSkillCatalog(root);
        resolveCoworkerManifest(types, 'slangpy-common', catalog, root);
        const ambiguityWarning = warnSpy.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' && call[0].includes('code.read') && call[0].includes('no explicit binding'),
        );
        expect(ambiguityWarning).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('warns when binding does not cover a required qualified trait', () => {
      const root = makeTempProject();
      writeFile(path.join(root, 'container', 'skills', 'spine-base', 'inv.md'), 'safety');
      writeTypes(
        root,
        'spine-base',
        `
base-common:
  description: "Base"
  invariants:
    - container/skills/spine-base/inv.md
`,
      );
      writeSkill(root, 'partial-skill', { name: 'partial-skill', type: 'capability', provides: ['code.read'] });
      writeSkill(root, 'edit-skill', { name: 'edit-skill', type: 'capability', provides: ['code.edit'] });
      writeSkill(root, 'impl-wf', {
        name: 'impl',
        type: 'workflow',
        requires: ['code.read', 'code.edit'],
        description: 'impl',
      });
      writeFile(path.join(root, 'container', 'skills', 'spine-test', 'id.md'), 'test');
      writeTypes(
        root,
        'spine-test',
        `
test-type:
  extends: base-common
  identity: container/skills/spine-test/id.md
  skills:
    - partial-skill
    - edit-skill
  workflows:
    - impl
  bindings:
    code: partial-skill
`,
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const types = readCoworkerTypes(root);
        const catalog = readSkillCatalog(root);
        resolveCoworkerManifest(types, 'test-type', catalog, root);
        const partialWarning = warnSpy.mock.calls.find(
          (call) =>
            typeof call[0] === 'string' && call[0].includes('does not provide') && call[0].includes('code.edit'),
        );
        expect(partialWarning).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
