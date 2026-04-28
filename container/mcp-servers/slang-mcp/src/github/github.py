"""GitHub API integration for MCP server."""

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator
from rich.console import Console
from rich.panel import Panel

from ..config import IsDebug, github_request  # Import IsDebug() from config

# Initialize rich console for detailed logging
console = Console(stderr=True)

# Maximum body length for list endpoints (single-item gets keep full body)
_MAX_LIST_BODY_LENGTH = 500


def truncate_body(body: Optional[str], max_length: int = _MAX_LIST_BODY_LENGTH) -> Optional[str]:
    """Truncate a body string for list endpoints to reduce noise."""
    if not body:
        return body
    if len(body) <= max_length:
        return body
    return body[:max_length] + "... [truncated, use get_issue/get_pull_request for full body]"


class GetIssueArgs(BaseModel):
    """Arguments for the get_issue tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    issue_number: int = Field(..., description="Issue number to retrieve")


class ListIssuesRestfulArgs(BaseModel):
    """Arguments for the list_issues_restful tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    state: Optional[str] = Field(
        None, description="Filter by state ('open', 'closed', 'all')"
    )
    labels: Optional[List[str]] = Field(None, description="Filter by labels")
    sort: Optional[str] = Field(
        "updated", description="Sort by ('created', 'updated', 'comments')"
    )
    direction: Optional[str] = Field(
        "desc", description="Sort direction ('asc', 'desc')"
    )
    since: Optional[str] = Field(
        None, description="Filter by date (ISO 8601 timestamp)"
    )
    page: Optional[int] = Field(None, description="Page number")
    per_page: Optional[int] = Field(20, description="Results per page")

    # Add validation for enum values
    @field_validator("state")
    @classmethod
    def validate_state(cls, v):
        if v is not None and v not in ["open", "closed", "all"]:
            raise ValueError("state must be one of: 'open', 'closed', 'all'")
        return v

    @field_validator("sort")
    @classmethod
    def validate_sort(cls, v):
        if v is not None and v not in ["created", "updated", "comments"]:
            raise ValueError("sort must be one of: 'created', 'updated', 'comments'")
        return v

    @field_validator("direction")
    @classmethod
    def validate_direction(cls, v):
        if v is not None and v not in ["asc", "desc"]:
            raise ValueError("direction must be one of: 'asc', 'desc'")
        return v


class ListIssuesArgs(BaseModel):
    """Arguments for the list_issues tool."""

    owner: str = Field(..., description="Repository owner (username or organization)")
    repo: str = Field(..., description="Repository name")
    state: Optional[str] = Field(
        "OPEN", description="Filter by state ('OPEN', 'CLOSED', 'ALL')"
    )
    labels: Optional[List[str]] = Field(None, description="Filter by labels")
    first: Optional[int] = Field(10, description="Number of issues to fetch (max 100)")
    after: Optional[str] = Field(None, description="Cursor for pagination")
    order_by: Optional[Dict[str, str]] = Field(
        {"field": "UPDATED_AT", "direction": "DESC"},
        description="Order by field and direction",
    )
    since: Optional[str] = Field(
        default_factory=lambda: (
            datetime.now(timezone.utc) - timedelta(days=7)
        ).isoformat(),
        description="Filter by date (ISO 8601 timestamp), defaults to 7 days ago",
    )

    @field_validator("state")
    @classmethod
    def validate_state(cls, v):
        if v is not None and v not in ["OPEN", "CLOSED", "ALL"]:
            raise ValueError("state must be one of: 'OPEN', 'CLOSED', 'ALL'")
        return v

    @field_validator("first")
    @classmethod
    def validate_first(cls, v):
        if v is not None and (v < 1 or v > 100):
            raise ValueError("first must be between 1 and 100")
        return v

    @field_validator("since")
    @classmethod
    def validate_since(cls, v):
        if v is not None:
            try:
                # Ensure the timestamp is timezone-aware by converting to UTC
                dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.isoformat()
            except ValueError:
                raise ValueError("since must be a valid ISO 8601 timestamp")
        return v


class SearchIssuesArgs(BaseModel):
    """Arguments for the search_issues tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    q: str = Field(..., description="Search query using GitHub issues search syntax")
    sort: Optional[str] = Field(
        None, description="Sort field (comments, reactions, created, updated, etc.)"
    )
    order: Optional[str] = Field(None, description="Sort order ('asc' or 'desc')")
    per_page: Optional[int] = Field(None, description="Results per page (max 100)")
    page: Optional[int] = Field(None, description="Page number")

    # Add validation for enum values
    @field_validator("sort")
    @classmethod
    def validate_sort(cls, v):
        if v is not None and v not in [
            "comments",
            "reactions",
            "reactions-+1",
            "reactions--1",
            "reactions-smile",
            "reactions-thinking_face",
            "reactions-heart",
            "reactions-tada",
            "interactions",
            "created",
            "updated",
        ]:
            raise ValueError("sort must be a valid GitHub search sort field")
        return v

    @field_validator("order")
    @classmethod
    def validate_order(cls, v):
        if v is not None and v not in ["asc", "desc"]:
            raise ValueError("order must be one of: 'asc', 'desc'")
        return v

    @field_validator("per_page")
    @classmethod
    def validate_per_page(cls, v):
        if v is not None and (v < 1 or v > 100):
            raise ValueError("per_page must be between 1 and 100")
        return v


class AddIssueCommentArgs(BaseModel):
    """Arguments for the add_issue_comment tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    issue_number: int = Field(..., description="Issue number to comment on")
    body: str = Field(..., description="Comment text")


class UpdateIssueArgs(BaseModel):
    """Arguments for the update_issue tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    issue_number: int = Field(..., description="Issue number to update")
    title: Optional[str] = Field(None, description="New title")
    body: Optional[str] = Field(None, description="New description")
    state: Optional[str] = Field(None, description="New state ('open' or 'closed')")
    labels: Optional[List[str]] = Field(None, description="New labels")
    assignees: Optional[List[str]] = Field(None, description="New assignees")
    milestone: Optional[int] = Field(None, description="New milestone number")

    # Add validation for enum values
    @field_validator("state")
    @classmethod
    def validate_state(cls, v):
        if v is not None and v not in ["open", "closed"]:
            raise ValueError("state must be one of: 'open', 'closed'")
        return v


class ListPullRequestsArgs(BaseModel):
    """Arguments for the list_pull_requests tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    state: Optional[str] = Field(
        None, description="Filter by state ('open', 'closed', 'all')"
    )
    head: Optional[str] = Field(None, description="Filter by head branch")
    base: Optional[str] = Field(None, description="Filter by base branch")
    sort: Optional[str] = Field(
        None,
        description="Sort by ('created', 'updated', 'popularity', 'long-running')",
    )
    direction: Optional[str] = Field(
        "desc", description="Sort direction ('asc', 'desc')"
    )
    page: Optional[int] = Field(None, description="Page number")
    per_page: Optional[int] = Field(10, description="Results per page")

    # Add validation for enum values
    @field_validator("state")
    @classmethod
    def validate_state(cls, v):
        if v is not None and v not in ["open", "closed", "all"]:
            raise ValueError("state must be one of: 'open', 'closed', 'all'")
        return v

    @field_validator("sort")
    @classmethod
    def validate_sort(cls, v):
        if v is not None and v not in [
            "created",
            "updated",
            "popularity",
            "long-running",
        ]:
            raise ValueError(
                "sort must be one of: 'created', 'updated', 'popularity', 'long-running'"
            )
        return v

    @field_validator("direction")
    @classmethod
    def validate_direction(cls, v):
        if v is not None and v not in ["asc", "desc"]:
            raise ValueError("direction must be one of: 'asc', 'desc'")
        return v


class GetPullRequestArgs(BaseModel):
    """Arguments for the get_pull_request tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number to retrieve")


class CreatePullRequestReviewArgs(BaseModel):
    """Arguments for the create_pull_request_review tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number")
    commit_id: Optional[str] = Field(
        None, description="The SHA of the commit to review"
    )
    body: str = Field(..., description="The text of the review")
    event: Optional[str] = Field(
        "COMMENT",
        description="The review action ('APPROVE', 'REQUEST_CHANGES', 'COMMENT')",
    )
    comments: Optional[List[Dict[str, Any]]] = Field(
        None, description="Comments on specific lines (advanced usage)"
    )

    # Add validation for enum values
    @field_validator("event")
    @classmethod
    def validate_event(cls, v):
        if v not in ["APPROVE", "REQUEST_CHANGES", "COMMENT"]:
            raise ValueError(
                "event must be one of: 'APPROVE', 'REQUEST_CHANGES', 'COMMENT'"
            )
        return v


class GetPullRequestStatusArgs(BaseModel):
    """Arguments for the get_pull_request_status tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number")


class GetPullRequestCommentsArgs(BaseModel):
    """Arguments for the get_pull_request_comments tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number")


class GetPullRequestReviewsArgs(BaseModel):
    """Arguments for the get_pull_request_reviews tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number")
    per_page: Optional[int] = Field(None, description="Results per page")
    page: Optional[int] = Field(None, description="Page number")


class ListPullRequestCommitsArgs(BaseModel):
    """Arguments for the list_pull_request_commits tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    pull_number: int = Field(..., description="Pull request number")
    per_page: Optional[int] = Field(None, description="Results per page")
    page: Optional[int] = Field(None, description="Page number")


class ListIssueCommentsArgs(BaseModel):
    """Arguments for the list_issue_comments tool."""

    owner: str = Field(
        "shader-slang", description="Repository owner (username or organization)"
    )
    repo: str = Field("slang", description="Repository name")
    issue_number: int = Field(..., description="Issue number to retrieve comments for")
    per_page: Optional[int] = Field(None, description="Results per page")
    page: Optional[int] = Field(None, description="Page number")


class CreateOrUpdateFileArgs(BaseModel):
    """Arguments for the create_or_update_file tool."""

    owner: str = Field(..., description="Repository owner (username or organization)")
    repo: str = Field(..., description="Repository name")
    path: str = Field(..., description="Path where to create/update the file")
    content: str = Field(..., description="Content of the file")
    message: str = Field(..., description="Commit message")
    branch: str = Field(..., description="Branch to create/update the file in")
    sha: Optional[str] = Field(
        None,
        description="SHA of the file being replaced (required when updating existing files)",
    )


class GetFileContentsArgs(BaseModel):
    """Arguments for the get_file_contents tool (read-only)."""

    owner: str = Field("shader-slang", description="Repository owner")
    repo: str = Field("slang", description="Repository name")
    path: str = Field(..., description="File path within the repository")
    ref: Optional[str] = Field(None, description="Branch, tag, or commit SHA (defaults to default branch)")


class GetDiscussionsArgs(BaseModel):
    """Arguments for the get_discussions tool."""

    owner: str = Field(..., description="Repository owner (username or organization)")
    repo: str = Field(..., description="Repository name")
    first: Optional[int] = Field(
        10, description="Number of discussions to fetch (max 100)"
    )
    after: Optional[str] = Field(None, description="Cursor for pagination")
    category_id: Optional[str] = Field(
        None, description="Filter by discussion category ID"
    )
    answered: Optional[bool] = Field(
        None, description="Filter by answered status (true/false/null for all)"
    )
    order_by: Optional[Dict[str, str]] = Field(
        {"field": "UPDATED_AT", "direction": "DESC"},
        description="Order by field and direction",
    )

    @field_validator("first")
    @classmethod
    def validate_first(cls, v):
        if v is not None and (v < 1 or v > 100):
            raise ValueError("first must be between 1 and 100")
        return v

    @field_validator("order_by")
    @classmethod
    def validate_order_by(cls, v):
        if v is not None:
            valid_fields = ["CREATED_AT", "UPDATED_AT"]
            valid_directions = ["ASC", "DESC"]
            if v.get("field") not in valid_fields:
                raise ValueError(f"order_by field must be one of: {valid_fields}")
            if v.get("direction") not in valid_directions:
                raise ValueError(
                    f"order_by direction must be one of: {valid_directions}"
                )
        return v


def filter_data(issue: dict, is_list: bool = False) -> dict:
    """Filter GitHub issue/PR data to include only essential fields.

    Args:
        issue: Raw GitHub issue/PR data
        is_list: If True, truncate body for list endpoints

    Returns:
        Filtered data with only essential fields
    """

    # Get the body text (truncated for list views)
    body = issue.get("body", "") or ""
    if is_list:
        body = truncate_body(body)

    # Extract priority from project items if available
    priority = None
    if issue.get("projectItems", {}).get("nodes", []):
        for project_item in issue["projectItems"]["nodes"]:
            if project_item is None:
                continue
            field_values = project_item.get("fieldValues", {}).get("nodes", [])
            for field_value in field_values:
                if field_value is None:
                    continue
                if (
                    field_value.get("__typename")
                    == "ProjectV2ItemFieldSingleSelectValue"
                    and field_value.get("field", {}).get("name") == "Priority"
                ):
                    priority = field_value.get("name")
                    break
            if priority:
                break

    # Create filtered data
    filtered = {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "body": body,
        "state": issue.get("state"),
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "closed_at": issue.get("closed_at"),
        "url": issue.get("html_url"),
        "author": issue.get("user", {}).get("login") if issue.get("user") else None,
        "assignees": [assignee.get("login") for assignee in issue.get("assignees", [])],
        "labels": [label.get("name") for label in issue.get("labels", [])],
        "comments_count": issue.get("comments"),
        "priority": priority,
    }

    # Add PR-specific fields if this is a pull request
    if "pull_request" in issue or issue.get("merged_at") is not None or issue.get("draft") is not None:
        filtered["draft"] = issue.get("draft")
        filtered["merged_at"] = issue.get("merged_at")
        if issue.get("requested_reviewers"):
            filtered["requested_reviewers"] = [
                r.get("login") for r in issue.get("requested_reviewers", [])
            ]
        if issue.get("head"):
            filtered["head_branch"] = issue.get("head", {}).get("ref")
        if issue.get("base"):
            filtered["base_branch"] = issue.get("base", {}).get("ref")

    # Include milestone if available
    if issue.get("milestone"):
        filtered["milestone"] = {
            "title": issue.get("milestone", {}).get("title"),
            "number": issue.get("milestone", {}).get("number"),
        }

    return filtered


async def get_issue(args: GetIssueArgs) -> dict:
    """Get an issue from a GitHub repository.

    Args:
        args: The arguments for the get_issue tool.

    Returns:
        The issue data.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/issues/{args.issue_number}"
        )
        console.print(
            Panel.fit(
                f"[cyan]Getting issue {args.issue_number} from {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Get issue data from REST API
        url = f"repos/{args.owner}/{args.repo}/issues/{args.issue_number}"
        response = await github_request("GET", url)

        # Log the raw response
        console.log("[green]GitHub API Raw Response[/green] - Status: Success")
        console.print(
            Panel(
                json.dumps(response, indent=2),
                title="Raw Response Data",
                border_style="green",
                expand=False,
            )
        )

        # Get GraphQL data for priority
        graphql_query = """
        query($owner: String!, $repo: String!, $issue_number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issue_number) {
              projectItems(first: 10) {
                nodes {
                  project {
                    title
                  }
                  fieldValues(first: 10) {
                    nodes {
                      __typename
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2FieldCommon {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        """
        graphql_variables = {
            "owner": args.owner,
            "repo": args.repo,
            "issue_number": args.issue_number,
        }

        # Make GraphQL request
        console.log("[blue]GitHub GraphQL Request[/blue] - Getting issue priority data")
        graphql_data = await github_request(
            "POST",
            "graphql",
            json={
                "query": graphql_query,
                "variables": graphql_variables,
            },
        )

        # Merge GraphQL data into REST response
        if graphql_data.get("data", {}).get("repository", {}).get("issue"):
            response["projectItems"] = graphql_data["data"]["repository"]["issue"][
                "projectItems"
            ]

        # Fetch comments for this issue
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/issues/{args.issue_number}/comments"
        )
        console.print(
            Panel.fit(
                f"[cyan]Fetching comments for issue {args.issue_number}[/cyan]",
                border_style="blue",
            )
        )

        comments_url = (
            f"repos/{args.owner}/{args.repo}/issues/{args.issue_number}/comments"
        )
        comments = await github_request("GET", comments_url)

        # Log the comments response
        console.log(
            f"[green]GitHub API Comments Response[/green] - Retrieved {len(comments)} comments"
        )
        if comments and len(comments) > 0:
            console.print(
                Panel(
                    json.dumps(
                        comments[:3] if len(comments) > 3 else comments, indent=2
                    ),
                    title=f"Comments Data (showing first {min(3, len(comments))} of {len(comments)} comments)",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter the response to include only essential fields
        filtered_response = filter_data(response)

        # Filter comments to include only essential fields
        filtered_comments = []
        for comment in comments:
            filtered_comment = {
                "id": comment.get("id"),
                "body": comment.get("body"),
                "created_at": comment.get("created_at"),
                "updated_at": comment.get("updated_at"),
                "html_url": comment.get("html_url"),
                "user": (
                    comment.get("user", {}).get("login")
                    if comment.get("user")
                    else None
                ),
                "author_association": comment.get("author_association"),
            }
            filtered_comments.append(filtered_comment)

        # Add comments to the filtered response
        filtered_response["comments_data"] = filtered_comments

        # Add comments to the raw response as well
        response["comments_data"] = comments

        # Return the structured response
        return {
            "filtered": filtered_response,
            "raw": response if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in get_issue: {str(e)}[/red]")
        return {"error": str(e)}


async def list_issues_restful(args: ListIssuesRestfulArgs) -> dict:
    """List issues from a GitHub repository with filtering options.

    Args:
        args: The arguments for the list_issues_restful tool.

    Returns:
        The list of issues matching the criteria.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/issues"
        )
        console.print(
            Panel.fit(
                f"[cyan]Listing issues from {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build query parameters
        params = {
            "sort": "updated",
            "since": (datetime.now(timezone.utc) - timedelta(hours=168)).isoformat(),
        }
        for field in ["state", "sort", "direction", "since", "page", "per_page"]:
            if getattr(args, field) is not None:
                params[field] = getattr(args, field)

        # Add labels if provided
        if args.labels:
            params["labels"] = ",".join(args.labels)

        # Log query parameters
        if params:
            console.log(
                f"[blue]Query Parameters[/blue]: {json.dumps(params, indent=2)}"
            )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/issues"
        issues_data = await github_request("GET", url, params=params)

        # Log the response
        console.log(
            f"[green]GitHub API Response[/green] - Retrieved {len(issues_data)} issues"
        )
        if issues_data and len(issues_data) > 0:
            console.print(
                Panel(
                    json.dumps(
                        issues_data[:2] if len(issues_data) > 2 else issues_data,
                        indent=2,
                    ),
                    title=f"Issues Data (showing first {min(2, len(issues_data))} of {len(issues_data)} issues)",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter the issues (truncate bodies for list view)
        filtered_issues = [filter_data(issue, is_list=True) for issue in issues_data]

        # Return filtered and raw data
        return {
            "filtered": filtered_issues,
            "total_count": len(issues_data),
            "raw": issues_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in list_issues_restful: {str(e)}[/red]")
        return {"error": str(e)}


async def search_issues(args: SearchIssuesArgs) -> dict:
    """Search for GitHub issues and pull requests across repositories.

    Args:
        args: The arguments for the search_issues tool.

    Returns:
        Search results matching the criteria.
    """
    try:
        # Log the request
        console.log("[blue]GitHub API Request[/blue] - GET /search/issues")
        console.print(
            Panel.fit(
                f"[cyan]Searching GitHub issues with query: {args.q}[/cyan]",
                border_style="blue",
            )
        )

        # Build query parameters
        params = {"q": args.q}
        for field in ["sort", "order", "per_page", "page"]:
            if getattr(args, field) is not None:
                params[field] = getattr(args, field)

        # Log query parameters
        console.log(f"[blue]Query Parameters[/blue]: {json.dumps(params, indent=2)}")

        # Make API request
        url = "search/issues"
        search_data = await github_request("GET", url, params=params)

        # Log the response
        total_count = search_data.get("total_count", 0)
        items_count = len(search_data.get("items", []))
        console.log(
            f"[green]GitHub API Response[/green] - Found {total_count} matches, returned {items_count} items"
        )

        if "items" in search_data and search_data["items"]:
            console.print(
                Panel(
                    json.dumps(
                        (
                            search_data["items"][:2]
                            if len(search_data["items"]) > 2
                            else search_data["items"]
                        ),
                        indent=2,
                    ),
                    title=(
                        f"Search Results (showing first "
                        f"{min(2, len(search_data['items']))} of "
                        f"{len(search_data['items'])} results)"
                    ),
                    border_style="green",
                    expand=False,
                )
            )

        # Filter the search results (truncate bodies for search listing)
        filtered_items = [filter_data(item, is_list=True) for item in search_data.get("items", [])]

        # Return filtered and raw data
        return {
            "filtered": {
                "items": filtered_items,
                "total_count": total_count,
                "incomplete_results": search_data.get("incomplete_results", False),
            },
            "raw": search_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in search_issues: {str(e)}[/red]")
        return {"error": str(e)}


async def add_issue_comment(args: AddIssueCommentArgs) -> dict:
    """Add a comment to a GitHub issue.

    Args:
        args: The arguments for the add_issue_comment tool.

    Returns:
        The created comment data.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - POST "
            f"/repos/{args.owner}/{args.repo}/issues/"
            f"{args.issue_number}/comments"
        )
        console.print(
            Panel.fit(
                f"[cyan]Adding comment to issue #{args.issue_number} in repository: {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build request body
        data = {"body": args.body}

        # Log request data
        console.log("[blue]Request Data[/blue]:")
        console.print(
            Panel(
                json.dumps(data, indent=2),
                title="Comment Data",
                border_style="blue",
                expand=False,
            )
        )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/issues/{args.issue_number}/comments"
        comment_data = await github_request("POST", url, json=data)

        # Log the response
        console.log("[green]GitHub API Response[/green] - Comment added successfully")
        console.print(
            Panel(
                f"Comment added: {comment_data.get('html_url')}",
                title="Created Comment",
                border_style="green",
                expand=False,
            )
        )

        # Filter and return the comment data
        filtered_comment = {
            "id": comment_data.get("id"),
            "body": comment_data.get("body"),
            "html_url": comment_data.get("html_url"),
            "created_at": comment_data.get("created_at"),
            "updated_at": comment_data.get("updated_at"),
            "user": (
                {
                    "login": comment_data.get("user", {}).get("login"),
                    "id": comment_data.get("user", {}).get("id"),
                    "html_url": comment_data.get("user", {}).get("html_url"),
                }
                if comment_data.get("user")
                else None
            ),
        }

        return {
            "filtered": filtered_comment,
            "raw": comment_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in add_issue_comment: {str(e)}[/red]")
        return {"error": str(e)}


async def update_issue(args: UpdateIssueArgs) -> dict:
    """Update an existing GitHub issue.

    Args:
        args: The arguments for the update_issue tool.

    Returns:
        The updated issue data.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - PATCH /repos/{args.owner}/{args.repo}/issues/{args.issue_number}"
        )
        console.print(
            Panel.fit(
                f"[cyan]Updating issue #{args.issue_number} in repository: {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build request body with only the fields that are provided
        data = {}
        for field in ["title", "body", "state", "assignees", "labels", "milestone"]:
            value = getattr(args, field, None)
            if value is not None:
                data[field] = value

        # Log request data
        console.log("[blue]Request Data[/blue]:")
        console.print(
            Panel(
                json.dumps(data, indent=2),
                title="Issue Update Data",
                border_style="blue",
                expand=False,
            )
        )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/issues/{args.issue_number}"
        issue_data = await github_request("PATCH", url, json=data)

        # Log the response
        console.log("[green]GitHub API Response[/green] - Issue updated successfully")
        console.print(
            Panel(
                f"Issue #{issue_data.get('number')} updated: {issue_data.get('html_url')}",
                title="Updated Issue",
                border_style="green",
                expand=False,
            )
        )

        # Filter and return the issue data
        filtered_issue = filter_data(issue_data)

        return {
            "filtered": filtered_issue,
            "raw": issue_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in update_issue: {str(e)}[/red]")
        return {"error": str(e)}


async def list_pull_requests(args: ListPullRequestsArgs) -> dict:
    """List pull requests in a GitHub repository.

    Args:
        args: The arguments for the list_pull_requests tool.

    Returns:
        List of pull requests matching the criteria.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls"
        )
        console.print(
            Panel.fit(
                f"[cyan]Listing pull requests in repository: {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build query parameters
        params = {"sort": "updated"}  # Set default sort to "updated"
        for field in ["state", "head", "base", "sort", "direction", "per_page", "page"]:
            if getattr(args, field) is not None:
                params[field] = getattr(args, field)

        # Log query parameters if any
        if params:
            console.log(
                f"[blue]Query Parameters[/blue]: {json.dumps(params, indent=2)}"
            )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/pulls"
        pulls_data = await github_request("GET", url, params=params)

        # Log the response
        pulls_count = len(pulls_data)
        console.log(
            f"[green]GitHub API Response[/green] - Found {pulls_count} pull requests"
        )

        if pulls_data:
            console.print(
                Panel(
                    json.dumps(
                        pulls_data[:2] if len(pulls_data) > 2 else pulls_data, indent=2
                    ),
                    title=f"Pull Requests Sample (showing first {min(2, len(pulls_data))} of {len(pulls_data)} PRs)",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter the pull requests data (truncate bodies for list view, exclude drafts)
        filtered_pulls = []
        for pr in pulls_data:
            if pr.get("draft", False):
                continue
            filtered_pr = filter_data(pr, is_list=True)
            if filtered_pr:
                filtered_pulls.append(filtered_pr)

        return {
            "filtered": filtered_pulls,
            "raw": pulls_data if IsDebug() else None,
            "_note": "Use get_pull_request for full PR details including body, diff, and review status.",
        }
    except Exception as e:
        console.print(f"[red]Error in list_pull_requests: {str(e)}[/red]")
        return {"error": str(e)}


async def get_pull_request(args: GetPullRequestArgs) -> dict:
    """Get a specific GitHub pull request.

    Args:
        args: The arguments for the get_pull_request tool.

    Returns:
        Detailed information about the pull request.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}"
        )
        console.print(
            Panel.fit(
                f"[cyan]Getting pull request #{args.pull_number} from repository: {args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}"
        pr_data = await github_request("GET", url)

        # Log the response
        console.log(
            f"[green]GitHub API Response[/green] - Retrieved pull request #{args.pull_number}"
        )
        console.print(
            Panel(
                f"Pull Request: {pr_data.get('title')}\nState: {pr_data.get('state')}\nURL: {pr_data.get('html_url')}",
                title=f"Pull Request #{pr_data.get('number')}",
                border_style="green",
                expand=False,
            )
        )

        # Filter and return the pull request data
        filtered_pr = filter_data(
            pr_data
        )  # Reuse issue filter as PR structure is similar

        return {
            "filtered": filtered_pr,
            "raw": pr_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in get_pull_request: {str(e)}[/red]")
        return {"error": str(e)}


async def create_pull_request_review(args: CreatePullRequestReviewArgs) -> dict:
    """Create a review for a GitHub pull request.

    Args:
        args: The arguments for the create_pull_request_review tool.

    Returns:
        The created review data.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - POST /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/reviews"
        )
        console.print(
            Panel.fit(
                f"[cyan]Creating review for pull request "
                f"#{args.pull_number} in repository: "
                f"{args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build request body
        data = {
            "body": args.body,
            "event": args.event,
        }

        # Log request data
        console.log("[blue]Request Data[/blue]:")
        console.print(
            Panel(
                json.dumps(data, indent=2),
                title="Review Data",
                border_style="blue",
                expand=False,
            )
        )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/reviews"
        review_data = await github_request("POST", url, json=data)

        # Log the response
        console.log("[green]GitHub API Response[/green] - Review created successfully")
        console.print(
            Panel(
                f"Review ID: {review_data.get('id')}\n"
                f"State: {review_data.get('state')}\n"
                f"Body: {review_data.get('body', '(No body provided)')[:100]}",
                title="Created Review",
                border_style="green",
                expand=False,
            )
        )

        # Filter and return the review data
        filtered_review = {
            "id": review_data.get("id"),
            "body": review_data.get("body"),
            "state": review_data.get("state"),
            "submitted_at": review_data.get("submitted_at"),
            "html_url": review_data.get("html_url"),
            "user": (
                {
                    "login": review_data.get("user", {}).get("login"),
                    "id": review_data.get("user", {}).get("id"),
                    "html_url": review_data.get("user", {}).get("html_url"),
                }
                if review_data.get("user")
                else None
            ),
        }

        return {
            "filtered": filtered_review,
            "raw": review_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in create_pull_request_review: {str(e)}[/red]")
        return {"error": str(e)}


async def get_pull_request_status(args: GetPullRequestStatusArgs) -> dict:
    """Get the status of a GitHub pull request, including CI/CD checks.

    Args:
        args: The arguments for the get_pull_request_status tool.

    Returns:
        Status information for the pull request.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}"
        )
        console.print(
            Panel.fit(
                f"[cyan]Getting status for pull request "
                f"#{args.pull_number} in repository: "
                f"{args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # First, get the pull request details
        url_pr = f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}"
        pr_data = await github_request("GET", url_pr)

        # Get the latest commit SHA
        head_sha = pr_data.get("head", {}).get("sha")

        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/commits/{head_sha}/status"
        )

        # Get the status checks for the latest commit
        url_status = f"repos/{args.owner}/{args.repo}/commits/{head_sha}/status"
        status_data = await github_request("GET", url_status)

        # Log the response
        status_count = len(status_data.get("statuses", []))
        console.log(
            f"[green]GitHub API Response[/green] - Found {status_count} status checks"
        )

        # Get additional check runs for the commit
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/commits/{head_sha}/check-runs"
        )

        url_checks = f"repos/{args.owner}/{args.repo}/commits/{head_sha}/check-runs"
        check_runs_data = await github_request("GET", url_checks)

        check_runs_count = check_runs_data.get("total_count", 0)
        console.log(
            f"[green]GitHub API Response[/green] - Found {check_runs_count} check runs"
        )

        # Combine status information
        combined_status = {
            "state": status_data.get("state", "unknown"),
            "total_count": status_data.get("total_count", 0),
            "statuses": status_data.get("statuses", []),
            "check_runs": check_runs_data.get("check_runs", []),
            "mergeable": pr_data.get("mergeable"),
            "mergeable_state": pr_data.get("mergeable_state"),
            "rebaseable": pr_data.get("rebaseable"),
        }

        # Log summary of status
        console.print(
            Panel(
                f"Pull Request State: {pr_data.get('state')}\n"
                f"CI Status: {status_data.get('state', 'unknown')}\n"
                f"Mergeable: {pr_data.get('mergeable')}\n"
                f"Mergeable State: {pr_data.get('mergeable_state')}\n"
                f"Status Checks: {status_data.get('total_count', 0)}\n"
                f"Check Runs: {check_runs_count}",
                title=f"PR #{args.pull_number} Status Summary",
                border_style="green",
                expand=False,
            )
        )

        # Filter status information
        filtered_status = {
            "state": status_data.get("state", "unknown"),
            "mergeable": pr_data.get("mergeable"),
            "mergeable_state": pr_data.get("mergeable_state", "unknown"),
            "statuses": [
                {
                    "context": status.get("context"),
                    "state": status.get("state"),
                    "description": status.get("description"),
                    "target_url": status.get("target_url"),
                }
                for status in status_data.get("statuses", [])
            ],
            "check_runs": [
                {
                    "name": check.get("name"),
                    "status": check.get("status"),
                    "conclusion": check.get("conclusion"),
                    "details_url": check.get("details_url"),
                }
                for check in check_runs_data.get("check_runs", [])
            ],
        }

        return {
            "filtered": filtered_status,
            "raw": combined_status if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in get_pull_request_status: {str(e)}[/red]")
        return {"error": str(e)}


async def get_pull_request_comments(args: GetPullRequestCommentsArgs) -> dict:
    """Get comments on a GitHub pull request.

    Args:
        args: The arguments for the get_pull_request_comments tool.

    Returns:
        Comments on the pull request, both issue comments and review comments.
    """
    try:
        # Log the request for issue comments
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/issues/{args.pull_number}/comments"
        )
        console.print(
            Panel.fit(
                f"[cyan]Getting comments for pull request "
                f"#{args.pull_number} in repository: "
                f"{args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Get issue comments
        issue_comments_url = (
            f"repos/{args.owner}/{args.repo}/issues/{args.pull_number}/comments"
        )
        issue_comments = await github_request("GET", issue_comments_url)

        # Log the response
        issue_comments_count = len(issue_comments)
        console.log(
            f"[green]GitHub API Response[/green] - Found {issue_comments_count} issue comments"
        )

        # Log the request for review comments
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/comments"
        )

        # Get review comments (diff comments)
        review_comments_url = (
            f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/comments"
        )
        review_comments = await github_request("GET", review_comments_url)

        # Log the response
        review_comments_count = len(review_comments)
        console.log(
            f"[green]GitHub API Response[/green] - Found {review_comments_count} review comments"
        )

        # Log summary
        console.print(
            Panel(
                f"Issue Comments: {issue_comments_count}\n"
                f"Review Comments: {review_comments_count}\n"
                f"Total Comments: "
                f"{issue_comments_count + review_comments_count}",
                title=f"PR #{args.pull_number} Comments Summary",
                border_style="green",
                expand=False,
            )
        )

        # Show sample comments if available
        if issue_comments:
            console.print(
                Panel(
                    json.dumps(
                        (
                            issue_comments[:1]
                            if len(issue_comments) > 1
                            else issue_comments
                        ),
                        indent=2,
                    ),
                    title=f"Issue Comments Sample (showing 1 of {len(issue_comments)})",
                    border_style="green",
                    expand=False,
                )
            )

        if review_comments:
            console.print(
                Panel(
                    json.dumps(
                        (
                            review_comments[:1]
                            if len(review_comments) > 1
                            else review_comments
                        ),
                        indent=2,
                    ),
                    title=f"Review Comments Sample (showing 1 of {len(review_comments)})",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter and process comments
        filtered_issue_comments = []
        for comment in issue_comments:
            filtered_comment = {
                "id": comment.get("id"),
                "body": truncate_body(comment.get("body"), max_length=1000),
                "html_url": comment.get("html_url"),
                "created_at": comment.get("created_at"),
                "author": comment.get("user", {}).get("login") if comment.get("user") else None,
                "type": "issue_comment",
            }
            filtered_issue_comments.append(filtered_comment)

        filtered_review_comments = []
        for comment in review_comments:
            filtered_comment = {
                "id": comment.get("id"),
                "body": truncate_body(comment.get("body"), max_length=1000),
                "html_url": comment.get("html_url"),
                "created_at": comment.get("created_at"),
                "author": comment.get("user", {}).get("login") if comment.get("user") else None,
                "type": "review_comment",
                "path": comment.get("path"),
                "line": comment.get("line"),
            }
            filtered_review_comments.append(filtered_comment)

        total = len(filtered_issue_comments) + len(filtered_review_comments)

        return {
            "filtered": {
                "issue_comments": filtered_issue_comments,
                "review_comments": filtered_review_comments,
                "total_count": total,
            },
            "raw": (
                {
                    "issue_comments": issue_comments,
                    "review_comments": review_comments,
                }
                if IsDebug()
                else None
            ),
            "_note": "Comment bodies are truncated to 1000 chars. Visit html_url for full content.",
        }
    except Exception as e:
        console.print(f"[red]Error in get_pull_request_comments: {str(e)}[/red]")
        return {"error": str(e)}


async def get_pull_request_reviews(args: GetPullRequestReviewsArgs) -> dict:
    """Get reviews for a GitHub pull request.

    Args:
        args: The arguments for the get_pull_request_reviews tool.

    Returns:
        Reviews for the pull request.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/reviews"
        )
        console.print(
            Panel.fit(
                f"[cyan]Getting reviews for pull request "
                f"#{args.pull_number} in repository: "
                f"{args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build query parameters
        params = {}
        if args.per_page:
            params["per_page"] = args.per_page
        if args.page:
            params["page"] = args.page

        # Log query parameters if any
        if params:
            console.log(
                f"[blue]Query Parameters[/blue]: {json.dumps(params, indent=2)}"
            )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/reviews"
        reviews_data = await github_request("GET", url, params=params)

        # Log the response
        reviews_count = len(reviews_data)
        console.log(
            f"[green]GitHub API Response[/green] - Found {reviews_count} reviews"
        )

        if reviews_data:
            console.print(
                Panel(
                    json.dumps(
                        reviews_data[:1] if len(reviews_data) > 1 else reviews_data,
                        indent=2,
                    ),
                    title=f"Reviews Sample (showing 1 of {len(reviews_data)})",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter reviews
        filtered_reviews = []
        for review in reviews_data:
            filtered_review = {
                "id": review.get("id"),
                "body": review.get("body"),
                "state": review.get("state"),
                "html_url": review.get("html_url"),
                "submitted_at": review.get("submitted_at"),
                "user": (
                    {
                        "login": review.get("user", {}).get("login"),
                        "id": review.get("user", {}).get("id"),
                        "html_url": review.get("user", {}).get("html_url"),
                    }
                    if review.get("user")
                    else None
                ),
            }
            filtered_reviews.append(filtered_review)

        return {
            "filtered": filtered_reviews,
            "raw": reviews_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in get_pull_request_reviews: {str(e)}[/red]")
        return {"error": str(e)}


async def list_commits(args: ListPullRequestCommitsArgs) -> dict:
    """List commits in a GitHub pull request.

    Args:
        args: The arguments for the list_commits tool.

    Returns:
        List of commits in the pull request.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - GET /repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/commits"
        )
        console.print(
            Panel.fit(
                f"[cyan]Listing commits for pull request "
                f"#{args.pull_number} in repository: "
                f"{args.owner}/{args.repo}[/cyan]",
                border_style="blue",
            )
        )

        # Build query parameters
        params = {}
        if args.per_page:
            params["per_page"] = args.per_page
        if args.page:
            params["page"] = args.page

        # Log query parameters if any
        if params:
            console.log(
                f"[blue]Query Parameters[/blue]: {json.dumps(params, indent=2)}"
            )

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/pulls/{args.pull_number}/commits"
        commits_data = await github_request("GET", url, params=params)

        # Log the response
        commits_count = len(commits_data)
        console.log(
            f"[green]GitHub API Response[/green] - Found {commits_count} commits"
        )

        if commits_data:
            console.print(
                Panel(
                    json.dumps(
                        commits_data[:2] if len(commits_data) > 2 else commits_data,
                        indent=2,
                    ),
                    title=f"Commits Sample (showing first {min(2, len(commits_data))} of {len(commits_data)} commits)",
                    border_style="green",
                    expand=False,
                )
            )

        # Filter and return data
        filtered_commits = []
        for commit in commits_data:
            filtered_commit = {
                "sha": commit.get("sha"),
                "message": commit.get("commit", {}).get("message"),
                "author": {
                    "name": commit.get("commit", {}).get("author", {}).get("name"),
                    "email": commit.get("commit", {}).get("author", {}).get("email"),
                    "date": commit.get("commit", {}).get("author", {}).get("date"),
                    "login": (
                        commit.get("author", {}).get("login")
                        if commit.get("author")
                        else None
                    ),
                },
                "html_url": commit.get("html_url"),
                "parents": [parent.get("sha") for parent in commit.get("parents", [])],
            }
            filtered_commits.append(filtered_commit)

        return {
            "filtered": filtered_commits,
            "raw": commits_data if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in list_commits: {str(e)}[/red]")
        return {"error": str(e)}


async def get_file_contents(owner: str, repo: str, path: str, branch: str) -> dict:
    """Get the contents of a file from a GitHub repository.

    Args:
        owner: Repository owner (username or organization)
        repo: Repository name
        path: Path to the file
        branch: Branch containing the file

    Returns:
        File content data including the SHA.
    """
    try:
        url = f"repos/{owner}/{repo}/contents/{path}"
        params = {"ref": branch}
        return await github_request("GET", url, params=params)
    except Exception as e:
        console.print(f"[red]Error in get_file_contents: {str(e)}[/red]")
        raise


async def create_or_update_file(args: CreateOrUpdateFileArgs) -> dict:
    """Create or update a file in a GitHub repository.

    Args:
        args: The arguments for the create_or_update_file tool.

    Returns:
        Response data from the file creation/update operation.
    """
    try:
        # Log the request
        console.log(
            f"[blue]GitHub API Request[/blue] - PUT /repos/{args.owner}/{args.repo}/contents/{args.path}"
        )
        console.print(
            Panel.fit(
                f"[cyan]Creating/updating file {args.path} in "
                f"repository: {args.owner}/{args.repo} "
                f"on branch {args.branch}[/cyan]",
                border_style="blue",
            )
        )

        # Get current SHA if not provided and file exists
        current_sha = args.sha
        if not current_sha:
            try:
                existing_file = await get_file_contents(
                    args.owner, args.repo, args.path, args.branch
                )
                if isinstance(existing_file, dict):
                    current_sha = existing_file.get("sha")
                    console.log("[blue]Found existing file, will update it[/blue]")
            except Exception:
                console.log("[blue]File does not exist, will create new file[/blue]")

        # Encode content to base64
        encoded_content = base64.b64encode(args.content.encode()).decode()

        # Build request body
        data = {
            "message": args.message,
            "content": encoded_content,
            "branch": args.branch,
        }
        if current_sha:
            data["sha"] = current_sha

        # Log request data (excluding file content for brevity)
        log_data = data.copy()
        log_data["content"] = "<base64-encoded-content>"
        console.log(f"[blue]Request Data[/blue]: {json.dumps(log_data, indent=2)}")

        # Make API request
        url = f"repos/{args.owner}/{args.repo}/contents/{args.path}"
        response = await github_request("PUT", url, json=data)

        # Log the response
        console.log(
            f"[green]GitHub API Response[/green] - File {'updated' if current_sha else 'created'} successfully"
        )
        console.print(
            Panel(
                f"File: {response.get('content', {}).get('path')}\n"
                f"SHA: {response.get('content', {}).get('sha')}\n"
                f"Size: {response.get('content', {}).get('size')} bytes\n"
                f"URL: {response.get('content', {}).get('html_url')}",
                title="File Operation Result",
                border_style="green",
                expand=False,
            )
        )

        # Filter and return response data
        filtered_response = {
            "content": {
                "name": response.get("content", {}).get("name"),
                "path": response.get("content", {}).get("path"),
                "sha": response.get("content", {}).get("sha"),
                "size": response.get("content", {}).get("size"),
                "url": response.get("content", {}).get("url"),
                "html_url": response.get("content", {}).get("html_url"),
                "git_url": response.get("content", {}).get("git_url"),
                "type": response.get("content", {}).get("type"),
            },
            "commit": {
                "sha": response.get("commit", {}).get("sha"),
                "url": response.get("commit", {}).get("url"),
                "html_url": response.get("commit", {}).get("html_url"),
                "message": response.get("commit", {}).get("message"),
            },
        }

        return {
            "filtered": filtered_response,
            "raw": response if IsDebug() else None,
        }
    except Exception as e:
        console.print(f"[red]Error in create_or_update_file: {str(e)}[/red]")
        return {"error": str(e)}


async def list_issues(args: ListIssuesArgs) -> dict:
    """List issues from a GitHub repository using GraphQL.

    Args:
        args: The arguments for the list_issues tool.

    Returns:
        The list of issues matching the criteria.
    """
    try:
        # Log the request
        console.log("[blue]GitHub GraphQL Request[/blue] - Listing issues")
        console.print(
            Panel.fit(
                f"[cyan]Listing issues from {args.owner}/{args.repo} using GraphQL[/cyan]",
                border_style="blue",
            )
        )

        # Build the GraphQL query
        graphql_query = """
        query(
          $owner: String!, $repo: String!, $first: Int!,
          $after: String, $states: [IssueState!],
          $labels: [String!], $orderBy: IssueOrder!
        ) {
          repository(owner: $owner, name: $repo) {
            issues(
              first: $first, after: $after,
              states: $states, labels: $labels,
              orderBy: $orderBy
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                number
                title
                body
                state
                createdAt
                updatedAt
                closedAt
                url
                author {
                  login
                }
                assignees(first: 10) {
                  nodes {
                    login
                  }
                }
                labels(first: 10) {
                  nodes {
                    name
                  }
                }
                comments {
                  totalCount
                }
                milestone {
                  title
                  number
                }
                projectItems(first: 10) {
                  nodes {
                    project {
                      title
                    }
                    fieldValues(first: 10) {
                      nodes {
                        __typename
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          name
                          field {
                            ... on ProjectV2FieldCommon {
                              name
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              totalCount
            }
          }
        }
        """

        # Initialize variables for pagination
        all_issues = []
        has_more = True
        current_cursor = args.after
        graphql_data: dict[str, Any] = {}
        since_date = None
        if args.since:
            # Convert since date to UTC timezone-aware datetime
            since_date = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
            if since_date.tzinfo is None:
                since_date = since_date.replace(tzinfo=timezone.utc)

        # Cap total results at the requested `first` count (default 10)
        max_results = min(args.first or 10, 100)
        while has_more and len(all_issues) < max_results:
            # Prepare variables for current page
            variables = {
                "owner": args.owner,
                "repo": args.repo,
                "first": args.first,
                "after": current_cursor,
                "states": [args.state] if args.state != "ALL" else ["OPEN", "CLOSED"],
                "labels": args.labels,
                "orderBy": args.order_by,
            }

            order_by = args.order_by or {"field": "UPDATED_AT", "direction": "DESC"}
            since_order_by = "createdAt" if order_by["field"] == "CREATED_AT" else "updatedAt"

            # Make GraphQL request
            graphql_data = await github_request(
                "POST", "graphql", json={"query": graphql_query, "variables": variables}
            )

            # Process current page
            if graphql_data.get("data", {}).get("repository", {}).get("issues"):
                issues_data = graphql_data["data"]["repository"]["issues"]
                current_page_issues = issues_data.get("nodes", [])

                # Filter issues by since date if specified
                if since_date:
                    for issue in current_page_issues:
                        # Convert issue date to UTC timezone-aware datetime
                        issue_date = datetime.fromisoformat(
                            issue[since_order_by].replace("Z", "+00:00")
                        )
                        if issue_date.tzinfo is None:
                            issue_date = issue_date.replace(tzinfo=timezone.utc)

                        if issue_date >= since_date:
                            all_issues.append(issue)
                        else:
                            has_more = False
                            break
                else:
                    all_issues.extend(current_page_issues)

                # Update pagination info
                page_info = issues_data.get("pageInfo", {})
                has_more = has_more and page_info.get("hasNextPage", False)
                current_cursor = page_info.get("endCursor")

                # Log progress
                console.log(
                    f"[green]Retrieved {len(current_page_issues)} issues, total so far: {len(all_issues)}"
                )
            else:
                has_more = False

            # Break if we've collected enough issues or there's an error
            if not has_more or not current_cursor:
                break

        # Process and filter the collected issues
        filtered_issues = []
        for issue in all_issues:
            filtered_issue = {
                "number": issue.get("number"),
                "title": issue.get("title"),
                "body": truncate_body(issue.get("body")),
                "state": issue.get("state").lower() if issue.get("state") else None,
                "created_at": issue.get("createdAt"),
                "updated_at": issue.get("updatedAt"),
                "closed_at": issue.get("closedAt"),
                "url": issue.get("url"),
                "author": (
                    issue.get("author", {}).get("login")
                    if issue.get("author")
                    else None
                ),
                "assignees": [
                    assignee.get("login")
                    for assignee in issue.get("assignees", {}).get("nodes", [])
                ],
                "labels": [
                    label.get("name")
                    for label in issue.get("labels", {}).get("nodes", [])
                ],
                "comments_count": issue.get("comments", {}).get("totalCount"),
            }

            # Extract priority from project items if available
            priority = None
            if issue.get("projectItems", {}).get("nodes"):
                for project_item in issue["projectItems"]["nodes"]:
                    if project_item is None:
                        continue
                    field_values = project_item.get("fieldValues", {}).get("nodes", [])
                    for field_value in field_values:
                        if field_value is None:
                            continue
                        if (
                            field_value.get("__typename")
                            == "ProjectV2ItemFieldSingleSelectValue"
                            and field_value.get("field", {}).get("name") == "Priority"
                        ):
                            priority = field_value.get("name")
                            break
                    if priority:
                        break
            filtered_issue["priority"] = priority

            # Add milestone if available
            if issue.get("milestone"):
                filtered_issue["milestone"] = {
                    "title": issue["milestone"].get("title"),
                    "number": issue["milestone"].get("number"),
                }

            filtered_issues.append(filtered_issue)

        # Return the filtered and raw data
        return {
            "filtered": {
                "issues": filtered_issues,
                "total_count": len(filtered_issues),
                "page_info": {"hasNextPage": has_more, "endCursor": current_cursor},
            },
            "raw": graphql_data if IsDebug() else None,
            "_note": "Bodies are truncated. Use get_issue for full details on a specific issue.",
        }
    except Exception as e:
        console.print(f"[red]Error in list_issues: {str(e)}[/red]")
        return {"error": str(e)}


async def get_file_contents(args: GetFileContentsArgs) -> dict:
    """Read a file from a GitHub repository (read-only).

    Returns the decoded file content and metadata.
    """
    try:
        url = f"repos/{args.owner}/{args.repo}/contents/{args.path}"
        params: Dict[str, str] = {}
        if args.ref:
            params["ref"] = args.ref
        result = await github_request("GET", url, params=params)
        if isinstance(result, dict) and "error" in result:
            return result
        if isinstance(result, list):
            # Directory listing
            return {
                "type": "directory",
                "path": args.path,
                "entries": [{"name": e["name"], "type": e["type"], "path": e["path"]} for e in result],
            }
        # File content
        content = ""
        if result.get("encoding") == "base64" and result.get("content"):
            content = base64.b64decode(result["content"]).decode("utf-8", errors="replace")
        return {
            "type": "file",
            "path": result.get("path", args.path),
            "size": result.get("size"),
            "sha": result.get("sha"),
            "content": content,
        }
    except Exception as e:
        return {"error": str(e)}


async def get_discussions(args: GetDiscussionsArgs) -> dict:
    """Get discussions from a GitHub repository using GraphQL.

    Args:
        args: The arguments for the get_discussions tool.

    Returns:
        The list of discussions matching the criteria.
    """
    try:
        # Log the request
        console.log("[blue]GitHub GraphQL Request[/blue] - Getting discussions")
        console.print(
            Panel.fit(
                f"[cyan]Getting discussions from {args.owner}/{args.repo} using GraphQL[/cyan]",
                border_style="blue",
            )
        )

        # Build the GraphQL query
        graphql_query = """
        query(
          $owner: String!, $repo: String!, $first: Int!,
          $after: String, $categoryId: ID,
          $answered: Boolean, $orderBy: DiscussionOrder!
        ) {
          repository(owner: $owner, name: $repo) {
            discussions(
              first: $first, after: $after,
              categoryId: $categoryId,
              answered: $answered, orderBy: $orderBy
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              totalCount
              nodes {
                id
                number
                title
                body
                createdAt
                updatedAt
                url
                locked
                isAnswered
                answerChosenAt
                author {
                  login
                }
                category {
                  id
                  name
                  description
                  emoji
                  isAnswerable
                }
                answer {
                  id
                  body
                  createdAt
                  author {
                    login
                  }
                }
                answerChosenBy {
                  login
                }
                comments {
                  totalCount
                }
                reactionGroups {
                  content
                  users {
                    totalCount
                  }
                }
              }
            }
            discussionCategories(first: 25) {
              nodes {
                id
                name
                description
                emoji
                isAnswerable
              }
            }
          }
        }
        """

        # Prepare variables
        variables = {
            "owner": args.owner,
            "repo": args.repo,
            "first": args.first,
            "after": args.after,
            "categoryId": args.category_id,
            "answered": args.answered,
            "orderBy": args.order_by,
        }

        # Log query parameters
        console.log(f"[blue]Query Variables[/blue]: {json.dumps(variables, indent=2)}")

        # Make GraphQL request
        graphql_data = await github_request(
            "POST", "graphql", json={"query": graphql_query, "variables": variables}
        )

        # Process response
        if graphql_data.get("data", {}).get("repository", {}).get("discussions"):
            discussions_data = graphql_data["data"]["repository"]["discussions"]
            categories_data = (
                graphql_data["data"]["repository"]
                .get("discussionCategories", {})
                .get("nodes", [])
            )

            discussions = discussions_data.get("nodes", [])
            total_count = discussions_data.get("totalCount", 0)
            page_info = discussions_data.get("pageInfo", {})

            # Log the response
            console.log(
                f"[green]GitHub API Response[/green] - Retrieved {len(discussions)} discussions"
            )

            if discussions:
                console.print(
                    Panel(
                        json.dumps(discussions[:1], indent=2),
                        title=f"Discussions Sample (showing 1 of {len(discussions)})",
                        border_style="green",
                        expand=False,
                    )
                )

            # Filter discussions data
            filtered_discussions = []
            for discussion in discussions:
                filtered_discussion = {
                    "id": discussion.get("id"),
                    "number": discussion.get("number"),
                    "title": discussion.get("title"),
                    "body": truncate_body(discussion.get("body")),
                    "created_at": discussion.get("createdAt"),
                    "updated_at": discussion.get("updatedAt"),
                    "url": discussion.get("url"),
                    "locked": discussion.get("locked"),
                    "is_answered": discussion.get("isAnswered"),
                    "author": (
                        discussion.get("author", {}).get("login")
                        if discussion.get("author")
                        else None
                    ),
                    "category": (
                        {
                            "id": discussion.get("category", {}).get("id"),
                            "name": discussion.get("category", {}).get("name"),
                            "description": discussion.get("category", {}).get(
                                "description"
                            ),
                            "emoji": discussion.get("category", {}).get("emoji"),
                            "is_answerable": discussion.get("category", {}).get(
                                "isAnswerable"
                            ),
                        }
                        if discussion.get("category")
                        else None
                    ),
                    "answer": (
                        {
                            "id": discussion.get("answer", {}).get("id"),
                            "body": discussion.get("answer", {}).get("body"),
                            "created_at": discussion.get("answer", {}).get("createdAt"),
                            "author": (
                                discussion.get("answer", {})
                                .get("author", {})
                                .get("login")
                                if discussion.get("answer", {}).get("author")
                                else None
                            ),
                        }
                        if discussion.get("answer")
                        else None
                    ),
                    "answer_chosen_by": (
                        discussion.get("answerChosenBy", {}).get("login")
                        if discussion.get("answerChosenBy")
                        else None
                    ),
                    "comments_count": discussion.get("comments", {}).get(
                        "totalCount", 0
                    ),
                    "reactions": {
                        reaction.get("content"): reaction.get("users", {}).get("totalCount", 0)
                        for reaction in discussion.get("reactionGroups", [])
                        if reaction.get("users", {}).get("totalCount", 0) > 0
                    } or None,
                }
                filtered_discussions.append(filtered_discussion)

            # Filter categories data
            filtered_categories = []
            for category in categories_data:
                filtered_category = {
                    "id": category.get("id"),
                    "name": category.get("name"),
                    "description": category.get("description"),
                    "emoji": category.get("emoji"),
                    "is_answerable": category.get("isAnswerable"),
                }
                filtered_categories.append(filtered_category)

            return {
                "filtered": {
                    "discussions": filtered_discussions,
                    "categories": filtered_categories,
                    "total_count": total_count,
                    "page_info": page_info,
                },
                "raw": graphql_data if IsDebug() else None,
                "_note": "Bodies are truncated. Only non-zero reactions are shown.",
            }
        else:
            return {
                "filtered": {
                    "discussions": [],
                    "categories": [],
                    "total_count": 0,
                    "page_info": {},
                },
                "raw": graphql_data if IsDebug() else None,
            }
    except Exception as e:
        console.print(f"[red]Error in get_discussions: {str(e)}[/red]")
        return {"error": str(e)}
