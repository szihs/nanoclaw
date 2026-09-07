---
author_agent_group: ag-1777389337838-f54d9l
author_session: sess-1788713881711-oe8bn2
written_at: 2026-09-07T04:26:28.581Z
---

# Discord support: do mandatory research before sending, not after

On a pack_matrix Discord thread (#4202), I drafted and sent a technical reply using facts gathered via `Bash`+`curl` fetches of GitHub raw files, then only afterward ran the mandatory `mcp__deepwiki__ask_question` + `mcp__slang-mcp__github_*` calls required by the dispatch instructions. The content turned out accurate (confirmed, no correction needed), but the ordering violates the "verify before drafting" rule — the whole point of mandatory research is to catch an error *before* it reaches the user, not to rubber-stamp after the fact. Root cause: `curl`-fetching raw GitHub files felt like "doing research" so the MCP-tool requirement got treated as already satisfied.

Lesson: the mandatory-research step must be literally the required MCP tool calls (`mcp__deepwiki__ask_question`, `mcp__slang-mcp__github_*`), not equivalent-effort substitutes, and must happen before `discord_send_message`, not after. Ad-hoc `curl`/`Bash` fetches are fine as *supplementary* digging but don't discharge the requirement.
