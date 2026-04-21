---
name: deep-research
description: "Deep external research against public repositories, docs, and linked knowledge. Trigger when you need background on a library, standard, or unfamiliar codebase before making a call. Keywords: research, look up, what is, how does X work, deepwiki."
provides: [research, doc-read]
allowed-tools: Read, Grep, Glob, mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_contents, mcp__deepwiki__read_wiki_structure
---

# Deep Research

Project-agnostic research skill. Wraps the `deepwiki` MCP server so any coworker can pull authoritative background without shelling out to the wider web.

## When to use

- A workflow hits an unfamiliar library, protocol, or standard and you need a grounded summary.
- Triage or review needs context from an upstream repo you don't have cloned.
- You want a quick "what is X and how does it work" answer against a specific repo's wiki.

## Steps

1. **Scope the question** — frame it against a repo (e.g. `owner/name`) or a topic. A wiki question without a target repo is a red flag — pick one.

2. **Ask** — `mcp__deepwiki__ask_question` for narrow Q&A, or `read_wiki_contents` / `read_wiki_structure` to browse. Prefer the narrowest query that answers the question.

3. **Cite** — every claim you take from this skill into downstream work quotes the source (repo + wiki path). Do not paraphrase into assertions that look authoritative without a link.

## Invariants

- Do not treat wiki content as ground truth for the calling project's own code — read the code. Use research to orient, then verify locally.
- Do not paste large wiki excerpts into reports. Summarize + link.
- Research is read-only; it never edits files or opens PRs.
