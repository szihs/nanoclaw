// Discovery: read the distributed coworker-type registry and skill catalog.
//
// Layout (post-refactor):
//   container/skills/<name>/SKILL.md       — capability skills (runtime slash
//                                              commands). May also contribute
//                                              coworker-types.yaml additions.
//   container/workflows/<name>/WORKFLOW.md — workflows (compose-time only;
//                                              full body embedded into CLAUDE.md).
//   container/overlays/<name>/OVERLAY.md   — overlays (compose-time only;
//                                              body inlined at gate anchors).
//   container/spines/<name>/coworker-types.yaml — spine/project coworker-type
//                                                  definitions.
//
// Alphabetical merge per dir tree: later entries extend or override earlier.

import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

import type { CoworkerTypeEntry, OverlayMeta, SkillMeta } from './types.js';

// Directories that may contribute coworker-type registrations. Capability
// skill dirs can add type contributions (e.g. `dashboard-base` appends
// `context:` to `main`). Spine dirs own the root types.
const TYPE_SOURCE_DIRS = [
  ['container', 'spines'],
  ['container', 'skills'],
] as const;

export function readCoworkerTypes(projectRoot = process.cwd()): Record<string, CoworkerTypeEntry> {
  const registry: Record<string, CoworkerTypeEntry> = {};

  for (const parts of TYPE_SOURCE_DIRS) {
    const rootDir = path.join(projectRoot, ...parts);
    if (!fs.existsSync(rootDir)) continue;

    let dirs: string[];
    try {
      dirs = fs.readdirSync(rootDir).sort();
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const typesFile = path.join(rootDir, dir, 'coworker-types.yaml');
      if (!fs.existsSync(typesFile)) continue;
      const loaded = yaml.load(fs.readFileSync(typesFile, 'utf-8'));
      if (!loaded || typeof loaded !== 'object') continue;
      for (const [name, entry] of Object.entries(loaded as Record<string, CoworkerTypeEntry>)) {
        registry[name] = registry[name] ? mergeTypeEntries(registry[name], entry, name) : entry;
      }
    }
  }

  return registry;
}

// Merge a later coworker-types.yaml contribution into an earlier one.
//
// Semantics:
// - scalars (description, project, extends, flat, identity): leaf-wins when
//   the later entry sets them; otherwise keep the earlier value
// - arrays (invariants, context, workflows, skills, overlays): append in
//   discovery order; dedup happens downstream in `resolveCoworkerManifest`
// - bindings: shallow merge, later wins per trait key
function mergeTypeEntries(base: CoworkerTypeEntry, addon: CoworkerTypeEntry, typeName?: string): CoworkerTypeEntry {
  if (typeName && addon.bindings && base.bindings) {
    for (const key of Object.keys(addon.bindings)) {
      if (base.bindings[key] && base.bindings[key] !== addon.bindings[key]) {
        console.warn(
          `Coworker type "${typeName}": binding "${key}" overwritten during merge: "${base.bindings[key]}" → "${addon.bindings[key]}".`,
        );
      }
    }
  }
  return {
    extends: addon.extends ?? base.extends,
    project: addon.project ?? base.project,
    description: addon.description ?? base.description,
    title: addon.title ?? base.title,
    flat: addon.flat ?? base.flat,
    identity: addon.identity ?? base.identity,
    invariants: [...(base.invariants || []), ...(addon.invariants || [])],
    context: [...(base.context || []), ...(addon.context || [])],
    workflows: [...(base.workflows || []), ...(addon.workflows || [])],
    skills: [...(base.skills || []), ...(addon.skills || [])],
    overlays: [...(base.overlays || []), ...(addon.overlays || [])],
    bindings: { ...(base.bindings || {}), ...(addon.bindings || {}) },
    mcpServers: { ...(base.mcpServers || {}), ...(addon.mcpServers || {}) },
  };
}

// Each catalog source: directory + filename to scan + forced type.
// The `forcedType` is the default; SKILL.md in container/skills/ still
// respects `type:` in its frontmatter (for legacy overlay-typed skills,
// though none should remain after the refactor).
interface CatalogSource {
  subdir: string[];
  filename: string;
  forcedType?: SkillMeta['type'];
}

const CATALOG_SOURCES: CatalogSource[] = [
  { subdir: ['container', 'skills'], filename: 'SKILL.md' },
  { subdir: ['container', 'workflows'], filename: 'WORKFLOW.md', forcedType: 'workflow' },
  { subdir: ['container', 'overlays'], filename: 'OVERLAY.md', forcedType: 'overlay' },
];

export function readSkillCatalog(projectRoot = process.cwd()): Record<string, SkillMeta> {
  const catalog: Record<string, SkillMeta> = {};

  for (const source of CATALOG_SOURCES) {
    const rootDir = path.join(projectRoot, ...source.subdir);
    if (!fs.existsSync(rootDir)) continue;

    let dirs: string[];
    try {
      dirs = fs.readdirSync(rootDir).sort();
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const filePath = path.join(rootDir, dir, source.filename);
      if (!fs.existsSync(filePath)) continue;
      const meta = parseSkillMeta(filePath, source.forcedType);
      if (!meta) continue;
      if (catalog[meta.name]) {
        throw new Error(`Duplicate skill name "${meta.name}" at ${filePath} (also at ${catalog[meta.name].path})`);
      }
      catalog[meta.name] = meta;
    }
  }

  return catalog;
}

function parseSkillMeta(filePath: string, forcedType?: SkillMeta['type']): SkillMeta | null {
  const text = fs.readFileSync(filePath, 'utf-8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const raw = yaml.load(match[1]);
  if (!raw || typeof raw !== 'object') return null;
  const fm = raw as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) return null;
  const declaredType: SkillMeta['type'] =
    fm.type === 'workflow' ? 'workflow' : fm.type === 'overlay' ? 'overlay' : 'capability';
  const type: SkillMeta['type'] = forcedType ?? declaredType;
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  const allowedTools = extractAllowedTools(fm['allowed-tools']);
  const usesRaw = fm.uses && typeof fm.uses === 'object' ? (fm.uses as Record<string, unknown>) : {};
  const uses = {
    skills: Array.isArray(usesRaw.skills) ? (usesRaw.skills as unknown[]).map(String) : [],
    workflows: Array.isArray(usesRaw.workflows) ? (usesRaw.workflows as unknown[]).map(String) : [],
  };

  const provides = Array.isArray(fm.provides) ? (fm.provides as unknown[]).map(String) : [];
  const requires = Array.isArray(fm.requires) ? (fm.requires as unknown[]).map(String) : [];
  const extendsWorkflow = typeof fm.extends === 'string' ? fm.extends.trim() || undefined : undefined;

  const overridesRaw =
    fm.overrides && typeof fm.overrides === 'object' ? (fm.overrides as Record<string, unknown>) : {};
  const overrides: Record<string, string> = {};
  for (const [stepId, value] of Object.entries(overridesRaw)) {
    if (typeof value === 'string') overrides[stepId] = value;
  }

  const steps: string[] = [];
  const stepBodies: Record<string, string> = {};
  if (type === 'workflow') {
    const body = text.slice(match[0].length);
    // Capture step ids in order. We match every numbered-list step
    // `N. **Title** [{#id}] — body…` and either use the explicit {#id}
    // or synthesize one from the title. Synthesized ids let workflows
    // skip anchors when no overlay/override needs to target the step,
    // without losing the step's prose from the rendered output.
    const stepHeaderRe = /^(\s*\d+\.\s+\*\*([^*]+)\*\*)(?:\s*\{#([a-z0-9-]+)\})?/gm;
    const positions: { id: string; index: number }[] = [];
    const usedIds = new Set<string>();
    for (const m of body.matchAll(stepHeaderRe)) {
      const explicit = m[3];
      const title = m[2].trim();
      let id = explicit;
      if (!id) {
        const base =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'step';
        id = base;
        let n = 2;
        while (usedIds.has(id)) {
          id = `${base}-${n++}`;
        }
      }
      usedIds.add(id);
      steps.push(id);
      // Anchor at the start of the header match so per-step body extraction
      // below slices from the numbered-bullet line as before.
      positions.push({ id, index: m.index ?? 0 });
    }
    // Extract per-step body: from the step's list-item start (back up to the
    // start of the numbered bullet line) until the next step's bullet start.
    // Pattern: "  1. **Name** {#id} — body...\n...\n\n2. **Next**..." — so we
    // walk from each {#id} backward to the nearest "^N. " or "N) " or bullet
    // on the line, then forward until just before the next such anchor.
    for (let i = 0; i < positions.length; i++) {
      const cur = positions[i];
      // Back up to the start of the line containing this marker.
      let startLine = body.lastIndexOf('\n', cur.index);
      startLine = startLine === -1 ? 0 : startLine + 1;
      // End: just before the next step's line start, or EOF.
      let endLine: number;
      if (i + 1 < positions.length) {
        const next = positions[i + 1];
        let nl = body.lastIndexOf('\n', next.index);
        nl = nl === -1 ? 0 : nl + 1;
        // Trim trailing blank lines between current step body and next step.
        endLine = nl;
      } else {
        // Last step: run until the next `## ` heading (e.g. Resumability) or EOF.
        const tail = body.slice(cur.index);
        const headingMatch = tail.match(/\n## /);
        endLine = headingMatch ? cur.index + (headingMatch.index ?? 0) : body.length;
      }
      stepBodies[cur.id] = body.slice(startLine, endLine).trim();
    }
  }

  let overlay: OverlayMeta | undefined;
  if (type === 'overlay') {
    const appliesTo =
      fm['applies-to'] && typeof fm['applies-to'] === 'object' ? (fm['applies-to'] as Record<string, unknown>) : {};
    const insertAfter = Array.isArray(fm['insert-after']) ? (fm['insert-after'] as unknown[]).map(String) : [];
    const insertBefore = Array.isArray(fm['insert-before']) ? (fm['insert-before'] as unknown[]).map(String) : [];
    const body = text.slice(match[0].length).trim();
    overlay = {
      appliesToWorkflows: Array.isArray(appliesTo.workflows) ? (appliesTo.workflows as unknown[]).map(String) : [],
      appliesToTraits: Array.isArray(appliesTo.traits) ? (appliesTo.traits as unknown[]).map(String) : [],
      insertAfter,
      insertBefore,
      step: body,
    };
  }

  return {
    name,
    type,
    description,
    allowedTools,
    uses,
    path: filePath,
    provides,
    steps,
    stepBodies,
    requires,
    extendsWorkflow,
    overrides,
    overlay,
  };
}

function extractAllowedTools(raw: unknown): string[] {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  const tokens: string[] = [];
  // Greedy MCP token match — handles paren-wrapped bash globs without
  // getting confused by commas inside parens.
  const mcpRe = /mcp__[a-zA-Z0-9_-]+/g;
  for (const m of text.match(mcpRe) || []) tokens.push(m);
  return [...new Set(tokens)];
}
