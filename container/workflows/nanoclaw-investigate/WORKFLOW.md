---
name: nanoclaw-investigate
type: workflow
description: "Investigate a NanoClaw issue. Specialized steps for the NanoClaw codebase."
extends: investigate
requires: [issues.read, code.read, doc.read, plan.research]
uses:
  skills: [nanoclaw-build, nanoclaw-code-reader, nanoclaw-github, deep-research]
  workflows: []
overrides:
  classify: "Classify by NanoClaw subsystem: host (index/delivery/router), container-runner, claude-composer, dashboard, modules (a2a/approvals/permissions/scheduling), container agent-runner, MCP."
  investigate: "Use /nanoclaw-code-reader for code, /nanoclaw-build for repro, /nanoclaw-github for CI logs, /deep-research for architecture."
---
