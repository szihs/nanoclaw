// Discovery: read the distributed coworker-type registry and skill catalog
// from container/skills/<skill>/. Alphabetical merge: later skills can extend
// or override earlier ones.

import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

import type { CoworkerTypeEntry, OverlayMeta, SkillMeta } from './types.js';

export function readCoworkerTypes(projectRoot = process.cwd()): Record<string, CoworkerTypeEntry> {
  const registry: Record<string, CoworkerTypeEntry> = {};
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (!fs.existsSync(skillsDir)) return registry;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(skillsDir).sort();
  } catch {
    return registry;
  }

  for (const dir of dirs) {
    const typesFile = path.join(skillsDir, dir, 'coworker-types.yaml');
    if (!fs.existsSync(typesFile)) continue;
    const loaded = yaml.load(fs.readFileSync(typesFile, 'utf-8'));
    if (!loaded || typeof loaded !== 'object') continue;
    for (const [name, entry] of Object.entries(loaded as Record<string, CoworkerTypeEntry>)) {
      registry[name] = registry[name] ? mergeTypeEntries(registry[name], entry, name) : entry;
    }
  }

  return registry;
}

// Merge a later coworker-types.yaml contribution into an earlier one.
//
// Discovery order is alphabetical by skill directory. "Later" means "comes
// later in the sorted list". Semantics:
// - scalars (description, project, extends, flat, identity): leaf-wins when
//   the later entry sets them; otherwise keep the earlier value
// - arrays (invariants, context, workflows, skills, overlays): append in
//   discovery order; dedup happens downstream in `resolveCoworkerManifest`
// - bindings: shallow merge, later wins per trait key
//
// This lets an addon skill extend an existing type (e.g. dashboard-base
// contributes `context:` to `main`) without owning it.
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

export function readSkillCatalog(projectRoot = process.cwd()): Record<string, SkillMeta> {
  const catalog: Record<string, SkillMeta> = {};
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (!fs.existsSync(skillsDir)) return catalog;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(skillsDir).sort();
  } catch {
    return catalog;
  }

  for (const dir of dirs) {
    const skillFile = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const meta = parseSkillMeta(skillFile);
    if (!meta) continue;
    if (catalog[meta.name]) {
      throw new Error(`Duplicate skill name "${meta.name}" at ${skillFile} (also at ${catalog[meta.name].path})`);
    }
    catalog[meta.name] = meta;
  }
  return catalog;
}

function parseSkillMeta(filePath: string): SkillMeta | null {
  const text = fs.readFileSync(filePath, 'utf-8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const raw = yaml.load(match[1]);
  if (!raw || typeof raw !== 'object') return null;
  const fm = raw as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name) return null;
  const type: SkillMeta['type'] =
    fm.type === 'workflow' ? 'workflow' : fm.type === 'overlay' ? 'overlay' : 'capability';
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
  if (type === 'workflow') {
    const body = text.slice(match[0].length);
    for (const m of body.matchAll(/\{#([a-z0-9-]+)\}/g)) {
      steps.push(m[1]);
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
