"""Tests for configuration module."""

import os
from unittest.mock import MagicMock, patch

import pytest

# Import config module
from src.config import (
    get_discord_config,
    get_github_config,
    get_github_headers,
    github_request,
    setup_environment,
)


@pytest.fixture
def mock_env_vars():
    """Mock environment variables."""
    # Store original values
    original_github = os.environ.get("GITHUB_ACCESS_TOKEN")
    original_discord = os.environ.get("DISCORD_BOT_TOKEN")

    # Mock dotenv.load_dotenv to prevent .env file from overriding our test values
    with patch("src.config.dotenv.load_dotenv"):
        # Set test environment variables
        os.environ["GITHUB_ACCESS_TOKEN"] = "github-test-token"
        os.environ["DISCORD_BOT_TOKEN"] = "discord-test-token"

        # Clear the cached configs so they reload with new env vars
        with (
            patch("src.config._GITHUB_CONFIG", None),
            patch("src.config._DISCORD_CONFIG", None),
            patch("src.config._GITLAB_CONFIG", None),
        ):
            yield

    # Restore original environment
    if original_github is not None:
        os.environ["GITHUB_ACCESS_TOKEN"] = original_github
    elif "GITHUB_ACCESS_TOKEN" in os.environ:
        del os.environ["GITHUB_ACCESS_TOKEN"]

    if original_discord is not None:
        os.environ["DISCORD_BOT_TOKEN"] = original_discord
    elif "DISCORD_BOT_TOKEN" in os.environ:
        del os.environ["DISCORD_BOT_TOKEN"]


@pytest.fixture
def mock_httpx_client():
    """Mock for httpx AsyncClient via _get_github_client."""
    mock_client = MagicMock()

    # Setup mock response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {"X-RateLimit-Remaining": "4999", "X-RateLimit-Limit": "5000"}
    mock_response.json.return_value = {"result": "success"}

    # Make the request method return an awaitable and track calls
    mock_client._call_count = 0
    mock_client._last_call_args = None
    mock_client._last_call_kwargs = None

    async def mock_request(*args, **kwargs):
        mock_client._call_count += 1
        mock_client._last_call_args = args
        mock_client._last_call_kwargs = kwargs
        mock_client.request.call_args = (args, kwargs)
        return mock_response

    mock_client.request = mock_request

    def assert_called_once():
        assert (
            mock_client._call_count == 1
        ), f"Expected 1 call, got {mock_client._call_count}"

    mock_client.request.assert_called_once = assert_called_once
    mock_client.request.call_args = None

    async def get_mock_client():
        return mock_client

    with patch("src.config._get_github_client", side_effect=get_mock_client):
        yield mock_client


def test_setup_environment(mock_env_vars):
    """Test setup_environment function."""
    # Call setup_environment
    config = setup_environment()

    # Check results
    assert "github" in config
    assert "discord" in config
    assert config["github"] is not None
    assert config["discord"] is not None

    # Check GitHub config
    github_config = config["github"]
    assert hasattr(github_config, "access_token")
    assert github_config.access_token.get_secret_value() == "github-test-token"

    # Check Discord config
    discord_config = config["discord"]
    assert hasattr(discord_config, "bot_token")
    assert discord_config.bot_token.get_secret_value() == "discord-test-token"


def test_get_github_config(mock_env_vars):
    """Test get_github_config function."""
    # Reset config state by patching the _GITHUB_CONFIG variable
    with patch("src.config._GITHUB_CONFIG", None):
        # Call get_github_config
        config = get_github_config()

        # Check results
        assert config is not None
        assert hasattr(config, "access_token")
        assert config.access_token.get_secret_value() == "github-test-token"


def test_get_discord_config(mock_env_vars):
    """Test get_discord_config function."""
    # Reset config state by patching the _DISCORD_CONFIG variable
    with patch("src.config._DISCORD_CONFIG", None):
        # Call get_discord_config
        config = get_discord_config()

        # Check results
        assert config is not None
        assert hasattr(config, "bot_token")
        assert config.bot_token.get_secret_value() == "discord-test-token"


def test_get_github_headers(mock_env_vars):
    """Test get_github_headers function."""
    # Call get_github_headers
    headers = get_github_headers()

    # Check results
    assert "Authorization" in headers
    assert "Accept" in headers
    assert "User-Agent" in headers
    assert headers["Authorization"] == "token github-test-token"
    assert headers["Accept"] == "application/vnd.github.v3+json"
    assert "Slang-MCP-Server" in headers["User-Agent"]


@pytest.mark.asyncio
async def test_github_request(mock_env_vars, mock_httpx_client):
    """Test github_request function."""
    # Call github_request
    result = await github_request("GET", "repos/test/repo/issues/1")

    # Check result
    assert result == {"result": "success"}

    # Verify client was used correctly
    mock_httpx_client.request.assert_called_once()
    call_args = mock_httpx_client.request.call_args
    assert call_args[0][0] == "GET"  # Method
    assert "https://api.github.com/repos/test/repo/issues/1" in call_args[0][1]  # URL
    assert "Authorization" in call_args[1]["headers"]
    assert "Accept" in call_args[1]["headers"]
    assert "User-Agent" in call_args[1]["headers"]


@pytest.mark.asyncio
async def test_github_request_error(mock_env_vars, mock_httpx_client):
    """Test github_request function with error response."""
    # Setup mock response with error
    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.raise_for_status.side_effect = Exception("Not found")
    mock_response.json.return_value = {"message": "Not found"}

    # Make the request method return an awaitable with error response
    async def mock_request_error(*args, **kwargs):
        return mock_response

    mock_httpx_client.request = mock_request_error

    # Call github_request
    result = await github_request("GET", "repos/test/repo/issues/999")

    # Check result contains error
    assert "error" in result


@pytest.mark.asyncio
async def test_github_request_rate_limit(mock_env_vars, mock_httpx_client):
    """Test github_request function with rate limit response."""
    # Setup mock response with rate limit
    mock_response = MagicMock()
    mock_response.status_code = 403
    mock_response.headers = {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1609459200",
    }

    # Make the request method return an awaitable with rate limit response
    async def mock_request_rate_limit(*args, **kwargs):
        return mock_response

    mock_httpx_client.request = mock_request_rate_limit

    # Call github_request
    result = await github_request("GET", "repos/test/repo/issues/1")

    # Check result contains rate limit error
    assert "error" in result
    assert "rate limit" in result["error"].lower()
