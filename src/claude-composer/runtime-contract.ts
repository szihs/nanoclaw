/**
 * `container/CLAUDE.md` is the runtime contract: the statements that are true for
 * every agent on every provider, regardless of coworker type. Upstream's composer
 * emits it whole as a `NanoClaw Runtime Contract` section. This fork's spine never
 * read it at all, so three of its statements reached no agent:
 *
 *   - where inbound attachments land (`/workspace/inbox/<message-id>/<filename>`)
 *   - that standing instructions go in `instructions.prepend.md` while durable
 *     facts go in `memory/`, and that instruction edits need a restart
 *   - that `conversations/` holds searchable past transcripts
 *
 * Emitting it whole would duplicate instead: the document's preamble restates
 * what the runtime system prompt already says, and its Communication and
 * Workspace sections are strictly weaker than `context/chain-reporting.md` and
 * `context/workspace.md`. So this selects sections by heading rather than
 * inlining the file — see the §4.3 ownership table in
 * `reports/spine-vs-upstream.md` for the per-section decision and its evidence.
 *
 * Selecting by heading, not by line range, is deliberate: the plan was written
 * against line numbers that PR #1331 had already shifted by rewording the Memory
 * section. Headings survive edits to the prose beneath them.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

/** Heading of the section this layer renders into the composed document. */
export const RUNTIME_CONTRACT_SECTION = 'NanoClaw Runtime Contract';

/** Shared base document, relative to the project root. Matches upstream's `baseDocPath`. */
export const RUNTIME_CONTRACT_PATH = path.join('container', 'CLAUDE.md');

/**
 * Must equal `MEMORY_NOTE_PLACEHOLDER` in project-doc-compose.ts. Duplicated as a
 * literal for the require()-ability reason documented at its use below; the
 * composed-document byte parity test fails if upstream changes the token.
 */
const MEMORY_NOTE_PLACEHOLDER = '{{provider-memory-note}}';

/**
 * The `##` headings carried into the composed document, in document order.
 *
 * Everything not listed is dropped as duplicated elsewhere. A heading listed
 * here but absent from the file is a silent no-op, which is why
 * `runtime-contract.test.ts` asserts every one of these still resolves — a
 * rename upstream would otherwise quietly drop an agent-facing guarantee.
 */
export const EMITTED_CONTRACT_SECTIONS = ['Received attachments', 'Memory', 'Conversation history'] as const;

interface ContractSection {
  heading: string;
  body: string;
}

/**
 * Split a markdown document into its `##` sections. Content before the first
 * `##` (the preamble) is discarded — it is row 2 of the ownership table, dropped
 * because the runtime system prompt already states the agent's name and
 * destinations.
 *
 * Fenced code is skipped so a `## …` line inside an example block cannot open a
 * phantom section.
 */
function splitH2Sections(md: string): ContractSection[] {
  const sections: ContractSection[] = [];
  let current: ContractSection | undefined;
  let inCodeFence = false;

  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inCodeFence = !inCodeFence;
    const m = inCodeFence ? null : line.match(/^## (.+)$/);
    if (m) {
      current = { heading: m[1].trim(), body: '' };
      sections.push(current);
      continue;
    }
    if (current) current.body += line + '\n';
  }

  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

/**
 * Render the emitted contract sections as one markdown block, or `undefined`
 * when nothing is available.
 *
 * Sections land at `###` so they nest under the `## NanoClaw Runtime Contract`
 * wrapper the caller pushes — the same convention `normalizeFragment(…, 3)`
 * applies to spine fragments. The bodies are already flat prose under an `h2`,
 * so a literal `###` prefix is sufficient and no demotion pass is needed.
 */
export function renderRuntimeContract(projectRoot: string): string | undefined {
  const file = path.resolve(projectRoot, RUNTIME_CONTRACT_PATH);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // Tolerated (a partial payload install has no base document yet) but never
    // silent: losing the runtime contract with no signal is the shape of the bug
    // this layer exists to fix, and it is also what a wrong-cwd host looks like.
    log.warn('Composed document has no runtime contract', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  // Upstream's template carries a `{{provider-memory-note}}` placeholder that its
  // own renderer (`renderBaseInstructions` in project-doc-compose.ts) substitutes
  // from a provider's declared native override files. Without substitution the raw
  // token reaches every agent's prompt verbatim.
  //
  // Mirrored here rather than imported: `dist/claude-composer.js` must stay
  // require()-able — `scripts/fetch-skills.sh` loads it with `require()` — and
  // project-doc-compose reaches the DB layer, whose migration auto-discovery ends in
  // a TOP-LEVEL AWAIT (`db/migrations/index.ts`). Importing it turns this bundle into
  // an async ESM graph and `require()` of it throws ERR_REQUIRE_ASYNC_MODULE.
  //
  // `claude` declares no override files, so the note is empty and the placeholder
  // (with its preceding blank line) is removed — leaving the document byte-identical
  // to the pre-placeholder text, which the parity digests assert.
  const template = raw.replace(`\n\n${MEMORY_NOTE_PLACEHOLDER}`, '');

  const byHeading = new Map(splitH2Sections(template).map((s) => [s.heading, s.body]));
  const blocks: string[] = [];
  for (const heading of EMITTED_CONTRACT_SECTIONS) {
    const body = byHeading.get(heading);
    if (!body) {
      log.warn('Runtime contract section not found; it will not reach the agent', { file, heading });
      continue;
    }
    blocks.push(`### ${heading}\n\n${body}`);
  }

  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}
