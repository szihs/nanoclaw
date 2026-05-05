// Refactor contract tests for the workflow/overlay/spine migration.
//
// These tests pin the behaviors the refactor introduced. They use temp-dir
// fixtures (same pattern as claude-composer.test.ts) so they are hermetic —
// no project-specific content is hardcoded, and they pass whether or not
// sibling branches are merged.
//
// Coverage map:
//   R01 full workflow step body embedded in composed CLAUDE.md
//   R02 overlay body inlined at each anchor as `⟐ NAME GATE` block
//   R03 extends + override: child override text replaces parent step body
//   R04 container/skills/ holds no WORKFLOW.md/OVERLAY.md (real repo state)
//   R05 no `type: workflow` or `type: overlay` in container/skills/ SKILL.md
//   R06 container/spines/*/coworker-types.yaml uses container/spines/* paths
//   R07 rebuild idempotency (same compose twice = byte-identical)
//   R08 overlay body headings demoted below the `####` gate header
//   R09 trailing "## Gates" section is gone (bodies are inline)
//   R10 "## How to Work" lists every workflow (no category dedup)
//   R11 mount/copy destinations contain only container/skills/ + overlay agent.md
//   R12 backticked `/workflow` refs inside bodies rewritten to section refs;
//       `/overlay` refs rewritten to Task subagent pointer;
//       capability skill slash commands left literal

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { composeCoworkerSpine } from './claude-composer.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-refactor-'));
  tempDirs.push(dir);
  return dir;
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeSpineBase(root: string): void {
  write(
    path.join(root, 'container', 'spines', 'base', 'invariants', 'safety.md'),
    '- Do not ship broken code.',
  );
  write(
    path.join(root, 'container', 'spines', 'base', 'coworker-types.yaml'),
    [
      'base-common:',
      '  description: "Test spine."',
      '  invariants:',
      '    - container/spines/base/invariants/safety.md',
      '',
    ].join('\n'),
  );
}

function writeWorkflow(
  root: string,
  name: string,
  body: string,
  frontmatter: {
    description?: string;
    requires?: string[];
    extends?: string;
    overrides?: Record<string, string>;
  } = {},
): void {
  const fm = [
    '---',
    `name: ${name}`,
    'type: workflow',
    `description: "${frontmatter.description || `Test ${name} workflow.`}"`,
    `requires: ${JSON.stringify(frontmatter.requires || [])}`,
    'uses:',
    '  skills: []',
    '  workflows: []',
    ...(frontmatter.extends ? [`extends: ${frontmatter.extends}`] : []),
    ...(frontmatter.overrides
      ? [
          'overrides:',
          ...Object.entries(frontmatter.overrides).map(
            ([id, text]) => `  ${id}: ${JSON.stringify(text)}`,
          ),
        ]
      : []),
    '---',
    '',
    body,
  ].join('\n');
  write(path.join(root, 'container', 'workflows', name, 'WORKFLOW.md'), fm);
}

function writeOverlay(
  root: string,
  name: string,
  body: string,
  frontmatter: {
    appliesToWorkflows?: string[];
    insertAfter?: string[];
    insertBefore?: string[];
  } = {},
): void {
  const fm = [
    '---',
    `name: ${name}`,
    'type: overlay',
    `description: "Test ${name} overlay."`,
    'applies-to:',
    `  workflows: ${JSON.stringify(frontmatter.appliesToWorkflows || [])}`,
    '  traits: []',
    `insert-after: ${JSON.stringify(frontmatter.insertAfter || [])}`,
    `insert-before: ${JSON.stringify(frontmatter.insertBefore || [])}`,
    'uses:',
    '  skills: []',
    '---',
    '',
    body,
  ].join('\n');
  write(path.join(root, 'container', 'overlays', name, 'OVERLAY.md'), fm);
}

function writeCapabilitySkill(root: string, name: string, description: string): void {
  const fm = [
    '---',
    `name: ${name}`,
    'type: capability',
    `description: "${description}"`,
    'provides: [probe.act]',
    '---',
    '',
    `Body for ${name}.`,
  ].join('\n');
  write(path.join(root, 'container', 'skills', name, 'SKILL.md'), fm);
}

function writeProjectType(root: string, yaml: string): void {
  write(path.join(root, 'container', 'spines', 'project', 'coworker-types.yaml'), yaml);
}

// --- Fixture-based behavioral tests ---

describe('R01: composed CLAUDE.md contains full workflow step body', () => {
  it('emits each step body, not just the step id', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(
      root,
      'triage',
      [
        '# Triage',
        '',
        '## Steps',
        '',
        '1. **Ingest** {#ingest} — DISTINCTIVE_INGEST_PHRASE read target.',
        '',
        '2. **Classify** {#classify} — DISTINCTIVE_CLASSIFY_PHRASE decide type.',
        '',
      ].join('\n'),
    );
    writeProjectType(
      root,
      'probe:\n  extends: base-common\n  description: "Probe."\n  workflows: [triage]\n',
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).toContain('DISTINCTIVE_INGEST_PHRASE');
    expect(spine).toContain('DISTINCTIVE_CLASSIFY_PHRASE');
  });
});

describe('R02: overlay body inlined at anchor', () => {
  it('renders a `⟐ NAME GATE (position `stepId`)` block at each anchor', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(root, 'build', '# Build\n\n## Steps\n\n1. **Do** {#do} — thing.\n');
    writeOverlay(root, 'guard', 'SENTINEL_GUARD_BODY', {
      appliesToWorkflows: ['build'],
      insertAfter: ['do'],
    });
    writeProjectType(
      root,
      [
        'probe:',
        '  extends: base-common',
        '  description: "Probe."',
        '  workflows: [build]',
        '  overlays: [guard]',
        '',
      ].join('\n'),
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).toMatch(/⟐ GUARD GATE \(after `do`\)/);
    expect(spine).toContain('SENTINEL_GUARD_BODY');
  });
});

describe('R03: extends + overrides replace parent step body', () => {
  it('override text replaces parent body for matching step id; inherited steps keep parent body', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(
      root,
      'parent-flow',
      [
        '# Parent',
        '',
        '## Steps',
        '',
        '1. **Reproduce** {#reproduce} — PARENT_REPRODUCE_BODY.',
        '',
        '2. **Patch** {#patch} — PARENT_PATCH_BODY.',
        '',
      ].join('\n'),
    );
    writeWorkflow(root, 'child-flow', '', {
      extends: 'parent-flow',
      overrides: { patch: 'CHILD_PATCH_OVERRIDE.' },
    });
    writeProjectType(
      root,
      'probe:\n  extends: base-common\n  description: "Probe."\n  workflows: [child-flow]\n',
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).toContain('PARENT_REPRODUCE_BODY');
    expect(spine).toContain('CHILD_PATCH_OVERRIDE');
    expect(spine).not.toContain('PARENT_PATCH_BODY');
  });
});

describe('R07: rebuild idempotency', () => {
  it('composing the same type twice is byte-identical', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(root, 'flow', '# F\n\n## Steps\n\n1. **A** {#a} — hi.');
    writeProjectType(
      root,
      'probe:\n  extends: base-common\n  description: "Probe."\n  workflows: [flow]\n',
    );
    const a = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    const b = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(a).toBe(b);
  });
});

describe('R08: overlay body headings demoted below gate header', () => {
  it('source `## Foo` renders as `#####` or deeper inside the gate block', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(root, 'flow', '# F\n\n## Steps\n\n1. **A** {#a} — hi.');
    writeOverlay(
      root,
      'guard',
      ['BODY_PREAMBLE.', '', '## Subheading One', '', 'Subheading body.'].join('\n'),
      { appliesToWorkflows: ['flow'], insertAfter: ['a'] },
    );
    writeProjectType(
      root,
      [
        'probe:',
        '  extends: base-common',
        '  description: "Probe."',
        '  workflows: [flow]',
        '  overlays: [guard]',
        '',
      ].join('\n'),
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).toMatch(/^##### Subheading One\s*$/m);
    expect(spine).not.toMatch(/^## Subheading One\s*$/m);
  });
});

describe('R09: trailing "## Gates" section is gone', () => {
  it('spine does not emit a standalone Gates section (bodies inline now)', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(root, 'flow', '# F\n\n## Steps\n\n1. **A** {#a} — hi.');
    writeOverlay(root, 'guard', 'body', { appliesToWorkflows: ['flow'], insertAfter: ['a'] });
    writeProjectType(
      root,
      [
        'probe:',
        '  extends: base-common',
        '  description: "Probe."',
        '  workflows: [flow]',
        '  overlays: [guard]',
        '',
      ].join('\n'),
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).not.toMatch(/\n## Gates\b/);
  });
});

describe('R10: "## How to Work" lists every workflow (no category dedup)', () => {
  it('two workflows sharing a category are both rendered', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeCapabilitySkill(root, 'repo-reader', 'Read repo.');
    // Tweak the skill's `provides` to expose `repo.read` so the trait-binding
    // check passes for our fixture workflows.
    fs.writeFileSync(
      path.join(root, 'container', 'skills', 'repo-reader', 'SKILL.md'),
      [
        '---',
        'name: repo-reader',
        'type: capability',
        'description: "Read repo."',
        'provides: [repo.read]',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );
    writeWorkflow(root, 'alpha-flow', '# A\n\n## Steps\n\n1. **A** {#a} — x.', {
      requires: ['repo.read'],
    });
    writeWorkflow(root, 'beta-flow', '# B\n\n## Steps\n\n1. **B** {#b} — y.', {
      requires: ['repo.read'],
    });
    writeProjectType(
      root,
      [
        'probe:',
        '  extends: base-common',
        '  description: "Probe."',
        '  workflows: [alpha-flow, beta-flow]',
        '  skills: [repo-reader]',
        '  bindings:',
        '    repo: repo-reader',
        '',
      ].join('\n'),
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    const howStart = spine.indexOf('## How to Work');
    const howEnd = spine.indexOf('\n## ', howStart + 1);
    const how = spine.slice(howStart, howEnd === -1 ? undefined : howEnd);
    expect(how).toContain('alpha-flow');
    expect(how).toContain('beta-flow');
  });
});

describe('R12: backticked slash refs in bodies are rewritten by kind', () => {
  it('workflow ref → section pointer; overlay ref → Task subagent pointer; skill ref → left literal', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(
      root,
      'alpha',
      [
        '# Alpha',
        '',
        '## Steps',
        '',
        '1. **Do** {#do} — first run `/beta` workflow, then invoke `/gamma-skill`, then spawn `/delta-overlay`.',
      ].join('\n'),
    );
    writeWorkflow(root, 'beta', '# Beta\n\n## Steps\n\n1. **B** {#b} — x.');
    writeCapabilitySkill(root, 'gamma-skill', 'Do gamma.');
    writeOverlay(root, 'delta-overlay', 'delta body', {
      appliesToWorkflows: [],
      insertAfter: [],
    });
    writeProjectType(
      root,
      [
        'probe:',
        '  extends: base-common',
        '  description: "Probe."',
        '  workflows: [alpha, beta]',
        '  skills: [gamma-skill]',
        '  overlays: [delta-overlay]',
        '  bindings:',
        '    probe: gamma-skill',
        '',
      ].join('\n'),
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    // Workflow ref in step body rewritten to section pointer. (Route lines
    // in "## How to Work" intentionally still use `/beta` to read naturally
    // as "General task → `/beta` workflow".)
    expect(spine).toContain('the **beta** workflow section below');
    // Overlay ref rewritten to Task subagent
    expect(spine).toContain('the **delta-overlay** subagent (spawn via the Task tool)');
    // Capability skill slash command left literal
    expect(spine).toMatch(/`\/gamma-skill`/);
  });

  it('leaves slash-prefixed paths inside code fences untouched', () => {
    const root = makeTempProject();
    writeSpineBase(root);
    writeWorkflow(
      root,
      'alpha',
      [
        '# Alpha',
        '',
        '## Steps',
        '',
        '1. **Do** {#do} — run:',
        '```bash',
        'mkdir -p /workspace/agent/plans',
        '```',
      ].join('\n'),
    );
    writeProjectType(
      root,
      'probe:\n  extends: base-common\n  description: "Probe."\n  workflows: [alpha]\n',
    );
    const spine = composeCoworkerSpine({ projectRoot: root, coworkerType: 'probe' });
    expect(spine).toContain('/workspace/agent/plans');
  });
});

// --- Repo-state invariants (run against real repo) ---

const REPO_ROOT = process.cwd();

describe('R04: container/skills/ holds no WORKFLOW.md or OVERLAY.md', () => {
  it('no workflow/overlay files live under container/skills/', () => {
    const skillsDir = path.join(REPO_ROOT, 'container', 'skills');
    if (!fs.existsSync(skillsDir)) return;
    for (const d of fs.readdirSync(skillsDir)) {
      expect(fs.existsSync(path.join(skillsDir, d, 'WORKFLOW.md')), `${d}/WORKFLOW.md`).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, d, 'OVERLAY.md')), `${d}/OVERLAY.md`).toBe(false);
    }
  });
});

describe('R05: no `type: workflow|overlay` in container/skills/*/SKILL.md', () => {
  it('capability-skill dirs stay capability', () => {
    const skillsDir = path.join(REPO_ROOT, 'container', 'skills');
    if (!fs.existsSync(skillsDir)) return;
    for (const d of fs.readdirSync(skillsDir)) {
      const skillMd = path.join(skillsDir, d, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const fm = fs.readFileSync(skillMd, 'utf-8').match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      expect(/^type:\s*(workflow|overlay)\s*$/m.test(fm[1]), `${d} has wrong type`).toBe(false);
    }
  });
});

describe('R06: every spine YAML uses container/spines/* paths', () => {
  it('no legacy container/skills/spine-* references inside container/spines/*/coworker-types.yaml', () => {
    const spinesDir = path.join(REPO_ROOT, 'container', 'spines');
    if (!fs.existsSync(spinesDir)) return;
    for (const d of fs.readdirSync(spinesDir)) {
      const yamlPath = path.join(spinesDir, d, 'coworker-types.yaml');
      if (!fs.existsSync(yamlPath)) continue;
      const text = fs.readFileSync(yamlPath, 'utf-8');
      expect(text, `${d} yaml`).not.toMatch(/container\/skills\/spine-/);
    }
  });
});

describe('R11: mount/copy code does not pull workflows or overlay bodies into containers', () => {
  // The refactor invariant: only container/skills/ (capability skills) and
  // overlay agent.md (subagent defs) are copied to .claude-shared. Workflow
  // bodies, overlay OVERLAY.md, and spine fragments are compose-time only.
  it('group-init.ts does not copy container/workflows/ or container/spines/', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'group-init.ts'), 'utf-8');
    // Allowed source roots for runtime copy are container/skills and container/overlays (for agent.md).
    expect(src).not.toMatch(/container['"]\s*,\s*['"]workflows/);
    expect(src).not.toMatch(/container['"]\s*,\s*['"]spines/);
  });

  it('group-init.ts overlay scan never copies an OVERLAY.md body', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'group-init.ts'), 'utf-8');
    // Strip single-line `//` comments so commentary mentioning "OVERLAY.md"
    // doesn't false-positive. We only care whether OVERLAY.md appears inside
    // executable code (e.g. a `copyFileSync` / `readFileSync` call).
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('OVERLAY.md');
  });

  it('container-runner.ts does not bind-mount container/workflows or container/spines into the container', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'container-runner.ts'), 'utf-8');
    // Only specific containerPath strings are mounted; ensure workflows/spines
    // are never used as host paths for a mount entry.
    const mountBlocks = src.split(/mounts\.push\(/).slice(1);
    for (const block of mountBlocks) {
      const hostPath = block.match(/hostPath:\s*([^,\n]+)/);
      if (!hostPath) continue;
      expect(hostPath[1]).not.toMatch(/container\/workflows/);
      expect(hostPath[1]).not.toMatch(/container\/spines/);
    }
  });
});
