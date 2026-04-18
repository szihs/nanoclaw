"""GitLab API integration package."""

from .gitlab import (
    CreateOrUpdateFileArgs,
    GetFileContentsArgs,
    ListIssuesArgs,
    ListMergeRequestArgs,
    create_or_update_file,
    get_file_contents,
    list_issues,
    list_merge_requests,
)

__all__ = [
    "CreateOrUpdateFileArgs",
    "GetFileContentsArgs",
    "ListIssuesArgs",
    "ListMergeRequestArgs",
    "get_file_contents",
    "create_or_update_file",
    "list_issues",
    "list_merge_requests",
]
