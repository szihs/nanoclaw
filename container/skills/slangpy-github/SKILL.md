---
name: slangpy-github
description: "GitHub operations for SlangPy. Clone, branch, PR, issues, CI."
provides: [repo.read, repo.write, repo.pr, issues.read, issues.write, ci.rerun]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob
---

## Repository

- **URL:** https://github.com/shader-slang/slangpy
- **Clone:** `git clone --recursive --tags https://github.com/shader-slang/slangpy.git`
- **Docs:** https://slangpy.shader-slang.org/en/latest/
- **Discussions:** https://github.com/shader-slang/slang/discussions
- **Discord:** https://khr.io/slangdiscord

## PR process

1. Fork -> clone -> branch (`feature/description`)
2. Implement, test, format (`pre-commit run --all-files`)
3. Push to fork, create PR against `shader-slang/slangpy:main`
4. PR requires review approval + CI pass
5. Squash merge -- rewrite final commit message to be descriptive

During review, push follow-up commits (don't rebase after PR creation). Sync with upstream via merge, not rebase:

```bash
git fetch upstream main
git merge upstream/main
git submodule update --recursive
```

## CI

CI workflows in `.github/workflows/`:

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Main CI: configure, build, test on multiple platforms |
| `ci-latest-slang.yml` | Test against latest Slang compiler build |
| `ci-benchmark.yml` | Performance benchmarks |
| `wheels.yml` / `wheels-dev.yml` | Python wheel builds |
| `slangpy_torch.yml` | PyTorch integration tests |
| `claude.yml` | Claude-driven CI tasks |

Key CI commands:

```bash
gh run list --repo shader-slang/slangpy --workflow=ci.yml --limit 5
gh run view <id> --log-failed
gh run rerun <id> --failed
```

## Issues

```bash
gh issue list --repo shader-slang/slangpy
gh issue view <number> --repo shader-slang/slangpy
gh issue create --repo shader-slang/slangpy --title "..." --body "..."
```

## Related repositories

- **Slang compiler:** https://github.com/shader-slang/slang -- the Slang shading language compiler that SlangPy depends on
- **slang-rhi:** GPU abstraction layer wrapped by the SGL core layer

## From project

- `CONTRIBUTING.md` -- fork/clone/branch process, PR requirements, squash merge policy, sync instructions
- `AGENTS.md` -- repository structure, CI system description
- `.github/workflows/` -- CI workflow definitions
