// Render a resolved CoworkerManifest as CLAUDE.md — the thin always-in-context
// spine for typed coworkers. Workflow and skill bodies load on demand via the
// Claude Code SKILL.md slash-command mechanism.

import { readCoworkerTypes, readSkillCatalog } from './registry.js';
import { resolveCoworkerManifest } from './resolve.js';

function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : pad + line))
    .join('\n');
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
        '\nWhen you receive a task unrelated to your current work, run `/clear` first to start with a fresh context.' +
        '\nYour role-specific standing orders: [Additional Instructions](#additional-instructions)',
    );
  }

  // --- Workflows: loop-unrolled with inline gates ---
  if (manifest.workflows.length > 0) {
    parts.push('## Workflows');
    const wfBlocks: string[] = [];

    // Collect overlay protocol bodies (render once at the end).
    const overlayBodies = new Map<string, string>();

    for (const w of manifest.workflows) {
      const wfCustomizations = manifest.customizations.filter((c) => c.workflow === w.name);
      const extendsC = wfCustomizations.find((c) => c.kind === 'extends');
      const overrides = wfCustomizations.filter((c) => c.kind === 'override');
      const overlays = wfCustomizations.filter((c) => c.kind === 'overlay');

      const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
      const extendsNote = extendsC?.extendsWorkflow ? ` (extends \`/${extendsC.extendsWorkflow}\`)` : '';
      let block = `### /${w.name}\n\n${w.description}${uses}${extendsNote}`;

      if (w.steps.length > 0) {
        // Build unrolled step list with inline gates.
        const overrideMap = new Map<string, string>();
        for (const o of overrides) {
          const stepMatch = o.summary.match(/step `([^`]+)`/);
          if (stepMatch) overrideMap.set(stepMatch[1], o.detail?.trim() || '');
        }

        // Map overlay anchors: stepId → gates to insert after/before.
        const stepSet = new Set(w.steps);
        const gatesAfter = new Map<string, string[]>();
        const gatesBefore = new Map<string, string[]>();
        const GATE_DIRECTIVES: Record<string, string> = {
          'critique-overlay': 'STOP and spawn codex-critique agent for review',
          'plan-overlay': 'STOP and write a plan before coding',
        };
        for (const ov of overlays) {
          if (ov.anchorSteps) {
            for (const anchor of ov.anchorSteps) {
              if (!stepSet.has(anchor.step)) {
                // Warn: overlay references a step that doesn't exist in this workflow.
                // eslint-disable-next-line no-console
                console.warn(
                  `[composer] overlay "${ov.overlayName}" anchors to step "${anchor.step}" which does not exist in workflow "${w.name}" (steps: ${w.steps.join(', ')})`,
                );
                continue;
              }
              const gateName = (ov.overlayName || 'overlay').toUpperCase().replaceAll('-', ' ');
              const directive = GATE_DIRECTIVES[ov.overlayName || ''] || 'see ## Gate Protocols below';
              const label = `── ${gateName} GATE (mandatory) ── ${directive}`;
              if (anchor.position === 'after') {
                const arr = gatesAfter.get(anchor.step) || [];
                arr.push(label);
                gatesAfter.set(anchor.step, arr);
              } else {
                const arr = gatesBefore.get(anchor.step) || [];
                arr.push(label);
                gatesBefore.set(anchor.step, arr);
              }
            }
          }
          if (ov.overlayName && ov.detail) overlayBodies.set(ov.overlayName, ov.detail.trim());
        }

        const stepLines: string[] = [];
        let n = 1;
        for (const step of w.steps) {
          // Insert gates BEFORE this step.
          for (const gate of gatesBefore.get(step) || []) {
            stepLines.push(`  ${n}. ${gate}`);
            n++;
          }

          // The step itself, with override if present.
          const override = overrideMap.get(step);
          const suffix = override ? ` — ${override}` : '';
          stepLines.push(`  ${n}. ${step}${suffix}`);
          n++;

          // Insert gates AFTER this step.
          for (const gate of gatesAfter.get(step) || []) {
            stepLines.push(`  ${n}. ${gate}`);
            n++;
          }
        }

        block += '\n\n' + stepLines.join('\n');
      }

      wfBlocks.push(block);
    }

    parts.push(wfBlocks.join('\n\n'));

    // Render overlay protocol bodies ONCE at the end.
    if (overlayBodies.size > 0) {
      parts.push('## Gate Protocols');
      for (const name of [...overlayBodies.keys()].sort()) {
        parts.push(`### ${name}\n\n${overlayBodies.get(name)}`);
      }
    }
  }

  // --- Skills ---
  if (manifest.skills.length > 0) {
    parts.push('## Skills Available');
    parts.push(
      renderCategorizedList(
        manifest.skills,
        (s) => s.provides,
        (s) => {
          const provides = s.provides.length > 0 ? ` Provides: ${s.provides.join(', ')}.` : '';
          return `- \`/${s.name}\` — ${s.description}${provides}`;
        },
      ),
    );
  }

  // --- Trait Bindings ---
  const bindingKeys = Object.keys(manifest.bindings).sort();
  if (bindingKeys.length > 0) {
    parts.push('## Trait Bindings');
    parts.push(
      bindingKeys
        .map((domain) => {
          const skillName = manifest.bindings[domain];
          const skill = catalog[skillName];
          const qualifiers = skill
            ? skill.provides.filter((t: string) => t.startsWith(domain + '.')).map((t: string) => t.split('.')[1])
            : [];
          const suffix = qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : '';
          return `- \`${domain}\` → \`/${skillName}\`${suffix}`;
        })
        .join('\n'),
    );
  }

  if (manifest.workflows.length > 0 || manifest.skills.length > 0) {
    parts.push('_Invoke a workflow or skill with its slash command. Bodies load on demand._');
  }

  if (extraInstructions?.trim()) {
    parts.push('## Additional Instructions');
    parts.push(extraInstructions.trim());
  }

  return parts.join('\n\n').trimEnd() + '\n';
}
