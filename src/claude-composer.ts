import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

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

/**
 * Per-section merge mode for type-chain composition.
 * - 'append': all ancestors contribute, base first then leaf last (default)
 * - 'leaf': only the leaf (most-derived) type's content is used
 */
const SECTION_MERGE_MODE: Record<PromptSectionName, 'append' | 'leaf'> = {
  role: 'leaf',
  capabilities: 'append',
  workflow: 'append',
  constraints: 'append',
  formatting: 'leaf',
  resources: 'append',
};

interface PromptTemplateConfig {
  role?: string;
  capabilities?: string;
  workflow?: string;
  constraints?: string;
  formatting?: string;
  resources?: string;
}

interface PromptDocument {
  title: string;
  sections: Record<PromptSectionName, string[]>;
}

interface MergeState {
  seen: Set<string>;
}

export interface CoworkerTypeEntry {
  extends?: string | string[];
  template?: string | string[];
  focusFiles?: string[];
  allowedMcpTools?: string[];
  description?: string;
  project?: string;
}

export interface ComposeClaudeMdOptions {
  projectRoot?: string;
  manifestName: 'main' | 'global' | 'coworker';
  coworkerType?: string | null;
  extraInstructions?: string | null;
}

export function readCoworkerTypes(projectRoot = process.cwd()): Record<string, CoworkerTypeEntry> {
  const registry: Record<string, CoworkerTypeEntry> = {};
  const skillsDir = path.join(projectRoot, 'container', 'skills');

  // Scan distributed YAML type definitions
  if (fs.existsSync(skillsDir)) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(skillsDir).sort();
    } catch {
      dirs = [];
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
  }

  // If any YAML types found, use them exclusively
  if (Object.keys(registry).length > 0) return registry;

  // Fallback: legacy JSON (migration compat)
  const jsonPath = path.join(projectRoot, 'groups', 'coworker-types.json');
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, CoworkerTypeEntry>;
    } catch {
      return {};
    }
  }

  return {};
}

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
    sections: {
      role: [],
      capabilities: [],
      workflow: [],
      constraints: [],
      formatting: [],
      resources: [],
    },
  };
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[+/_\-.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function normalizeList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
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

function loadPromptTemplate(filePath: string): {
  sections: Partial<Record<PromptSectionName, string>>;
} {
  const text = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return normalizePromptTemplate(yaml.load(text), filePath);
  }

  return {
    sections: {
      workflow: text.trimEnd(),
    },
  };
}

function mergePromptTemplate(doc: PromptDocument, filePath: string, state: MergeState): void {
  if (!fs.existsSync(filePath)) return;
  const resolvedPath = path.resolve(filePath);
  if (state.seen.has(resolvedPath)) return;

  const template = loadPromptTemplate(resolvedPath);

  for (const sectionName of PROMPT_SECTION_ORDER) {
    const content = template.sections[sectionName];
    if (content) {
      doc.sections[sectionName].push(content);
    }
  }

  state.seen.add(resolvedPath);
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

export function resolveTypeFields(
  types: Record<string, CoworkerTypeEntry>,
  typeName: string,
): { templates: string[]; focusFiles: string[]; allowedMcpTools: string[] } {
  const chain = resolveTypeChain(types, typeName);
  const templates: string[] = [];
  const focusFiles: string[] = [];
  const allowedMcpTools: string[] = [];

  for (const entry of chain) {
    const resolvedTemplates = Array.isArray(entry.template) ? entry.template : entry.template ? [entry.template] : [];
    templates.push(...resolvedTemplates);
    if (entry.focusFiles) focusFiles.push(...entry.focusFiles);
    if (entry.allowedMcpTools) allowedMcpTools.push(...entry.allowedMcpTools);
  }

  return {
    templates: [...new Set(templates)],
    focusFiles: [...new Set(focusFiles)],
    allowedMcpTools: [...new Set(allowedMcpTools)],
  };
}

function appendRoleTemplates(doc: PromptDocument, projectRoot: string, coworkerType: string, state: MergeState): void {
  const types = readCoworkerTypes(projectRoot);
  if (Object.keys(types).length === 0) return;

  // Validate cross-project extends
  validateCrossProjectExtends(types);

  const roles = coworkerType
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean);

  // Warn on cross-project + composition
  if (roles.length > 1) {
    const projects = new Set<string>();
    for (const role of roles) {
      const chain = resolveTypeChain(types, role);
      for (const entry of chain) {
        if (entry.project) projects.add(entry.project);
      }
    }
    if (projects.size > 1) {
      console.warn(`Cross-project composition: "${coworkerType}" mixes projects: ${Array.from(projects).join(', ')}`);
    }
  }

  const allTemplates: string[] = [];
  const allFocusFiles: string[] = [];

  for (const role of roles) {
    const resolved = resolveTypeFields(types, role);
    allTemplates.push(...resolved.templates);
    allFocusFiles.push(...resolved.focusFiles);
  }

  // Snapshot section lengths before merging role templates (for leaf-only sections)
  const preMergeLengths: Record<PromptSectionName, number> = {} as Record<PromptSectionName, number>;
  for (const sectionName of PROMPT_SECTION_ORDER) {
    preMergeLengths[sectionName] = doc.sections[sectionName].length;
  }

  for (const templatePath of [...new Set(allTemplates)]) {
    mergePromptTemplate(doc, path.resolve(projectRoot, templatePath), state);
    const templateStem = path.basename(templatePath, path.extname(templatePath));
    doc.title = humanizeIdentifier(templateStem);
  }

  // Apply leaf-only merge mode: for leaf sections, keep only the last entry
  // added by the type chain (discard ancestor contributions for that section)
  for (const sectionName of PROMPT_SECTION_ORDER) {
    if (SECTION_MERGE_MODE[sectionName] !== 'leaf') continue;
    const entries = doc.sections[sectionName];
    const preLen = preMergeLengths[sectionName];
    const typeEntries = entries.slice(preLen);
    if (typeEntries.length > 1) {
      // Keep pre-type entries + only the last type entry (the leaf)
      doc.sections[sectionName] = [...entries.slice(0, preLen), typeEntries[typeEntries.length - 1]];
    }
  }

  const uniqueFocus = [...new Set(allFocusFiles)];
  if (uniqueFocus.length > 0) {
    doc.sections.resources.push(
      [
        '### Priority Files',
        '',
        'Focus your work on these paths first:',
        ...uniqueFocus.map((file) => `- \`${file}\``),
      ].join('\n'),
    );
  }
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
      if (sharedSectionPath) {
        mergePromptTemplate(doc, sharedSectionPath, state);
      }
    }

    const overlayStem = manifestName === 'coworker' ? 'coworker-base' : `${manifestName}-overlay`;
    const overlayPath = resolveOptionalTemplatePath(projectDir, overlayStem);
    if (overlayPath) {
      mergePromptTemplate(doc, overlayPath, state);
    }
  }
}

function renderPromptDocument(doc: PromptDocument): string {
  const parts: string[] = [];

  parts.push(`# ${doc.title}`);

  for (const sectionName of PROMPT_SECTION_ORDER) {
    const sectionParts = doc.sections[sectionName].map((part) => part.trim()).filter(Boolean);
    if (sectionParts.length === 0) continue;
    parts.push(`## ${PROMPT_SECTION_HEADINGS[sectionName]}`);
    parts.push(sectionParts.join('\n\n'));
  }

  return `${parts.join('\n\n').trimEnd()}\n`;
}

export function composeClaudeMd(options: ComposeClaudeMdOptions): string {
  const projectRoot = options.projectRoot ?? process.cwd();
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

  if (options.coworkerType) {
    appendRoleTemplates(doc, projectRoot, options.coworkerType, state);
  }

  if (options.extraInstructions?.trim()) {
    doc.sections.workflow.push(['### Additional Instructions', '', options.extraInstructions.trim()].join('\n'));
  }

  return renderPromptDocument(doc);
}
