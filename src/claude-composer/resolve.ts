// Type-chain resolution: walk `extends` ancestors, merge fragments, validate
// bindings, and return a fully-resolved CoworkerManifest ready to render.

import fs from 'fs';
import path from 'path';

import type { CoworkerManifest, CoworkerTypeEntry, SkillMeta, WorkflowCustomization } from './types.js';

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
  const overlayNames: string[] = [];
  const bindings: Record<string, string> = {};
  const mcpServers: Record<string, import('./types.js').McpServerTypeConfig> = {};
  let manifestProject: string | undefined;
  let flat = false;

  // Build skill → native project. A skill is project-specific only when every
  // project-typed type that lists it shares the same project. Skills listed by
  // types from multiple different projects, or only by base types (no project),
  // are universal and can bind to any manifest.
  const skillProjectSets = new Map<string, Set<string>>();
  for (const entry of Object.values(types)) {
    if (!entry.skills || !entry.project) continue;
    for (const s of entry.skills) {
      const projs = skillProjectSets.get(s) || new Set();
      projs.add(entry.project);
      skillProjectSets.set(s, projs);
    }
  }

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
      if (entry.overlays) overlayNames.push(...entry.overlays);
      if (entry.flat === true) flat = true;
      if (entry.bindings) {
        for (const [trait, skillName] of Object.entries(entry.bindings)) {
          bindings[trait] = skillName;
        }
      }
      if (entry.mcpServers) {
        for (const [name, config] of Object.entries(entry.mcpServers)) {
          mcpServers[name] = config;
        }
      }
    }
    if (leafIdentity) identityParts.push(leafIdentity);
    if (!manifestProject) {
      const leaf = chain[chain.length - 1];
      if (leaf?.project) manifestProject = leaf.project;
    }
  }

  // Flat types are verbatim prose bodies (main/global). Skip workflow/skill/
  // overlay/binding validation — they don't apply. Additive skills contribute
  // context fragments only.
  if (flat) {
    const identity = readFragments(dedupRelative(identityParts, projectRoot), projectRoot).join('\n\n').trim();
    const context = readFragments(dedupRelative(contextFiles, projectRoot), projectRoot);
    const title = humanize(roles[roles.length - 1]);
    return {
      typeName,
      title,
      identity: identity || defaultIdentity(title),
      invariants: [],
      context,
      workflows: [],
      skills: [],
      tools: [],
      bindings: {},
      customizations: [],
      mcpServers,
      flat: true,
    };
  }

  // Validate references. Actionable errors naming the exact offender.
  const unknownRefs: string[] = [];
  for (const name of [...workflowNames, ...skillNames, ...overlayNames]) {
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

  // Classify workflow vs skill by the catalog's declared type. Overlays are
  // not directly invocable; they appear in ## Workflow Customizations only.
  const workflowEntries: CoworkerManifest['workflows'] = [];
  const skillEntries: CoworkerManifest['skills'] = [];
  const uniqueRefs = [...new Set([...workflowNames, ...skillNames])];
  const workflowSet = new Set<string>();
  for (const name of uniqueRefs) {
    const meta = catalog[name];
    if (meta.type === 'workflow') {
      const uses = [...meta.uses.skills, ...meta.uses.workflows];
      // Inherit steps from parent workflow if this child has none.
      let steps = meta.steps;
      if (steps.length === 0 && meta.extendsWorkflow && catalog[meta.extendsWorkflow]) {
        steps = catalog[meta.extendsWorkflow].steps;
      }
      workflowEntries.push({
        name: meta.name,
        description: meta.description,
        uses,
        requires: meta.requires,
        steps,
      });
      workflowSet.add(meta.name);
    } else if (meta.type === 'capability') {
      skillEntries.push({ name: meta.name, description: meta.description, provides: meta.provides });
    }
  }

  // Validate bindings. Traits use dotted qualifiers (e.g. repo.pr, code.edit).
  // Bindings are keyed by domain (e.g. repo, code). The validator:
  //   1. Extracts the domain from a qualified trait (repo.pr → repo)
  //   2. Looks up the binding by domain
  //   3. Checks the bound skill provides the full qualified string
  //   4. Falls back to a project-scoped skill scan (same project or base first)
  const requiredTraits = new Set<string>();
  for (const wf of workflowEntries) {
    for (const trait of wf.requires) requiredTraits.add(trait);
  }

  // Build project-scoped provider map. Only same-project or universal skills
  // can auto-bind. Cross-project skills are never considered — if a trait is
  // only satisfiable by a foreign skill, it's an unresolved-trait error.
  const directlyProvided = new Map<string, string>();
  const traitProviders = new Map<string, string[]>();
  for (const s of skillEntries) {
    const projs = skillProjectSets.get(s.name);
    const soleProject = projs?.size === 1 ? [...projs][0] : undefined;
    const compatible = !soleProject || !manifestProject || soleProject === manifestProject;
    for (const trait of s.provides) {
      const providers = traitProviders.get(trait) || [];
      providers.push(s.name);
      traitProviders.set(trait, providers);
      if (compatible && !directlyProvided.has(trait)) {
        directlyProvided.set(trait, s.name);
      }
    }
  }

  // Warn when multiple skills provide the same trait without an explicit binding.
  for (const [trait, providers] of traitProviders) {
    if (providers.length <= 1) continue;
    const domain = trait.split('.')[0];
    if (!bindings[domain] && !bindings[trait]) {
      console.warn(
        `Coworker type "${typeName}": trait "${trait}" provided by [${providers.join(', ')}] with no explicit binding. Using "${providers[0]}".`,
      );
    }
  }

  const resolvedBindings: Record<string, string> = { ...bindings };
  const unresolvedTraits: string[] = [];
  for (const qualifiedTrait of requiredTraits) {
    const domain = qualifiedTrait.split('.')[0];

    // 1. Check domain-level binding
    if (resolvedBindings[domain]) {
      const skill = catalog[resolvedBindings[domain]];
      if (!skill) {
        throw new Error(
          `Coworker type "${typeName}" binds domain "${domain}" → "${resolvedBindings[domain]}" but that skill is not in the catalog.`,
        );
      }
      if (skill.provides.includes(qualifiedTrait)) {
        continue;
      }
      console.warn(
        `Coworker type "${typeName}": binding "${domain}" → "${resolvedBindings[domain]}" does not provide "${qualifiedTrait}". Falling back to skill scan.`,
      );
    }

    // 2. Check exact-key binding (backward compat with unqualified traits)
    if (resolvedBindings[qualifiedTrait]) {
      const skill = catalog[resolvedBindings[qualifiedTrait]];
      if (skill?.provides.includes(qualifiedTrait)) {
        continue;
      }
    }

    // 3. Fallback: project-scoped skill scan. Only same-project or universal skills.
    if (directlyProvided.has(qualifiedTrait)) {
      if (!resolvedBindings[domain]) {
        resolvedBindings[domain] = directlyProvided.get(qualifiedTrait)!;
      }
      continue;
    }

    unresolvedTraits.push(qualifiedTrait);
  }
  if (unresolvedTraits.length > 0) {
    throw new Error(
      `Coworker type "${typeName}" requires trait(s) with no binding: ${[...new Set(unresolvedTraits)].join(', ')}. ` +
        `Either include a skill whose frontmatter declares \`provides: [<trait>]\`, or add a \`bindings: { <trait>: <skill-name> }\` mapping to the coworker type.`,
    );
  }

  // Collect workflow customizations: extends-chains, overrides, and overlays.
  const customizations: WorkflowCustomization[] = [];
  for (const wf of workflowEntries) {
    const meta = catalog[wf.name];
    if (meta.extendsWorkflow) {
      customizations.push({
        workflow: wf.name,
        kind: 'extends',
        extendsWorkflow: meta.extendsWorkflow,
        summary: `\`/${wf.name}\` extends \`/${meta.extendsWorkflow}\` — run base steps, then the specialized steps.`,
      });
    }
    for (const [stepId, body] of Object.entries(meta.overrides)) {
      customizations.push({
        workflow: wf.name,
        kind: 'override',
        summary: `In \`/${wf.name}\`, step \`${stepId}\` is overridden.`,
        detail: body.trim(),
      });
    }
  }
  const uniqueOverlayNames = [...new Set(overlayNames)];
  for (const overlayName of uniqueOverlayNames) {
    const overlayMeta = catalog[overlayName];
    if (!overlayMeta || overlayMeta.type !== 'overlay' || !overlayMeta.overlay) {
      throw new Error(
        `Coworker type "${typeName}" references overlay "${overlayName}" but it is not a \`type: overlay\` SKILL.md.`,
      );
    }
    const overlay = overlayMeta.overlay;
    const targets = new Set<string>();
    for (const wfName of overlay.appliesToWorkflows) {
      if (workflowSet.has(wfName)) targets.add(wfName);
    }
    for (const wf of workflowEntries) {
      for (const trait of wf.requires) {
        const domain = trait.split('.')[0];
        if (overlay.appliesToTraits.includes(trait) || overlay.appliesToTraits.includes(domain)) targets.add(wf.name);
      }
    }
    // Deduplicate: if a child workflow extends a parent that's also a target,
    // drop the parent — the child's customization subsumes it.
    for (const target of [...targets]) {
      const meta = catalog[target];
      if (meta?.extendsWorkflow && targets.has(meta.extendsWorkflow)) {
        targets.delete(meta.extendsWorkflow);
      }
    }
    for (const target of targets) {
      const anchors: string[] = [];
      const anchorSteps: { position: 'before' | 'after'; step: string }[] = [];
      for (const step of overlay.insertAfter) {
        anchors.push(`after step \`${step}\``);
        anchorSteps.push({ position: 'after', step });
      }
      for (const step of overlay.insertBefore) {
        anchors.push(`before step \`${step}\``);
        anchorSteps.push({ position: 'before', step });
      }
      const where = anchors.length > 0 ? anchors.join(' and ') : 'at the end';
      customizations.push({
        workflow: target,
        kind: 'overlay',
        overlayName,
        anchorSteps,
        summary: `\`/${target}\` is augmented by \`${overlayName}\` ${where}.`,
        detail: overlay.step,
      });
    }
  }

  // Derive tool allowlist: direct refs + transitive workflow `uses` + bound
  // trait skills + overlays that attach to any referenced workflow.
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
      if (meta.extendsWorkflow) collectTools(meta.extendsWorkflow);
    }
  }
  for (const name of uniqueRefs) collectTools(name);
  for (const skillName of Object.values(resolvedBindings)) collectTools(skillName);
  for (const overlayName of uniqueOverlayNames) collectTools(overlayName);

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
    bindings: resolvedBindings,
    customizations,
    mcpServers,
    flat: false,
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
