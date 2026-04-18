#!/usr/bin/env python3
"""Integration tests for GitHub pull request functions.

These tests call real APIs and require GITHUB_ACCESS_TOKEN.
Run with: pytest -m integration
"""

import pytest

from src.github.github import ListPullRequestsArgs, list_pull_requests


@pytest.mark.integration
@pytest.mark.asyncio
async def test_list_pull_requests():
    """Integration test: list open PRs from shader-slang/slang."""
    args = ListPullRequestsArgs(
        owner="shader-slang",
        repo="slang",
        state="open",
        sort="updated",
        direction="desc",
        per_page=5,
    )

    result = await list_pull_requests(args)

    assert "error" not in result, f"API error: {result.get('error')}"
    assert "filtered" in result
    assert isinstance(result["filtered"], list)
