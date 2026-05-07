/**
 * Tests for dashboard/public/session-slug.js. The file is a plain ESM
 * module; vitest imports it directly. In the browser it's loaded via
 * <script type="module"> and also attaches to window.*.
 */
import { describe, expect, it } from 'vitest';

import { ADJ, NOUN, VERB, fnv1a, sessionLabel, sessionSlug } from './public/session-slug.js';

describe('session-slug helper', () => {
  it('wordlists are exactly 64 entries each', () => {
    expect(ADJ).toHaveLength(64);
    expect(NOUN).toHaveLength(64);
    expect(VERB).toHaveLength(64);
  });

  it('wordlists have no duplicate entries within a list', () => {
    expect(new Set(ADJ).size).toBe(ADJ.length);
    expect(new Set(NOUN).size).toBe(NOUN.length);
    expect(new Set(VERB).size).toBe(VERB.length);
  });

  it('sessionSlug is deterministic', () => {
    expect(sessionSlug('sess-1778143510824-x485si')).toBe(sessionSlug('sess-1778143510824-x485si'));
  });

  it('sessionSlug returns the adj-noun-verb shape', () => {
    const slug = sessionSlug('sess-abc');
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const parts = slug.split('-');
    expect(ADJ).toContain(parts[0]);
    expect(NOUN).toContain(parts[1]);
    expect(VERB).toContain(parts[2]);
  });

  it('sessionSlug handles empty/null inputs gracefully', () => {
    expect(sessionSlug('')).toBe('unknown');
    expect(sessionSlug(null as unknown as string)).toBe('unknown');
    expect(sessionSlug(undefined as unknown as string)).toBe('unknown');
  });

  it('sessionLabel prefixes main/thread correctly', () => {
    expect(sessionLabel('sess-abc', null).startsWith('main · ')).toBe(true);
    expect(sessionLabel('sess-abc', undefined).startsWith('main · ')).toBe(true);
    expect(sessionLabel('sess-abc', '').startsWith('main · ')).toBe(true);
    expect(sessionLabel('sess-abc', 'parent-xyz').startsWith('thread · ')).toBe(true);
  });

  it('sessionLabel is deterministic per (sessionId, threadId)', () => {
    expect(sessionLabel('sess-1', 'msg-abc')).toBe(sessionLabel('sess-1', 'msg-abc'));
  });

  it('same session id + different threadId produce same slug', () => {
    // Slug comes from sessionId; threadId only toggles the main/thread prefix.
    // This invariant matters because the Timeline uses sessionId for its slug
    // and the thread panel reads the same session — the slug must match
    // across both so operators see a consistent identity.
    const s = 'sess-abc';
    expect(sessionSlug(s)).toBe(sessionLabel(s, null).split(' · ')[1]);
    expect(sessionSlug(s)).toBe(sessionLabel(s, 'ignored').split(' · ')[1]);
  });

  it('collision rate across 1000 deterministic ids is < 1%', () => {
    // Deterministic inputs — no Math.random, same seed every run.
    const ids = Array.from({ length: 1000 }, (_, i) => `sess-1778143510000-${i.toString(16).padStart(6, '0')}`);
    const slugs = new Set(ids.map(sessionSlug));
    // 262,144 slug namespace; 1000 ids → birthday-paradox expected ≈ 1.9
    // collisions. Allow up to 10 to avoid flakes on a bad hash alignment.
    expect(slugs.size).toBeGreaterThanOrEqual(990);
  });

  it('fnv1a is deterministic and non-zero for non-empty input', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('def'));
    expect(fnv1a('hello world')).toBeGreaterThan(0);
  });

  it('fnv1a collision smoke: 1000 varied inputs produce at most 2 collisions', () => {
    const hashes = new Set<number>();
    for (let i = 0; i < 1000; i++) hashes.add(fnv1a(`in-${i}`));
    expect(hashes.size).toBeGreaterThanOrEqual(998);
  });
});
