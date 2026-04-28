// Legacy 6-section manifest composition: used for main/global (static repo
// documents) and by v1→v2 migration to reconstruct what the v1 composer
// would have produced, so the custom tail can be extracted. Typed coworkers
// at runtime go through the spine renderer instead.

import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

import {
  PROMPT_SECTION_HEADINGS,
  PROMPT_SECTION_ORDER,
  type ComposeLegacyPromptOptions,
  type ManifestConfig,
  type MergeState,
  type PromptDocument,
  type PromptSectionName,
  type PromptTemplateConfig,
} from './types.js';

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

function defaultDocumentTitle(manifestName: ComposeLegacyPromptOptions['manifestName']): string {
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
  manifestName: ComposeLegacyPromptOptions['manifestName'],
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

export function composeLegacyDocument(projectRoot: string, options: ComposeLegacyPromptOptions): string {
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
