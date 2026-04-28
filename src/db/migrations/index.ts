import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

// Migrations are discovered at module load from adjacent files named
// `<version>-<slug>.{ts,js}` (e.g. `007-hook-events.ts`). This means a
// project branch can add a migration by dropping a file in this directory
// without editing any central registry — keeping the registry out of the
// merge path when two project branches ship alongside one another.
//
// Each migration file must export exactly one value whose shape matches
// the `Migration` interface. The export name is irrelevant — we pick it
// by shape, so conventional names like `migration007` still work.
function isMigration(value: unknown): value is Migration {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Migration).version === 'number' &&
    typeof (value as Migration).name === 'string' &&
    typeof (value as Migration).up === 'function'
  );
}

async function loadMigrations(): Promise<Migration[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = fs
    .readdirSync(here)
    .filter((f) => /^(\d+|module)-.*\.(js|ts)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();

  const out: Migration[] = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(here, file)).href);
    const found = Object.values(mod).find(isMigration);
    if (!found) {
      throw new Error(`Migration file ${file} does not export a Migration-shaped value`);
    }
    out.push(found);
  }

  out.sort((a, b) => a.version - b.version);

  const versions = out.map((m) => m.version);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  if (dupes.length > 0) {
    throw new Error(`Duplicate migration versions: ${dupes.join(', ')}`);
  }

  return out;
}

const migrations: Migration[] = await loadMigrations();

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
  `);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  log.info('Running migrations', {
    from: currentVersion,
    to: pending[pending.length - 1].version,
    count: pending.length,
  });

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    log.info('Migration applied', { version: m.version, name: m.name });
  }
}
