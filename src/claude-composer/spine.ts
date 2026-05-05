// Render a resolved CoworkerManifest as CLAUDE.md — the always-in-context
// spine for typed coworkers. Workflows and overlays are embedded verbatim at
// compose time (their full bodies are baked into CLAUDE.md); capability
// skills still load on demand via Claude Code's SKILL.md slash-command
// mechanism.

import { readCoworkerTypes, readSkillCatalog } from './registry.js';
import { resolveCoworkerManifest } from './resolve.js';

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

// Render a single workflow step as a sub-section under the workflow heading.
// The body may span multiple lines (nested bullets, code blocks, prose).
function renderStepBlock(n: number, stepId: string, rawBody: string): string {
  const cleaned = stripStepAnchors(rawBody).trim();
  const lines = cleaned.split('\n');
  if (lines.length === 0) return `#### ${n}. ${stepId}`;
  const first = stripLeadingNumber(lines[0]).trim();
  const rest = lines.slice(1).join('\n').trimEnd();
  const header = `#### ${n}. ${first}`;
  return rest ? `${header}\n\n${rest}` : header;
}

// Render a gate overlay as an inlined sub-block under the workflow. The full
// overlay body (including its <IMPORTANT>...</IMPORTANT> + stage protocols) is
// emitted verbatim — no runtime loading needed.
function renderGateBlock(overlayName: string, body: string, position: 'BEFORE' | 'AFTER', stepId: string): string {
  const label = `${overlayName.toUpperCase().replaceAll('-', ' ')} GATE`;
  const where = position === 'BEFORE' ? `before \`${stepId}\`` : `after \`${stepId}\``;
  return `#### ⟐ ${label} (${where})\n\n${body.trim()}`;
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
// a workflow that pulls from [repo.read, ci.inspect] is classified CI only if
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

  // --- Task routing guide ---
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
    const seen = new Set<string>();
    for (const w of manifest.workflows) {
      const cat = categorize(w.requires);
      if (seen.has(cat)) continue;
      seen.add(cat);
      routeLines.push(`- ${TRIGGER_MAP[cat]} → \`/${w.name}\``);
    }
    parts.push('## How to Work');
    parts.push(
      routeLines.join('\n') +
        '\n\nAlways start with a workflow. Never jump straight to code.' +
        '\nYour role-specific standing orders: [Additional Instructions](#additional-instructions)',
    );
  }

  // --- Workflows: full body embedded with inline overlay gates ---
  if (manifest.workflows.length > 0) {
    parts.push('## Workflows');
    const wfBlocks: string[] = [];

    for (const w of manifest.workflows) {
      const wfCustomizations = manifest.customizations.filter((c) => c.workflow === w.name);
      const extendsC = wfCustomizations.find((c) => c.kind === 'extends');
      const overrides = wfCustomizations.filter((c) => c.kind === 'override');
      const overlays = wfCustomizations.filter((c) => c.kind === 'overlay');

      const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
      const extendsNote = extendsC?.extendsWorkflow ? ` (extends \`/${extendsC.extendsWorkflow}\`)` : '';
      let block = `### /${w.name}\n\n${w.description}${uses}${extendsNote}`;

      if (w.steps.length > 0) {
        // Override lookup by stepId (no more regex on summary).
        const overrideMap = new Map<string, string>();
        for (const o of overrides) {
          if (o.stepId) overrideMap.set(o.stepId, (o.detail || '').trim());
        }

        // Overlay anchor maps: stepId → array of full overlay bodies to inline
        // before/after that step.
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

        // Render each step as a numbered markdown section. Gate overlays are
        // emitted as inline sub-blocks (full body) before/after the anchored
        // step. Numbering is per-step (not gate-counted) since gates aren't
        // steps — they are mandatory sub-protocols attached to steps.
        const chunks: string[] = [];
        let n = 1;
        for (const stepId of w.steps) {
          // Emit BEFORE-gates for this step.
          for (const gate of gatesBefore.get(stepId) || []) {
            chunks.push(renderGateBlock(gate.overlayName, gate.body, 'BEFORE', stepId));
          }

          // The step itself.
          const overrideBody = overrideMap.get(stepId);
          const rawBody = overrideBody || w.stepBodies[stepId] || stepId;
          chunks.push(renderStepBlock(n, stepId, rawBody));
          n++;

          // Emit AFTER-gates for this step.
          for (const gate of gatesAfter.get(stepId) || []) {
            chunks.push(renderGateBlock(gate.overlayName, gate.body, 'AFTER', stepId));
          }
        }

        block += '\n\n' + chunks.join('\n\n');
      }

      wfBlocks.push(block);
    }

    parts.push(wfBlocks.join('\n\n'));
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
