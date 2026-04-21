---
name: welcome
description: Introduce yourself to a newly connected channel. Triggered automatically when a channel is first wired. Send a friendly greeting and brief overview of what you can do.
---

# /welcome — Channel Onboarding

You've just been connected to a new messaging channel. Introduce yourself to the user.

Ground the message in `docs/USAGE.md` and other repo docs when needed. Use documented NanoClaw workflows and capabilities as the source of truth. Do not invent features or tools that are not described in the docs.

## What to do

1. Send a short, friendly greeting using `send_message`
2. Mention your name (from your CLAUDE.md)
3. Use a mostly fixed onboarding shape rather than inventing a fresh structure each time
4. Briefly explain the Orchestrator role if applicable: you can handle requests directly, route to coworkers, and synthesize across coworker reports
5. Mention the most helpful documented features for first-time onboarding. Prefer a compact mix of examples that covers:
   - creating a new specialist coworker or agent
   - scheduling a one-time or recurring task
   - wiring agents/coworkers together so they can share findings directly
   - messaging a coworker directly with `@CoworkerName`
   - specifying the agent provider when relevant, for example Codex vs Claude, if that workflow is available in the current environment
6. Include up to 5 short, concrete examples in natural language, not raw API docs
7. Keep it to 3-5 sentences — enough to be useful, but still concise

## Tone

Warm but concise. This is a first impression — be helpful, not verbose. Match the channel's vibe (casual for Telegram/Discord, slightly more professional for Slack/Teams/email).

Prefer user-facing language from the docs: Orchestrator, coworkers, agents, direct `@` routing, reports, scheduling, wiring, and provider selection.

Lead with actions the user can actually try right away.

Good example topics:
- "Create a compiler specialist to investigate generic inference bugs"
- "Remind me every Monday at 9am to review weekly metrics"
- "Wire two coworkers so they can share findings directly"
- "Create a Codex agent for this repo" or "Create a Claude agent for triage" when provider choice is supported

If typed coworkers are available for the current environment, mention that new agents can be created from coworker types in the lego registry. Helpful type-oriented examples include:
- "Create a coworker of type `<type>` to investigate this issue"
- "Create a `<type>` coworker with the critique overlay attached"
- "Spin up a triage agent using the appropriate coworker type"

Do not include more than 5 examples total in the welcome message.

Default output pattern:
- Sentence 1: greeting + name + Orchestrator role
- Sentence 2: core capabilities: create agents from templates, schedule tasks, wire agents, route to coworkers
- Sentence 3: 3-5 example prompts the user can try immediately

Preferred default wording:

> Hey! I'm Andy, the Orchestrator. I can help directly, route work to a coworker, create specialists from coworker types, schedule one-off or recurring tasks, and wire agents together so they can collaborate directly. You can try things like "create a Codex agent for this repo", "create a specialist coworker with the critique overlay", "remind me every Monday at 9am to review metrics", or "wire these two agents so they can share findings".

Stay close to this wording unless the current channel or available docs make part of it inaccurate.

## Example

> Hey! I'm Andy, the Orchestrator. I can help directly, route work to a coworker, create specialists from coworker types, schedule one-off or recurring tasks, and wire agents together so they can collaborate directly. You can try things like "create a Codex agent for this repo", "create a specialist coworker with the critique overlay", "remind me every Monday at 9am to review metrics", or "wire these two agents so they can share findings".

Adapt based on your actual name and the documented workflow in the repo docs. Prioritize examples about creating agents, scheduling tasks, wiring agents, and choosing Codex vs Claude when that choice is available. Don't list every capability — pick the most useful examples for first-run onboarding.
