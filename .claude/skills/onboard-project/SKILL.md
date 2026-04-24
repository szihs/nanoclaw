---
name: onboard-project
description: "Onboard a new project into the NanoClaw lego coworker system. Generates the full skeleton: spine, capability skills (5), workflow extensions (4), coworker types (common, reader, writer), and all 16 trait bindings. For OSS GitHub repos, uses DeepWiki for codebase analysis."
---

# Onboard Project

Generate a complete NanoClaw lego project skeleton — the full equivalent of what `spine-slang` provides — for any new project.

## Input

The user passes the project as the prompt argument: `/onboard-project <github-url> [short-name]`

Example: `/onboard-project https://github.com/shader-slang/slangpy slangpy`

- **`$1`** — GitHub repo URL (required)
- **`$2`** — Project short name (optional; derived from repo name if omitted: `shader-slang/slangpy` → `slangpy`)

Parse from the prompt. If the URL is missing, ask for it. The short name must be lowercase, hyphen-separated — it becomes the prefix for all generated skills.

## Phase 1: Analyze the repository

### 1a. Research via DeepWiki (OSS GitHub repos)

Extract `{owner}/{repo}` from the URL. Use `mcp__deepwiki__ask_question` if available (the agent has it when the type includes `deepwiki` MCP server). Ask these questions — store each answer as a section in `/workspace/group/onboard-{project}.md`:

1. "What are the primary programming languages, build system (CMake/npm/cargo/pip/etc), and how do you build and run tests in {owner}/{repo}?"
2. "What is the source directory layout of {owner}/{repo}? List the top-level directories and what each contains."
3. "What is the public API surface of {owner}/{repo}? What classes, functions, or modules are user-facing and should be treated as stable?"
4. "What are the contribution guidelines for {owner}/{repo}? Branch naming, PR process, code style, pre-commit hooks, CI requirements?"
5. "What CI/CD system does {owner}/{repo} use? What are the key workflow files and test commands?"
6. "What documentation system does {owner}/{repo} use? Where are docs, how are they generated?"

### 1b. Fallback (no DeepWiki or private repo)

Clone to `/tmp/{project}`: `git clone --depth 1 {url} /tmp/{project}`

Read these files to extract the same information:
- `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`
- Build files: `CMakeLists.txt`, `package.json`, `pyproject.toml`, `Cargo.toml`, `Makefile`
- CI: `.github/workflows/*.yml` (first 2-3 files)
- Test directory: find `tests/`, `test/`, `**/test_*.py`, `**/*.test.ts`
- Source entry: `src/`, `lib/`, `{project}/`

Write the analysis to `/workspace/group/onboard-{project}.md`.

### 1c. Derive project profile

From the analysis, determine:

| Field | Example (slangpy) |
|-------|-------------------|
| `LANG` | Python + C++ |
| `BUILD_CMD` | `python tools/ci.py configure && python tools/ci.py build` |
| `TEST_CMD` | `pytest slangpy/tests -v` |
| `TEST_DIR` | `slangpy/tests/` |
| `SRC_DIRS` | `slangpy/`, `src/sgl/`, `src/slangpy_ext/` |
| `ENTRY_POINT` | `slangpy/__init__.py` |
| `DOC_DIR` | `docs/` |
| `DOC_CMD` | `sphinx-build docs/ docs/_build/` |
| `CI_FILE` | `.github/workflows/ci.yml` |
| `STYLE` | Black (Python), clang-format (C++) |
| `BRANCH_CONVENTION` | `feature/name` |
| `PR_PROCESS` | Fork → branch → PR → squash merge |
| `IDENTITY` | "You are a SlangPy engineer..." |
| `KEY_INVARIANTS` | Type annotations required, backward compat, tests as contract |

## Phase 2: Generate artifacts

Create all files. Use `{project}` as the prefix. Use `{Project}` (capitalized) in descriptions.

### 2a. Spine: `container/skills/spine-{project}/`

**`identity/engineer.md`** — One paragraph. Derive from repo description and primary language:
> You are a {Project} engineer. You work on {repo description from GitHub}. You understand {key technical domains from analysis}. You prefer {coding style preferences from analysis}.

**`invariants/public-api.md`** — From the API surface analysis:
```markdown
### {Project} public API invariants

- {list stable API surfaces}
- {list test contract rules}
- {list backward compatibility rules}
```

**`context/layout.md`** — From directory structure analysis:
```markdown
### {Project} repository layout

- `{dir1}/` — {purpose}
- `{dir2}/` — {purpose}
...
- `{test_dir}/` — tests. See `/{project}-build` to build/test.
- `.github/workflows/` — CI. See `/{project}-investigate` for CI issues.
```

**`README.md`** — Brief:
```markdown
# spine-{project}

{Project} project spine under the lego coworker model. Provides identity, invariants, context, and coworker types ({project}-common, {project}-reader, {project}-writer).
```

**`coworker-types.yaml`**:
```yaml
{project}-common:
  description: "{Project} spine — identity, API invariants, repo layout."
  project: {project}
  extends: base-common
  identity: container/skills/spine-{project}/identity/engineer.md
  invariants:
    - container/skills/spine-{project}/invariants/public-api.md
  context:
    - container/skills/spine-{project}/context/layout.md
  skills:
    - {project}-build
    - {project}-code-reader
    - {project}-github
    - deep-research
    - codex-critique
  workflows:
    - investigate
    - review
  overlays:
    - critique-overlay
    - plan-overlay
  mcpServers:
    deepwiki:
      type: http
      url: https://mcp.deepwiki.com/mcp
  bindings:
    repo: {project}-github
    issues: {project}-github
    code: {project}-code-reader
    doc: {project}-code-reader
    test: {project}-build
    plan: deep-research
    critique: codex-critique

{project}-reader:
  description: "Read-only {Project} coworker — investigate issues, review PRs, research codebase. Cannot edit code or create PRs."
  project: {project}
  extends: {project}-common
  workflows:
    - {project}-investigate
    - {project}-review

{project}-writer:
  description: "Write-capable {Project} coworker — investigate, implement, review, document. Can edit code, write tests, create PRs."
  project: {project}
  extends: {project}-common
  skills:
    - {project}-code-writer
    - {project}-docs
  workflows:
    - {project}-investigate
    - {project}-implement
    - implement
    - document
    - {project}-review
    - {project}-document
  bindings:
    code: {project}-code-writer
    test: {project}-build
    doc: {project}-docs
```

### 2b. Capability skills (5 skills)

Each SKILL.md must have frontmatter with `name`, `description`, `provides`, `allowed-tools`, and a body with project-specific guidance.

**`container/skills/{project}-build/SKILL.md`**:
```yaml
---
name: {project}-build
description: "Clone, build, and test {Project}. Use when the repo needs setup, a rebuild, or when tests fail."
provides: [code.build, test.run, test.gen, ci.inspect]
allowed-tools: Bash(git:*), Bash({build_tool}:*), Read, Grep, Glob
---
```
Body: Clone instructions, build commands (from `BUILD_CMD`), test commands (from `TEST_CMD`), CI log inspection, common gotchas from analysis.

**`container/skills/{project}-code-reader/SKILL.md`**:
```yaml
---
name: {project}-code-reader
description: "Read-only investigation of the {Project} codebase. Navigate source, trace call paths, understand architecture."
provides: [code.read, doc.read]
allowed-tools: Bash, Read, Grep, Glob, mcp__deepwiki__ask_question
---
```
Body: Source layout (from analysis), key modules, entry points, architecture overview, search strategies.

**`container/skills/{project}-code-writer/SKILL.md`**:
```yaml
---
name: {project}-code-writer
description: "Implement changes in {Project}. Edit code, write tests, format, commit."
provides: [code.read, code.edit, test.gen]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---
```
Body: Code style rules (from `STYLE`), test patterns (from test dir analysis), branch naming (from `BRANCH_CONVENTION`), build-test-format-commit cycle.

**`container/skills/{project}-docs/SKILL.md`**:
```yaml
---
name: {project}-docs
description: "Read and write {Project} documentation."
provides: [doc.read, doc.write]
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git add:*), Bash(git commit:*)
---
```
Body: Doc location (from `DOC_DIR`), doc framework, generation commands (from `DOC_CMD`), doc style conventions.

**`container/skills/{project}-github/SKILL.md`**:
```yaml
---
name: {project}-github
description: "GitHub operations for {Project}. Clone, branch, PR, issues, CI."
provides: [repo.read, repo.write, repo.pr, issues.read, issues.write, ci.rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob
---
```
Body: Repo URL, clone command, PR process (from `PR_PROCESS`), issue conventions, CI rerun commands.

### 2c. Workflow extensions (4 workflows)

**`container/skills/{project}-investigate-workflow/SKILL.md`**:
```yaml
---
name: {project}-investigate
type: workflow
description: "Investigate a {Project} issue. Specialized steps for {Project} codebase."
extends: investigate
requires: [issues.read, code.read, doc.read, plan.research]
uses:
  skills: [{project}-build, {project}-code-reader, {project}-github, deep-research]
  workflows: []
overrides:
  classify: "Classify by {Project} subsystem: {list key subsystems from analysis}."
  investigate: "Use /{project}-code-reader for code, /{project}-build for repro, /{project}-github for CI logs, /deep-research for architecture."
---
```

**`container/skills/{project}-implement-workflow/SKILL.md`**:
```yaml
---
name: {project}-implement
type: workflow
description: "Implement a fix or feature in {Project}. Specialized build/test/format steps."
extends: implement
requires: [code.read, code.edit, test.run, test.gen, repo.pr]
uses:
  skills: [{project}-build, {project}-code-reader, {project}-github, {project}-code-writer]
  workflows: []
overrides:
  reproduce: "Write a failing test in `{TEST_DIR}` that demonstrates the issue. Commit the failing test first."
  patch: "Use /{project}-code-writer. Keep changes minimal and within one subsystem."
  validate: "Build: `{BUILD_CMD}`. Test: `{TEST_CMD}`. Format: `{format_cmd}`. Check for regressions."
---
```

**`container/skills/{project}-review-workflow/SKILL.md`**:
```yaml
---
name: {project}-review
type: workflow
description: "Review a {Project} change against project conventions."
extends: review
requires: [repo.read, code.read, doc.read]
uses:
  skills: [{project}-code-reader, {project}-github]
  workflows: []
overrides:
  assess: "Check against {Project} conventions: {list key style rules, API rules, test requirements from analysis}."
---
```

**`container/skills/{project}-document-workflow/SKILL.md`**:
```yaml
---
name: {project}-document
type: workflow
description: "Update {Project} documentation after a change or for a doc gap."
extends: document
requires: [code.read, doc.read, doc.write, repo.pr]
uses:
  skills: [{project}-docs, {project}-code-reader, {project}-github]
  workflows: []
overrides:
  survey: "Check {DOC_DIR} for existing docs. Use /{project}-code-reader to understand the code being documented."
  draft: "Use /{project}-docs for writing. Follow {Project} doc conventions: {doc style from analysis}."
---
```

## Phase 3: Validate

Run these commands and fix any issues:

```bash
npm run build
npm run validate:templates
npx vitest run
```

All types must compose cleanly with zero warnings. If `validate:templates` fails:
- Missing skill reference → check SKILL.md `name:` matches the reference in coworker-types.yaml
- Unresolved trait → check `provides:` in the relevant capability skill
- Cross-project binding → check that all skills are listed under the correct project's types

## Phase 4: Summary

Report to the user:
1. Files created (count and list)
2. Coworker types available: `{project}-reader`, `{project}-writer`
3. Traits covered (all 16)
4. Next steps: use `/onboard-coworker` to create agents from these types

Ask if they want pre-packaged coworker bundles in `coworkers/` (triage agent, fixer agent).

## Reference: All 16 traits

| # | Trait | Domain | Skill | Binding level |
|---|-------|--------|-------|---------------|
| 1 | `repo.read` | repo | `{project}-github` | common |
| 2 | `repo.write` | repo | `{project}-github` | common |
| 3 | `repo.pr` | repo | `{project}-github` | common |
| 4 | `issues.read` | issues | `{project}-github` | common |
| 5 | `issues.write` | issues | `{project}-github` | common |
| 6 | `code.read` | code | `{project}-code-reader` | common |
| 7 | `code.edit` | code | `{project}-code-writer` | writer override |
| 8 | `code.build` | code | `{project}-build` | common |
| 9 | `test.run` | test | `{project}-build` | common |
| 10 | `test.gen` | test | `{project}-build` | common |
| 11 | `ci.inspect` | ci | `{project}-build` | auto (test domain) |
| 12 | `ci.rerun` | ci | `{project}-github` | auto (repo domain) |
| 13 | `doc.read` | doc | `{project}-code-reader` | common |
| 14 | `doc.write` | doc | `{project}-docs` | writer override |
| 15 | `plan.research` | plan | `deep-research` | common |
| 16 | `critique` | critique | `codex-critique` | common |
