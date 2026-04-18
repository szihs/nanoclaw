# Slang MCP Server

A minimal MCP server for GitHub, GitLab, Discord, and Slack APIs.

## Available Tools

### GitHub API

1. `github_get_issue` - Get details of a GitHub issue by owner, repo, and issue number
2. `github_list_issues` - List and filter GitHub repository issues with various parameters
3. `github_search_issues` - Search for GitHub issues using their search query syntax
4. `github_list_pull_requests` - List pull requests from a GitHub repository with filtering
5. `github_get_pull_request` - Get detailed information about a specific pull request
6. `github_get_pull_request_comments` - Get comments on a pull request
7. `github_get_pull_request_reviews` - Get reviews for a pull request
8. `github_get_discussions` - Get discussions from a GitHub repository with filtering and pagination
9. `github_create_or_update_file` - Create or update a file in a GitHub repository

### GitLab API

1. `gitlab_get_file_contents` - Read file contents from a GitLab repository
2. `gitlab_list_issues` - List and filter GitLab project issues
3. `gitlab_list_merge_requests` - List merge requests from a GitLab project
4. `gitlab_create_or_update_file` - Create or update a file in a GitLab repository

### Discord API

1. `discord_read_messages` - Read messages from a Discord channel

### Slack API

1. `slack_post_message` - Post a new message to a Slack channel
2. `slack_get_channel_history` - Get recent messages from a Slack channel
3. `slack_reply_to_thread` - Reply to a thread in a Slack channel
4. `slack_get_user_profile` - Get user profile information (display name, real name, email) from user ID


## Installation

### Prerequisites

Install uv, a fast Python package installer and environment manager:

#### macOS and Linux
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### Windows
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### Setup

1. Clone the repository and set up the server:
   ```bash
   cd container/mcp-servers/slang-mcp
   ```

2. Create a `.env` file with your API tokens:
   ```bash
   cp .env.example .env
   # Edit .env with your GitHub, GitLab, Discord, and Slack tokens
   ```

3. Install dependencies using uv:
   ```bash
   uv venv
   source .venv/bin/activate  # On Unix/MacOS
   # or
   .venv\Scripts\activate     # On Windows
   ```

## Usage

Run the server using uv with SSE transport:
```bash
uv run slang-mcp-server --transport sse --port 9010
```

### Configuring with Cursor IDE

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "Github": {
      "url": "http://localhost:9010/sse",
      "transport": "sse"
    }
  }
}
```

## License

This project is licensed under the MIT License. 