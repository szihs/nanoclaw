import fs from 'fs';
import path from 'path';

import { composeLegacyPrompt } from './claude-composer.js';

export interface LegacyPromptGroup {
  isMain: boolean | number;
  coworkerType?: string | null;
}

/**
 * Reconstruct what v1's composer would have produced for a group, so we can
 * diff it against the on-disk CLAUDE.md and extract the custom tail during
 * v1→v2 migration. v1 always used the 6-section manifest path — the lego
 * spine model only exists in v2.
 */
export function recomposeLegacyTemplate(projectRoot: string, group: LegacyPromptGroup): string | null {
  try {
    const manifestName = group.isMain ? 'main' : 'coworker';
    const manifestPath = path.join(projectRoot, 'groups', 'templates', 'manifests', `${manifestName}.yaml`);
    if (!fs.existsSync(manifestPath)) return null;

    return composeLegacyPrompt({
      projectRoot,
      manifestName,
      coworkerType: group.coworkerType || null,
      extraInstructions: null,
    });
  } catch {
    return null;
  }
}

export function extractLegacyCustomInstructions(actual: string, template: string): string | null {
  const templateLines = template.trimEnd().split('\n');

  let anchor = '';
  for (let i = templateLines.length - 1; i >= 0; i--) {
    if (templateLines[i].trim()) {
      anchor = templateLines[i].trim();
      break;
    }
  }
  if (!anchor) return null;

  const actualLines = actual.split('\n');
  let anchorIdx = -1;
  for (let i = actualLines.length - 1; i >= 0; i--) {
    if (actualLines[i].trim() === anchor) {
      anchorIdx = i;
      break;
    }
  }

  if (anchorIdx < 0) {
    let matchEnd = 0;
    for (let i = 0; i < Math.min(templateLines.length, actualLines.length); i++) {
      if (templateLines[i].trimEnd() === actualLines[i].trimEnd()) {
        matchEnd = i + 1;
      } else {
        break;
      }
    }
    if (matchEnd > 0 && matchEnd < actualLines.length) {
      const custom = actualLines.slice(matchEnd).join('\n').trim();
      return custom || null;
    }
    return null;
  }

  const custom = actualLines
    .slice(anchorIdx + 1)
    .join('\n')
    .trim();
  return custom.replace(/^---\s*\n?/, '').trim() || null;
}
