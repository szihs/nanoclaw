#!/usr/bin/env tsx
/**
 * Standalone runner for the global→shared migration. The actual logic
 * lives in src/migrations/global-to-shared.ts so src/index.ts can import
 * it at startup without tripping TypeScript's rootDir check.
 *
 * Usage: `tsx scripts/migrate-global-to-shared.ts`
 *
 * Idempotent — runs only if the data/.migrations/global-to-shared.done
 * marker is absent.
 */
import { runGlobalToSharedMigration } from '../src/migrations/global-to-shared.js';

const ran = runGlobalToSharedMigration(process.cwd());
console.log(ran ? 'migration complete' : 'migration already applied (marker present)');
