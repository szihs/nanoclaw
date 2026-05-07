"""Tests for GitHub API integration."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import dotenv
import pytest

# Load environment variables for testing
dotenv.load_dotenv()

from src.github import (  # noqa: E402
    AddIssueCommentArgs,
    GetDiscussionsArgs,
    GetIssueArgs,
    ListIssuesArgs,
    SearchIssuesArgs,
    UpdateIssueArgs,
    add_issue_comment,
    get_discussions,
    get_issue,
    list_issues,
    search_issues,
    update_issue,
)


@pytest.fixture
def mock_github_request():
    """Mock for github_request function."""
    with patch("src.github.github.github_request") as mock:
        yield mock


@pytest.fixture
def sample_issue_data():
    """Sample GitHub issue data for testing."""
    return {
        "number": 1,
        "title": "Test Issue",
        "body": "This is a test issue for unit testing",
        "state": "open",
        "created_at": "2023-01-01T00:00:00Z",
        "updated_at": "2023-01-02T00:00:00Z",
        "closed_at": None,
        "html_url": "https://github.com/test/repo/issues/1",
        "user": {"login": "testuser"},
        "assignees": [{"login": "testuser"}],
        "labels": [{"name": "bug"}, {"name": "priority"}],
        "comments": 2,
        "milestone": {"title": "v1.0", "number": 1},
    }


@pytest.mark.asyncio
async def test_get_issue(mock_github_request, sample_issue_data):
    """Test get_issue function."""
    # Setup mock responses
    mock_github_request.return_value = AsyncMock()
    mock_github_request.side_effect = [
        sample_issue_data,  # Main issue response (REST)
        {
            "data": {"repository": {"issue": {"projectItems": {"nodes": []}}}}
        },  # GraphQL response
        [{"id": 1, "body": "Test comment"}],  # Comments response (REST)
    ]

    # Test function
    args = GetIssueArgs(owner="test", repo="repo", issue_number=1)
    result = await get_issue(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert result["filtered"]["number"] == 1
    assert result["filtered"]["title"] == "Test Issue"
    assert result["filtered"]["state"] == "open"
    assert result["filtered"]["author"] == "testuser"
    assert "comments_data" in result["filtered"]
    assert len(result["filtered"]["comments_data"]) == 1
    assert result["filtered"]["comments_data"][0]["body"] == "Test comment"

    # Verify API was called correctly
    mock_github_request.assert_any_call("GET", "repos/test/repo/issues/1")
    mock_github_request.assert_any_call("GET", "repos/test/repo/issues/1/comments")


@pytest.mark.asyncio
async def test_list_issues(mock_github_request):
    """Test list_issues function."""
    # Setup mock response
    mock_github_request.return_value = AsyncMock()
    # Use dates relative to now so the default 7-day since filter works
    now = datetime.now(timezone.utc)
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    two_days_ago = (now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    mock_issues = [
        {
            "number": 1,
            "title": "Issue 1",
            "body": "Description 1",
            "state": "OPEN",
            "createdAt": two_days_ago,
            "updatedAt": yesterday,
            "closedAt": None,
            "url": "https://github.com/test/repo/issues/1",
            "author": {"login": "testuser"},
            "assignees": {"nodes": []},
            "labels": {"nodes": [{"name": "bug"}]},
            "comments": {"totalCount": 0},
        },
        {
            "number": 2,
            "title": "Issue 2",
            "body": "Description 2",
            "state": "OPEN",
            "createdAt": two_days_ago,
            "updatedAt": two_days_ago,
            "closedAt": None,
            "url": "https://github.com/test/repo/issues/2",
            "author": {"login": "testuser2"},
            "assignees": {"nodes": []},
            "labels": {"nodes": [{"name": "enhancement"}]},
            "comments": {"totalCount": 1},
        },
    ]
    # GraphQL response structure for list_issues
    graphql_response = {
        "data": {
            "repository": {
                "issues": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": mock_issues
                }
            }
        }
    }
    mock_github_request.side_effect = [graphql_response]

    # Test function
    args = ListIssuesArgs(owner="test", repo="repo", state="OPEN")
    result = await list_issues(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert "issues" in result["filtered"]
    assert "total_count" in result["filtered"]
    assert result["filtered"]["total_count"] == 2
    assert len(result["filtered"]["issues"]) == 2
    assert result["filtered"]["issues"][0]["number"] == 1 
    assert result["filtered"]["issues"][1]["number"] == 2

    # Verify GraphQL API was called correctly
    mock_github_request.assert_called_once()
    call_args = mock_github_request.call_args
    assert call_args[0][0] == "POST"  # HTTP method
    assert call_args[0][1] == "graphql"  # Endpoint
    assert "json" in call_args[1]  # GraphQL payload


@pytest.mark.asyncio
async def test_search_issues(mock_github_request):
    """Test search_issues function."""
    # Setup mock response
    mock_github_request.return_value = AsyncMock()
    mock_search_result = {
        "total_count": 1,
        "incomplete_results": False,
        "items": [
            {
                "number": 1,
                "title": "Issue 1",
                "body": "Description 1",
                "state": "open",
                "created_at": "2023-01-01T00:00:00Z",
                "updated_at": "2023-01-02T00:00:00Z",
                "closed_at": None,
                "html_url": "https://github.com/test/repo/issues/1",
                "user": {"login": "testuser"},
                "assignees": [],
                "labels": [{"name": "bug"}],
                "comments": 0,
            }
        ],
    }
    mock_github_request.side_effect = [mock_search_result]

    # Test function
    args = SearchIssuesArgs(q="repo:test/repo is:issue bug")
    result = await search_issues(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert "items" in result["filtered"]
    assert "total_count" in result["filtered"]
    assert result["filtered"]["total_count"] == 1
    assert len(result["filtered"]["items"]) == 1
    assert result["filtered"]["items"][0]["number"] == 1
    assert result["filtered"]["items"][0]["title"] == "Issue 1"

    # Verify API was called correctly
    mock_github_request.assert_called_once_with(
        "GET", "search/issues", params={"q": "repo:test/repo is:issue bug"}
    )


@pytest.mark.asyncio
async def test_add_issue_comment(mock_github_request):
    """Test add_issue_comment function."""
    # Setup mock response
    mock_github_request.return_value = AsyncMock()
    mock_comment = {
        "id": 1,
        "body": "Test comment",
        "created_at": "2023-01-01T00:00:00Z",
        "html_url": "https://github.com/test/repo/issues/1#issuecomment-1",
        "user": {"login": "testuser"},
    }
    mock_github_request.side_effect = [mock_comment]

    # Test function
    args = AddIssueCommentArgs(
        owner="test", repo="repo", issue_number=1, body="Test comment"
    )
    result = await add_issue_comment(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert result["filtered"]["id"] == 1
    assert result["filtered"]["body"] == "Test comment"
    assert (
        result["filtered"]["html_url"]
        == "https://github.com/test/repo/issues/1#issuecomment-1"
    )

    # Verify API was called correctly
    mock_github_request.assert_called_once_with(
        "POST",
        "repos/test/repo/issues/1/comments",
        json={"body": "Test comment"},
    )


@pytest.mark.asyncio
async def test_update_issue(mock_github_request, sample_issue_data):
    """Test update_issue function."""
    # Setup mock response
    mock_github_request.return_value = AsyncMock()
    updated_issue = sample_issue_data.copy()
    updated_issue["title"] = "Updated Title"
    updated_issue["state"] = "closed"
    mock_github_request.side_effect = [updated_issue]

    # Test function
    args = UpdateIssueArgs(
        owner="test",
        repo="repo",
        issue_number=1,
        title="Updated Title",
        state="closed",
    )
    result = await update_issue(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert result["filtered"]["title"] == "Updated Title"
    assert result["filtered"]["state"] == "closed"

    # Verify API was called correctly
    mock_github_request.assert_called_once_with(
        "PATCH",
        "repos/test/repo/issues/1",
        json={"title": "Updated Title", "state": "closed"},
    )


@pytest.mark.asyncio
async def test_get_discussions(mock_github_request):
    """Test get_discussions function."""
    # Setup mock response with GraphQL structure
    mock_discussions = [
        {
            "id": "D_kwDOABCDEF4ABCDE",
            "number": 1,
            "title": "Discussion 1",
            "body": "This is a discussion about feature X",
            "bodyText": "This is a discussion about feature X",
            "createdAt": "2025-06-10T00:00:00Z",
            "updatedAt": "2025-06-11T00:00:00Z",
            "url": "https://github.com/test/repo/discussions/1",
            "resourcePath": "/test/repo/discussions/1",
            "locked": False,
            "isAnswered": True,
            "answerChosenAt": "2025-06-11T12:00:00Z",
            "author": {"login": "discussionuser"},
            "category": {
                "id": "DIC_kwDOABCDEF4ABCDE",
                "name": "Q&A",
                "description": "Ask questions and get answers",
                "emoji": "❓",
                "isAnswerable": True
            },
            "answer": {
                "id": "DC_kwDOABCDEF4ABCDE",
                "body": "Here's the answer to your question",
                "createdAt": "2025-06-11T12:00:00Z",
                "author": {"login": "answeruser"}
            },
            "answerChosenBy": {"login": "discussionuser"},
            "comments": {"totalCount": 3},
            "reactionGroups": [
                {"content": "THUMBS_UP", "users": {"totalCount": 5}},
                {"content": "HEART", "users": {"totalCount": 2}}
            ]
        },
        {
            "id": "D_kwDOABCDEF4FGHIJ",
            "number": 2,
            "title": "Discussion 2",
            "body": "This is an unanswered discussion",
            "bodyText": "This is an unanswered discussion",
            "createdAt": "2025-06-09T00:00:00Z",
            "updatedAt": "2025-06-10T00:00:00Z",
            "url": "https://github.com/test/repo/discussions/2",
            "resourcePath": "/test/repo/discussions/2",
            "locked": False,
            "isAnswered": False,
            "answerChosenAt": None,
            "author": {"login": "user2"},
            "category": {
                "id": "DIC_kwDOABCDEF4FGHIJ",
                "name": "General",
                "description": "General discussion",
                "emoji": "💬",
                "isAnswerable": False
            },
            "answer": None,
            "answerChosenBy": None,
            "comments": {"totalCount": 1},
            "reactionGroups": []
        }
    ]

    # GraphQL response structure for get_discussions
    graphql_response = {
        "data": {
            "repository": {
                "discussions": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": mock_discussions,
                    "totalCount": 2
                },
                "discussionCategories": {
                    "nodes": [
                        {
                            "id": "DIC_kwDOABCDEF4ABCDE",
                            "name": "Q&A",
                            "description": "Ask questions and get answers",
                            "emoji": "❓"
                        },
                        {
                            "id": "DIC_kwDOABCDEF4FGHIJ", 
                            "name": "General",
                            "description": "General discussion",
                            "emoji": "💬"
                        }
                    ]
                }
            }
        }
    }
    
    mock_github_request.side_effect = [graphql_response]

    # Test function
    args = GetDiscussionsArgs(owner="test", repo="repo", first=10)
    result = await get_discussions(args)

    # Verify results - the function returns a nested structure
    assert "filtered" in result
    assert "raw" in result
    assert "discussions" in result["filtered"]
    assert "total_count" in result["filtered"]
    assert "page_info" in result["filtered"]
    assert "categories" in result["filtered"]
    
    # Check discussions data
    assert result["filtered"]["total_count"] == 2
    assert len(result["filtered"]["discussions"]) == 2
    
    # Check first discussion
    discussion1 = result["filtered"]["discussions"][0]
    assert discussion1["number"] == 1
    assert discussion1["title"] == "Discussion 1"
    assert discussion1["is_answered"] is True
    assert discussion1["author"] == "discussionuser"
    assert discussion1["category"]["name"] == "Q&A"
    assert discussion1["answer"]["body"] == "Here's the answer to your question"
    assert discussion1["answer_chosen_by"] == "discussionuser"
    assert discussion1["comments_count"] == 3
    assert discussion1["reactions"] == {"THUMBS_UP": 5, "HEART": 2}

    # Check second discussion (unanswered)
    discussion2 = result["filtered"]["discussions"][1]
    assert discussion2["number"] == 2
    assert discussion2["title"] == "Discussion 2"
    assert discussion2["is_answered"] is False
    assert discussion2["author"] == "user2"
    assert discussion2["category"]["name"] == "General"
    assert discussion2["answer"] is None
    assert discussion2["answer_chosen_by"] is None
    assert discussion2["comments_count"] == 1
    assert discussion2["reactions"] is None
    
    # Check categories
    assert len(result["filtered"]["categories"]) == 2
    assert result["filtered"]["categories"][0]["name"] == "Q&A"
    assert result["filtered"]["categories"][1]["name"] == "General"

    # Verify GraphQL API was called correctly
    mock_github_request.assert_called_once()
    call_args = mock_github_request.call_args
    assert call_args[0][0] == "POST"  # HTTP method
    assert call_args[0][1] == "graphql"  # Endpoint
    assert "json" in call_args[1]  # GraphQL payload
    assert "query" in call_args[1]["json"]
    assert "variables" in call_args[1]["json"]


@pytest.mark.asyncio
async def test_get_discussions_filtered(mock_github_request):
    """Test get_discussions function with filters."""
    # Setup mock response with no discussions (filtered out)
    graphql_response = {
        "data": {
            "repository": {
                "discussions": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [],
                    "totalCount": 0
                },
                "discussionCategories": {
                    "nodes": [
                        {
                            "id": "DIC_kwDOABCDEF4ABCDE",
                            "name": "Q&A",
                            "description": "Ask questions and get answers",
                            "emoji": "❓"
                        }
                    ]
                }
            }
        }
    }
    
    mock_github_request.side_effect = [graphql_response]

    # Test function with filters
    args = GetDiscussionsArgs(
        owner="test", 
        repo="repo", 
        first=5,
        answered=True,  # Only answered discussions
        category_id="DIC_kwDOABCDEF4ABCDE"  # Specific category
    )
    result = await get_discussions(args)

    # Verify results
    assert "filtered" in result
    assert result["filtered"]["total_count"] == 0
    assert len(result["filtered"]["discussions"]) == 0
    assert len(result["filtered"]["categories"]) == 1

    # Verify API was called with correct variables
    mock_github_request.assert_called_once()
    call_args = mock_github_request.call_args
    variables = call_args[1]["json"]["variables"]
    assert variables["first"] == 5
    assert variables["answered"] is True
    assert variables["categoryId"] == "DIC_kwDOABCDEF4ABCDE"
