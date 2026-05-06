import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshMirror } from './group-init.js';

describe('refreshMirror', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mirror-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(p: string, body: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }

  function backdate(p: string, secondsAgo: number): void {
    const t = (Date.now() - secondsAgo * 1000) / 1000;
    fs.utimesSync(p, t, t);
    if (fs.statSync(p).isDirectory()) {
      for (const entry of fs.readdirSync(p)) backdate(path.join(p, entry), secondsAgo);
    }
  }

  it('copies when destination is missing', () => {
    const src = path.join(tmp, 'src', 'foo');
    const dst = path.join(tmp, 'dst', 'foo');
    write(path.join(src, 'SKILL.md'), 'v1');

    expect(refreshMirror(src, dst)).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('skips when destination is up-to-date', () => {
    const src = path.join(tmp, 'src', 'foo');
    const dst = path.join(tmp, 'dst', 'foo');
    write(path.join(src, 'SKILL.md'), 'v1');
    fs.cpSync(src, dst, { recursive: true });

    expect(refreshMirror(src, dst)).toBe(false);
  });

  it('refreshes when source is newer', () => {
    const src = path.join(tmp, 'src', 'foo');
    const dst = path.join(tmp, 'dst', 'foo');
    write(path.join(src, 'SKILL.md'), 'v1');
    fs.cpSync(src, dst, { recursive: true });
    backdate(dst, 60);
    write(path.join(src, 'SKILL.md'), 'v2');

    expect(refreshMirror(src, dst)).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('removes files deleted from source on refresh', () => {
    const src = path.join(tmp, 'src', 'foo');
    const dst = path.join(tmp, 'dst', 'foo');
    write(path.join(src, 'SKILL.md'), 'v1');
    write(path.join(src, 'stale.md'), 'gone-upstream');
    fs.cpSync(src, dst, { recursive: true });
    backdate(dst, 60);
    fs.rmSync(path.join(src, 'stale.md'));
    write(path.join(src, 'SKILL.md'), 'v2');

    expect(refreshMirror(src, dst)).toBe(true);
    expect(fs.existsSync(path.join(dst, 'stale.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('detects nested file changes', () => {
    const src = path.join(tmp, 'src', 'foo');
    const dst = path.join(tmp, 'dst', 'foo');
    write(path.join(src, 'sub', 'nested.md'), 'v1');
    fs.cpSync(src, dst, { recursive: true });
    backdate(dst, 60);
    write(path.join(src, 'sub', 'nested.md'), 'v2');

    expect(refreshMirror(src, dst)).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'sub', 'nested.md'), 'utf8')).toBe('v2');
  });
});
