"""GitLab API integration for MCP server."""

import base64
import copy
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from pydantic import BaseModel, Field
from rich.console import Console
from rich.panel import Panel

from ..config import IsDebug, gitlab_request


def _flatten_user(user: Any) -> Optional[str]:
    """Extract username from a GitLab user object."""
    if user is None:
        return None
    if isinstance(user, dict):
        return user.get("username") or user.get("name")
    return str(user)


def _flatten_users(users: Any) -> Optional[List[str]]:
    """Extract usernames from a list of GitLab user objects."""
    if not users:
        return None
    flattened = [_flatten_user(u) for u in users if u]
    return [name for name in flattened if name is not None]

# Initialize rich console for detailed logging
console = Console(stderr=True)


def encode_uri_component(value: str) -> str:
    """Encode a string like JavaScript's encodeURIComponent."""
    return quote(value, safe="")


class ListIssuesArgs(BaseModel):
    """Arguments for listing issues in GitLab repository."""

    project_id: str = Field(..., description="GitLab project ID")
    state: Optional[str] = Field(
        "opened",
        description=("Filter by state ('opened', 'closed', 'all')"),
    )
    order_by: Optional[str] = Field(
        "updated_at",
        description="Order by field",
    )
    sort: Optional[str] = Field("desc", description="Sort order ('asc', 'desc')")
    per_page: Optional[int] = Field(20, description="Results per page (max 100)")


class ListMergeRequestArgs(BaseModel):
    """Arguments for listing merge requests in GitLab."""

    project_id: str = Field(..., description="GitLab project ID")
    state: Optional[str] = Field(
        "opened",
        description="Filter by state",
    )
    order_by: Optional[str] = Field("updated_at", description="Order by field")
    sort: Optional[str] = Field("desc", description="Sort order ('asc', 'desc')")
    per_page: Optional[int] = Field(20, description="Results per page (max 100)")
    target_branch: Optional[str] = Field(None, description="Filter by target branch")
    source_branch: Optional[str] = Field(None, description="Filter by source branch")
    wip: Optional[str] = Field(
        None,
        description="Filter by work in progress status",
    )
    milestone: Optional[str] = Field(None, description="Filter by milestone title")
    scope: Optional[str] = Field(None, description="Filter by scope")


class GetFileContentsArgs(BaseModel):
    """Arguments for getting file contents from GitLab."""

    project_id: str = Field(..., description="GitLab project ID")
    file_path: str = Field(..., description="Path to the file in the repository")
    ref: Optional[str] = Field(
        None,
        description="Branch, tag or commit SHA to get file from",
    )


class CreateOrUpdateFileArgs(BaseModel):
    """Arguments for creating or updating a file in GitLab."""

    project_id: str = Field(..., description="GitLab project ID")
    file_path: str = Field(..., description="Path to the file in the repository")
    content: str = Field(..., description="Content to write to the file")
    commit_message: str = Field(..., description="Commit message")
    branch: str = Field(..., description="Branch name")
    previous_path: Optional[str] = Field(
        None, description="Previous path in case of move/rename"
    )


async def list_issues(args: ListIssuesArgs) -> Dict[str, Any]:
    """Get issues in a GitLab project."""
    project_id = args.project_id
    encoded_project_id = encode_uri_component(project_id)
    endpoint = f"projects/{encoded_project_id}/issues"
    params = {}
    if args.state:
        params["state"] = args.state
    if args.order_by:
        params["order_by"] = args.order_by
    if args.sort:
        params["sort"] = args.sort
    if args.per_page:
        params["per_page"] = args.per_page

    if IsDebug():
        console.print(
            Panel(
                f"[bold]Getting issues[/bold]\n"
                f"Project: {project_id}\n"
                f"State: {args.state or 'all'}\n"
                f"Order by: {args.order_by or 'created_at'}\n"
                f"Sort: {args.sort or 'desc'}\n"
                f"Per page: {args.per_page or 20}",
                title="GitLab API Request",
            )
        )

    response_data = await gitlab_request("GET", endpoint, params=params)

    if "error" in response_data:
        return response_data

    issues = []
    for item in response_data:
        issue = {
            "id": item.get("id"),
            "iid": item.get("iid"),
            "title": item.get("title"),
            "description": item.get("description"),
            "state": item.get("state"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "closed_at": item.get("closed_at"),
            "labels": item.get("labels"),
            "author": _flatten_user(item.get("author")),
            "assignees": _flatten_users(item.get("assignees")),
            "web_url": item.get("web_url"),
        }
        issues.append(issue)

    if IsDebug():
        return {"data": issues, "raw": response_data}
    return {"data": issues}


async def list_merge_requests(
    args: ListMergeRequestArgs,
) -> Dict[str, Any]:
    """Get merge requests in a GitLab project."""
    project_id = args.project_id
    encoded_project_id = encode_uri_component(project_id)
    endpoint = f"projects/{encoded_project_id}/merge_requests"

    params = {}
    if args.state:
        params["state"] = args.state
    if args.order_by:
        params["order_by"] = args.order_by
    if args.sort:
        params["sort"] = args.sort
    if args.per_page:
        params["per_page"] = args.per_page
    if args.target_branch:
        params["target_branch"] = args.target_branch
    if args.source_branch:
        params["source_branch"] = args.source_branch
    if args.wip:
        params["wip"] = args.wip
    if args.milestone:
        params["milestone"] = args.milestone
    if args.scope:
        params["scope"] = args.scope

    if IsDebug():
        console.print(
            Panel(
                f"[bold]Getting merge requests[/bold]\n"
                f"Project: {project_id}\n"
                f"State: {args.state or 'all'}",
                title="GitLab API Request",
            )
        )

    response_data = await gitlab_request("GET", endpoint, params=params)

    if "error" in response_data:
        return response_data

    merge_requests = []
    for item in response_data:
        mr = {
            "id": item.get("id"),
            "iid": item.get("iid"),
            "title": item.get("title"),
            "description": item.get("description"),
            "state": item.get("state"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "merged_at": item.get("merged_at"),
            "closed_at": item.get("closed_at"),
            "target_branch": item.get("target_branch"),
            "source_branch": item.get("source_branch"),
            "labels": item.get("labels"),
            "author": _flatten_user(item.get("author")),
            "assignees": _flatten_users(item.get("assignees")),
            "reviewers": _flatten_users(item.get("reviewers")),
            "web_url": item.get("web_url"),
            "merge_status": item.get("merge_status"),
            "draft": item.get("draft"),
            "milestone": item.get("milestone"),
        }
        merge_requests.append(mr)

    if IsDebug():
        return {"data": merge_requests, "raw": response_data}
    return {"data": merge_requests}


async def get_file_contents(
    args: GetFileContentsArgs,
) -> Dict[str, Any]:
    """Get contents of a file from a GitLab repository."""
    project_id = args.project_id
    encoded_project_id = encode_uri_component(project_id)
    encoded_file_path = encode_uri_component(args.file_path)

    endpoint = f"projects/{encoded_project_id}/repository/files/{encoded_file_path}"

    params = {}
    if args.ref:
        params["ref"] = args.ref
    else:
        # GitLab API requires ref; fetch the project's default branch if not provided
        project_data = await gitlab_request("GET", f"projects/{encoded_project_id}")
        if isinstance(project_data, dict) and "default_branch" in project_data:
            params["ref"] = project_data["default_branch"]
        else:
            params["ref"] = "main"

    if IsDebug():
        console.print(
            Panel(
                f"[bold]Getting file contents[/bold]\n"
                f"Project: {project_id}\n"
                f"File: {args.file_path}\n"
                f"Ref: {args.ref or 'default branch'}",
                title="GitLab API Request",
            )
        )

    response_data = await gitlab_request("GET", endpoint, params=params)

    if "error" in response_data:
        return response_data

    # Decode the content from base64
    if "content" in response_data:
        try:
            content = base64.b64decode(response_data["content"]).decode("utf-8")
            response_data["content"] = content
        except Exception as e:
            return {"error": (f"Failed to decode file content: {str(e)}")}

    filtered_data = {
        "file_name": response_data.get("file_name"),
        "file_path": response_data.get("file_path"),
        "size": response_data.get("size"),
        "encoding": response_data.get("encoding"),
        "content": response_data.get("content"),
        "content_sha256": response_data.get("content_sha256"),
        "ref": response_data.get("ref"),
        "blob_id": response_data.get("blob_id"),
        "commit_id": response_data.get("commit_id"),
        "last_commit_id": response_data.get("last_commit_id"),
    }

    if IsDebug():
        debug_data = copy.deepcopy(response_data)
        if "content" in debug_data:
            debug_data["content"] = f"{debug_data['content'][:100]}... (truncated)"
        return {"data": filtered_data, "raw": debug_data}

    return {"data": filtered_data}


async def create_or_update_file(
    args: CreateOrUpdateFileArgs,
) -> Dict[str, Any]:
    """Create or update a file in a GitLab repository."""
    project_id = args.project_id
    encoded_project_id = encode_uri_component(project_id)
    encoded_file_path = encode_uri_component(args.file_path)

    endpoint = f"projects/{encoded_project_id}/repository/files/{encoded_file_path}"

    body = {
        "branch": args.branch,
        "content": args.content,
        "commit_message": args.commit_message,
    }
    if args.previous_path:
        body["previous_path"] = args.previous_path

    if IsDebug():
        console.print(
            Panel(
                f"[bold]Creating/Updating file[/bold]\n"
                f"Project: {project_id}\n"
                f"File: {args.file_path}\n"
                f"Branch: {args.branch}",
                title="GitLab API Request",
            )
        )

    # Check if file exists to determine HTTP method
    method = "POST"
    check_args = GetFileContentsArgs(
        project_id=args.project_id,
        file_path=args.file_path,
        ref=args.branch,
    )
    check_result = await get_file_contents(check_args)
    if "error" not in check_result:
        method = "PUT"

    response_data = await gitlab_request(method, endpoint, json=body)

    if "error" in response_data:
        return response_data

    filtered_data = {
        "file_path": response_data.get("file_path"),
        "branch": response_data.get("branch"),
    }

    if IsDebug():
        return {"data": filtered_data, "raw": response_data}

    return {"data": filtered_data}
