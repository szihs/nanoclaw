#!/usr/bin/env python3
"""Integration tests for GitHub issue functions.

These tests call real APIs and require GITHUB_ACCESS_TOKEN.
Run with: pytest -m integration
"""


import pytest
from rich.console import Console

from src.github.github import (
    GetIssueArgs,
    ListIssuesArgs,
    get_issue,
    list_issues,
)

console = Console()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_issue():
    """Integration test: fetch a real issue from shader-slang/slang."""
    args = GetIssueArgs(
        owner="shader-slang",
        repo="slang",
        issue_number=6772,
    )

    result = await get_issue(args)

    assert "error" not in result, f"API error: {result.get('error')}"
    assert "filtered" in result
    filtered = result["filtered"]
    assert filtered["number"] == 6772
    assert filtered["title"] is not None


@pytest.mark.integration
@pytest.mark.asyncio
async def test_list_issues_graphql():
    """Integration test: list issues via GraphQL."""
    args = ListIssuesArgs(
        owner="shader-slang",
        repo="slang",
        state="OPEN",
        first=5,
        since="2025-04-07T00:00:00Z",
    )

    result = await list_issues(args)

    assert "error" not in result, f"API error: {result.get('error')}"
    assert "filtered" in result
    filtered = result["filtered"]
    assert "issues" in filtered
    assert "total_count" in filtered
    assert filtered["total_count"] >= 0
