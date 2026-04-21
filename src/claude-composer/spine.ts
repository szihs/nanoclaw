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
const CATEGORY_ORDER = ['vcs', 'code', 'test', 'ci', 'research', 'critique', 'other'] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_HEADINGS: Record<Category, string> = {
  vcs: 'VCS',
  code: 'Code',
  test: 'Test',
  ci: 'CI',
  research: 'Research',
  critique: 'Critique',
  other: 'Other',
};

const TRAIT_TO_CATEGORY: Record<string, Category> = {
  'vcs-read': 'vcs',
  'vcs-write': 'vcs',
  'vcs-pr': 'vcs',
  'code-read': 'code',
  'code-edit': 'code',
  'code-build': 'code',
  'test-run': 'test',
  'test-gen': 'test',
  'ci-inspect': 'ci',
  'ci-rerun': 'ci',
  research: 'research',
  'issue-tracker': 'research',
  'doc-read': 'research',
  'doc-write': 'research',
  critique: 'critique',
};

// Pick the dominant category for an entry by counting how many of its traits
// fall into each bucket. Ties resolve via CATEGORY_ORDER (earlier wins), so
// a workflow that pulls from [vcs-read, ci-inspect] is classified CI only if
// CI trait count strictly exceeds VCS — otherwise VCS wins by order.
function categorize(traits: readonly string[]): Category {
  if (traits.length === 0) return 'other';
  const counts = new Map<Category, number>();
  for (const trait of traits) {
    const cat = TRAIT_TO_CATEGORY[trait] ?? 'other';
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

  if (manifest.workflows.length > 0) {
    parts.push('## Workflows Available');
    parts.push(
      renderCategorizedList(
        manifest.workflows,
        (w) => w.requires,
        (w) => {
          const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
          const requires = w.requires.length > 0 ? ` Requires traits: ${w.requires.join(', ')}.` : '';
          const steps = w.steps.length > 0 ? `\n  Steps: ${w.steps.join(' → ')}` : '';
          return `- \`/${w.name}\` — ${w.description}${uses}${requires}${steps}`;
        },
      ),
    );
  }

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

  const bindingKeys = Object.keys(manifest.bindings).sort();
  if (bindingKeys.length > 0) {
    parts.push('## Trait Bindings');
    parts.push(bindingKeys.map((trait) => `- \`${trait}\` → \`/${manifest.bindings[trait]}\``).join('\n'));
  }

  if (manifest.customizations.length > 0) {
    parts.push('## Workflow Customizations');
    const blocks: string[] = [];
    for (const c of manifest.customizations) {
      if (c.detail && c.detail.trim()) {
        blocks.push(`- ${c.summary}\n\n${indentBlock(c.detail.trim(), 2)}`);
      } else {
        blocks.push(`- ${c.summary}`);
      }
    }
    parts.push(blocks.join('\n\n'));
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
