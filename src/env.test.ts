import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEnvFile } from './env.js';

// readEnvFile reads the .env next to `process.cwd()`. Tests run from the
// project root, so we back up any real .env, write fixtures, then restore.
const realCwd = process.cwd();
const envPath = path.join(realCwd, '.env');
let backup: string | null = null;

beforeEach(() => {
  backup = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : null;
});

afterEach(() => {
  if (backup === null) {
    try {
      fs.unlinkSync(envPath);
    } catch {
      // already gone
    }
  } else {
    fs.writeFileSync(envPath, backup);
  }
  backup = null;
});

describe('readEnvFile', () => {
  it('returns only the requested keys', () => {
    fs.writeFileSync(envPath, ['WANTED=one', 'UNWANTED=two', 'ALSO_WANTED=three'].join('\n'));
    expect(readEnvFile(['WANTED', 'ALSO_WANTED'])).toEqual({
      WANTED: 'one',
      ALSO_WANTED: 'three',
    });
  });

  it('returns an empty object when .env is missing', () => {
    if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    expect(readEnvFile(['ANYTHING'])).toEqual({});
  });

  it('skips blank lines and comments', () => {
    fs.writeFileSync(envPath, ['# header comment', '', 'TOKEN=abc', '  # indented comment', ''].join('\n'));
    expect(readEnvFile(['TOKEN'])).toEqual({ TOKEN: 'abc' });
  });

  it('strips matching double or single quotes around values', () => {
    fs.writeFileSync(envPath, ['DOUBLE="hello world"', "SINGLE='hi there'", 'BARE=plain'].join('\n'));
    expect(readEnvFile(['DOUBLE', 'SINGLE', 'BARE'])).toEqual({
      DOUBLE: 'hello world',
      SINGLE: 'hi there',
      BARE: 'plain',
    });
  });

  it('leaves mismatched quotes untouched', () => {
    fs.writeFileSync(envPath, [`MIX="hello'`, `HALF="only-left`].join('\n'));
    const result = readEnvFile(['MIX', 'HALF']);
    expect(result.MIX).toBe(`"hello'`);
    expect(result.HALF).toBe(`"only-left`);
  });

  it('keeps equals signs that appear in the value', () => {
    fs.writeFileSync(envPath, ['DSN=postgres://user:p=ss@host/db'].join('\n'));
    expect(readEnvFile(['DSN'])).toEqual({ DSN: 'postgres://user:p=ss@host/db' });
  });

  it('drops keys with empty values', () => {
    fs.writeFileSync(envPath, ['EMPTY=', 'KEPT=value'].join('\n'));
    expect(readEnvFile(['EMPTY', 'KEPT'])).toEqual({ KEPT: 'value' });
  });

  it('ignores lines without an `=`', () => {
    fs.writeFileSync(envPath, ['not_an_env_line', 'TOKEN=abc'].join('\n'));
    expect(readEnvFile(['TOKEN'])).toEqual({ TOKEN: 'abc' });
  });

  it('returns empty when no requested keys are present', () => {
    fs.writeFileSync(envPath, 'UNRELATED=value\n');
    expect(readEnvFile(['MISSING'])).toEqual({});
  });

  it('handles a .env at an arbitrary cwd — parser uses process.cwd()', () => {
    // Sanity check that readEnvFile relies on the current working directory.
    // We create a tempdir with its own .env, chdir in, and read.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    try {
      fs.writeFileSync(path.join(tmp, '.env'), 'CWD_KEY=cwd-value\n');
      const originalCwd = process.cwd();
      try {
        process.chdir(tmp);
        expect(readEnvFile(['CWD_KEY'])).toEqual({ CWD_KEY: 'cwd-value' });
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
