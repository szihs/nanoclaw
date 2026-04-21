# dashboard-base

Formatting addon for the web dashboard channel.

## What it provides

Contributes a single Markdown-formatting block to the `main` and `global` flat types. When the composer merges coworker-types.yaml files across `container/skills/`, this skill appends `context: [prompts/formatting.md]` to both, and the renderer inserts the block after the upstream body separated by a `---` rule.

## Why it's separate from nanoclaw-base

`nanoclaw-base` is pinned to upstream parity — anything that deviates goes in its own skill so the default install stays a byte-for-byte match of upstream. Installing the dashboard feature is what pulls this skill in.
