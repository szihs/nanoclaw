// Public facade for the coworker composer. Implementation lives in
// ./claude-composer/ — split across types / registry / resolve / spine /
// legacy so each concern stays small and testable.
//
// External callers import from this module; internal modules import from
// each other directly to avoid circular facades.

import { renderCoworkerSpine } from './claude-composer/spine.js';
import { composeLegacyDocument } from './claude-composer/legacy.js';
import type { ComposeCoworkerSpineOptions, ComposeLegacyPromptOptions } from './claude-composer/types.js';

export { readCoworkerTypes, readSkillCatalog } from './claude-composer/registry.js';
export { resolveCoworkerManifest, resolveTypeChain } from './claude-composer/resolve.js';
export type {
  ComposeCoworkerSpineOptions,
  ComposeLegacyPromptOptions,
  CoworkerManifest,
  CoworkerTypeEntry,
  OverlayMeta,
  PromptSectionName,
  SkillMeta,
  WorkflowCustomization,
} from './claude-composer/types.js';

/**
 * Compose a coworker CLAUDE.md from the lego spine model (spine fragments +
 * capability skills + workflows + overlays + trait bindings, all discovered
 * under `container/skills/<skill>/`). This is the only path used at runtime
 * for typed coworkers — the 6-section manifest path was retired for coworkers.
 *
 * Throws if the registry doesn't know the requested type.
 */
export function composeCoworkerSpine(options: ComposeCoworkerSpineOptions): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  return renderCoworkerSpine(projectRoot, options.coworkerType, options.extraInstructions);
}

/**
 * Compose a CLAUDE.md from the 6-section legacy manifest model. Used for
 * admin main/global documents in v2, and by v1→v2 migration to reconstruct
 * what the v1 composer would have produced so the custom tail can be
 * extracted. Not used at runtime for v2 coworkers.
 */
export function composeLegacyPrompt(options: ComposeLegacyPromptOptions): string {
  const projectRoot = options.projectRoot ?? process.cwd();
  return composeLegacyDocument(projectRoot, options);
}
