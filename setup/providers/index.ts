// Setup-side provider barrel. Provider payloads with their own setup surface
// (picker entry, auth walk-through, install check) self-register on import.
// Skills add a provider by appending one import line below.

// claude first: the setup registry's order is its picker order, and claude is
// the built-in default (setup/providers/registry.test.ts pins index 0).
import './claude.js';
import './codex.js';
