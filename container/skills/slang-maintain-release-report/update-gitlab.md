# GitLab nv-master Rebase

Integrate latest GitHub master into GitLab's nv-master branch.

## Workflow

1. Check current sync status via MCP:
   ```
   mcp__slang-mcp__gitlab_list_merge_requests — check pending MRs
   ```

2. In the Slang repo, fetch both remotes:
   ```bash
   git fetch origin          # GitHub
   git fetch gitlab          # GitLab
   ```

3. Create backup branch:
   ```bash
   git checkout gitlab/nv-master
   git checkout -b backup/nv-master-$(date +%Y%m%d)
   ```

4. Rebase nv-master onto latest master:
   ```bash
   git checkout nv-master
   git rebase origin/master
   ```

5. If conflicts arise:
   - Resolve conflict files
   - `git add <resolved files>`
   - `git rebase --continue`
   - Ask user for help if the conflict is non-trivial

6. Build and test:
   ```bash
   cmake --build --preset debug --parallel $(nproc)
   cd build && ctest --output-on-failure
   ```

7. Push (after user confirmation):
   ```bash
   git push gitlab nv-master --force-with-lease
   ```

## Gotchas

- **Always use --force-with-lease**, never --force — protects against someone else pushing to nv-master
- **nv-specific patches** — nv-master has NVIDIA-specific patches on top of master. Rebase preserves these. If a conflict touches nv-specific code, prefer the nv-master version.
- **CI must pass** — GitLab CI runs on push. Check pipeline status before announcing completion.
- **Backup first** — Always create backup/nv-master-{date} branch before rebasing.
