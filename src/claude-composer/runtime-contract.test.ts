/**
 * The runtime contract (`container/CLAUDE.md`) states what is true for every
 * agent on every provider. The fork's spine replaced the composer that used to
 * read it and never picked the job up, so three of its statements reached no
 * agent at all: where inbound attachments land, the standing-instructions vs
 * durable-facts split, and that `conversations/` holds past transcripts.
 *
 * Two failure modes to pin, pulling in opposite directions:
 *
 *   - emit too little — a heading renamed upstream silently drops an
 *     agent-facing guarantee again;
 *   - emit too much — the preamble, Communication, and Workspace sections are
 *     already covered (and covered better) by `context/chain-reporting.md` and
 *     `context/workspace.md`, so inlining the file whole would duplicate
 *     instructions in a document that has a byte cap coming.
 *
 * See the §4.3 ownership table in `reports/spine-vs-upstream.md` for the
 * per-section decision.
 */
import fs from 'fs';
import { protectedProviderDocumentSourcePaths } from '../provider-contracts/realize.js';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EMITTED_CONTRACT_SECTIONS,
  RUNTIME_CONTRACT_PATH,
  RUNTIME_CONTRACT_SECTION,
  renderRuntimeContract,
} from './runtime-contract.js';

const tempDirs: string[] = [];

function makeProject(contract?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-contract-'));
  tempDirs.push(dir);
  if (contract !== undefined) {
    const file = path.join(dir, RUNTIME_CONTRACT_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contract);
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const FULL = `You are a NanoClaw agent. Your name is in the runtime system prompt.

## Communication

Be concise.

## Workspace

Files you create are saved in \`/workspace/agent/\`.

## Received attachments

Files arrive at \`/workspace/inbox/<message-id>/<filename>\`.

## Memory

Standing instructions belong in \`instructions.prepend.md\`; durable facts in memory.

## Conversation history

The \`conversations/\` folder holds searchable transcripts.
`;

describe('section selection', () => {
  it('emits exactly the three sections the ownership table keeps', () => {
    const out = renderRuntimeContract(makeProject(FULL))!;

    expect(out.match(/^### /gm)).toHaveLength(3);
    for (const heading of EMITTED_CONTRACT_SECTIONS) expect(out).toContain(`### ${heading}`);
  });

  // The drops are the half a reviewer cannot see by reading the output, so they
  // are asserted rather than left implied.
  it('drops the preamble, Communication, and Workspace', () => {
    const out = renderRuntimeContract(makeProject(FULL))!;

    expect(out).not.toContain('You are a NanoClaw agent');
    expect(out).not.toContain('Communication');
    expect(out).not.toContain('Be concise');
    expect(out).not.toContain('Workspace');
  });

  it('carries each kept section body, not just its heading', () => {
    const out = renderRuntimeContract(makeProject(FULL))!;

    expect(out).toContain('/workspace/inbox/<message-id>/<filename>');
    expect(out).toContain('instructions.prepend.md');
    expect(out).toContain('`conversations/` folder');
  });

  it('preserves document order', () => {
    const out = renderRuntimeContract(makeProject(FULL))!;

    expect(out.indexOf('### Received attachments')).toBeLessThan(out.indexOf('### Memory'));
    expect(out.indexOf('### Memory')).toBeLessThan(out.indexOf('### Conversation history'));
  });

  // Sections nest under the `## NanoClaw Runtime Contract` wrapper the caller
  // pushes, matching what `normalizeFragment(…, 3)` does for spine fragments. An
  // `##` here would end the wrapper and promote each section to a peer.
  it('normalizes headings to h3', () => {
    const out = renderRuntimeContract(makeProject(FULL))!;

    expect(out).not.toMatch(/^## /m);
    expect(out).not.toMatch(/^# /m);
  });
});

describe('resilience', () => {
  it('returns undefined when the contract file is absent', () => {
    expect(renderRuntimeContract(makeProject())).toBeUndefined();
  });

  // A partial payload install has no base document yet. Tolerated, because a
  // spawn that dies over a missing doc is worse than one without it.
  it('does not throw on a missing file', () => {
    expect(() => renderRuntimeContract(makeProject())).not.toThrow();
  });

  it('emits what it can when a section is missing', () => {
    const out = renderRuntimeContract(makeProject('## Memory\n\nJust this one.\n'))!;

    expect(out).toContain('### Memory');
    expect(out).not.toContain('### Received attachments');
  });

  it('returns undefined when no kept section is present', () => {
    expect(renderRuntimeContract(makeProject('## Communication\n\nDropped.\n'))).toBeUndefined();
  });

  // A `## …` line inside a fenced example must not open a phantom section, or a
  // code sample could smuggle content past the selection.
  it('ignores headings inside fenced code', () => {
    const out = renderRuntimeContract(
      makeProject('## Memory\n\nReal body.\n\n```md\n## Received attachments\nfake\n```\n'),
    )!;

    expect(out).toContain('Real body.');
    expect(out).not.toContain('### Received attachments');
    expect(out).toContain('fake'); // still inside Memory's body, as authored
  });
});

/**
 * The layer only matters if the file it reads still has the sections it names.
 * These run against the REAL `container/CLAUDE.md`, so an upstream rename shows
 * up here instead of as three silently-missing guarantees.
 */
describe('against the real contract document', () => {
  const ROOT = process.cwd();

  it('resolves every section it claims to emit', () => {
    const raw = fs.readFileSync(path.join(ROOT, RUNTIME_CONTRACT_PATH), 'utf-8');

    for (const heading of EMITTED_CONTRACT_SECTIONS) {
      expect(raw).toMatch(new RegExp(`^## ${heading}$`, 'm'));
    }
  });

  it('renders all three from the real file', () => {
    const out = renderRuntimeContract(ROOT)!;

    expect(out.match(/^### /gm)).toHaveLength(3);
  });

  // `container/CLAUDE.md` is enumerated as an install surface so an operator
  // additionalMount covering the project tree is forced read-only. The layer
  // reads it on the host; a writable mount of a document inlined into the prompt
  // would let the agent rewrite its own contract.
  // Asserts the GUARANTEE, not the spelling: upstream replaced the literal
  // path.join with protectedProviderDocumentSourcePaths(), so pinning the old
  // text would go red on a behaviour-preserving refactor while a real
  // regression — the path dropping out of the protected set — stayed green.
  it('stays an enumerated install surface', () => {
    const drivers = fs.readFileSync(path.join(ROOT, 'src/drivers/index.ts'), 'utf-8');

    expect(drivers).toContain('protectedProviderDocumentSourcePaths(projectRoot)');
    expect(protectedProviderDocumentSourcePaths(ROOT)).toContain(path.join(ROOT, 'container', 'CLAUDE.md'));
  });
});

describe('exported names', () => {
  // Upstream's composer names this section identically. Keeping the string in
  // sync means a future re-adoption produces the same document rather than two
  // differently-titled contract sections.
  it('matches upstream project-doc-compose BASE_DOC_SECTION', () => {
    expect(RUNTIME_CONTRACT_SECTION).toBe('NanoClaw Runtime Contract');
  });

  // `scripts/fetch-skills.sh` loads dist/claude-composer.js with require(), and CI's
  // "Fetch external skills" step runs it. A single import that reaches the DB layer
  // makes the bundle an async ESM graph — `db/migrations/index.ts` ends in a
  // TOP-LEVEL AWAIT for migration auto-discovery — and require() then throws
  // ERR_REQUIRE_ASYNC_MODULE. That failure surfaces only in CI, in a step whose name
  // says nothing about imports, so it is asserted here on the static graph instead.
  it('composer bundle never imports a module whose graph has a top-level await', () => {
    const ROOT = process.cwd();
    const resolveLocal = (fromFile: string, spec: string): string | undefined => {
      if (!spec.startsWith('.')) return undefined;
      const abs = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, '.ts'));
      return fs.existsSync(abs) ? abs : undefined;
    };
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string, trail: readonly string[]): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf-8');
      // A top-level await is one at column 0 — anything indented is inside a function.
      if (/^(?:await |(?:export )?const [^=]+= await )/m.test(src)) {
        offenders.push([...trail, path.relative(ROOT, file)].join(' -> '));
        return;
      }
      for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        const next = resolveLocal(file, m[1]!);
        if (next) walk(next, [...trail, path.relative(ROOT, file)]);
      }
    };
    walk(path.join(ROOT, 'src/claude-composer.ts'), []);

    // join(): the failure message must NAME the import chain, or the next reader
    // has to re-derive it from a bare array diff.
    expect(offenders.join('\n')).toBe('');
  });
});
