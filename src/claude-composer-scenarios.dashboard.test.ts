/**
 * Dashboard-owned half of the lego composer scenario coverage (Scenario 2).
 * Architectural framing + Scenario 1 + upstream drift checks live in
 * claude-composer-scenarios.test.ts on the neutral spine.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { composeCoworkerSpine, readCoworkerTypes } from './claude-composer.js';

const REPO_ROOT = process.cwd();

function readFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

describe('Scenario 2: + dashboard-base', () => {
  it('dashboard-base contributes a context fragment to main and global', () => {
    expect(exists('container/skills/dashboard-base/prompts/formatting.md')).toBe(true);
    const types = readCoworkerTypes(REPO_ROOT);
    expect(types.main?.context).toContain('container/skills/dashboard-base/prompts/formatting.md');
    expect(types.global?.context).toContain('container/skills/dashboard-base/prompts/formatting.md');
  });

  it('composing main with both skills installed emits body + --- + formatting block', () => {
    const spine = composeCoworkerSpine({ projectRoot: REPO_ROOT, coworkerType: 'main' });
    const dashboardFormatting = readFile('container/skills/dashboard-base/prompts/formatting.md').trim();
    expect(spine).toContain(dashboardFormatting);
    // Fragments are joined by a horizontal rule — this is the flat-mode
    // separator that lets additive skills append without restructuring.
    expect(spine).toMatch(/\n\n---\n\n/);
  });

  it('flat mode suppresses structured headings even when multiple fragments are present', () => {
    const spine = composeCoworkerSpine({ projectRoot: REPO_ROOT, coworkerType: 'main' });
    expect(spine).not.toContain('## Identity');
    expect(spine).not.toContain('## Invariants');
    expect(spine).not.toContain('## Workflows Available');
    expect(spine).not.toContain('Bodies load on demand.');
  });
});
