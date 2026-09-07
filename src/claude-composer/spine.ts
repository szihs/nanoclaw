// Render a resolved CoworkerManifest as CLAUDE.md — the always-in-context
// spine for typed coworkers. Workflows and overlays are embedded verbatim at
// compose time (their full bodies are baked into CLAUDE.md); capability
// skills still load on demand via Claude Code's SKILL.md slash-command
// mechanism.

import fs from 'fs';
import path from 'path';

import { type ComposedSectionInput, renderProjectDoc } from './project-doc.js';
import { readCoworkerTypes, readSkillCatalog } from './registry.js';
import { injectOverlays, resolveCoworkerManifest } from './resolve.js';
import { RUNTIME_CONTRACT_SECTION, renderRuntimeContract } from './runtime-contract.js';
import type { CoworkerManifest, CoworkerTypeEntry, SkillMeta } from './types.js';
import { COMPOSED_DOC_MARKER } from '../group-persona.js';

/** The MCP wrapper's heading, and the group key tying its servers to it. */
const MCP_SECTION = 'MCP Servers';
const MCP_GROUP = 'mcp';

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
// body below the heading; we strip any leading "N. **Title** — " prefix from
// the body so the title isn't repeated twice (once in the heading, once in
// the body's bullet prefix).
function renderStepBlock(n: number, stepId: string, rawBody: string, title: string): string {
  const header = `#### ${n}. ${title}`;
  // Step bodies render under `## Workflows → ### /workflow → #### N. Step`.
  // Any H1 (`# Foo`) inside the raw step body would break the section
  // hierarchy (top-level heading collision with `# Coworker`). Demote H1
  // to H5 so it stays within the step's sub-structure. H2/H3 may be
  // intentional sub-structure in a long step body — leave them.
  const demotedBody = rawBody.replace(/^# /gm, '##### ');
  const cleaned = stripStepAnchors(demotedBody).trim();
  if (!cleaned) return header;
  const lines = cleaned.split('\n');
  // Two-stage strip from line 1: source numbering (we own the count), then
  // a bolded title repeat that matches our heading title (override bodies
  // often start with "**Title** — ..." even without a leading number).
  let firstLine = lines[0];
  const numMatch = firstLine.match(/^\s*\d+[.)]\s+(.*)$/);
  if (numMatch) firstLine = numMatch[1];
  const titleMatch = firstLine.match(/^\s*\*\*([^*\n]+)\*\*\s*(?:\{#[^}]+\})?\s*[—-]?\s*(.*)$/);
  if (titleMatch && titleMatch[1].trim().toLowerCase() === title.trim().toLowerCase()) {
    firstLine = titleMatch[2];
  }
  // When the source step header is `**Title** {#anchor}` on its own line
  // (no inline body), firstLine after stripping is empty. Skip it from
  // the join so the rendered body doesn't get a leading blank-line block,
  // and trimStart any remaining leading whitespace from the actual body.
  const tail = lines
    .slice(1)
    .join('\n')
    .replace(/^\s*\n+/, '');
  const head = firstLine.trim();
  const body = (head ? head + (tail ? '\n' + tail : '') : tail).trimEnd();
  return body ? `${header}\n\n${body}` : header;
}

// Render a gate overlay as an inlined sub-block under the workflow. Overlay
// body markdown headings are demoted so they live below the gate's `####`
// header: `## Foo` becomes `##### Foo`. Prevents overlay sub-headings from
// breaking the outer `## Workflows` section boundary.
function renderGateBlock(
  overlayName: string,
  body: string,
  position: 'BEFORE' | 'AFTER' | 'START',
  stepId: string,
): string {
  const label = `${overlayName.toUpperCase().replaceAll('-', ' ')} GATE`;
  const where =
    position === 'START' ? 'at workflow start' : position === 'BEFORE' ? `before \`${stepId}\`` : `after \`${stepId}\``;
  const demoted = demoteHeadings(body.trim(), 3);
  return `#### ⟐ ${label} (${where})\n\n${demoted}`;
}

// ---- Stage-aware overlay rendering ----
//
// Some overlays organize their body into per-stage
// sections whose headings encode anchor semantics, e.g.:
//
//     ## PLAN_REVIEW (before `patch` in /implement)
//     ## DIAGNOSIS_REVIEW (after `root-cause` or `report`)
//     ## CODE_REVIEW (after `patch`)
//     ## OUTPUT_REVIEW (after `draft` or `write`)
//
// plus shared sections (e.g. `## 3-Round Protocol`, `## Record verdicts`)
// that apply across all stages.
//
// `parseStagedOverlay` parses such bodies into:
//   - stages:  { anchorKey → stage body }, keyed by "before:step" / "after:step"
//   - shared:  string (concatenated non-stage top-level sections)
//   - leading: string (preamble before the first `## ` heading)
// Non-staged overlays return null — caller falls back to full-body emit.
interface StagedOverlay {
  leading: string;
  stagesByAnchor: Map<string, string>; // "before:patch" / "after:report" → body
  shared: string;
}

function parseStagedOverlay(body: string): StagedOverlay | null {
  const lines = body.split('\n');
  const sections: { heading: string; body: string[] }[] = [];
  let leading: string[] = [];
  let current: { heading: string; body: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const m = line.match(/^## (.+)$/);
      if (m) {
        if (current) sections.push(current);
        current = { heading: m[1], body: [] };
        continue;
      }
    }
    if (current) current.body.push(line);
    else leading.push(line);
  }
  if (current) sections.push(current);
  if (sections.length === 0) return null;

  // Heading must match STAGE_NAME (before|after `step1` [or `step2` ...])
  // to qualify as a stage section. Everything else is shared.
  const anchorRe = /^([A-Z][A-Z0-9_]+)\s*\((before|after)\s+`([a-z0-9-]+)`(?:\s+or\s+`([a-z0-9-]+)`)?/;
  const stagesByAnchor = new Map<string, string>();
  const sharedSections: string[] = [];
  let sawStaged = false;
  for (const s of sections) {
    const m = s.heading.match(anchorRe);
    if (!m) {
      sharedSections.push(`## ${s.heading}\n${s.body.join('\n').trimEnd()}`);
      continue;
    }
    sawStaged = true;
    const stageName = m[1];
    const position = m[2];
    // Emit stage header as `**STAGE_NAME**` only — the gate anchor line
    // (rendered by emitGate) already carries the `(before|after \`step\`)`
    // context, so repeating the full heading here produces the stutter
    // `**DIAGNOSIS_REVIEW** — DIAGNOSIS_REVIEW (after \`diagnose\`)`.
    const body = `**${stageName}**\n\n${s.body.join('\n').trim()}`.trim();
    stagesByAnchor.set(`${position}:${m[3]}`, body);
    if (m[4]) stagesByAnchor.set(`${position}:${m[4]}`, body);
  }
  if (!sawStaged) return null; // ordinary overlay — fall back
  return {
    leading: leading.join('\n').trim(),
    stagesByAnchor,
    shared: sharedSections.join('\n\n').trim(),
  };
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

/**
 * Render per-server usage prose from `container.json` `mcpServers[].instructions`.
 *
 * An external MCP server ships its own tool descriptions, but those cannot say
 * "in THIS install, use the staging endpoint" or "never call `delete_*` here".
 * That install-specific prose is what this section carries, and it has to be in
 * context BEFORE the agent reaches for the tool — a prohibition cannot be lazily
 * loaded the way a SKILL.md body can.
 *
 * Server names are sorted so the section is deterministic: the composed document
 * feeds a sha256 staleness comparison, and `Object.entries` order would otherwise
 * make an unrelated config edit look like a content change.
 *
 * Bodies are normalized to `####` (one level below the `### <name>` sub-heading)
 * so operator-authored headings nest instead of escaping the section wrapper.
 * Blank or whitespace-only entries are skipped rather than emitting an empty
 * heading.
 */
function renderMcpInstructions(mcpInstructions: Record<string, string> | undefined): string | undefined {
  const blocks = mcpServerBlocks(mcpInstructions);
  return blocks.length > 0 ? blocks.map((b) => b.body).join('\n\n') : undefined;
}

/**
 * The same blocks, still addressable per server.
 *
 * Each server is already an independent `### <name>` block over a sorted key
 * order, so per-server granularity costs nothing here — and it is what lets the
 * cap ladder evict one oversized server's guidance without deleting every other
 * server's. Whole-section eviction would.
 */
function mcpServerBlocks(mcpInstructions: Record<string, string> | undefined): { name: string; body: string }[] {
  if (!mcpInstructions) return [];

  const blocks: { name: string; body: string }[] = [];
  for (const name of Object.keys(mcpInstructions).sort()) {
    const body = mcpInstructions[name]?.trim();
    if (!body) continue;
    blocks.push({ name, body: `### ${name}\n\n${normalizeFragment(body, 4)}` });
  }

  return blocks;
}

// Normalize a fragment so its top heading sits at `targetMinLevel`. Computes
// the offset from the fragment's own minimum heading level and applies a
// uniform demote so internal hierarchy is preserved. Used at fragment-join
// time in typed mode: identity / invariants / context fragments live under
// `## Wrapper` (h2), so we want their top heading to be h3.
function normalizeFragment(md: string, targetMinLevel: number): string {
  const lines = md.split('\n');
  let inCodeFence = false;
  let minLevel = Infinity;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = line.match(/^(#{1,6}) /);
    if (m) minLevel = Math.min(minLevel, m[1].length);
  }
  if (!isFinite(minLevel) || minLevel >= targetMinLevel) return md;
  return demoteHeadings(md, targetMinLevel - minLevel);
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
    // Render `{{target}}` as `<target>` — the agent reads this as a
    // placeholder to fill from the user's request at runtime. Backticks
    // were considered but break file paths (`/workspace/plans/`target`.md`),
    // angle brackets render cleanly inline and inside paths.
    lines[i] = line.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, name) => `<${name}>`);
  }
  return lines.join('\n');
}

// Substitute compose-time `{{vars.KEY}}` tokens with the coworker's resolved
// `vars` map (CoworkerTypeEntry.vars, merged leaf-wins). Unlike
// rewritePlaceholders, this runs over the WHOLE body INCLUDING fenced code
// blocks — a shared workflow's bash example hard-codes e.g. `{{vars.repo}}`,
// and that must become the real repo. Must run BEFORE rewritePlaceholders so a
// var token is replaced by its value rather than rendered as `<vars.KEY>`. A
// referenced-but-undeclared var throws (compose-time error), so a typo or a
// project that forgot to declare it fails validate:templates loudly instead of
// shipping a literal `{{vars.KEY}}`.
function substituteVars(md: string, vars: Record<string, string>): string {
  return md.replace(/\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    if (!(key in vars)) {
      throw new Error(
        `Template references {{vars.${key}}} but the coworker type declares no such var. ` +
          `Declare it in the type's (or its project-common parent's) \`vars:\` map in coworker-types.yaml.`,
      );
    }
    return vars[key];
  });
}

// Rewrite `/name` references embedded inside workflow / overlay bodies so
// the agent doesn't confuse workflow names (embedded procedures) with skill
// names (runtime slash commands) or overlay names (Task-tool subagents, not
// slash commands). Handles both backticked (`` `/alpha` ``) and unbackticked
// (`Use /alpha for navigation`) source prose.
//
//   /alpha where alpha is a workflow         → "the **alpha** workflow section below"
//   /beta  where beta  is a capability skill → left literal (real slash command)
//   /gamma where gamma is an overlay         → "the **gamma** subagent (spawn via the Task tool)"
//   /delta unknown                           → left literal, warn once at compose time
//
// The unbackticked pass must not mangle filesystem paths (`/workspace/...`),
// bash snippets (`mkdir -p /tmp/x`), or URL paths. Two guards:
//   (1) the preceding char must be start-of-string, whitespace, or `(`.
//   (2) the following char must be a sentence delimiter (whitespace,
//       `.,;:!?)`) or end-of-string.
// That excludes `/a/b/c` because `/b` and `/c` are preceded by a letter,
// not whitespace. Skips fenced code blocks entirely.
function rewriteSlashRefs(
  md: string,
  workflowNames: Set<string>,
  capabilitySkillNames: Set<string>,
  overlayNames: Set<string>,
): string {
  const warned = new Set<string>();

  // Resolve a slash ref to its rewritten form, or return null if it should
  // be left literal (skill, unknown, or not rewritable). Logs one warning
  // per unknown name.
  const resolve = (name: string): string | null => {
    if (workflowNames.has(name)) return `the **${name}** workflow section below`;
    if (overlayNames.has(name)) return `the **${name}** subagent (spawn via the Task tool)`;
    if (capabilitySkillNames.has(name)) return null; // real slash command
    if (!warned.has(name)) {
      warned.add(name);
      // eslint-disable-next-line no-console
      console.warn(
        `[composer] Unknown slash ref /${name} in workflow body — leaving literal. Fix the source WORKFLOW.md/OVERLAY.md.`,
      );
    }
    return null;
  };

  const lines = md.split('\n');
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Pass 1: backticked `/name` refs.
    let rewritten = line.replace(/`\/([a-z][a-z0-9-]*)`/g, (m, name) => {
      const replacement = resolve(name);
      return replacement ?? m;
    });

    // Pass 2: unbackticked /name refs at safe boundaries. We preserve the
    // captured leading char so file paths like `/workspace/agent/foo` do
    // NOT match on the inner `/agent` or `/foo` (the `/a` of `/agent` has
    // a letter before it, not whitespace).
    //
    // Skip markdown ATX headings entirely — the composer itself emits
    // workflow headings as `### /name` and those must stay as-is for the
    // reader to recognize the section.
    if (!/^\s*#{1,6}\s/.test(rewritten)) {
      rewritten = rewritten.replace(/(^|[\s(])\/([a-z][a-z0-9-]*)(?=[\s.,;:!?)]|$)/g, (m, prefix, name) => {
        const replacement = resolve(name);
        if (replacement === null) return m;
        return `${prefix}${replacement}`;
      });
    }

    lines[i] = rewritten;
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

/**
 * Auto-emit a "Projects available" block for Main by scanning the coworker
 * registry for entries that declare `project: <name>`. Groups entries by
 * project slug and renders one `### <project>` section per discovered
 * project listing the leaf coworker types (non-flat, non-`*-common`).
 *
 * Returns an empty string if no projects are registered. No project name
 * is hardcoded — adding a new spine at `container/spines/<name>/` with
 * `project: <name>` in its yaml causes that project to appear in Main
 * automatically on the next compose.
 */
/**
 * Extract a short lead-in from a spine's `identity` file — the first
 * complete sentence, capped at ~200 chars. Returns undefined if the
 * file isn't present or is empty. Used to enrich Main's project block
 * with the spine's actual role description (usually a richer statement
 * than the type's one-line `description:`).
 */
function readIdentityLeadIn(identityPath: string | undefined, projectRoot: string): string | undefined {
  if (!identityPath) return undefined;
  const full = path.join(projectRoot, identityPath);
  let body: string;
  try {
    body = fs.readFileSync(full, 'utf-8').trim();
  } catch {
    return undefined;
  }
  if (!body) return undefined;
  // Strip leading headings — identity files typically start with a
  // paragraph, but be defensive.
  const prose = body.replace(/^(#{1,6}\s+.*\n+)+/m, '').trim();
  // Take the first paragraph (up to blank line) and truncate at a
  // sentence boundary under ~280 chars. One-sentence identities produce
  // a useless one-liner; multi-sentence identities carry the actual
  // project context we want Main to see.
  const firstPara = prose
    .split(/\n\s*\n/)[0]
    .replace(/\n/g, ' ')
    .trim();
  if (!firstPara) return undefined;
  const cap = 280;
  if (firstPara.length <= cap) return firstPara;
  // Over cap — truncate at the last sentence boundary that fits.
  const slice = firstPara.slice(0, cap);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastSentenceEnd > 100) return slice.slice(0, lastSentenceEnd + 1);
  return slice + '...';
}

function emitDiscoveredProjectFragments(types: Record<string, CoworkerTypeEntry>, projectRoot: string): string {
  // Group type names by their `project:` field, then emit a single compact
  // table. Source: spine metadata only — adding a new spine with a `project:`
  // field produces a row automatically; no per-project hardcoding.
  const byProject = new Map<string, string[]>();
  for (const [typeName, entry] of Object.entries(types)) {
    const project = entry.project;
    if (!project) continue;
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project)!.push(typeName);
  }
  if (byProject.size === 0) return '';

  const lines: string[] = ['## Projects available', '', '| Project | Types | Workflows |', '|---|---|---|'];
  const projectNames = [...byProject.keys()].sort();
  for (const project of projectNames) {
    const typeNames = byProject.get(project)!.sort();
    const commonName = typeNames.find((n) => n === `${project}-common`) ?? typeNames[0];
    const leaves = typeNames.filter((n) => n !== commonName && !types[n].flat).sort();

    const typeCell = leaves.map((n) => `\`${n}\``).join(', ') || '—';
    const workflowSet = new Set<string>();
    for (const leaf of leaves) {
      for (const wf of types[leaf]?.workflows ?? []) workflowSet.add(wf);
    }
    const workflowCell =
      [...workflowSet]
        .sort()
        .map((w) => `\`${w}\``)
        .join(', ') || '—';

    lines.push(`| **${project}** | ${typeCell} | ${workflowCell} |`);
  }
  return lines.join('\n');
}

/**
 * The string form, for the callers that only ever wanted a document.
 *
 * Assembly belongs to `renderProjectDoc` now, so this delegates rather than
 * joining anything itself — one assembler, whether a caller wants bytes or
 * sections. Deliberately passes NO cap: these are author-time and script callers
 * (`validate-templates`, `rebuild-claude-md`), where refusing to render an
 * oversized document would report a size problem as a missing document.
 */
export function renderCoworkerSpine(
  projectRoot: string,
  coworkerType: string,
  extraInstructions: string | null | undefined,
  opts: {
    disableOverlays?: boolean;
    overlays?: string[];
    cliScope?: 'disabled' | 'group' | 'global';
    mcpInstructions?: Record<string, string>;
  } = {},
): string {
  return renderProjectDoc(composedDocHeader(), {
    fileName: 'CLAUDE.md',
    extraSections: asNonEmpty(renderCoworkerSections(projectRoot, coworkerType, extraInstructions, opts)),
  }).content;
}

/**
 * The same composition, stopping one step short of a document.
 *
 * This is the seam. Producers describe sections; the caller chooses the cap and
 * what to do when it is exceeded. `container-runner.ts` passes one, because a
 * spawned agent whose document Claude Code silently skips in full is exactly the
 * failure the cap exists to prevent.
 */
export function renderCoworkerSections(
  projectRoot: string,
  coworkerType: string,
  extraInstructions: string | null | undefined,
  opts: {
    disableOverlays?: boolean;
    overlays?: string[];
    cliScope?: 'disabled' | 'group' | 'global';
    mcpInstructions?: Record<string, string>;
  } = {},
): ComposedSectionInput[] {
  // cliScope gates inclusion of the `ncl-*.md` tool-instruction fragments.
  //   'disabled' → strip every ncl-*.md from context (agent has no CLI access)
  //   'group'    → keep ncl-group.md, drop ncl-global.md
  //   'global'   → keep both (typically only Main / owner agents)
  // Filtering happens after fragment load by matching the rendered text
  // against the fragment's own H2 heading, since manifest.context is a
  // string array — the path is gone by then.
  const cliScope = opts.cliScope ?? 'group';
  const types = readCoworkerTypes(projectRoot);
  const catalog = readSkillCatalog(projectRoot);
  const manifest = resolveCoworkerManifest(types, coworkerType, catalog, projectRoot, { cliScope });

  // Inject per-agent overlays from DB (agent_groups.overlays column).
  if (opts.overlays && opts.overlays.length > 0) {
    injectOverlays(manifest, opts.overlays, catalog);
  }

  // Per-coworker overlay disable: strip every overlay customization attached
  // to workflows before rendering. Drops all `⟐ ... GATE` inline blocks and
  // the trailing `## Gate Protocol` section. Honors `agent_groups.disable_overlays`
  // passed from container-runner.ts.
  //
  // No-op when the coworker has no overlays in its type chain *and* no
  // runtime overlays were injected via agent_groups.overlays — there's
  // simply nothing to strip. Common case for vanilla typed coworkers.
  if (opts.disableOverlays) {
    manifest.customizations = manifest.customizations.filter((c) => c.kind !== 'overlay');
  }

  // Both render paths get the contract: `main` is `flat: true` and returns
  // early, so computing it here is what keeps the admin orchestrator from being
  // the one coworker without it.
  const contract = renderRuntimeContract(projectRoot);

  if (manifest.flat) {
    // Flat mode: emit identity (body file) + context fragments (skill
    // contributions via `context:` in their coworker-types.yaml), verbatim,
    // separated by horizontal rules.
    //
    // For the 'main' type, additionally auto-emit a per-project "Projects
    // available" block summarizing any project spines present in the
    // install. This is pure discovery — no project is hardcoded anywhere.
    // Adding a new project (e.g. container/spines/nv-graphics/ with
    // `project: graphics` in its yaml) automatically shows up here.
    // Flat bodies carry their own headings, so the contract joins them as a peer
    // `##` section rather than nesting under a wrapper. It goes AFTER the
    // identity body, not before it: in flat mode the identity carries the
    // document's `# Title` (`main-body.md:1`), so leading with an `##` section
    // would emit a subsection above the H1.
    const contractBody = contract ? [`## ${RUNTIME_CONTRACT_SECTION}\n\n${contract}`] : [];
    const bodies = [manifest.identity, ...contractBody, ...manifest.context].map((b) => b.trim()).filter(Boolean);
    if (coworkerType === 'main') {
      const projectsBlock = emitDiscoveredProjectFragments(types, projectRoot);
      if (projectsBlock) bodies.push(projectsBlock);
    }
    // Same section, same reason, on this path too: `main` is the only flat type,
    // and an admin orchestrator with wired MCP servers needs their usage prose as
    // much as a typed coworker does.
    // Everything on this path is verbatim: flat bodies carry their own headings,
    // and the identity body owns the document's `# Title` (`main-body.md:1`).
    // One lifecycle rule, two renderings — the wrapper is a `group-header` here
    // too, but `verbatim`, because its body already carries `## MCP Servers`.
    const flatSections: ComposedSectionInput[] = bodies.map((b, i) =>
      i === 0
        ? { role: 'title', droppable: false, name: manifest.title, heading: { kind: 'verbatim' }, body: b }
        : { role: 'body', droppable: false, name: `flat-${i}`, heading: { kind: 'verbatim' }, body: b },
    );

    const flatMcp = mcpServerBlocks(opts.mcpInstructions);
    if (flatMcp.length > 0) {
      flatSections.push({
        role: 'group-header',
        droppable: false,
        group: MCP_GROUP,
        name: MCP_SECTION,
        heading: { kind: 'verbatim' },
        body: `## ${MCP_SECTION}`,
      });
      for (const block of flatMcp) {
        flatSections.push({
          role: 'body',
          droppable: true,
          group: MCP_GROUP,
          name: `MCP Server: ${block.name}`,
          heading: { kind: 'verbatim' },
          body: block.body,
        });
      }
    }

    const extra = extraInstructions?.trim();
    if (extra) {
      flatSections.push({
        role: 'persona',
        droppable: false,
        name: 'Additional Instructions',
        heading: { kind: 'verbatim' },
        body: extra,
      });
    }
    // Section boundaries are H2 headings inside each fragment — no `---`
    // separators. Horizontal rules between every fragment created visual
    // noise without adding structure that the headings didn't already carry.
    return flatSections;
  }

  // Sections rather than raw strings: `sectionsToParts` below flattens them back
  // into the `parts` shape `renderDocument` still consumes, so this step changes
  // no composed byte while giving the cap ladder something it can rank and evict.
  const sections: ComposedSectionInput[] = [];
  sections.push({
    role: 'title',
    droppable: false,
    name: manifest.title,
    heading: { kind: 'titled', level: 1 },
    body: '',
  });

  // Before Identity, matching the §4.3 ownership table and upstream's composer:
  // the contract states environment facts (where attachments land, where memory
  // lives) that hold for every coworker, so they precede this type's own
  // material rather than trailing it.
  if (contract) {
    sections.push(section(RUNTIME_CONTRACT_SECTION, contract));
  }

  // Fragments are normalized to start at h3 so they nest correctly under
  // their ## h2 wrapper regardless of how they were authored. Without this,
  // fragments authored at # or ## (e.g. context/chain-reporting.md, slang's
  // skill-discovery.md) leak their headings out to the top of the document.
  sections.push(section('Identity', normalizeFragment(manifest.identity, 3)));

  if (manifest.invariants.length > 0) {
    sections.push(section('Invariants', manifest.invariants.map((f) => normalizeFragment(f, 3)).join('\n\n')));
  }

  if (manifest.context.length > 0) {
    sections.push(section('Context', manifest.context.map((f) => normalizeFragment(f, 3)).join('\n\n')));
  }

  // Build name lookups for slash-rewrite. Three distinct resolutions:
  //   workflows           → embedded procedures, rewrite to section refs
  //   capability skills   → runtime slash commands, leave literal
  //   overlays (agent.md) → Task-tool subagents, rewrite accordingly
  const workflowNames = new Set(manifest.workflows.map((w) => w.name));
  // Also treat extends-chain parents as known names. A typed coworker that
  // has /slang-plan inherits /plan's body; that body's prose may say "run
  // `/plan`" referring to the parent concept. Without this, the slash-rewrite
  // would warn "Unknown slash ref /plan" for every typed coworker that
  // extends a base workflow.
  for (const w of manifest.workflows) {
    let cur = catalog[w.name];
    while (cur?.extendsWorkflow) {
      workflowNames.add(cur.extendsWorkflow);
      cur = catalog[cur.extendsWorkflow];
    }
  }
  const capabilitySkillNames = new Set(manifest.skills.map((s) => s.name));
  const overlayNames = new Set<string>();
  for (const meta of Object.values(catalog) as SkillMeta[]) {
    if (meta.type === 'overlay') overlayNames.add(meta.name);
  }

  // --- Task routing guide (every workflow, no category dedup) ---
  // Each entry uses the workflow's own description's first sentence as the
  // trigger label — generic per-trait labels collide when two workflows in
  // the same category coexist (e.g. /slang-plan + /slang-maintain both
  // dominate to `repo`). First-sentence labels are workflow-distinct by
  // construction. Truncated at ~120 chars to keep the index scannable.
  if (manifest.workflows.length > 0) {
    const routeLines: string[] = [];
    for (const w of manifest.workflows) {
      const desc = (w.description || '').trim();
      const firstSentenceMatch = desc.match(/^[^.!?]*[.!?]/);
      let label = (firstSentenceMatch ? firstSentenceMatch[0] : desc).trim().replace(/[.!?]$/, '');
      if (label.length > 120) label = label.slice(0, 117).trimEnd() + '…';
      if (!label) label = `Run /${w.name}`;
      routeLines.push(`- ${label} → \`/${w.name}\` workflow`);
    }
    sections.push(
      section(
        'How to Work',
        routeLines.join('\n') +
          '\n\nAlways start with a workflow. Never jump straight to code.' +
          '\nWorkflow bodies are embedded below — follow the steps inline. Workflows are not slash commands.' +
          (extraInstructions?.trim()
            ? '\nYour role-specific standing orders: [Additional Instructions](#additional-instructions)'
            : ''),
      ),
    );
  }

  // --- Workflows: full body embedded with inline overlay gates ---
  //
  // Assembly order: we render workflow bodies first (which populates
  // `sharedGateState` from staged-overlay anchors), then emit the
  // `## Gate Protocol` section BEFORE `## Workflows` so the reader learns
  // the gate protocol before hitting inline `⟐ ... GATE` blocks. The
  // workflow output is buffered into `wfOutput` and pushed after the
  // gate block.
  if (manifest.workflows.length > 0) {
    const wfBlocks: string[] = [];

    // Gate rendering state:
    //   emittedOverlay   — for non-staged overlays, first anchor emits full
    //                      body and later anchors point back (existing dedup).
    //   stagedCache      — cache the `parseStagedOverlay` result per overlay.
    //   sharedGateState  — for STAGED overlays, collects the overlay's
    //                      leading + shared-section text exactly once. Emitted
    //                      as a single `## Gate Protocol` block after all
    //                      workflow blocks.
    const emittedOverlay = new Map<string, { workflowName: string; stepId: string }>();
    const stagedCache = new Map<string, StagedOverlay | null>();
    const sharedGateState = new Map<string, { leading: string; shared: string }>();

    for (const w of manifest.workflows) {
      const wfCustomizations = manifest.customizations.filter((c) => c.workflow === w.name);
      const extendsC = wfCustomizations.find((c) => c.kind === 'extends');
      const overrides = wfCustomizations.filter((c) => c.kind === 'override');
      const overlays = wfCustomizations.filter((c) => c.kind === 'overlay');

      const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
      // Extends-note surfaces the base workflow's literal slash form so the
      // Workflows listing reads as a cross-reference. An em-dash separator
      // keeps rewriteSlashRefs pass-2 from matching (its boundary pattern
      // requires a whitespace/punct/`)` char after the name; U+2014 is none
      // of those), so no phantom "Unknown slash ref" warnings fire for the
      // parent workflow name — which isn't in this coworker's own workflow
      // set. The slash-dash-name shape still reads unambiguously as a
      // reference to the embedded parent section.
      const extendsNote = extendsC?.extendsWorkflow ? ` (extends /${extendsC.extendsWorkflow}—see section below)` : '';
      let block = `### /${w.name}\n\n${w.description}${uses}${extendsNote}`;

      // Prologue: workflow's top-of-doc framing prose (IMPORTANT callouts,
      // mode notes, framing) lifted from the source body. Renders between the
      // description line and the numbered steps so the agent sees it before
      // executing the workflow.
      if (w.prologue) {
        // Headings inside the prologue need to nest under the workflow's H3
        // wrapper (### /name) — demote H1/H2 by 2 levels so an authored `# Foo`
        // becomes `### Foo` under the workflow heading.
        block += '\n\n' + normalizeFragment(w.prologue, 4);
      }

      if (w.steps.length > 0) {
        // Override lookup by stepId.
        const overrideMap = new Map<string, string>();
        for (const o of overrides) {
          if (o.stepId) overrideMap.set(o.stepId, (o.detail || '').trim());
        }

        // Overlay anchor maps: stepId → full bodies to emit before/after.
        // The synthetic `start` anchor is collected separately and rendered
        // ahead of step 1 below.
        const stepSet = new Set(w.steps);
        const gatesAfter = new Map<string, { overlayName: string; body: string }[]>();
        const gatesBefore = new Map<string, { overlayName: string; body: string }[]>();
        const gatesAtStart: { overlayName: string; body: string }[] = [];
        for (const ov of overlays) {
          if (!ov.anchorSteps || !ov.overlayName || !ov.detail) continue;
          for (const anchor of ov.anchorSteps) {
            const entry = { overlayName: ov.overlayName, body: ov.detail.trim() };
            if (anchor.position === 'start') {
              gatesAtStart.push(entry);
              continue;
            }
            if (!stepSet.has(anchor.step)) continue;
            const map = anchor.position === 'after' ? gatesAfter : gatesBefore;
            const arr = map.get(anchor.step) || [];
            arr.push(entry);
            map.set(anchor.step, arr);
          }
        }

        const chunks: string[] = [];
        // Workflow-start gates: render once, ahead of step 1. Use a synthetic
        // anchor label so the inline marker reads naturally ("at start") and
        // the dedup map (`emittedOverlay`) treats it as a normal anchor site.
        for (const gate of gatesAtStart) {
          chunks.push(
            emitGate(emittedOverlay, stagedCache, sharedGateState, gate.overlayName, gate.body, 'START', '', w.name),
          );
        }
        let n = 1;
        for (const stepId of w.steps) {
          // BEFORE gates.
          for (const gate of gatesBefore.get(stepId) || []) {
            chunks.push(
              emitGate(
                emittedOverlay,
                stagedCache,
                sharedGateState,
                gate.overlayName,
                gate.body,
                'BEFORE',
                stepId,
                w.name,
              ),
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
              emitGate(
                emittedOverlay,
                stagedCache,
                sharedGateState,
                gate.overlayName,
                gate.body,
                'AFTER',
                stepId,
                w.name,
              ),
            );
          }
        }

        block += '\n\n' + chunks.join('\n\n');
      }

      // Epilogue: cross-mode notes / `## Mode invariants` block authored
      // after the last step. Same heading-normalize as the prologue so any
      // `## Sub-heading` nests under the workflow's H3.
      if (w.epilogue) {
        block += '\n\n' + normalizeFragment(w.epilogue, 4);
      }

      wfBlocks.push(block);
    }

    // Run the slash-rewrite once over the entire workflow block so that
    // backticked `/workflow` refs become section refs and `/overlay` refs
    // become Task-tool subagent pointers. Capability skill refs stay literal.
    const wfJoined = wfBlocks.join('\n\n');
    const slashRewritten = rewriteSlashRefs(wfJoined, workflowNames, capabilitySkillNames, overlayNames);
    const wfVarSubbed = substituteVars(slashRewritten, manifest.vars);
    const wfOutput = rewritePlaceholders(wfVarSubbed);

    // Emit shared gate protocols for every staged overlay whose stages
    // appeared as inline anchors above. Each overlay contributes one
    // `### <OVERLAY> Gate Protocol` subsection under a single top-level
    // `## Gate Protocol` heading. This keeps cross-stage content (3-round
    // protocol, record-verdicts steps, etc.) in one place per coworker
    // instead of repeating it at every anchor.
    //
    // Gate Protocol is pushed BEFORE `## Workflows` so the reader sees the
    // protocol definition before inline `⟐ ... GATE` anchors reference it.
    if (sharedGateState.size > 0) {
      const blocks: string[] = [];
      for (const [overlayName, { leading, shared }] of sharedGateState) {
        const title = overlayName.toUpperCase().replaceAll('-', ' ');
        const pieces = [leading, shared].filter(Boolean).join('\n\n').trim();
        if (!pieces) continue;
        // Demote by 2: overlay body `## Foo` → `#### Foo`, sitting one
        // level below the `### Gate Protocol` wrapper. Previously demoted
        // by 3 (→ `##### Foo`) which skipped h4 and left a visual gap.
        blocks.push(`### ${title} Gate Protocol\n\n${demoteHeadings(pieces, 2)}`);
      }
      if (blocks.length > 0) {
        // Never droppable: these carry mandatory safety gates, so evicting them
        // to fit a size cap would silently disable enforcement the document
        // still claims applies. Deliberate divergence from upstream's ranking.
        sections.push(section('Gate Protocol', blocks.join('\n\n')));
      }
    }

    sections.push(section('Workflows', wfOutput));
  }

  // --- Skills ---
  // Every inherited capability skill is listed (slash-invoked, loaded on demand
  // via Claude Code's progressive skill discovery). The list is categorized by
  // the skill's `provides:` traits — bound skills land under their domain
  // heading (Repo, Code, Test, …), unbound skills (e.g. `base-nanoclaw` host
  // tools) land under "Other" so they're still visible to the reader.
  if (manifest.skills.length > 0) {
    sections.push(
      section(
        'Skills',
        renderCategorizedList(
          manifest.skills,
          (s) => s.provides,
          (s) => `- \`/${s.name}\` — ${s.description}`,
        ),
      ),
    );
  }
  // Footer dropped — `container/spines/base/context/invocation.md` already
  // covers the "skills are slash commands / workflows are embedded" split.

  // Per-server MCP guidance, after Skills because it is the same kind of thing
  // (how to use a tool you have) and before Additional Instructions so the
  // operator's persona still has the last word.
  // Grouped, not one block: the wrapper is a `group-header` and each server is a
  // droppable member of that group. The header is built ONLY when it has at least
  // one member, so a group with no configured servers is absent rather than
  // reported as "omitted for size" — every in-tree type wires none, and the
  // ladder must not log a phantom omission on each of their spawns.
  const mcpBlocks = mcpServerBlocks(opts.mcpInstructions);
  if (mcpBlocks.length > 0) {
    sections.push({
      role: 'group-header',
      droppable: false,
      group: MCP_GROUP,
      name: MCP_SECTION,
      heading: { kind: 'titled', level: 2 },
      body: '',
    });
    for (const block of mcpBlocks) {
      sections.push({
        role: 'body',
        droppable: true,
        group: MCP_GROUP,
        // Upstream's naming, so an eviction log line reads the same on both.
        name: `MCP Server: ${block.name}`,
        heading: { kind: 'verbatim' },
        body: block.body,
      });
    }
  }

  if (extraInstructions?.trim()) {
    sections.push({
      role: 'persona',
      droppable: false,
      name: 'Additional Instructions',
      heading: { kind: 'titled', level: 2 },
      // Normalize so any operator-authored `## Foo` headings nest under our
      // `## Additional Instructions` wrapper (they should be `### Foo`).
      body: normalizeFragment(extraInstructions.trim(), 3),
    });
  }

  return sections;
}

/**
 * The composed-document header, prepended by the assembler.
 *
 * Both the flat and the inherited path route through one assembler now, so
 * neither can lose the marker — `main` is `flat: true` and returns early, which
 * is exactly how the first attempt at this missed the admin orchestrator.
 *
 * The marker makes the document self-identifying as composer output. Two
 * consumers depend on it: the persona migration in `container-runner.ts` (a
 * composed document must never be mistaken for hand-written standing
 * instructions) and `.claude/skills/migrate-memory` (generated boilerplate vs
 * memory). It deliberately carries no timestamp — the composed text feeds a
 * sha256 staleness comparison, so a clock would make every spawn look stale.
 */
export function composedDocHeader(): string {
  return `${COMPOSED_DOC_MARKER} — do not edit; edit instructions.prepend.md -->`;
}

/** An ordinary non-droppable `##` section — the shape most producers want. */
function section(name: string, body: string): ComposedSectionInput {
  return { role: 'body', droppable: false, name, heading: { kind: 'titled', level: 2 }, body };
}

/**
 * Narrow to the non-empty tuple `ProjectDocSpec` requires.
 *
 * A producer that returned nothing would otherwise compose a header-only
 * document, which `assertComposedDocUsable` accepts as usable (it checks
 * `trim().length > 0`) — so a group would spawn with no instructions at all, and
 * silently. `renderProjectDoc` re-checks; this exists so the type is honest at
 * the call site rather than relying on a cast.
 */
export function asNonEmpty(
  sections: ComposedSectionInput[],
): readonly [ComposedSectionInput, ...ComposedSectionInput[]] {
  if (sections.length === 0) throw new Error('Composed document has no sections');
  return sections as [ComposedSectionInput, ...ComposedSectionInput[]];
}

// Emit a gate block. Uses stage-aware rendering when the overlay body
// encodes anchor semantics (see `parseStagedOverlay`); otherwise falls back
// to first-body-full / later-pointer dedup.
//
// Stage-aware mode: each anchor site emits ONLY the matching stage section
// (e.g. the `insert-after: patch` anchor gets just the CODE_REVIEW body,
// not the PLAN_REVIEW + DIAGNOSIS_REVIEW + OUTPUT_REVIEW siblings). Shared
// sections are deduped to a single trailing `## Gate Protocol` block per
// coworker, collected in `sharedGateSections`.
function emitGate(
  seen: Map<string, { workflowName: string; stepId: string }>,
  staged: Map<string, StagedOverlay | null>,
  sharedGateSections: Map<string, { leading: string; shared: string }>,
  overlayName: string,
  body: string,
  position: 'BEFORE' | 'AFTER' | 'START',
  stepId: string,
  workflowName: string,
): string {
  // Cache the parse per overlay.
  if (!staged.has(overlayName)) {
    staged.set(overlayName, parseStagedOverlay(body));
  }
  const parsed = staged.get(overlayName);

  const label = `${overlayName.toUpperCase().replaceAll('-', ' ')} GATE`;
  const where =
    position === 'START' ? 'at workflow start' : position === 'BEFORE' ? `before \`${stepId}\`` : `after \`${stepId}\``;

  if (parsed) {
    // Stage-aware: find the matching stage body.
    const key = `${position.toLowerCase()}:${stepId}`;
    const stageBody = parsed.stagesByAnchor.get(key);
    // Collect the shared + leading sections exactly once per overlay.
    if (!sharedGateSections.has(overlayName)) {
      sharedGateSections.set(overlayName, { leading: parsed.leading, shared: parsed.shared });
    }
    if (stageBody) {
      return `#### ⟐ ${label} (${where})\n\n${demoteHeadings(stageBody, 3)}`;
    }
    // Anchor defined but no stage match in the parsed body — emit a minimal
    // pointer so the agent still sees the gate marker.
    return (
      `#### ⟐ ${label} (${where})\n\n` +
      // "above", not "below": this pointer is emitted INSIDE a workflow body, and
      // the shared `## Gate Protocol` section is pushed before `## Workflows`
      // (`:991` then `:995`) — so it precedes every workflow that points at it. The
      // old wording sent the reader forward past the end of the document.
      `Apply the **${label}** protocol (see the shared **Gate Protocol** section above).`
    );
  }

  // Non-staged overlay: first anchor emits full body, subsequent anchors
  // point back to the first emission.
  if (!seen.has(overlayName)) {
    seen.set(overlayName, { workflowName, stepId });
    return renderGateBlock(overlayName, body, position, stepId);
  }
  const first = seen.get(overlayName)!;
  return (
    `#### ⟐ ${label} (${where})\n\n` +
    `Follow the **${label}** protocol documented under the **${first.workflowName}** ` +
    `workflow (step \`${first.stepId}\`). Every stage's procedure applies — match ` +
    `the stage to the anchor type (before/after which step triggered this gate).`
  );
}
