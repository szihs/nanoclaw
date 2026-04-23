---
name: plan
description: "Create a structured plan before solving. Take a requirement, research the problem space, identify approaches, evaluate trade-offs, and produce an actionable plan. Use before any non-trivial implementation — never jump straight to code without a plan."
provides: [plan.research]
allowed-tools: Read, Grep, Glob, WebSearch, WebFetch, Bash(find:*), Bash(git log:*), Bash(git show:*)
---

# Plan

Stop and think before acting. This skill turns a requirement into an actionable plan through structured research and analysis.

## When to use

- Before implementing a non-trivial change (more than a one-line fix)
- When asked "how should we approach this?"
- When an investigation reveals multiple possible solutions
- When the scope is unclear or the requirement is ambiguous
- Before any architectural decision

## Steps

1. **Understand the requirement** — restate what was asked in your own words. If ambiguous, list the interpretations and pick the most likely. If still unclear, ask.

2. **Research the problem space** — before proposing solutions:
   - Read relevant code paths (use Grep/Glob to find entry points)
   - Check git history for prior attempts (`git log --all --grep="<keyword>"`)
   - Search for existing patterns in the codebase that solve similar problems
   - If external knowledge is needed, use WebSearch or deepwiki

3. **Identify approaches** — list 2-3 concrete approaches. For each:
   - What changes are needed (files, functions, interfaces)
   - What existing code/patterns can be reused
   - Estimated complexity (lines changed, files touched)

4. **Evaluate trade-offs** — for each approach:
   - Correctness: does it actually solve the problem?
   - Simplicity: is it the minimum change?
   - Risk: what could break? What's the blast radius?
   - Reversibility: how easy to undo if wrong?

5. **Recommend** — pick one approach with a clear justification. Structure the plan as:

```md
# Plan: <title>

## Problem
<one paragraph>

## Approach
<chosen approach with justification>

## Steps
1. <concrete step with file paths>
2. <concrete step>
3. ...

## Verification
- <how to test it worked>

## Risks
- <what could go wrong>
```

6. **Get confirmation** — present the plan and wait for approval before proceeding.
   <!-- mcp__nanoclaw__ask_user_question disabled — plan-overlay's critique loop handles approval. -->

## Invariants

- Never skip the research step. "I already know how to do this" is not a plan.
- Never propose more than 3 approaches — if there are more, you haven't narrowed enough.
- Every step in the plan must name a concrete file or function, not a vague area.
- The plan must fit in one screen. If it doesn't, the scope is too large — break it down.
- A plan is not a commitment. It's a hypothesis to be validated during implementation.
