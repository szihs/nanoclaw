---
name: onboard-coworker
description: Create a new AI coworker role for NanoClaw. Interactive wizard that builds skills, tools, CLAUDE.md templates, and container config for a new coworker type (e.g., software quality coworker, security auditor, documentation writer). Use when user wants to add a new coworker role or customize an existing one.
triggers:
  - onboard.?coworker
  - create.?coworker
  - new.?coworker
  - add.?coworker
  - coworker.?role
---

# Onboard Coworker

This skill creates new AI coworker types for NanoClaw. Each coworker type is a reusable template — once created, N instances can be spawned for parallel work.

## Key Files

| File | Purpose |
|------|---------|
| `groups/coworker-types.json` | Registry of all coworker types |
| `groups/slang-base/CLAUDE.md` | Base Slang coworker template (reference) |
| `groups/slang-*/CLAUDE.md` | Domain-specific templates (reference) |
| `container/skills/*/SKILL.md` | Container skills (composable capabilities) |
| `scripts/spawn-coworker.sh` | CLI to spawn coworker instances |
| `container/Dockerfile` | Container dependencies |
| `src/container-runner.ts` | Container env vars and mounts |

## Phase 1: Discovery — Understand the Coworker Role

Ask the user these questions using AskUserQuestion:

1. **Role**: What kind of coworker? (e.g., "software quality engineer", "security auditor", "DevOps engineer", "Slang SPIRV specialist")
2. **Project**: What project/repo will this coworker work on? (may be the same as existing coworkers)
3. **Core tasks**: What are the top 3-5 things this coworker will do?
4. **Tools needed**: What tools/skills does it need? (build systems, linters, test frameworks, APIs)
5. **Channels**: Which communication channels? (Slack, Discord, GitHub)
6. **Working style**: Plan-first (default) or act-first? Autonomous or collaborative?

## Phase 2: Inventory — Check Existing Skills & Tools

Scan for reusable components:

```bash
# List existing container skills
ls container/skills/

# List existing coworker types
cat groups/coworker-types.json | jq 'keys'

# Check what's installed in the container
head -50 container/Dockerfile

# Check configured channels
ls src/channels/

# Check environment variables
grep -v '^#' .env | grep -v '^$' | cut -d= -f1
```

Present findings to user:
- "These existing skills can be reused: [list]"
- "These new skills need to be created: [list]"
- "These tools are already in the container: [list]"
- "These tools need to be added: [list]"

## Phase 3: Create/Customize Container Skills

For each new skill needed, create `container/skills/<name>/SKILL.md`:

```yaml
---
name: <skill-name>
description: <when to use this skill>
allowed-tools: Bash(<tool-pattern>:*)
---
```

Follow the format of existing skills (see `container/skills/slang-repo/SKILL.md` for reference). Each skill should:
- Explain what the skill does
- Provide concrete bash commands
- Include common patterns and workflows
- Document troubleshooting steps

## Phase 4: Create Coworker Group Template

### 4a. Decide on template inheritance

- If this coworker is a new domain for an existing project (e.g., another Slang specialist), it should extend the project's base template
- If this is a completely new project coworker, create both a base template and the domain template

### 4b. Create the CLAUDE.md

Create `groups/<coworker-type>/CLAUDE.md` with these sections:

```markdown
# <Role Name>

You specialize in <domain description>.

## Domain: <Name>

<What area this coworker owns>

## Key Files

| File | Purpose |
|------|---------|
| ... | ... |

## Domain Knowledge

<Architectural notes, patterns, conventions — starts minimal, grows via auto-memory>

## Typical Tasks

- Task 1
- Task 2
- ...

## Related Coworkers

- **<Type>** — <how they interact>
```

If extending a base template, the base's CLAUDE.md gets mounted at `/workspace/global/CLAUDE.md` (read-only). The domain template lives in the group's own folder.

## Phase 5: Container Dependencies

Check if new tools are needed in the container:

```bash
# Current Dockerfile packages
grep 'apt-get install\|npm install -g\|pip install' container/Dockerfile
```

If new tools are needed:
1. Add them to the appropriate `apt-get install` or `npm install -g` line in `container/Dockerfile`
2. Rebuild: `./container/build.sh`

Common additions:
- Build tools: `cmake`, `ninja-build`, `cargo`, `go`
- Linters: `eslint`, `pylint`, `cppcheck`, `clang-tidy`
- Coverage: `lcov`, `gcov`
- Analysis: `valgrind`, `strace`

## Phase 6: Environment & Auth

Check if new credentials are needed:

```bash
# Current env vars
grep -v '^#' .env | grep -v '^$' | cut -d= -f1
```

If new tokens are needed:
1. Add to `.env` (e.g., `SONAR_TOKEN=...`)
2. If the container needs the token, add it to `src/container-runner.ts` in the container environment setup
3. Sync env: `cp .env data/env/env`

## Phase 7: Register in Coworker Types

Add the new type to `groups/coworker-types.json`:

```json
{
  "<type-name>": {
    "description": "<one-line description>",
    "template": "groups/<type-name>/CLAUDE.md",
    "base": "<base-type or null>",
    "repo": "<repo-url if applicable>",
    "containerDeps": ["<tool1>", "<tool2>"],
    "skills": ["<skill1>", "<skill2>"],
    "focusFiles": ["<glob-pattern>"]
  }
}
```

## Phase 8: Test the Coworker

1. Spawn a test instance:
   ```bash
   ./scripts/spawn-coworker.sh --type <type-name> "test-instance" "Simple test task"
   ```

2. Verify:
   - Group folder created with correct CLAUDE.md
   - Skills loaded in container's `.claude/skills/`
   - Coworker follows plan-first protocol
   - Memory persists between sessions

3. If using `npm run dev`, send a test message to the coworker's channel

## Phase 9: Summary

After completing all phases, summarize what was created:

```
=== New Coworker Type: <name> ===

Template: groups/<type>/CLAUDE.md
Skills created: <list>
Skills reused: <list>
Container deps added: <list>
Env vars added: <list>

Spawn with:
  ./scripts/spawn-coworker.sh --type <type> "<name>" "<task>"

Or via channel:
  @Andy spawn <type> <name> <task>
```
