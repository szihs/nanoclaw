import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Legacy 6-section model (used only for `main` and `global` manifests — the
// two static documents in the repo that aren't coworker-typed). Typed
// coworkers use the lego spine model further down.
// ---------------------------------------------------------------------------

interface ManifestConfig {
  base: string;
  sections?: string[];
  project_overlays?: boolean;
}

export type PromptSectionName = 'role' | 'capabilities' | 'workflow' | 'constraints' | 'formatting' | 'resources';

const PROMPT_SECTION_ORDER: PromptSectionName[] = [
  'role',
  'capabilities',
  'workflow',
  'constraints',
  'formatting',
  'resources',
];

const PROMPT_SECTION_HEADINGS: Record<PromptSectionName, string> = {
  role: 'Role',
  capabilities: 'Capabilities',
  workflow: 'Workflow',
  constraints: 'Constraints',
  formatting: 'Formatting',
  resources: 'Resources',
};

interface PromptDocument {
  title: string;
  sections: Record<PromptSectionName, string[]>;
}

interface MergeState {
  seen: Set<string>;
}

interface PromptTemplateConfig {
  role?: string;
  capabilities?: string;
  workflow?: string;
  constraints?: string;
  formatting?: string;
  resources?: string;
}

// ---------------------------------------------------------------------------
// Lego model: spine fragments + workflows + skills, all composed into a thin
// always-in-context CLAUDE.md for typed coworkers.
// ---------------------------------------------------------------------------

export interface CoworkerTypeEntry {
  extends?: string | string[];
  project?: string;
  description?: string;

  // Spine fragments (paths relative to projectRoot).
  identity?: string;
  invariants?: string[];
  context?: string[];

  // Skill catalog references (SKILL.md `name` values under container/skills/).
  workflows?: string[];
  skills?: string[];
}

export interface SkillMeta {
  name: string;
  type: 'capability' | 'workflow';
  description: string;
  allowedTools: string[];
  uses: { skills: string[]; workflows: string[] };
  path: string;
}

export interface CoworkerManifest {
  typeName: string;
  title: string;
  identity: string;
  invariants: string[];
  context: string[];
  workflows: { name: string; description: string; uses: string[] }[];
  skills: { name: string; description: string }[];
  tools: string[];
}

export interface ComposeClaudeMdOptions {
  projectRoot?: string;
  manifestName: 'main' | 'global' | 'coworker';
  coworkerType?: string | null;
  extraInstructions?: string | null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

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
      if (registry[name]) {
        throw new Error(`Duplicate coworker type "${name}" found in ${typesFile}`);
      }
      registry[name] = entry;
    }
  }

  return registry;
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
  const type = fm.type === 'workflow' ? 'workflow' : 'capability';
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  const allowedTools = extractAllowedTools(fm['allowed-tools']);
  const usesRaw = fm.uses && typeof fm.uses === 'object' ? (fm.uses as Record<string, unknown>) : {};
  const uses = {
    skills: Array.isArray(usesRaw.skills) ? (usesRaw.skills as unknown[]).map(String) : [],
    workflows: Array.isArray(usesRaw.workflows) ? (usesRaw.workflows as unknown[]).map(String) : [],
  };
  return { name, type, description, allowedTools, uses, path: filePath };
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

// ---------------------------------------------------------------------------
// Type-chain resolution
// ---------------------------------------------------------------------------

function normalizeList<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x): x is T => x !== null && x !== undefined);
  return [v];
}

function validateCrossProjectExtends(types: Record<string, CoworkerTypeEntry>): void {
  for (const [name, entry] of Object.entries(types)) {
    if (!entry.project) continue;
    for (const parent of normalizeList(entry.extends)) {
      const parentEntry = types[parent];
      if (parentEntry?.project && parentEntry.project !== entry.project) {
        throw new Error(
          `Cross-project extends: "${name}" (project: ${entry.project}) cannot extend "${parent}" (project: ${parentEntry.project})`,
        );
      }
    }
  }
}

export function resolveTypeChain(types: Record<string, CoworkerTypeEntry>, typeName: string): CoworkerTypeEntry[] {
  const chain: CoworkerTypeEntry[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  function visit(current: string): void {
    if (seen.has(current) || visiting.has(current)) return;
    visiting.add(current);
    const entry = types[current];
    if (!entry) {
      visiting.delete(current);
      return;
    }
    for (const parent of normalizeList(entry.extends)) {
      visit(parent);
    }
    chain.push(entry);
    visiting.delete(current);
    seen.add(current);
  }

  visit(typeName);
  return chain;
}

export function resolveCoworkerManifest(
  types: Record<string, CoworkerTypeEntry>,
  typeName: string,
  catalog: Record<string, SkillMeta>,
  projectRoot: string,
): CoworkerManifest {
  validateCrossProjectExtends(types);

  const roles = typeName
    .split('+')
    .map((r) => r.trim())
    .filter(Boolean);
  if (roles.length === 0) {
    throw new Error(`Coworker type name is empty: "${typeName}"`);
  }

  // Cross-project `+` composition — warn on mixed projects, don't throw.
  const projects = new Set<string>();
  for (const role of roles) {
    for (const entry of resolveTypeChain(types, role)) {
      if (entry.project) projects.add(entry.project);
    }
  }
  if (roles.length > 1 && projects.size > 1) {
    console.warn(`Cross-project composition: "${typeName}" mixes projects: ${[...projects].join(', ')}`);
  }

  const identityParts: string[] = [];
  const invariantFiles: string[] = [];
  const contextFiles: string[] = [];
  const workflowNames: string[] = [];
  const skillNames: string[] = [];

  for (const role of roles) {
    const chain = resolveTypeChain(types, role);
    if (chain.length === 0) {
      throw new Error(`Unknown coworker type: "${role}"`);
    }
    let leafIdentity = '';
    for (const entry of chain) {
      if (entry.identity) leafIdentity = entry.identity;
      if (entry.invariants) invariantFiles.push(...entry.invariants);
      if (entry.context) contextFiles.push(...entry.context);
      if (entry.workflows) workflowNames.push(...entry.workflows);
      if (entry.skills) skillNames.push(...entry.skills);
    }
    if (leafIdentity) identityParts.push(leafIdentity);
  }

  // Validate references. Actionable errors naming the exact offender.
  const unknownRefs: string[] = [];
  for (const name of [...workflowNames, ...skillNames]) {
    if (!catalog[name]) unknownRefs.push(name);
  }
  if (unknownRefs.length > 0) {
    throw new Error(
      `Coworker type "${typeName}" references unknown skill/workflow: ${[...new Set(unknownRefs)].join(', ')}. ` +
        `Each reference must match a container/skills/<dir>/SKILL.md with \`name: <ref>\` in its frontmatter.`,
    );
  }

  // Read spine fragments (dedup by resolved absolute path).
  const identity = readFragments(dedupRelative(identityParts, projectRoot), projectRoot).join('\n\n').trim();
  const invariants = readFragments(dedupRelative(invariantFiles, projectRoot), projectRoot);
  const context = readFragments(dedupRelative(contextFiles, projectRoot), projectRoot);

  // Classify workflow vs skill by the catalog's declared type.
  const workflowEntries: CoworkerManifest['workflows'] = [];
  const skillEntries: CoworkerManifest['skills'] = [];
  const uniqueRefs = [...new Set([...workflowNames, ...skillNames])];
  for (const name of uniqueRefs) {
    const meta = catalog[name];
    if (meta.type === 'workflow') {
      const uses = [...meta.uses.skills, ...meta.uses.workflows];
      workflowEntries.push({ name: meta.name, description: meta.description, uses });
    } else {
      skillEntries.push({ name: meta.name, description: meta.description });
    }
  }

  // Derive tool allowlist: direct refs + transitive workflow `uses`.
  const tools = new Set<string>();
  const visited = new Set<string>();
  function collectTools(ref: string): void {
    if (visited.has(ref)) return;
    visited.add(ref);
    const meta = catalog[ref];
    if (!meta) return;
    for (const t of meta.allowedTools) tools.add(t);
    if (meta.type === 'workflow') {
      for (const sub of [...meta.uses.skills, ...meta.uses.workflows]) collectTools(sub);
    }
  }
  for (const name of uniqueRefs) collectTools(name);

  const title = humanize(roles[roles.length - 1]);

  return {
    typeName,
    title,
    identity: identity || defaultIdentity(title),
    invariants,
    context,
    workflows: workflowEntries,
    skills: skillEntries,
    tools: [...tools].sort(),
  };
}

function dedupRelative(paths: string[], projectRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(projectRoot, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(p);
  }
  return out;
}

function readFragments(paths: string[], projectRoot: string): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(projectRoot, p);
    if (!fs.existsSync(abs)) {
      throw new Error(`Spine fragment not found: ${p}`);
    }
    const text = fs.readFileSync(abs, 'utf-8').trim();
    if (text) out.push(text);
  }
  return out;
}

function humanize(value: string): string {
  return value
    .split(/[-_+/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function defaultIdentity(title: string): string {
  return `You are ${title}, a specialist coworker.`;
}

// ---------------------------------------------------------------------------
// Spine composition (typed coworker CLAUDE.md)
// ---------------------------------------------------------------------------

function composeCoworkerSpine(
  projectRoot: string,
  coworkerType: string,
  extraInstructions: string | null | undefined,
): string {
  const types = readCoworkerTypes(projectRoot);
  const catalog = readSkillCatalog(projectRoot);
  const manifest = resolveCoworkerManifest(types, coworkerType, catalog, projectRoot);

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
      manifest.workflows
        .map((w) => {
          const uses = w.uses.length > 0 ? ` Uses: ${w.uses.join(', ')}.` : '';
          return `- \`/${w.name}\` — ${w.description}${uses}`;
        })
        .join('\n'),
    );
  }

  if (manifest.skills.length > 0) {
    parts.push('## Skills Available');
    parts.push(manifest.skills.map((s) => `- \`/${s.name}\` — ${s.description}`).join('\n'));
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

// ---------------------------------------------------------------------------
// Legacy 6-section document composition (main/global + untyped coworkers)
// ---------------------------------------------------------------------------

function loadManifest(projectRoot: string, manifestName: string): ManifestConfig {
  const manifestPath = path.join(projectRoot, 'groups', 'templates', 'manifests', `${manifestName}.yaml`);
  return yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as ManifestConfig;
}

function resolveOptionalTemplatePath(dir: string, stem: string): string | null {
  for (const ext of ['.yaml', '.yml', '.md']) {
    const candidate = path.join(dir, `${stem}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBasePath(projectRoot: string, base: string): string {
  const baseDir = path.join(projectRoot, 'groups', 'templates', 'base');
  switch (base) {
    case 'upstream-main': {
      const resolved = resolveOptionalTemplatePath(baseDir, 'main');
      if (resolved) return resolved;
      break;
    }
    case 'upstream-global': {
      const resolved = resolveOptionalTemplatePath(baseDir, 'global');
      if (resolved) return resolved;
      break;
    }
    default:
      throw new Error(`Unknown manifest base: ${base}`);
  }
  throw new Error(`Missing template for manifest base: ${base}`);
}

function createPromptDocument(title: string): PromptDocument {
  return {
    title,
    sections: { role: [], capabilities: [], workflow: [], constraints: [], formatting: [], resources: [] },
  };
}

function defaultDocumentTitle(manifestName: ComposeClaudeMdOptions['manifestName']): string {
  switch (manifestName) {
    case 'global':
      return 'Global';
    case 'main':
      return 'Main';
    case 'coworker':
      return 'Coworker';
  }
}

function normalizePromptTemplate(
  template: unknown,
  filePath: string,
): { sections: Partial<Record<PromptSectionName, string>> } {
  if (!template || typeof template !== 'object') {
    throw new Error(`Invalid prompt template in ${filePath}`);
  }

  const config = template as PromptTemplateConfig;
  const allowedKeys = new Set<string>(PROMPT_SECTION_ORDER);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown prompt template key "${key}" in ${filePath}`);
    }
  }

  const sections: Partial<Record<PromptSectionName, string>> = {};
  for (const sectionName of PROMPT_SECTION_ORDER) {
    const value = config[sectionName];
    if (typeof value === 'string' && value.trim()) {
      sections[sectionName] = value.trimEnd();
    }
  }

  return { sections };
}

function loadPromptTemplate(filePath: string): { sections: Partial<Record<PromptSectionName, string>> } {
  const text = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return normalizePromptTemplate(yaml.load(text), filePath);
  }
  return { sections: { workflow: text.trimEnd() } };
}

function mergePromptTemplate(doc: PromptDocument, filePath: string, state: MergeState): void {
  if (!fs.existsSync(filePath)) return;
  const resolvedPath = path.resolve(filePath);
  if (state.seen.has(resolvedPath)) return;
  const template = loadPromptTemplate(resolvedPath);
  for (const sectionName of PROMPT_SECTION_ORDER) {
    const content = template.sections[sectionName];
    if (content) doc.sections[sectionName].push(content);
  }
  state.seen.add(resolvedPath);
}

function appendProjectOverlays(
  doc: PromptDocument,
  templatesDir: string,
  manifestName: ComposeClaudeMdOptions['manifestName'],
  state: MergeState,
): void {
  const projectsDir = path.join(templatesDir, 'projects');
  if (!fs.existsSync(projectsDir)) return;

  for (const projectName of fs.readdirSync(projectsDir).sort()) {
    const projectDir = path.join(projectsDir, projectName);
    if (!fs.statSync(projectDir).isDirectory()) continue;

    for (const sectionName of PROMPT_SECTION_ORDER) {
      const sharedSectionPath = resolveOptionalTemplatePath(projectDir, sectionName);
      if (sharedSectionPath) mergePromptTemplate(doc, sharedSectionPath, state);
    }

    const overlayStem = manifestName === 'coworker' ? 'coworker-base' : `${manifestName}-overlay`;
    const overlayPath = resolveOptionalTemplatePath(projectDir, overlayStem);
    if (overlayPath) mergePromptTemplate(doc, overlayPath, state);
  }
}

function renderPromptDocument(doc: PromptDocument): string {
  const parts: string[] = [];
  parts.push(`# ${doc.title}`);
  for (const sectionName of PROMPT_SECTION_ORDER) {
    const sectionParts = doc.sections[sectionName].map((p) => p.trim()).filter(Boolean);
    if (sectionParts.length === 0) continue;
    parts.push(`## ${PROMPT_SECTION_HEADINGS[sectionName]}`);
    parts.push(sectionParts.join('\n\n'));
  }
  return `${parts.join('\n\n').trimEnd()}\n`;
}

function composeLegacyDocument(projectRoot: string, options: ComposeClaudeMdOptions): string {
  const templatesDir = path.join(projectRoot, 'groups', 'templates');
  const manifest = loadManifest(projectRoot, options.manifestName);
  const doc = createPromptDocument(defaultDocumentTitle(options.manifestName));
  const state: MergeState = { seen: new Set<string>() };

  mergePromptTemplate(doc, resolveBasePath(projectRoot, manifest.base), state);

  for (const section of manifest.sections || []) {
    const sectionPath = resolveOptionalTemplatePath(path.join(templatesDir, 'sections'), section);
    if (sectionPath) mergePromptTemplate(doc, sectionPath, state);
  }

  if (manifest.project_overlays) {
    appendProjectOverlays(doc, templatesDir, options.manifestName, state);
  }

  if (options.extraInstructions?.trim()) {
    doc.sections.workflow.push(['### Additional Instructions', '', options.extraInstructions.trim()].join('\n'));
  }

  return renderPromptDocument(doc);
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function composeClaudeMd(options: ComposeClaudeMdOptions): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  if (options.manifestName === 'coworker' && options.coworkerType) {
    return composeCoworkerSpine(projectRoot, options.coworkerType, options.extraInstructions);
  }
  return composeLegacyDocument(projectRoot, options);
}
