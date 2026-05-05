// Render a resolved CoworkerManifest as CLAUDE.md — the always-in-context
// spine for typed coworkers. Workflows and overlays are embedded verbatim at
// compose time (their full bodies are baked into CLAUDE.md); capability
// skills still load on demand via Claude Code's SKILL.md slash-command
// mechanism.

import { readCoworkerTypes, readSkillCatalog } from './registry.js';
import { resolveCoworkerManifest } from './resolve.js';
import type { CoworkerManifest, SkillMeta } from './types.js';

function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : pad + line))
    .join('\n');
}

// Strip a leading source-ordered bullet prefix like `1. `, `2) `, etc.
function stripLeadingNumber(line: string): string {
  return line.replace(/^\s*\d+[.)]\s+/, '');
}

// Strip inline `{#step-id}` anchors — the rendered CLAUDE.md gives each step a
// human-readable number, the anchor id is only needed at parse time.
function stripStepAnchors(text: string): string {
  return text.replace(/\s*\{#[a-z0-9-]+\}/g, '');
}

// Humanize a step id into a title: "root-cause" → "Root cause".
function humanizeStepId(id: string): string {
  if (!id) return '';
  return id.replace(/[-_]+/g, ' ').replace(/^(\w)/, (m) => m.toUpperCase());
}

// Extract the title for a step from its source body: the first `**Bolded**`
// segment wins; otherwise fall back to humanized stepId. Used so the rendered
// heading stays stable even when a body has been overridden or inherited.
function extractStepTitle(body: string | undefined, stepId: string): string {
  if (!body) return humanizeStepId(stepId);
  const bolded = body.match(/\*\*([^*\n]+)\*\*/);
  if (bolded) return bolded[1].trim();
  return humanizeStepId(stepId);
}

// Render a single workflow step as a sub-section under the workflow heading.
// Heading is stable: `#### N. <Step Title>`. The rawBody becomes the prose
// body below the heading; if the body's first line was a bullet like
// "1. **Name** — body" we strip the redundant title prefix so the body reads
// as pure prose.
function renderStepBlock(n: number, stepId: string, rawBody: string, title: string): string {
  const header = `#### ${n}. ${title}`;
  const cleaned = stripStepAnchors(rawBody).trim();
  if (!cleaned) return header;
  const lines = cleaned.split('\n');
  // Drop a leading "N. **Title** — " prefix if present; otherwise keep the
  // body verbatim.
  const first = lines[0];
  const prefixMatch = first.match(/^\s*\d+[.)]\s+(\*\*[^*\n]+\*\*\s*(?:\{#[^}]+\})?\s*[—-]?\s*)?(.*)$/);
  let body: string;
  if (prefixMatch) {
    const remainder = prefixMatch[2].trim();
    body = [remainder, ...lines.slice(1)].join('\n').trimEnd();
  } else {
    body = cleaned;
  }
  return body ? `${header}\n\n${body}` : header;
}

// Render a gate overlay as an inlined sub-block under the workflow. Overlay
// body markdown headings are demoted so they live below the gate's `####`
// header: `## Foo` becomes `##### Foo`. Prevents overlay sub-headings from
// breaking the outer `## Workflows` section boundary.
function renderGateBlock(overlayName: string, body: string, position: 'BEFORE' | 'AFTER', stepId: string): string {
  const label = `${overlayName.toUpperCase().replaceAll('-', ' ')} GATE`;
  const where = position === 'BEFORE' ? `before \`${stepId}\`` : `after \`${stepId}\``;
  const demoted = demoteHeadings(body.trim(), 3);
  return `#### ⟐ ${label} (${where})\n\n${demoted}`;
}

// Demote ATX markdown headings by `levels`, capped at h6. Ignores code fences.
function demoteHeadings(md: string, levels: number): string {
  const lines = md.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = line.match(/^(#{1,6}) (.*)$/);
    if (!m) continue;
    const newLevel = Math.min(6, m[1].length + levels);
    lines[i] = '#'.repeat(newLevel) + ' ' + m[2];
  }
  return lines.join('\n');
}

// Rewrite unresolved template placeholders (`{{name}}`, `{{foo.bar}}`,
// `{{foo_bar}}`) in workflow / overlay bodies so the agent sees them as
// user-supplied placeholders rather than raw handlebars.
//
//   {{target}}         → <target>
//   {{report.path}}    → <report.path>
//   {{target_slug}}    → <target_slug>
//
// The composer deliberately does NOT resolve these from the workflow's
// `params:` frontmatter — that would require runtime binding to the user's
// request. Converting to `<name>` renders naturally in prose ("read
// <target>") and avoids confusing the agent with unrendered Jinja/Handlebars
// syntax.
//
// Skips fenced code blocks entirely so that backticked examples of the
// template syntax itself (e.g. documentation snippets) stay literal.
function rewritePlaceholders(md: string): string {
  const lines = md.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    lines[i] = line.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, name) => `<${name}>`);
  }
  return lines.join('\n');
}

// Rewrite backtick-wrapped `/name` references embedded inside workflow /
// overlay bodies so the agent doesn't confuse workflow names (embedded
// procedures) with skill names (runtime slash commands) or overlay names
// (Task-tool subagents, not slash commands).
//
//   `/alpha` where alpha is a workflow   → "the **alpha** workflow section below"
//   `/beta`  where beta is a capability skill → left as `` `/beta` `` (slash command)
//   `/gamma` where gamma is an overlay   → "the **gamma** subagent (spawn via Task tool)"
//   `/delta` unknown                     → left as `` `/delta` `` (caller must fix source)
//
// Restricted to backticked refs to avoid mangling file paths like
// `/workspace/agent/...` or bash snippets like `mkdir -p /tmp/x`. Skips
// fenced code blocks entirely.
function rewriteSlashRefs(
  md: string,
  workflowNames: Set<string>,
  capabilitySkillNames: Set<string>,
  overlayNames: Set<string>,
): string {
  const lines = md.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    lines[i] = line.replace(/`\/([a-z][a-z0-9-]*)`/g, (m, name) => {
      if (workflowNames.has(name)) return `the **${name}** workflow section below`;
      if (overlayNames.has(name)) return `the **${name}** subagent (spawn via the Task tool)`;
      if (capabilitySkillNames.has(name)) return m; // real slash command
      return m; // unknown — leave literal for upstream fix
    });
  }
  return lines.join('\n');
}

// Category order drives the section layout. "other" is the sink for traits
// that don't map anywhere, plus entries with no traits at all.
const CATEGORY_ORDER = ['repo', 'code', 'test', 'ci', 'doc', 'plan', 'critique', 'other'] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_HEADINGS: Record<Category, string> = {
  repo: 'Repo',
  code: 'Code',
  test: 'Test',
  ci: 'CI',
  doc: 'Docs',
  plan: 'Research',
  critique: 'Critique',
  other: 'Other',
};

// Maps trait domains to display categories. Qualified traits (repo.pr, code.edit)
// are resolved by extracting the domain prefix before the dot.
const DOMAIN_TO_CATEGORY: Record<string, Category> = {
  repo: 'repo',
  issues: 'repo',
  ci: 'ci',
  code: 'code',
  test: 'test',
  doc: 'doc',
  plan: 'plan',
  critique: 'critique',
};

// Pick the dominant category for an entry by counting how many of its traits
// fall into each bucket. Ties resolve via CATEGORY_ORDER (earlier wins), so
// an entry that pulls from [repo.read, ci.inspect] is classified CI only if
// CI trait count strictly exceeds Repo — otherwise Repo wins by order.
function categorize(traits: readonly string[]): Category {
  if (traits.length === 0) return 'other';
  const counts = new Map<Category, number>();
  for (const trait of traits) {
    const domain = trait.split('.')[0];
    const cat = DOMAIN_TO_CATEGORY[domain] ?? 'other';
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: Category = 'other';
  let bestCount = -1;
  for (const cat of CATEGORY_ORDER) {
    const c = counts.get(cat) ?? 0;
    if (c > bestCount) {
      best = cat;
      bestCount = c;
    }
  }
  return best;
}

function renderCategorizedList<T>(entries: T[], traitsOf: (e: T) => readonly string[], line: (e: T) => string): string {
  const grouped = new Map<Category, T[]>();
  for (const e of entries) {
    const cat = categorize(traitsOf(e));
    const list = grouped.get(cat) ?? [];
    list.push(e);
    grouped.set(cat, list);
  }

  // If everything lands in one category, suppress the sub-headings — a single
  // unstructured bullet list reads cleaner than a block with one header.
  if (grouped.size <= 1) {
    return entries.map(line).join('\n');
  }

  const blocks: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const bucket = grouped.get(cat);
    if (!bucket || bucket.length === 0) continue;
    blocks.push(`**${CATEGORY_HEADINGS[cat]}**`);
    blocks.push(bucket.map(line).join('\n'));
  }
  return blocks.join('\n\n');
}

export function renderCoworkerSpine(
  projectRoot: string,
  coworkerType: string,
  extraInstructions: string | null | undefined,
): string {
  const types = readCoworkerTypes(projectRoot);
  const catalog = readSkillCatalog(projectRoot);
  const manifest = resolveCoworkerManifest(types, coworkerType, catalog, projectRoot);

  if (manifest.flat) {
    // Flat mode: emit identity (e.g. upstream body) and context fragments
    // verbatim, separated by horizontal rules. No auto-generated title, no
    // structured section headings — the body files own their own formatting.
    const bodies = [manifest.identity, ...manifest.context].map((b) => b.trim()).filter(Boolean);
    const extra = extraInstructions?.trim();
    if (extra) bodies.push(extra);
    return bodies.join('\n\n---\n\n').trimEnd() + '\n';
  }

  const parts: string[] = [];
  parts.push(`# ${manifest.title}`);

  parts.push('## Identity');
  parts.push(manifest.identity);

  if (manifest.invariants.length > 0) {
    parts.push('## Invariants');
    parts.push(manifest.invariants.join('\n\n'));
  }

  if (manifest.context.length > 0) {
    parts.push('## Context');
    parts.push(manifest.context.join('\n\n'));
  }

  // Build name lookups for slash-rewrite. Three distinct resolutions:
  //   workflows           → embedded procedures, rewrite to section refs
  //   capability skills   → runtime slash commands, leave literal
  //   overlays (agent.md) → Task-tool subagents, rewrite accordingly
  const workflowNames = new Set(manifest.workflows.map((w) => w.name));
  const capabilitySkillNames = new Set(manifest.skills.map((s) => s.name));
  const overlayNames = new Set<string>();
  for (const meta of Object.values(catalog) as SkillMeta[]) {
    if (meta.type === 'overlay') overlayNames.add(meta.name);
  }

  // --- Task routing guide (every workflow, no category dedup) ---
  if (manifest.workflows.length > 0) {
    const TRIGGER_MAP: Record<Category, string> = {
      repo: 'Investigation / triage / "what\'s going on?"',
      code: 'Code change / fix / feature',
      test: 'Test authoring / CI fix',
      ci: 'CI investigation',
      doc: 'Documentation update',
      plan: 'Research / planning',
      critique: 'Review / critique',
      other: 'General task',
    };
    const routeLines: string[] = [];
    for (const w of manifest.workflows) {
      const cat = categorize(w.requires);
      routeLines.push(`- ${TRIGGER_MAP[cat]} → \`/${w.name}\` workflow`);
    }
    parts.push('## How to Work');
    parts.push(
      routeLines.join('\n') +
        '\n\nAlways start with a workflow. Never jump straight to code.' +
        '\nWorkflow bodies are embedded below — follow the steps inline. Workflows are not slash commands.' +
        '\nYour role-specific standing orders: [Additional Instructions](#additional-instructions)',
    );
  }

  // --- Workflows: full body embedded with inline overlay gates ---
  if (manifest.workflows.length > 0) {
    parts.push('## Workflows');
    const wfBlocks: string[] = [];

    // Dedup overlay full bodies across anchor sites. First anchor per overlay
    // emits the full body; subsequent anchors get a short pointer.
    const emittedOverlay = new Map<string, { workflowName: string; stepId: string }>();

    for (const w of manifest.workflows) {
      const wfCustomizations = manifest.customizations.filter((c) => c.workflow === w.name);
      const extendsC = wfCustomizations.find((c) => c.kind === 'extends');
      const overrides = wfCustomizations.filter((c) => c.kind === 'override');
      const overlays = wfCustomizations.filter((c) => c.kind === 'overlay');

      const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
      const extendsNote = extendsC?.extendsWorkflow
        ? ` (extends the **${extendsC.extendsWorkflow}** workflow section below)`
        : '';
      let block = `### /${w.name}\n\n${w.description}${uses}${extendsNote}`;

      if (w.steps.length > 0) {
        // Override lookup by stepId.
        const overrideMap = new Map<string, string>();
        for (const o of overrides) {
          if (o.stepId) overrideMap.set(o.stepId, (o.detail || '').trim());
        }

        // Overlay anchor maps: stepId → full bodies to emit before/after.
        const stepSet = new Set(w.steps);
        const gatesAfter = new Map<string, { overlayName: string; body: string }[]>();
        const gatesBefore = new Map<string, { overlayName: string; body: string }[]>();
        for (const ov of overlays) {
          if (!ov.anchorSteps || !ov.overlayName || !ov.detail) continue;
          for (const anchor of ov.anchorSteps) {
            if (!stepSet.has(anchor.step)) continue;
            const entry = { overlayName: ov.overlayName, body: ov.detail.trim() };
            const map = anchor.position === 'after' ? gatesAfter : gatesBefore;
            const arr = map.get(anchor.step) || [];
            arr.push(entry);
            map.set(anchor.step, arr);
          }
        }

        const chunks: string[] = [];
        let n = 1;
        for (const stepId of w.steps) {
          // BEFORE gates.
          for (const gate of gatesBefore.get(stepId) || []) {
            chunks.push(
              emitGate(emittedOverlay, gate.overlayName, gate.body, 'BEFORE', stepId, w.name),
            );
          }

          // The step itself. Title is derived from parent body (or override)
          // so the heading stays stable even when override text would have
          // produced an unwieldy heading.
          const parentBody = w.stepBodies[stepId];
          const overrideBody = overrideMap.get(stepId);
          const title = extractStepTitle(parentBody, stepId);
          const rawBody = overrideBody || parentBody || stepId;
          chunks.push(renderStepBlock(n, stepId, rawBody, title));
          n++;

          // AFTER gates.
          for (const gate of gatesAfter.get(stepId) || []) {
            chunks.push(
              emitGate(emittedOverlay, gate.overlayName, gate.body, 'AFTER', stepId, w.name),
            );
          }
        }

        block += '\n\n' + chunks.join('\n\n');
      }

      wfBlocks.push(block);
    }

    // Run the slash-rewrite once over the entire workflow block so that
    // backticked `/workflow` refs become section refs and `/overlay` refs
    // become Task-tool subagent pointers. Capability skill refs stay literal.
    const wfJoined = wfBlocks.join('\n\n');
    const slashRewritten = rewriteSlashRefs(wfJoined, workflowNames, capabilitySkillNames, overlayNames);
    parts.push(rewritePlaceholders(slashRewritten));
  }

  // --- Skills ---
  if (manifest.skills.length > 0) {
    parts.push('## Skills Available');
    parts.push(
      renderCategorizedList(
        manifest.skills,
        (s) => s.provides,
        (s) => `- \`/${s.name}\` — ${s.description}`,
      ),
    );
  }

  if (manifest.skills.length > 0) {
    parts.push('_Invoke a skill with its slash command. Skill bodies load on demand._');
  }

  if (extraInstructions?.trim()) {
    parts.push('## Additional Instructions');
    parts.push(extraInstructions.trim());
  }

  return parts.join('\n\n').trimEnd() + '\n';
}

// Dedup overlay body emissions across anchor sites. First anchor: full body.
// Subsequent anchors: short pointer to the first emission.
function emitGate(
  seen: Map<string, { workflowName: string; stepId: string }>,
  overlayName: string,
  body: string,
  position: 'BEFORE' | 'AFTER',
  stepId: string,
  workflowName: string,
): string {
  if (!seen.has(overlayName)) {
    seen.set(overlayName, { workflowName, stepId });
    return renderGateBlock(overlayName, body, position, stepId);
  }
  const first = seen.get(overlayName)!;
  const label = `${overlayName.toUpperCase().replaceAll('-', ' ')} GATE`;
  const where = position === 'BEFORE' ? `before \`${stepId}\`` : `after \`${stepId}\``;
  return (
    `#### ⟐ ${label} (${where})\n\n` +
    `Follow the **${label}** protocol documented under the **${first.workflowName}** ` +
    `workflow (step \`${first.stepId}\`). Every stage's procedure applies — match ` +
    `the stage to the anchor type (before/after which step triggered this gate).`
  );
}
