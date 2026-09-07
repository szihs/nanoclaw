---
name: explain-diff-html
license: MIT
description: "Rich, self-contained HTML explanation of a code change (PR, branch, or diff): Background → Intuition → Code walkthrough → five-question interactive quiz. Run it right after every `gh pr create` (the PR-created hook asks for it) and whenever someone asks for a deep explanation of a change. Writes under reports/pr-explanations/ and delivers the file; never posts it to GitHub."
provides: [pr.explain]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(date:*), Read, Grep, Glob, Write, mcp__nanoclaw__send_file, mcp__nanoclaw__send_message
---

# Explain a diff as HTML

Produce one self-contained HTML page that teaches a reader what a change does and why, well enough that they could review it. The reader may be the peer reviewer, the orchestrator, or a human who was not in the loop.

## When

- **After every PR you create.** The PR-created hook context names the PR (`owner/repo#N`). Call `report_pr_created` first, then run this skill, then send the review request / report with the file path in its artifact list. The explanation is part of opening a PR, not an optional extra.
- **On request.** "Explain this PR / branch / diff" from anyone in the chain.

## Scope the change

```bash
gh pr view <n> --repo <owner/repo> --json title,body,baseRefName,headRefName,additions,deletions,files
gh pr diff <n> --repo <owner/repo>                      # or: git diff <base>...<head>
```

Then read the surrounding code in your checkout — the modules the diff touches, their callers, the tests. Background needs the system as it was, not just the hunks.

## Sections, in this order

1. **Background.** The existing system relevant to this change. Two layers: a deep background for a beginner (marked as skippable), then a narrow background directly relevant to the change.
2. **Intuition.** The essence of the change, not the details. Concrete examples with toy data. Figures and diagrams throughout.
3. **Code.** A high-level walkthrough of the diff, grouped and ordered so it reads as a story rather than file by file.
4. **Quiz.** Five multiple-choice questions of medium difficulty: answerable only by someone who understood the substance, never gotchas. Clicking an option reveals correct/incorrect and a one-paragraph explanation.

## Format

- One HTML file with inline CSS and JavaScript, no external assets, works offline. One long page with section headers and a table of contents at the top. No tabs for the top-level structure. Basic responsive styling so it reads on a phone.
- Write with the clarity and flow of Martin Kleppmann: engaging, classic style, smooth transitions between sections.
- Diagrams: pick a small number of diagram families and reuse them across cases. Useful families: a very simplified version of the UI the user sees; a system diagram of data flow between components **with example data in it**.
- No ASCII diagrams. Diagrams are simple HTML/CSS; lists are HTML lists.
- Code goes in `<pre>`. If a styled `<div>` holds code it must carry `white-space: pre-wrap`, or the browser collapses the newlines. Before saving, scan every code block in the source and confirm `white-space: pre` or `pre-wrap` applies.
- Callouts for key concepts, definitions, and important edge cases.

## Where it goes

```
/workspace/agent/reports/pr-explanations/<YYYY-MM-DD>-<owner>-<repo>-pr<N>-<slug>.html   # PR
/workspace/agent/reports/pr-explanations/<YYYY-MM-DD>-<branch-slug>.html                 # no PR yet
```

`date +%F` for the prefix (files stay time-sorted); `<slug>` is 2–5 lowercase words from the title. The directory sits outside every git checkout: never commit it, never `git add` it.

## Deliver

1. `mcp__nanoclaw__send_file({ path, text: "Explanation of <owner/repo>#<N> — <title>" })` to the thread that asked for the PR (`in_reply_to` the request when you are on a chain). If the channel cannot take a file, say so in one line and give the path.
2. Put the path in the artifact list of the review request / `[Fix Report]` / handoff that follows, so the reviewer opens it before the diff.
3. **Never** post the file or its path to GitHub. Upstream PRs are public; this artifact is internal.

## Effort

One focused pass: read for background, write, verify the checklist, deliver. Do not re-run tests or re-review the code here — that is the critique's job. For a docs-only or under-20-line diff, keep Background short and say "compact" in the header; the quiz is still five questions.

## Before you send

- Table of contents anchors resolve; the page is one scroll.
- Every code block keeps its newlines (`<pre>` or `pre-wrap` confirmed in the source).
- Each quiz option responds with correct/incorrect and feedback.
- No `http(s)://` asset references; the file opens from disk.
