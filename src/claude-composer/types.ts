// Type definitions for the coworker composer. Split out so runtime modules
// (registry / resolve / spine / legacy) can depend on these without pulling
// in each other.

// ---------------------------------------------------------------------------
// Legacy 6-section model (used only for `main` and `global` manifests — the
// two static documents in the repo that aren't coworker-typed). Typed
// coworkers use the lego spine model further down.
// ---------------------------------------------------------------------------

export interface ManifestConfig {
  base: string;
  sections?: string[];
  project_overlays?: boolean;
}

export type PromptSectionName = 'role' | 'capabilities' | 'workflow' | 'constraints' | 'formatting' | 'resources';

export const PROMPT_SECTION_ORDER: PromptSectionName[] = [
  'role',
  'capabilities',
  'workflow',
  'constraints',
  'formatting',
  'resources',
];

export const PROMPT_SECTION_HEADINGS: Record<PromptSectionName, string> = {
  role: 'Role',
  capabilities: 'Capabilities',
  workflow: 'Workflow',
  constraints: 'Constraints',
  formatting: 'Formatting',
  resources: 'Resources',
};

export interface PromptDocument {
  title: string;
  sections: Record<PromptSectionName, string[]>;
}

export interface MergeState {
  seen: Set<string>;
}

export interface PromptTemplateConfig {
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

  // Flat rendering mode: emit identity + context bodies verbatim with `---`
  // separators, no `## Identity` / `## Invariants` wrappers, no auto-generated
  // title. Used for main/global where the upstream body is a single prose
  // document that additive skills append to. Typed coworkers leave this unset.
  flat?: boolean;

  // Spine fragments (paths relative to projectRoot).
  identity?: string;
  invariants?: string[];
  context?: string[];

  // Skill catalog references (SKILL.md `name` values under container/skills/).
  workflows?: string[];
  skills?: string[];

  // Trait bindings: abstract trait name → concrete skill name that provides it.
  // Leaf-wins across the type chain. Lets a type inherit a workflow that
  // declares `requires: [repo.pr]` without hard-coding which skill satisfies it.
  bindings?: Record<string, string>;

  // Overlays (SKILL.md `type: overlay` entries) to apply to this coworker's
  // workflows at compose time. Union-merged across the type chain.
  overlays?: string[];

  // MCP servers to inject into containers for this coworker type.
  // Shallow merge across the extends chain (leaf wins per server name).
  // Per-instance container.json overrides type-level config.
  mcpServers?: Record<string, McpServerTypeConfig>;
}

export interface McpServerTypeConfig {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface OverlayMeta {
  // Which workflows this overlay attaches to (by workflow name).
  appliesToWorkflows: string[];
  // Alternative targeting: any workflow that requires one of these traits.
  appliesToTraits: string[];
  // Step-id anchors. Overlay body is inserted AFTER each listed step id.
  insertAfter: string[];
  // Step-id anchors. Overlay body is inserted BEFORE each listed step id.
  insertBefore: string[];
  // Inline step markdown (body of the overlay after the frontmatter).
  step: string;
}

export interface SkillMeta {
  name: string;
  type: 'capability' | 'workflow' | 'overlay';
  description: string;
  allowedTools: string[];
  uses: { skills: string[]; workflows: string[] };
  path: string;

  // Trait system.
  provides: string[]; // Traits this skill provides (capability skills).
  requires: string[]; // Traits this workflow needs (workflow skills).

  // Workflow inheritance — this workflow extends another workflow;
  // step-level `overrides` replace the body under the matching step id.
  steps: string[];
  extendsWorkflow?: string;
  overrides: Record<string, string>;

  // Overlay metadata (only populated for type: overlay skills).
  overlay?: OverlayMeta;
}

export interface WorkflowCustomization {
  workflow: string; // Target workflow name.
  kind: 'extends' | 'override' | 'overlay';
  summary: string; // One-line description rendered into the spine.
  detail?: string; // Optional longer form (step body / override body).
  overlayName?: string; // For kind=overlay: the overlay skill name (used to group rendering).
  anchorSteps?: { position: 'before' | 'after'; step: string }[]; // For kind=overlay: which steps this gate attaches to.
  extendsWorkflow?: string; // For kind=extends: the parent workflow name.
}

export interface CoworkerManifest {
  typeName: string;
  title: string;
  identity: string;
  invariants: string[];
  context: string[];
  workflows: { name: string; description: string; uses: string[]; requires: string[]; steps: string[] }[];
  skills: { name: string; description: string; provides: string[] }[];
  tools: string[];

  // Trait layer.
  bindings: Record<string, string>;
  customizations: WorkflowCustomization[];

  // MCP servers from the type registry (merged across extends chain).
  mcpServers: Record<string, McpServerTypeConfig>;

  // See CoworkerTypeEntry.flat.
  flat: boolean;
}

export interface ComposeCoworkerSpineOptions {
  coworkerType: string;
  extraInstructions?: string | null;
  projectRoot?: string;
}

export interface ComposeLegacyPromptOptions {
  manifestName: 'main' | 'global' | 'coworker';
  coworkerType?: string | null;
  extraInstructions?: string | null;
  projectRoot?: string;
}
