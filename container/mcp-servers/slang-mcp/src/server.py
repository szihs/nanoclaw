"""Slang MCP server for GitHub, Discord, and Slack API tools."""

import json
import sys

import anyio
import click
import mcp.types as types
from mcp.server.lowlevel import Server
from rich.console import Console
from rich.panel import Panel

# Initialize rich console
console = Console(stderr=True)

from .config import close_http_clients, setup_environment  # noqa: E402
from .discord import (  # noqa: E402
    ReadMessagesArgs,
    SendMessageArgs,
    cleanup_discord_client,
    init_discord_client,
    read_messages,
    send_message,
)
from .github import (  # noqa: E402
    CreateOrUpdateFileArgs,
    GetDiscussionsArgs,
    GetFileContentsArgs,
    GetIssueArgs,
    GetPullRequestArgs,
    GetPullRequestCommentsArgs,
    GetPullRequestReviewsArgs,
    ListIssuesArgs,
    ListPullRequestsArgs,
    SearchIssuesArgs,
    create_or_update_file,
    get_discussions,
    get_file_contents,
    get_issue,
    get_pull_request,
    get_pull_request_comments,
    get_pull_request_reviews,
    list_issues,
    list_pull_requests,
    search_issues,
)
from .gitlab import CreateOrUpdateFileArgs as GitLabCreateOrUpdateFileArgs  # noqa: E402
from .gitlab import GetFileContentsArgs as GitLabGetFileContentsArgs  # noqa: E402
from .gitlab import ListIssuesArgs as GitLabListIssuesArgs  # noqa: E402
from .gitlab import ListMergeRequestArgs as GitLabListMergeRequestArgs  # noqa: E402
from .gitlab import create_or_update_file as gitlab_create_or_update_file  # noqa: E402
from .gitlab import get_file_contents as gitlab_get_file_contents  # noqa: E402
from .gitlab import list_issues as gitlab_list_issues  # noqa: E402
from .gitlab import list_merge_requests as gitlab_list_merge_requests  # noqa: E402
from .slack import (  # noqa: E402
    GetChannelHistoryArgs,
    GetUserProfileArgs,
    PostMessageArgs,
    ReplyToThreadArgs,
    cleanup_slack_client,
    get_channel_history,
    get_user_profile,
    post_message,
    reply_to_thread,
)


@click.command()
@click.option("--port", default=8000, help="Port to listen on for SSE")
@click.option(
    "--transport",
    type=click.Choice(["stdio", "sse"]),
    default="stdio",
    help="Transport type",
)
def main(port: int, transport: str) -> int:
    """Run the Slang MCP server."""
    try:
        # Display application header
        console.print(
            Panel.fit(
                "[bold blue]Slang MCP Server[/bold blue]\n"
                "[cyan]Interact with GitHub, Discord and Slack APIs using natural language[/cyan]",
                border_style="blue",
            )
        )

        # Initialize configuration
        setup_environment()

        # Display configuration
        console.print("[green]API configurations loaded successfully[/green]")

        # Check which APIs are available
        available_apis = []
        try:
            from .config import get_gitlab_config

            get_gitlab_config()
            available_apis.append("GitLab")
        except ValueError:
            console.print(
                "[yellow]GitLab API is not available (token not configured)[/yellow]"
            )

        try:
            from .config import get_github_config

            get_github_config()
            available_apis.append("GitHub")
        except ValueError:
            console.print(
                "[yellow]GitHub API is not available (token not configured)[/yellow]"
            )

        try:
            from .config import get_discord_config

            get_discord_config()
            available_apis.append("Discord")
        except ValueError:
            console.print(
                "[yellow]Discord API is not available (token not configured)[/yellow]"
            )

        try:
            from .config import get_slack_config

            get_slack_config()
            available_apis.append("Slack")
        except ValueError:
            console.print(
                "[yellow]Slack API is not available (token not configured)[/yellow]"
            )

        if not available_apis:
            console.print(
                "[red]No APIs are available. Please check your configuration.[/red]"
            )
            return 1

        console.print(f"[green]Available APIs: {', '.join(available_apis)}[/green]")

        # Discord client will be started eagerly inside the event loop (see arun below)
        discord_eager_init = "Discord" in available_apis

        # Create MCP server
        app = Server("slang-mcp-server")

        # Register cleanup handlers
        import atexit
        import signal

        # Register cleanup handlers for graceful shutdown
        async def cleanup_all():
            """Clean up all clients gracefully."""
            if "Discord" in available_apis:
                try:
                    await cleanup_discord_client()
                except Exception as e:
                    console.print(f"[yellow]Error during Discord cleanup: {e}[/yellow]")

            if "Slack" in available_apis:
                try:
                    await cleanup_slack_client()
                except Exception as e:
                    console.print(f"[yellow]Error during Slack cleanup: {e}[/yellow]")

            # Close shared HTTP clients (GitHub, GitLab)
            try:
                await close_http_clients()
            except Exception as e:
                console.print(f"[yellow]Error closing HTTP clients: {e}[/yellow]")

        def handle_shutdown(signum=None, frame=None):
            """Handle shutdown signals gracefully."""
            console.print("[yellow]Shutting down gracefully...[/yellow]")
            try:
                import asyncio

                try:
                    loop = asyncio.get_running_loop()
                    # Loop is running — schedule cleanup, then exit from callback
                    task = loop.create_task(cleanup_all())
                    if signum is not None:
                        task.add_done_callback(lambda _: sys.exit(0))
                    return  # Let the event loop run the cleanup task
                except RuntimeError:
                    # No running loop — create one for cleanup
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    loop.run_until_complete(cleanup_all())
                    loop.close()
            except Exception as e:
                console.print(f"[red]Error during cleanup: {e}[/red]")
            if signum is not None:
                sys.exit(0)

        # Register signal handlers
        signal.signal(signal.SIGINT, handle_shutdown)
        signal.signal(signal.SIGTERM, handle_shutdown)

        # Register atexit handler as fallback (no sys.exit)
        def _atexit_cleanup():
            try:
                import asyncio

                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                loop.run_until_complete(cleanup_all())
                loop.close()
            except Exception as e:
                console.print(f"[red]Error during atexit cleanup: {e}[/red]")

        atexit.register(_atexit_cleanup)

        console.print("[green]Registered cleanup handlers[/green]")

        # Set up tool handlers
        @app.call_tool()
        async def call_tool(
            name: str, arguments: dict
        ) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
            """Handle tool calls."""
            try:
                # Log the tool call
                console.rule(f"[yellow]Tool Call: {name}[/yellow]")
                console.print(
                    Panel(
                        json.dumps(arguments, indent=2),
                        title="Arguments",
                        border_style="yellow",
                    )
                )

                # GitHub Tools - only whitelisted ones
                if name == "github_get_issue":
                    args = GetIssueArgs(**arguments)
                    result = await get_issue(args)
                elif name == "github_list_issues":
                    args = ListIssuesArgs(**arguments)
                    result = await list_issues(args)
                elif name == "github_search_issues":
                    args = SearchIssuesArgs(**arguments)
                    result = await search_issues(args)
                elif name == "github_list_pull_requests":
                    args = ListPullRequestsArgs(**arguments)
                    result = await list_pull_requests(args)
                elif name == "github_get_pull_request":
                    args = GetPullRequestArgs(**arguments)
                    result = await get_pull_request(args)
                elif name == "github_get_pull_request_comments":
                    args = GetPullRequestCommentsArgs(**arguments)
                    result = await get_pull_request_comments(args)
                elif name == "github_get_pull_request_reviews":
                    args = GetPullRequestReviewsArgs(**arguments)
                    result = await get_pull_request_reviews(args)
                elif name == "github_create_or_update_file":
                    args = CreateOrUpdateFileArgs(**arguments)
                    result = await create_or_update_file(args)
                elif name == "github_get_discussions":
                    args = GetDiscussionsArgs(**arguments)
                    result = await get_discussions(args)
                elif name == "github_get_file_contents":
                    args = GetFileContentsArgs(**arguments)
                    result = await get_file_contents(args)

                # GitLab Tools
                elif name == "gitlab_get_file_contents":
                    args = GitLabGetFileContentsArgs(**arguments)
                    result = await gitlab_get_file_contents(args)
                elif name == "gitlab_create_or_update_file":
                    args = GitLabCreateOrUpdateFileArgs(**arguments)
                    result = await gitlab_create_or_update_file(args)
                elif name == "gitlab_list_issues":
                    args = GitLabListIssuesArgs(**arguments)
                    result = await gitlab_list_issues(args)
                elif name == "gitlab_list_merge_requests":
                    args = GitLabListMergeRequestArgs(**arguments)
                    result = await gitlab_list_merge_requests(args)

                # Discord Tools - only whitelisted ones
                elif name == "discord_read_messages":
                    args = ReadMessagesArgs(**arguments)
                    result = await read_messages(args)
                elif name == "discord_send_message":
                    args = SendMessageArgs(**arguments)
                    result = await send_message(args)

                # Slack Tools - only whitelisted ones
                elif name == "slack_post_message":
                    args = PostMessageArgs(**arguments)
                    result = await post_message(args)
                elif name == "slack_get_channel_history":
                    args = GetChannelHistoryArgs(**arguments)
                    result = await get_channel_history(args)
                elif name == "slack_reply_to_thread":
                    args = ReplyToThreadArgs(**arguments)
                    result = await reply_to_thread(args)
                elif name == "slack_get_user_profile":
                    args = GetUserProfileArgs(**arguments)
                    result = await get_user_profile(args)
                else:
                    result = {"error": f"Unknown tool: {name}"}

                # Format result as JSON
                result_json = json.dumps(result, indent=2)

                # Log the result
                console.rule("[green]Tool Result[/green]")
                console.print(
                    Panel(
                        result_json[:500] + "..."
                        if len(result_json) > 500
                        else result_json
                    )
                )

                return [types.TextContent(type="text", text=result_json)]
            except Exception as e:
                console.print(f"[red]Error in tool call {name}: {str(e)}[/red]")
                return [
                    types.TextContent(type="text", text=json.dumps({"error": str(e)}))
                ]

        # Set up tool definitions
        @app.list_tools()
        async def list_tools() -> list[types.Tool]:
            """List available tools."""
            tools = []

            # GitHub tools (if available) - only whitelisted ones
            if "GitHub" in available_apis:
                tools.extend(
                    [
                        types.Tool(
                            name="github_get_issue",
                            description="Get details of a GitHub issue",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "issue_number": {
                                        "type": "integer",
                                        "description": "Issue number to retrieve",
                                    },
                                },
                                "required": ["owner", "repo", "issue_number"],
                            },
                        ),
                        types.Tool(
                            name="github_list_issues",
                            description="List and filter GitHub repository issues",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "state": {
                                        "type": "string",
                                        "description": "Filter by state ('OPEN', 'CLOSED', 'ALL')",
                                        "enum": ["OPEN", "CLOSED", "ALL"],
                                        "default": "OPEN",
                                    },
                                    "labels": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                        "description": "Filter by labels",
                                    },
                                    "first": {
                                        "type": "integer",
                                        "description": "Number of issues to fetch (max 100)",
                                        "default": 10,
                                        "minimum": 1,
                                        "maximum": 100,
                                    },
                                    "after": {
                                        "type": "string",
                                        "description": "Cursor for pagination",
                                    },
                                    "order_by": {
                                        "type": "object",
                                        "description": "Order by field and direction",
                                        "properties": {
                                            "field": {
                                                "type": "string",
                                                "enum": ["CREATED_AT", "UPDATED_AT"],
                                            },
                                            "direction": {
                                                "type": "string",
                                                "enum": ["ASC", "DESC"],
                                            },
                                        },
                                        "default": {
                                            "field": "UPDATED_AT",
                                            "direction": "DESC",
                                        },
                                    },
                                    "since": {
                                        "type": "string",
                                        "description": "Filter by date (ISO 8601 timestamp), defaults to 7 days ago",
                                    },
                                },
                                "required": ["owner", "repo"],
                            },
                        ),
                        types.Tool(
                            name="github_search_issues",
                            description="Search for GitHub issues and pull requests",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "q": {
                                        "type": "string",
                                        "description": "Search query using GitHub issues search syntax",
                                    },
                                    "sort": {
                                        "type": "string",
                                        "description": "Sort field (comments, reactions, created, updated, etc.)",
                                    },
                                    "order": {
                                        "type": "string",
                                        "description": "Sort order ('asc', 'desc')",
                                        "enum": ["asc", "desc"],
                                    },
                                    "per_page": {
                                        "type": "integer",
                                        "description": "Results per page (max 100)",
                                    },
                                    "page": {
                                        "type": "integer",
                                        "description": "Page number",
                                    },
                                },
                                "required": ["q"],
                            },
                        ),
                        types.Tool(
                            name="github_list_pull_requests",
                            description="List pull requests from a GitHub repository",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "state": {
                                        "type": "string",
                                        "description": "Filter by state ('open', 'closed', 'all')",
                                        "enum": ["open", "closed", "all"],
                                    },
                                    "head": {
                                        "type": "string",
                                        "description": "Filter by head branch",
                                    },
                                    "base": {
                                        "type": "string",
                                        "description": "Filter by base branch",
                                    },
                                    "sort": {
                                        "type": "string",
                                        "description": "Sort by ('created', 'updated', 'popularity', 'long-running')",
                                        "enum": [
                                            "created",
                                            "updated",
                                            "popularity",
                                            "long-running",
                                        ],
                                    },
                                    "direction": {
                                        "type": "string",
                                        "description": "Sort direction ('asc', 'desc')",
                                        "enum": ["asc", "desc"],
                                    },
                                    "page": {
                                        "type": "integer",
                                        "description": "Page number",
                                    },
                                    "per_page": {
                                        "type": "integer",
                                        "description": "Results per page",
                                    },
                                },
                                "required": ["owner", "repo"],
                            },
                        ),
                        types.Tool(
                            name="github_get_pull_request",
                            description="Get detailed information about a specific pull request",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "pull_number": {
                                        "type": "integer",
                                        "description": "Pull request number to retrieve",
                                    },
                                },
                                "required": ["owner", "repo", "pull_number"],
                            },
                        ),
                        types.Tool(
                            name="github_get_pull_request_comments",
                            description="Get comments on a pull request",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "pull_number": {
                                        "type": "integer",
                                        "description": "Pull request number",
                                    },
                                },
                                "required": ["owner", "repo", "pull_number"],
                            },
                        ),
                        types.Tool(
                            name="github_get_pull_request_reviews",
                            description="Get reviews for a pull request",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "pull_number": {
                                        "type": "integer",
                                        "description": "Pull request number",
                                    },
                                },
                                "required": ["owner", "repo", "pull_number"],
                            },
                        ),
                        types.Tool(
                            name="github_create_or_update_file",
                            description="Create or update a single file in a GitHub repository",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "path": {
                                        "type": "string",
                                        "description": "Path where to create/update the file",
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "Content of the file",
                                    },
                                    "message": {
                                        "type": "string",
                                        "description": "Commit message",
                                    },
                                    "branch": {
                                        "type": "string",
                                        "description": "Branch to create/update the file in",
                                    },
                                    "sha": {
                                        "type": "string",
                                        "description": (
                                            "SHA of the file being replaced"
                                            " (required when updating existing files)"
                                        ),
                                    },
                                },
                                "required": [
                                    "owner",
                                    "repo",
                                    "path",
                                    "content",
                                    "message",
                                    "branch",
                                ],
                            },
                        ),
                        types.Tool(
                            name="github_get_discussions",
                            description="Get discussions from a GitHub repository",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner (username or organization)",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                    },
                                    "first": {
                                        "type": "integer",
                                        "description": "Number of discussions to fetch (max 100)",
                                        "default": 10,
                                        "minimum": 1,
                                        "maximum": 100,
                                    },
                                    "after": {
                                        "type": "string",
                                        "description": "Cursor for pagination",
                                    },
                                    "category_id": {
                                        "type": "string",
                                        "description": "Filter by discussion category ID",
                                    },
                                    "answered": {
                                        "type": "boolean",
                                        "description": "Filter by answered status (true/false/null for all)",
                                    },
                                    "order_by": {
                                        "type": "object",
                                        "description": "Order by field and direction",
                                        "properties": {
                                            "field": {
                                                "type": "string",
                                                "enum": ["CREATED_AT", "UPDATED_AT"],
                                            },
                                            "direction": {
                                                "type": "string",
                                                "enum": ["ASC", "DESC"],
                                            },
                                        },
                                        "default": {
                                            "field": "UPDATED_AT",
                                            "direction": "DESC",
                                        },
                                    },
                                },
                                "required": ["owner", "repo"],
                            },
                        ),
                        types.Tool(
                            name="github_get_file_contents",
                            description="Read a file or list a directory from a GitHub repository (read-only). Defaults to shader-slang/slang.",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "owner": {
                                        "type": "string",
                                        "description": "Repository owner",
                                        "default": "shader-slang",
                                    },
                                    "repo": {
                                        "type": "string",
                                        "description": "Repository name",
                                        "default": "slang",
                                    },
                                    "path": {
                                        "type": "string",
                                        "description": "File or directory path within the repository",
                                    },
                                    "ref": {
                                        "type": "string",
                                        "description": "Branch, tag, or commit SHA (defaults to default branch)",
                                    },
                                },
                                "required": ["path"],
                            },
                        ),
                    ]
                )

            # GitLab tools (if available)
            if "GitLab" in available_apis:
                tools.extend(
                    [
                        types.Tool(
                            name="gitlab_list_issues",
                            description="List the issues in a GitLab project",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "project_id": {
                                        "type": "string",
                                        "description": "GitLab project ID",
                                    },
                                    "state": {
                                        "type": "string",
                                        "description": "Filter by state ('opened', 'closed', 'all')",
                                        "enum": ["opened", "closed", "all"],
                                        "default": "opened",
                                    },
                                    "order_by": {
                                        "type": "string",
                                        "description": (
                                            "Order by field ('created_at',"
                                            " 'updated_at', 'priority',"
                                            " 'label_priority', 'milestone_due',"
                                            " 'milestone_start', 'due_date',"
                                            " 'relative_position', 'subject')"
                                        ),
                                        "enum": [
                                            "created_at",
                                            "updated_at",
                                            "priority",
                                            "label_priority",
                                            "milestone_due",
                                            "milestone_start",
                                            "due_date",
                                            "relative_position",
                                            "subject",
                                        ],
                                        "default": "updated_at",
                                    },
                                    "sort": {
                                        "type": "string",
                                        "description": "Sort order ('asc', 'desc')",
                                        "enum": ["asc", "desc"],
                                        "default": "desc",
                                    },
                                    "per_page": {
                                        "type": "integer",
                                        "description": "Results per page (max 100)",
                                        "minimum": 1,
                                        "maximum": 100,
                                        "default": 20,
                                    },
                                },
                                "required": ["project_id"],
                            },
                        ),
                        types.Tool(
                            name="gitlab_list_merge_requests",
                            description="List and filter merge requests in a GitLab project",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "project_id": {
                                        "type": "string",
                                        "description": "GitLab project ID",
                                    },
                                    "state": {
                                        "type": "string",
                                        "description": (
                                            "Filter by state ('opened',"
                                            " 'closed', 'locked',"
                                            " 'merged', 'all')"
                                        ),
                                        "enum": [
                                            "opened",
                                            "closed",
                                            "locked",
                                            "merged",
                                            "all",
                                        ],
                                        "default": "opened",
                                    },
                                    "order_by": {
                                        "type": "string",
                                        "description": (
                                            "Order by field ('created_at',"
                                            " 'updated_at', 'merged_at',"
                                            " 'title')"
                                        ),
                                        "enum": [
                                            "created_at",
                                            "updated_at",
                                            "merged_at",
                                            "title",
                                        ],
                                        "default": "updated_at",
                                    },
                                    "sort": {
                                        "type": "string",
                                        "description": "Sort order ('asc', 'desc')",
                                        "enum": ["asc", "desc"],
                                        "default": "desc",
                                    },
                                    "per_page": {
                                        "type": "integer",
                                        "description": "Results per page (max 100)",
                                        "minimum": 1,
                                        "maximum": 100,
                                        "default": 20,
                                    },
                                    "target_branch": {
                                        "type": "string",
                                        "description": "Filter by target branch",
                                    },
                                    "source_branch": {
                                        "type": "string",
                                        "description": "Filter by source branch",
                                    },
                                    "wip": {
                                        "type": "string",
                                        "description": "Filter by work in progress status ('yes' or 'no')",
                                        "enum": ["yes", "no"],
                                    },
                                    "milestone": {
                                        "type": "string",
                                        "description": "Filter by milestone title",
                                    },
                                    "scope": {
                                        "type": "string",
                                        "description": "Filter by scope ('created_by_me', 'assigned_to_me', 'all')",
                                        "enum": [
                                            "created_by_me",
                                            "assigned_to_me",
                                            "all",
                                        ],
                                    },
                                },
                                "required": ["project_id"],
                            },
                        ),
                        types.Tool(
                            name="gitlab_get_file_contents",
                            description="Get contents of a file from a GitLab repository",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "project_id": {
                                        "type": "string",
                                        "description": "GitLab project ID",
                                    },
                                    "file_path": {
                                        "type": "string",
                                        "description": "Path to the file in the repository",
                                    },
                                    "ref": {
                                        "type": "string",
                                        "description": "Branch, tag or commit SHA to get file from",
                                    },
                                },
                                "required": ["project_id", "file_path"],
                            },
                        ),
                        types.Tool(
                            name="gitlab_create_or_update_file",
                            description="Create or update a file in a GitLab repository",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "project_id": {
                                        "type": "string",
                                        "description": "GitLab project ID",
                                    },
                                    "file_path": {
                                        "type": "string",
                                        "description": "Path to the file in the repository",
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "Content to write to the file",
                                    },
                                    "commit_message": {
                                        "type": "string",
                                        "description": "Commit message",
                                    },
                                    "branch": {
                                        "type": "string",
                                        "description": "Branch name",
                                    },
                                    "previous_path": {
                                        "type": "string",
                                        "description": "Previous path in case of move/rename",
                                    },
                                },
                                "required": [
                                    "project_id",
                                    "file_path",
                                    "content",
                                    "commit_message",
                                    "branch",
                                ],
                            },
                        ),
                    ]
                )

            # Discord tools (if available) - only whitelisted ones
            if "Discord" in available_apis:
                tools.extend(
                    [
                        types.Tool(
                            name="discord_read_messages",
                            description="Read messages from a Discord channel",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "channel_id": {
                                        "type": "string",
                                        "description": "Discord channel ID",
                                    },
                                    "limit": {
                                        "type": "integer",
                                        "description": "Number of messages to fetch (max 100)",
                                        "default": 10,
                                        "minimum": 1,
                                        "maximum": 100,
                                    },
                                },
                                "required": ["channel_id"],
                            },
                        ),
                        types.Tool(
                            name="discord_send_message",
                            description="Send a message to a Discord channel, thread, or forum. For forums, creates a new thread/post. Restricted to allowed channels.",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "channel_id": {
                                        "type": "string",
                                        "description": "Discord channel ID (text channel, thread, or forum channel)",
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "Message content",
                                    },
                                    "thread_name": {
                                        "type": "string",
                                        "description": "For forum channels: title for the new thread/post. Ignored for text channels and threads.",
                                    },
                                    "add_feedback_buttons": {
                                        "type": "boolean",
                                        "description": "If true, attach Resolved/Helpful/Not Helpful feedback buttons",
                                        "default": False,
                                    },
                                },
                                "required": ["channel_id", "content"],
                            },
                        ),
                    ]
                )

            # Slack tools (if available) - only whitelisted ones
            if "Slack" in available_apis:
                tools.extend(
                    [
                        types.Tool(
                            name="slack_post_message",
                            description="Post a new message to a Slack channel",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "channel_id": {
                                        "type": "string",
                                        "description": "The ID of the channel to post to",
                                    },
                                    "text": {
                                        "type": "string",
                                        "description": "The message text to post",
                                    },
                                },
                                "required": ["channel_id", "text"],
                            },
                        ),
                        types.Tool(
                            name="slack_get_channel_history",
                            description="Get recent messages from a channel",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "channel_id": {
                                        "type": "string",
                                        "description": "The ID of the channel",
                                    },
                                    "limit": {
                                        "type": "integer",
                                        "description": "Number of messages to retrieve (default 10)",
                                        "default": 10,
                                        "minimum": 1,
                                        "maximum": 100,
                                    },
                                    "since": {
                                        "type": "string",
                                        "description": (
                                            "Retrieve messages since this"
                                            " ISO 8601 timestamp"
                                            " (e.g. '2023-04-01T00:00:00Z')"
                                        ),
                                    },
                                },
                                "required": ["channel_id"],
                            },
                        ),
                        types.Tool(
                            name="slack_reply_to_thread",
                            description="Reply to a thread in a channel",
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "channel_id": {
                                        "type": "string",
                                        "description": "The ID of the channel containing the thread",
                                    },
                                    "thread_ts": {
                                        "type": "string",
                                        "description": "The timestamp of the parent message",
                                    },
                                    "text": {
                                        "type": "string",
                                        "description": "The reply text",
                                    },
                                },
                                "required": ["channel_id", "thread_ts", "text"],
                            },
                        ),
                        types.Tool(
                            name="slack_get_user_profile",
                            description=(
                                "Get a user's profile information from their"
                                " user ID. Returns the user's display name,"
                                " real name, email, and other profile fields."
                                " Use this to convert Slack user IDs (like"
                                " 'U12345678') to human-readable names."
                            ),
                            inputSchema={
                                "type": "object",
                                "properties": {
                                    "user_id": {
                                        "type": "string",
                                        "description": "The Slack user ID (e.g., 'U12345678')",
                                    },
                                    "force_refresh": {
                                        "type": "boolean",
                                        "description": (
                                            "Bypass cache and fetch fresh data from"
                                            " Slack API (default: false)"
                                        ),
                                        "default": False,
                                    },
                                },
                                "required": ["user_id"],
                            },
                        ),
                    ]
                )

            return tools

        # Run the server with the specified transport
        console.rule(
            f"[bold green]Starting server with {transport} transport[/bold green]"
        )

        if transport == "sse":
            from mcp.server.sse import SseServerTransport
            from starlette.applications import Starlette
            from starlette.responses import Response
            from starlette.routing import Mount, Route

            sse = SseServerTransport("/messages/")

            async def handle_sse(request):
                async with sse.connect_sse(
                    request.scope, request.receive, request._send
                ) as streams:
                    await app.run(
                        streams[0], streams[1], app.create_initialization_options()
                    )
                # Return empty response to avoid NoneType error when client disconnects
                return Response()

            starlette_app = Starlette(
                debug=True,
                routes=[
                    Route("/sse", endpoint=handle_sse),
                    Mount("/messages/", app=sse.handle_post_message),
                ],
            )

            console.print(f"[green]Server listening on port {port}[/green]")
            import uvicorn

            uvicorn.run(starlette_app, host="127.0.0.1", port=port)
        else:
            from mcp.server.stdio import stdio_server

            console.print("[green]Server running on stdio[/green]")

            async def arun():
                async with stdio_server() as streams:
                    await app.run(
                        streams[0], streams[1], app.create_initialization_options()
                    )

            anyio.run(arun)

        return 0
    except Exception as e:
        console.print(f"[red]Error starting GitHub MCP server: {str(e)}[/red]")
        return 1


if __name__ == "__main__":
    sys.exit(main())
