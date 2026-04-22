---
name: onboard-project
description: "Onboard a new project into the NanoClaw lego coworker system. Generates the full skeleton: spine, capability skills (5), workflow extensions (4), coworker types (common, reader, writer), and all 16 trait bindings. Accepts a GitHub URL or local path. Uses DeepWiki for OSS GitHub repos."
---

# Onboard Project

Generate a complete NanoClaw lego project skeleton — the full equivalent of what `spine-slang` provides — for any new project.

## Input

The user passes the project as the prompt argument: `/onboard-project <repo> [short-name]`

- **`$1`** — GitHub URL (e.g. `https://github.com/shader-slang/slangpy`) OR local path (e.g. `/home/user/projects/mylib`)
- **`$2`** — Project short name (optional; derived from repo/directory name if omitted)

Examples:
```
/onboard-project https://github.com/shader-slang/slangpy slangpy
/onboard-project /home/user/projects/mylib
/onboard-project ~/code/graphics-engine gfx
```

Parse from the prompt. If the path/URL is missing, ask for it. The short name must be lowercase, hyphen-separated — it becomes the prefix for all generated skills.

## Phase 1: Analyze the repository

### 1a. Get the code on disk

**Always clone or locate the code first.** You need files on disk to read `.claude/`, `AGENTS.md`, build configs, and tests.

- **GitHub URL**: `git clone --depth 1 https://github.com/{owner}/{repo}.git /tmp/{project}`
- **Local path** (starts with `/`, `~`, or `.`): Use directly — already on disk.
- **Other git URL**: `git clone --depth 1 {url} /tmp/{project}`

Set `PROJECT_PATH` to the directory containing the code. All subsequent steps read from this path.

### 1b. Discover existing skills

Before generating anything, scan `container/skills/` for reusable skills. These exist on nv-main and should be referenced, not recreated:

```bash
ls container/skills/*/SKILL.md | while read f; do
  grep -m1 "^name:" "$f" | sed 's/name: //'
done
```

Common reusable skills: `base-nanoclaw`, `plan`, `deep-research`, `codex-critique`, `investigate` (workflow), `implement` (workflow), `review` (workflow), `document` (workflow), `critique-overlay`, `plan-overlay`. These are shared across ALL projects — the new project's `coworker-types.yaml` references them, no need to generate duplicates.

### 1c. Research the codebase

**IMPORTANT: Mine ALL AI config from the project.** Do NOT skip any file found below. These are the highest-signal sources because they describe how agents should work with this code. Every skill, agent, command, and instruction file must be read and incorporated into the generated skills. Read every file found:

```bash
# Find all AI agent config files
find {PROJECT_PATH} -maxdepth 3 \( \
  -name "CLAUDE.md" -o -name "AGENTS.md" -o -name "CONTRIBUTING.md" \
  -o -name "copilot-instructions.md" -o -name ".cursorrules" \
  -o -path "*/.claude/skills/*/SKILL.md" \
  -o -path "*/.claude/agents/*.md" \
  -o -path "*/.claude/commands/*.md" \
  -o -path "*/.codex/*.md" \
  -o -path "*/.cursor/rules/*.mdc" \
\) -type f 2>/dev/null
```

**For each file found:**
1. Read it fully
2. Extract: build commands, test patterns, code style, architecture, debugging tools, review checklists
3. Map to our 16 traits — each project skill/agent/command covers one or more traits

**Especially important — project's existing skills and agents:**
- `.claude/skills/*/SKILL.md` — the project's own automation. Reference them by name in our generated skills (e.g. "See project's `/{skill}` skill for {purpose}").
- `.claude/agents/*.md` — review/analysis patterns. Incorporate their checklists into `{project}-review` overrides and `{project}-code-reader` review lenses.
- Don't recreate what the project already has — reference it and add trait declarations.

**Then read standard project files:**
1. `README.md`
2. Build files: `CMakeLists.txt`, `package.json`, `pyproject.toml`, `Cargo.toml`, `Makefile`
3. CI: `.github/workflows/*.yml` (first 2-3 files)
4. Test directory: find `tests/`, `test/`, `**/test_*.py`, `**/*.test.ts`
5. Source layout: `src/`, `lib/`, `{project}/`

**Supplemental: DeepWiki** (for OSS GitHub repos only). Use `mcp__deepwiki__ask_question` with `{owner}/{repo}` for deeper architecture questions that aren't answered by the files on disk. This is optional — the clone has everything needed.

Write the analysis to `/workspace/group/onboard-{project}.md`.

### 1d. Build trait capability map

Scan ALL existing skills for their `provides:` traits. This tells you which capabilities are already covered and what the new project needs:

```bash
for f in container/skills/*/SKILL.md; do
  name=$(grep -m1 "^name:" "$f" | sed 's/name: //')
  provides=$(grep -m1 "^provides:" "$f" | sed 's/provides: //')
  [ -n "$provides" ] && echo "$name: $provides"
done
```

**Already covered by base skills (don't regenerate):**
- `plan` → `plan.research`
- `codex-critique` → `critique`
- `deep-research` → `plan.research`

### 1d. Incorporate project's existing skills, agents, and commands

The project's own AI config is the best source for building our skills. The priority is to **reuse** what exists, not recreate it.

**Strategy: reference first, build only when missing.**

For each of the 16 traits, check if the project already has a skill/agent/command covering it:

1. **Project has a matching skill** (`.claude/skills/*/SKILL.md`) → reference it by name in our generated skill body: "See project's `/repro-remix` skill for RTX Remix testing." Add the project skill's knowledge to the relevant NanoClaw skill.

2. **Project has matching agents** (`.claude/agents/*.md`) → extract their review checklists, patterns, and focus areas. Incorporate into our `{project}-review` workflow overrides and `{project}-code-reader` review lenses section.

3. **Project has commands** (`.claude/commands/*.md`) → reference in the relevant skill body.

4. **No project coverage for a trait** → generate the skill from scratch using CLAUDE.md, README, build files, and CI.

**For each generated skill, include a "From project" section** that links back to the original sources used:

```markdown
## From project

- `/{skill-name}` — {description} (`.claude/skills/{skill-name}/`)
- `{agent-name}` agent — {what it checks} (`.claude/agents/{agent-name}.md`)
```

This ensures knowledge isn't lost and the coworker knows where to find deeper guidance.

**Trait inference heuristic** (map skill name/description to traits):

| Signal in name/description | Traits |
|---------------------------|--------|
| build, compile, cmake, make, cargo build | `code.build, test.run` |
| test, pytest, jest, vitest | `test.run, test.gen` |
| read, explore, trace, navigate, search | `code.read` |
| edit, write, implement, fix, patch | `code.read, code.edit` |
| doc, documentation, sphinx, rustdoc | `doc.read, doc.write` |
| github, git, pr, issue, ci | `repo.read, repo.write, repo.pr` |
| perf, benchmark, profile, trace | `perf.profile, perf.bench` |
| debug, inspect, diagnose | `code.read, test.run` |
| format, lint, style | `code.edit` |
| deploy, release | `repo.write` |

If a trait can't be inferred, ask the user. Always confirm the mapping with the user before writing.

**If the project has NO existing skills**, generate the standard set from scratch:
- `{project}-build`, `{project}-code-reader`, `{project}-code-writer`, `{project}-docs`, `{project}-github`

### 1e. Generate specialized types from skill clusters

Beyond the default common/reader/writer, look for skill clusters that warrant their own type:

- Skills with `perf.*` traits → `{project}-perf` type (extends writer, adds perf skills + performance workflow)
- Skills with `debug.*` or `inspect.*` traits → `{project}-debugger` type
- Skills with domain-specific traits not covered by reader/writer → new specialized type

Only create specialized types when the skill set is distinct enough that a separate coworker role makes sense. Don't create a type for every skill — most fit into reader or writer.

### 1d. Derive project profile

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

## Phase 3: Validate and activate

Run these commands and fix any issues:

```bash
pnpm run build
npm run rebuild:claude
npm run validate:templates
npx vitest run
```

All types must compose cleanly with zero warnings. If `validate:templates` fails:
- Missing skill reference → check SKILL.md `name:` matches the reference in coworker-types.yaml
- Unresolved trait → check `provides:` in the relevant capability skill
- Cross-project binding → check that all skills are listed under the correct project's types

**Activate the new types** — restart the running NanoClaw service (and dashboard if running) so new types are immediately visible in the UI. The agent should know the service name from setup context.

Rebuild the container image if needed (new skills may add allowed-tools that need to be baked in):

```bash
./container/build.sh 2>&1 | tail -5
```

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
