"""Regression tests for MCP tool annotations on slang-mcp tools.

These pin which tools carry `openWorldHint=True`. The host-side critique
gate (src/container-runner.ts: resolveCritiqueGatedTools) treats any tool
with `openWorldHint === true` as an externally-posting tool and gates it
under plan-gate.sh alongside Edit/Write. So mis-annotating a read-only
tool would spuriously block it, and missing an annotation on a writing
tool silently disables the gate for that path.

Uses AST parsing rather than invoking the MCP server so the tests run
offline without the full `mcp` runtime — the annotation is a static
kwarg on `types.Tool(...)` calls in server.py and is visible in source.

The WRITE_TOOLS and READ_TOOLS lists below ARE the reviewable contract
established by the companion PR #115 on nv-main. If a new tool is added,
add it to one list or the other so the classification stays explicit.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

# Tools that post/create/modify externally. Annotated with openWorldHint=True
# in src/server.py so plan-gate.sh blocks them when critique_required/
# plan_required is active. Keep this list sorted alphabetically by platform
# then name so reviewers can read it as the contract.
WRITE_TOOLS = [
    # Discord
    "discord_send_message",
    # GitHub
    "github_create_or_update_file",
    # GitLab
    "gitlab_create_or_update_file",
    # Slack
    "slack_post_message",
    "slack_reply_to_thread",
]

# Tools that only read. Must NOT carry openWorldHint=True — the gate
# filters on openWorldHint===true with no read/write distinction, so
# marking a read-only tool would spuriously block triage/investigation
# workflows.
READ_TOOLS = [
    # Discord
    "discord_read_messages",
    # GitHub
    "github_get_discussions",
    "github_get_file_contents",
    "github_get_issue",
    "github_get_pull_request",
    "github_get_pull_request_comments",
    "github_get_pull_request_reviews",
    "github_list_issues",
    "github_list_pull_requests",
    "github_search_issues",
    # GitLab
    "gitlab_get_file_contents",
    "gitlab_list_issues",
    "gitlab_list_merge_requests",
    # Slack
    "slack_get_channel_history",
    "slack_get_user_profile",
]

SERVER_PY = Path(__file__).parent.parent / "src" / "server.py"


def _collect_tool_annotations() -> dict[str, dict[str, object] | None]:
    """Parse src/server.py and return {tool_name: annotation_kwargs_or_None}.

    Returns None for tools without an `annotations=` kwarg. Otherwise returns
    a dict of the kwargs passed to `types.ToolAnnotations(...)`, with constant
    values unwrapped (e.g. `{"openWorldHint": True}`).
    """
    tree = ast.parse(SERVER_PY.read_text(), filename=str(SERVER_PY))
    result: dict[str, dict[str, object] | None] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        # Match `types.Tool(...)` calls only.
        if not (
            isinstance(func, ast.Attribute)
            and func.attr == "Tool"
            and isinstance(func.value, ast.Name)
            and func.value.id == "types"
        ):
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg is not None}
        name_node = kwargs.get("name")
        if not isinstance(name_node, ast.Constant) or not isinstance(name_node.value, str):
            continue
        name = name_node.value
        ann_node = kwargs.get("annotations")
        if ann_node is None:
            result[name] = None
            continue
        # Expect `types.ToolAnnotations(openWorldHint=..., ...)`.
        if isinstance(ann_node, ast.Call):
            ann_kwargs: dict[str, object] = {}
            for kw in ann_node.keywords:
                if kw.arg is None:
                    continue
                if isinstance(kw.value, ast.Constant):
                    ann_kwargs[kw.arg] = kw.value.value
                else:
                    ann_kwargs[kw.arg] = kw.value  # non-constant; leave as AST node
            result[name] = ann_kwargs
        else:
            result[name] = {"__raw__": ann_node}
    return result


@pytest.fixture(scope="module")
def tool_annotations() -> dict[str, dict[str, object] | None]:
    return _collect_tool_annotations()


def test_server_py_is_parseable() -> None:
    """Sanity: server.py parses at the top level."""
    assert SERVER_PY.exists(), f"{SERVER_PY} not found"
    ast.parse(SERVER_PY.read_text())


@pytest.mark.parametrize("name", WRITE_TOOLS)
def test_write_tools_have_openworld_hint(
    name: str, tool_annotations: dict[str, dict[str, object] | None]
) -> None:
    """Every externally-posting tool must carry openWorldHint=True.

    Without this, the host-side critique gate (see PR #115) silently
    skips it — external posts would bypass the plan/critique state
    machine that guards Edit/Write.
    """
    assert name in tool_annotations, (
        f"{name} not found in server.py — either it was renamed/removed "
        f"(update WRITE_TOOLS) or the AST walker is mis-parsing."
    )
    ann = tool_annotations[name]
    assert ann is not None, (
        f"{name} is a write tool but has no annotations=... kwarg. "
        f"Add `annotations=types.ToolAnnotations(openWorldHint=True)` to "
        f"its types.Tool(...) call."
    )
    assert ann.get("openWorldHint") is True, (
        f"{name} annotations has openWorldHint={ann.get('openWorldHint')!r}; "
        f"expected True so the critique gate engages."
    )


@pytest.mark.parametrize("name", READ_TOOLS)
def test_read_tools_have_no_openworld_hint(
    name: str, tool_annotations: dict[str, dict[str, object] | None]
) -> None:
    """Read-only tools must NOT carry openWorldHint=True.

    The host-side gate has no readOnlyHint check — it filters purely on
    `openWorldHint === true`. Annotating a read tool would spuriously
    block triage/investigation workflows that do no external writes.
    """
    assert name in tool_annotations, (
        f"{name} not found in server.py — either renamed/removed "
        f"(update READ_TOOLS) or the AST walker is mis-parsing."
    )
    ann = tool_annotations[name]
    assert ann is None or ann.get("openWorldHint") is not True, (
        f"{name} is read-only but has openWorldHint=True — this would "
        f"cause the critique gate to spuriously block it. Remove the "
        f"openWorldHint kwarg (or set it to False / drop the annotations= "
        f"kwarg entirely)."
    )


def test_no_contradictory_hints(
    tool_annotations: dict[str, dict[str, object] | None],
) -> None:
    """A tool can't be both openWorld and readOnly simultaneously."""
    for name, ann in tool_annotations.items():
        if ann is None:
            continue
        if ann.get("openWorldHint") is True and ann.get("readOnlyHint") is True:
            pytest.fail(
                f"{name} has contradictory hints: openWorldHint=True AND readOnlyHint=True"
            )


def test_write_and_read_lists_are_disjoint() -> None:
    """Catches typos where a tool appears in both lists."""
    overlap = set(WRITE_TOOLS) & set(READ_TOOLS)
    assert not overlap, f"Tool(s) in both WRITE_TOOLS and READ_TOOLS: {sorted(overlap)}"


def test_lists_cover_every_tool_in_server_py(
    tool_annotations: dict[str, dict[str, object] | None],
) -> None:
    """If a new tool was added to server.py without updating these lists,
    fail loudly so the reviewer makes an explicit classification.
    """
    known = set(WRITE_TOOLS) | set(READ_TOOLS)
    discovered = set(tool_annotations.keys())
    missing = discovered - known
    assert not missing, (
        f"New tools in server.py not classified in WRITE_TOOLS or READ_TOOLS: "
        f"{sorted(missing)}. Add each one to the appropriate list in "
        f"test_tool_annotations.py — this is an explicit contract, not an "
        f"auto-detected set."
    )
