"""Common test fixtures for pytest."""

import os
import sys
from pathlib import Path

import pytest

# Add the parent directory to sys.path to make imports work
parent_dir = str(Path(__file__).parent.parent)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)


@pytest.fixture(autouse=True)
def set_test_env():
    """Set test environment variables."""
    # Save original environment
    original_env = os.environ.copy()

    # Set test environment variables if not already set
    if "GITHUB_ACCESS_TOKEN" not in os.environ:
        os.environ["GITHUB_ACCESS_TOKEN"] = "test-github-token"
    if "DISCORD_BOT_TOKEN" not in os.environ:
        os.environ["DISCORD_BOT_TOKEN"] = "test-discord-token"

    yield

    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)


def pytest_collection_modifyitems(config, items):
    """Skip integration tests unless explicitly enabled."""
    run_integration = os.environ.get("RUN_INTEGRATION_TESTS", "").lower() == "true"
    if run_integration:
        return

    skip_integration = pytest.mark.skip(
        reason="set RUN_INTEGRATION_TESTS=true to run integration tests"
    )
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_integration)
