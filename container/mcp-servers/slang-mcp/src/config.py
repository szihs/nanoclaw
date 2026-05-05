"""Configuration for GitHub, GitLab, Discord and Slack MCP server."""

import logging
import os
import platform
from pathlib import Path
from typing import Any, Dict, Optional

import dotenv
import httpx
from pydantic import BaseModel, SecretStr, field_serializer

# Set up logging
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


DEBUG = False  # Will be updated in setup_environment
# Define what symbols are exported when using 'from config import *'
# These are the symbols that are actually used across the codebase
__all__ = [
    "GitHubConfig",  # Used as type annotation and in tests
    "GitLabConfig",  # Used as type annotation and in tests
    "DiscordConfig",  # Used as type annotation and in tests
    "setup_environment",  # Used in server.py and main agent
    "get_github_config",  # Used in server.py and tests
    "get_gitlab_config",  # Used in server.py and tests
    "get_discord_config",  # Used in server.py and tests
    "github_request",  # Used in github.py for API requests
    "gitlab_request",  # Used in server.py and tests
    "IsDebug",
]


def IsDebug():
    global DEBUG
    return DEBUG


def get_ssl_verify_config():
    """Get SSL verification configuration for the current platform."""
    import ssl

    onecli_cert = os.environ.get("SSL_CERT_FILE")
    if onecli_cert and os.path.exists(onecli_cert):
        # OneCLI sets SSL_CERT_FILE to its own CA cert only. Merge with the
        # system bundle so both direct connections (GitHub's real cert) and
        # MITM-proxied connections (OneCLI-signed cert) are trusted.
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(onecli_cert)
        return ctx
    if platform.system() == "Linux":
        cert_path = "/etc/ssl/certs/ca-certificates.crt"
        if os.path.exists(cert_path):
            return cert_path
    return True


class GitHubConfig(BaseModel):
    """GitHub API configuration."""

    access_token: SecretStr
    api_base: str = "https://api.github.com"

    @field_serializer("access_token", when_used="json")
    def dump_secret(self, v):
        return v.get_secret_value()


class GitLabConfig(BaseModel):
    """GitLab API configuration."""

    access_token: SecretStr
    api_base: str = "https://gitlab-master.nvidia.com/api/v4"

    @field_serializer("access_token", when_used="json")
    def dump_secret(self, v):
        return v.get_secret_value()


class DiscordConfig(BaseModel):
    """Discord API configuration."""

    bot_token: SecretStr

    @field_serializer("bot_token", when_used="json")
    def dump_secret(self, v):
        return v.get_secret_value()


_GITHUB_CONFIG: Optional[GitHubConfig] = None
_GITLAB_CONFIG: Optional[GitLabConfig] = None
_DISCORD_CONFIG: Optional[DiscordConfig] = None

# Shared httpx clients (reused across requests)
_github_http_client: Optional[httpx.AsyncClient] = None
_gitlab_http_client: Optional[httpx.AsyncClient] = None

_DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def setup_environment():
    """Load environment variables and set up configurations."""
    global _GITHUB_CONFIG, _GITLAB_CONFIG, _DISCORD_CONFIG, DEBUG

    # Load environment variables from .env file
    dotenv.load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env", override=True)
    # Global debug flag
    DEBUG = os.environ.get("DEBUG", "False").lower() == "true"
    # Get GitHub access token.
    # Preference order:
    #   1. ONECLI_URL set → OneCLI proxy injects Authorization; use placeholder token.
    #   2. GH_TOKEN — rotating GitHub App installation token (managed externally).
    #   3. GITHUB_ACCESS_TOKEN — legacy static PAT (backwards compat).
    onecli_url = os.environ.get("ONECLI_URL")
    github_token = (
        os.environ.get("GH_TOKEN")
        or os.environ.get("GITHUB_ACCESS_TOKEN")
        or ("onecli-managed" if onecli_url else None)
    )
    if github_token:
        _GITHUB_CONFIG = GitHubConfig(
            access_token=SecretStr(github_token),
            api_base=os.environ.get("GITHUB_API_BASE", "https://api.github.com"),
        )
        logger.info("GitHub configuration loaded successfully")
    else:
        logger.warning("GH_TOKEN / ONECLI_URL is not set in environment variables")

    # Get GitLab access token
    gitlab_token = os.environ.get("GITLAB_ACCESS_TOKEN")
    if gitlab_token:
        _GITLAB_CONFIG = GitLabConfig(
            access_token=SecretStr(gitlab_token),
            api_base=os.environ.get(
                "GITLAB_API_BASE",
                "https://gitlab-master.nvidia.com/api/v4",
            ),
        )
        logger.info("GitLab configuration loaded successfully")
    else:
        logger.warning("GITLAB_ACCESS_TOKEN is not set in environment variables")

    # Get Discord bot token
    discord_token = os.environ.get("DISCORD_BOT_TOKEN")
    if discord_token:
        _DISCORD_CONFIG = DiscordConfig(
            bot_token=SecretStr(discord_token),
        )
        logger.info("Discord configuration loaded successfully")
    else:
        logger.warning("DISCORD_BOT_TOKEN is not set in environment variables")

    return {
        "github": _GITHUB_CONFIG,
        "gitlab": _GITLAB_CONFIG,
        "discord": _DISCORD_CONFIG,
    }


def get_github_config() -> GitHubConfig:
    """Get GitHub configuration."""
    global _GITHUB_CONFIG
    if _GITHUB_CONFIG is None:
        setup_environment()
    if _GITHUB_CONFIG is None:
        raise ValueError(
            "GitHub configuration is not available. "
            "Make sure GITHUB_ACCESS_TOKEN is set."
        )
    return _GITHUB_CONFIG


def get_gitlab_config() -> GitLabConfig:
    """Get GitLab configuration."""
    global _GITLAB_CONFIG
    if _GITLAB_CONFIG is None:
        setup_environment()
    if _GITLAB_CONFIG is None:
        raise ValueError(
            "GitLab configuration is not available. "
            "Make sure GITLAB_ACCESS_TOKEN is set."
        )
    return _GITLAB_CONFIG


def get_discord_config() -> DiscordConfig:
    """Get Discord configuration."""
    global _DISCORD_CONFIG
    if _DISCORD_CONFIG is None:
        setup_environment()
    if _DISCORD_CONFIG is None:
        raise ValueError(
            "Discord configuration is not available. "
            "Make sure DISCORD_BOT_TOKEN is set."
        )
    return _DISCORD_CONFIG


def get_github_headers():
    """Get GitHub API headers with authentication."""
    config = get_github_config()
    return {
        "Authorization": f"token {config.access_token.get_secret_value()}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Slang-MCP-Server/1.0",
    }


async def _get_github_client() -> httpx.AsyncClient:
    """Get or create the shared GitHub httpx client."""
    global _github_http_client
    if _github_http_client is None or _github_http_client.is_closed:
        ssl_verify = get_ssl_verify_config()
        # trust_env=True (default) picks up https_proxy / SSL_CERT_FILE set by the
        # host MCP registry when running behind OneCLI.
        _github_http_client = httpx.AsyncClient(
            verify=ssl_verify, timeout=_DEFAULT_TIMEOUT
        )
    return _github_http_client


async def github_request(method: str, url: str, **kwargs) -> Any:
    """Make a request to the GitHub API."""
    config = get_github_config()

    # Add base URL if URL doesn't start with http
    if not url.startswith("http"):
        url = f"{config.api_base}/{url.lstrip('/')}"

    # Add authentication headers
    headers = kwargs.pop("headers", {})
    headers.update(get_github_headers())

    client = await _get_github_client()
    response = await client.request(method, url, headers=headers, **kwargs)

    # Extract rate limit info
    rate_limit_remaining = response.headers.get("X-RateLimit-Remaining")
    rate_limit_total = response.headers.get("X-RateLimit-Limit")

    # Handle API rate limiting
    if response.status_code == 403:
        if rate_limit_remaining == "0":
            logger.warning("GitHub API rate limit exceeded")
            return {
                "error": "GitHub API rate limit exceeded",
                "reset_at": response.headers.get("X-RateLimit-Reset", "unknown"),
            }

    # Handle errors
    try:
        response.raise_for_status()
        result = response.json()
        # Attach rate limit metadata when remaining is low (<100)
        if rate_limit_remaining and int(rate_limit_remaining) < 100:
            if isinstance(result, dict):
                result["_rate_limit"] = {
                    "remaining": int(rate_limit_remaining),
                    "limit": int(rate_limit_total) if rate_limit_total else None,
                }
        return result
    except httpx.HTTPStatusError as e:
        logger.error(f"GitHub API error: {str(e)}")
        try:
            error_data = response.json()
            return {
                "error": f"GitHub API error: {response.status_code}",
                "message": error_data.get("message", "Unknown error"),
                "documentation_url": error_data.get("documentation_url"),
            }
        except Exception:
            return {
                "error": f"GitHub API error: {response.status_code}",
                "message": str(e),
            }
    except Exception as e:
        logger.error(f"Request error: {str(e)}")
        return {"error": str(e)}


async def close_http_clients():
    """Close shared HTTP clients on shutdown."""
    global _github_http_client, _gitlab_http_client
    if _github_http_client is not None and not _github_http_client.is_closed:
        await _github_http_client.aclose()
        _github_http_client = None
    if _gitlab_http_client is not None and not _gitlab_http_client.is_closed:
        await _gitlab_http_client.aclose()
        _gitlab_http_client = None


def get_gitlab_headers():
    """Get GitLab API headers with authentication."""
    config = get_gitlab_config()
    return {
        "PRIVATE-TOKEN": f"{config.access_token.get_secret_value()}",
        "Content-Type": "application/json",
    }


async def _get_gitlab_client() -> httpx.AsyncClient:
    """Get or create the shared GitLab httpx client."""
    global _gitlab_http_client
    if _gitlab_http_client is None or _gitlab_http_client.is_closed:
        ssl_verify = get_ssl_verify_config()
        _gitlab_http_client = httpx.AsyncClient(
            verify=ssl_verify, timeout=_DEFAULT_TIMEOUT
        )
    return _gitlab_http_client


async def gitlab_request(method: str, url: str, **kwargs) -> Any:
    """Make a request to the GitLab API.

    Returns the parsed JSON response on success (may be a dict or list depending
    on the endpoint).  On error, always returns a dict with an "error" key.
    """
    config = get_gitlab_config()

    # Add base URL if URL doesn't start with http
    if not url.startswith("http"):
        url = f"{config.api_base}/{url.lstrip('/')}"

    # Add authentication headers
    headers = kwargs.pop("headers", {})
    headers.update(get_gitlab_headers())

    client = await _get_gitlab_client()
    response = await client.request(method, url, headers=headers, **kwargs)

    # Handle API rate limiting
    if response.status_code == 429:
        logger.warning("GitLab API rate limit exceeded")
        return {
            "error": "GitLab API rate limit exceeded",
            "retry_after": response.headers.get("Retry-After", "unknown"),
        }

    # Handle errors
    try:
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        logger.error(f"GitLab API error: {str(e)}")
        try:
            error_data = response.json()
            return {
                "error": (f"GitLab API error: {response.status_code}"),
                "message": error_data.get("message", "Unknown error"),
            }
        except Exception:
            return {
                "error": (f"GitLab API error: {response.status_code}"),
                "message": str(e),
            }
    except Exception as e:
        logger.error(f"Request error: {str(e)}")
        return {"error": str(e)}


def get_slack_config() -> Dict[str, Any]:
    """Get Slack API configuration from environment variables."""
    slack_bot_token = os.environ.get("SLACK_BOT_TOKEN")
    slack_team_id = os.environ.get("SLACK_TEAM_ID")

    if not slack_bot_token:
        logger.error("SLACK_BOT_TOKEN environment variable not set")
        raise ValueError(
            "Slack Bot Token not configured. Set SLACK_BOT_TOKEN environment variable."
        )

    if not slack_team_id:
        logger.error("SLACK_TEAM_ID environment variable not set")
        raise ValueError(
            "Slack Team ID not configured. Set SLACK_TEAM_ID environment variable."
        )

    return {
        "bot_token": slack_bot_token,
        "team_id": slack_team_id,
    }
