import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine, readCoworkerTypes, readSkillCatalog } from './claude-composer.js';

// Guardrail for the four Slang coworker types that the v1→v2 migration tool
// is expected to instantiate against the current lego registry. Bundles
// themselves are code-constructed (produced by scripts/migrate-v1-to-v2.ts),
// so we assert registry-level invariants instead of reading checked-in YAMLs.
describe('slang coworker types', () => {
  const KEPT_TYPES = ['slang-reader', 'slang-writer'];

  it('registers each kept slang type in the lego registry', () => {
    const types = readCoworkerTypes(process.cwd());
    for (const name of KEPT_TYPES) {
      expect(types[name], `expected coworker type "${name}" in container/skills/*/coworker-types.yaml`).toBeDefined();
    }
  });

  it('composes a spine CLAUDE.md for each kept slang type with extra instructions appended verbatim', () => {
    const types = readCoworkerTypes(process.cwd());
    const catalog = readSkillCatalog(process.cwd());

    for (const name of KEPT_TYPES) {
      const entry = types[name];
      expect(entry, `expected coworker type "${name}" in container/skills/*/coworker-types.yaml`).toBeDefined();

      // Every workflow/skill reference the type makes must resolve.
      for (const ref of [...(entry.workflows ?? []), ...(entry.skills ?? [])]) {
        expect(catalog[ref], `"${name}" references unknown skill/workflow "${ref}"`).toBeDefined();
      }

      // Spine renders cleanly and keeps the extra instructions tail verbatim.
      const instructions = `# Test tail for ${name}\n\nAppended instructions.`;
      const spine = composeCoworkerSpine({
        projectRoot: process.cwd(),
        coworkerType: name,
        extraInstructions: instructions,
      });
      expect(spine).toMatch(/^# [\w -]+\n/);
      expect(spine).toContain('## Identity');
      expect(spine).toContain('## Additional Instructions');
      expect(spine).toContain(instructions);

      // Procedural 6-section template content must not be pinned in the spine —
      // it moves to progressively-disclosed workflow SKILL.md bodies.
      const additionalIdx = spine.indexOf('## Additional Instructions');
      const spinePortion = additionalIdx >= 0 ? spine.slice(0, additionalIdx) : spine;
      expect(spinePortion).not.toContain('## Capabilities');
      expect(spinePortion).not.toContain('## Resources');
      expect(spinePortion).not.toContain('## Workflow\n');
    }
  });
});
