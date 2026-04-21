"""Integration tests for GitLab API functions.

These tests call real APIs and require GITLAB_ACCESS_TOKEN.
Run with: pytest -m integration
"""

import pytest

from src.gitlab import (
    ListIssuesArgs,
    ListMergeRequestArgs,
    list_issues,
    list_merge_requests,
)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_gitlab_get_issues():
    """Integration test: list issues from a GitLab project."""
    args = ListIssuesArgs(
        project_id="6417",
        state="opened",
    )

    result = await list_issues(args)

    assert "error" not in result, f"API error: {result.get('error')}"
    assert "data" in result
    assert isinstance(result["data"], list)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_gitlab_list_merge_requests():
    """Integration test: list merge requests from a GitLab project."""
    args = ListMergeRequestArgs(
        project_id="6417",
        state="opened",
    )

    result = await list_merge_requests(args)

    assert "error" not in result, f"API error: {result.get('error')}"
    assert "data" in result
    assert isinstance(result["data"], list)
