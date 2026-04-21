"""Slack API integration module for MCP server."""

import asyncio
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import aiohttp
import aiosqlite
from pydantic import BaseModel, Field, field_validator

from ..config import IsDebug

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("slack-api")


class UserProfileCache:
    """SQLite-backed cache for Slack user profiles."""

    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_path = str(Path.home() / ".slang-mcp" / "slack_user_cache.db")
        self.db_path = db_path
        self._db: Optional[aiosqlite.Connection] = None

    async def ensure_db(self) -> aiosqlite.Connection:
        """Create DB and table if they don't exist, return connection."""
        if self._db is not None:
            return self._db
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        await self._db.execute(
            """CREATE TABLE IF NOT EXISTS user_profiles (
                user_id TEXT PRIMARY KEY,
                display_name TEXT,
                real_name TEXT,
                email TEXT,
                raw_json TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        await self._db.commit()
        return self._db

    async def get(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Look up a cached profile by user_id."""
        db = await self.ensure_db()
        async with db.execute("SELECT raw_json FROM user_profiles WHERE user_id = ?", (user_id,)) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return json.loads(row[0])

    async def set(self, user_id: str, profile_data: Dict[str, Any]) -> None:
        """Upsert a user profile into the cache."""
        db = await self.ensure_db()
        profile = profile_data.get("profile", {})
        await db.execute(
            """INSERT INTO user_profiles (user_id, display_name, real_name, email, raw_json, updated_at)
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(user_id) DO UPDATE SET
                   display_name = excluded.display_name,
                   real_name = excluded.real_name,
                   email = excluded.email,
                   raw_json = excluded.raw_json,
                   updated_at = CURRENT_TIMESTAMP""",
            (
                user_id,
                profile.get("display_name", ""),
                profile.get("real_name", ""),
                profile.get("email", ""),
                json.dumps(profile_data),
            ),
        )
        await db.commit()

    async def close(self) -> None:
        """Close the DB connection."""
        if self._db is not None:
            await self._db.close()
            self._db = None


# Global cache instance
_user_profile_cache: Optional[UserProfileCache] = None


def _get_user_profile_cache() -> UserProfileCache:
    """Get or create the global user profile cache."""
    global _user_profile_cache
    if _user_profile_cache is None:
        _user_profile_cache = UserProfileCache()
    return _user_profile_cache


#
# Data Models
#
class ListChannelsArgs(BaseModel):
    """Arguments for the list_channels tool."""

    limit: Optional[int] = Field(100, description="Maximum number of channels to return (default 100, max 200)")
    cursor: Optional[str] = Field(None, description="Pagination cursor for next page of results")

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v):
        if v is None:
            return 100
        if v < 1:
            raise ValueError("Limit must be at least 1")
        if v > 200:
            raise ValueError("Limit cannot exceed 200")
        return v


class PostMessageArgs(BaseModel):
    """Arguments for the post_message tool."""

    channel_id: str = Field(..., description="The ID of the channel to post to")
    text: str = Field(..., description="The message text to post")


class ReplyToThreadArgs(BaseModel):
    """Arguments for the reply_to_thread tool."""

    channel_id: str = Field(..., description="The ID of the channel containing the thread")
    thread_ts: str = Field(..., description="The timestamp of the parent message")
    text: str = Field(..., description="The reply text")

    @field_validator("thread_ts")
    @classmethod
    def validate_thread_ts(cls, v):
        # If timestamp doesn't contain a dot, but is a number, insert a dot before the last 6 digits
        if "." not in v and v.isdigit() and len(v) > 6:
            v = v[:-6] + "." + v[-6:]
        return v


class AddReactionArgs(BaseModel):
    """Arguments for the add_reaction tool."""

    channel_id: str = Field(..., description="The ID of the channel containing the message")
    timestamp: str = Field(..., description="The timestamp of the message to react to")
    reaction: str = Field(..., description="The name of the emoji reaction (without ::)")

    @field_validator("timestamp")
    @classmethod
    def validate_timestamp(cls, v):
        # If timestamp doesn't contain a dot, but is a number, insert a dot before the last 6 digits
        if "." not in v and v.isdigit() and len(v) > 6:
            v = v[:-6] + "." + v[-6:]
        return v

    @field_validator("reaction")
    @classmethod
    def validate_reaction(cls, v):
        # Remove colons if present
        return v.replace(":", "")


class GetChannelHistoryArgs(BaseModel):
    """Arguments for the get_channel_history tool."""

    channel_id: str = Field(..., description="The ID of the channel")
    limit: Optional[int] = Field(10, description="Number of messages to retrieve (default 10)")
    since: Optional[str] = Field(
        None,
        description="Retrieve messages since this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')",
    )
    before: Optional[str] = Field(
        None,
        description="Retrieve messages before this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')",
    )

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v):
        if v is None:
            return 10
        if v < 1:
            raise ValueError("Limit must be at least 1")
        if v > 100:
            raise ValueError("Limit cannot exceed 100")
        return v

    @field_validator("since")
    @classmethod
    def validate_since(cls, v):
        if v is not None:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError("since must be a valid ISO 8601 timestamp")
        return v

    @field_validator("before")
    @classmethod
    def validate_before(cls, v):
        if v is not None:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError("before must be a valid ISO 8601 timestamp")
        return v


class GetThreadRepliesArgs(BaseModel):
    """Arguments for the get_thread_replies tool."""

    channel_id: str = Field(
        ...,
        description="The ID of the channel containing the thread",
    )
    thread_ts: str = Field(..., description="The timestamp of the parent message")

    @field_validator("thread_ts")
    @classmethod
    def validate_thread_ts(cls, v):
        if "." not in v and v.isdigit() and len(v) > 6:
            v = v[:-6] + "." + v[-6:]
        return v


class GetUsersArgs(BaseModel):
    """Arguments for the get_users tool."""

    cursor: Optional[str] = Field(
        None,
        description="Pagination cursor for next page of results",
    )
    limit: Optional[int] = Field(
        100,
        description="Max number of users to return (max 200)",
    )

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v):
        if v is None:
            return 100
        if v < 1:
            raise ValueError("Limit must be at least 1")
        if v > 200:
            raise ValueError("Limit cannot exceed 200")
        return v


class GetUserProfileArgs(BaseModel):
    """Arguments for the get_user_profile tool."""

    user_id: str = Field(..., description="The ID of the user")
    force_refresh: bool = Field(False, description="Bypass cache and fetch from Slack API")


class SearchMessagesArgs(BaseModel):
    """Arguments for the search_messages tool."""

    query: str = Field(
        ...,
        description=(
            "Slack search query string. Supports modifiers: "
            "from:<@UserID>, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD. "
            "If user_id, channel, since, or before are provided they are appended automatically."
        ),
    )
    user_id: Optional[str] = Field(
        None,
        description="Filter messages from this Slack user ID (e.g. 'U12345678'). Appended as from:<@user_id>.",
    )
    channel: Optional[str] = Field(
        None,
        description="Filter messages in this channel name or ID (e.g. 'general' or 'C0EXAMPLE'). Appended as in:<channel>.",
    )
    since: Optional[str] = Field(
        None,
        description="Return messages after this ISO 8601 date (e.g. '2026-02-01T00:00:00Z'). Appended as after:YYYY-MM-DD.",
    )
    before: Optional[str] = Field(
        None,
        description="Return messages before this ISO 8601 date (e.g. '2026-02-18T00:00:00Z'). Appended as before:YYYY-MM-DD.",
    )
    count: Optional[int] = Field(
        20,
        description="Maximum number of messages to return (default 20, max 100).",
    )

    @field_validator("count")
    @classmethod
    def validate_count(cls, v):
        if v is None:
            return 20
        if v < 1:
            raise ValueError("count must be at least 1")
        if v > 100:
            raise ValueError("count cannot exceed 100")
        return v


class SlackClient:
    """Client for interacting with the Slack API."""

    def __init__(self, bot_token: Optional[str] = None, team_id: Optional[str] = None):
        """Initialize the Slack client with token and team ID.

        Args:
            bot_token: Slack bot token (defaults to SLACK_BOT_TOKEN env var)
            team_id: Slack team ID (defaults to SLACK_TEAM_ID env var)
        """
        self.bot_token = bot_token or os.environ.get("SLACK_BOT_TOKEN")
        self.team_id = team_id or os.environ.get("SLACK_TEAM_ID")

        if not self.bot_token:
            raise ValueError("Slack bot token not provided or found in environment")

        if not self.team_id:
            raise ValueError("Slack team ID not provided or found in environment")

        self.session = None

    async def ensure_session(self):
        """Ensure that an aiohttp session exists."""
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {self.bot_token}",
                    "Content-Type": "application/json",
                }
            )
        return self.session

    async def close(self):
        """Close the aiohttp session."""
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None

    async def list_channels(self, args: ListChannelsArgs) -> Dict[str, Any]:
        """List channels in the workspace.

        Args:
            args: Arguments for listing channels

        Returns:
            Dict containing channels information or error
        """
        try:
            session = await self.ensure_session()

            # Build query parameters
            params = {
                "types": "public_channel",
                "exclude_archived": "true",
                "limit": str(args.limit),
                "team_id": self.team_id,
            }

            if args.cursor:
                params["cursor"] = args.cursor

            # Make API request
            url = "https://slack.com/api/conversations.list"
            logger.info(f"Fetching channels from {url} with params: {params}")

            async with session.get(url, params=params) as response:
                response_data = await response.json()

                # Log the response summary
                if "channels" in response_data:
                    logger.info(f"Fetched {len(response_data['channels'])} channels from Slack")
                else:
                    logger.warning(f"Failed to fetch channels: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in list_channels: {str(e)}")
            return {"error": str(e)}

    async def post_message(self, args: PostMessageArgs) -> Dict[str, Any]:
        """Post a message to a channel.

        Args:
            args: Arguments for posting a message

        Returns:
            Dict containing message information or error
        """
        try:
            session = await self.ensure_session()

            # Build message payload
            payload = {
                "channel": args.channel_id,
                "text": args.text,
            }

            # Make API request
            url = "https://slack.com/api/chat.postMessage"
            logger.info(f"Posting message to channel {args.channel_id}")

            async with session.post(url, json=payload) as response:
                response_data = await response.json()

                # Log the response summary
                if response_data.get("ok", False):
                    logger.info(f"Successfully posted message to channel {args.channel_id}")
                else:
                    logger.warning(f"Failed to post message: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in post_message: {str(e)}")
            return {"error": str(e)}

    async def reply_to_thread(self, args: ReplyToThreadArgs) -> Dict[str, Any]:
        """Reply to a thread in a channel.

        Args:
            args: Arguments for replying to a thread

        Returns:
            Dict containing reply information or error
        """
        try:
            session = await self.ensure_session()

            # Build message payload
            payload = {
                "channel": args.channel_id,
                "thread_ts": args.thread_ts,
                "text": args.text,
            }

            # Make API request
            url = "https://slack.com/api/chat.postMessage"
            logger.info(f"Replying to thread {args.thread_ts} in channel {args.channel_id}")

            async with session.post(url, json=payload) as response:
                response_data = await response.json()

                # Log the response summary
                if response_data.get("ok", False):
                    logger.info(f"Successfully replied to thread {args.thread_ts}")
                else:
                    logger.warning(f"Failed to reply to thread: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in reply_to_thread: {str(e)}")
            return {"error": str(e)}

    async def add_reaction(self, args: AddReactionArgs) -> Dict[str, Any]:
        """Add a reaction to a message.

        Args:
            args: Arguments for adding a reaction

        Returns:
            Dict containing reaction information or error
        """
        try:
            session = await self.ensure_session()

            # Build payload
            payload = {
                "channel": args.channel_id,
                "timestamp": args.timestamp,
                "name": args.reaction,
            }

            # Make API request
            url = "https://slack.com/api/reactions.add"
            logger.info(f"Adding reaction :{args.reaction}: to message {args.timestamp}")

            async with session.post(url, json=payload) as response:
                response_data = await response.json()

                # Log the response summary
                if response_data.get("ok", False):
                    logger.info(f"Successfully added reaction :{args.reaction}: to message")
                else:
                    logger.warning(f"Failed to add reaction: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in add_reaction: {str(e)}")
            return {"error": str(e)}

    async def get_channel_history(self, args: GetChannelHistoryArgs) -> Dict[str, Any]:
        """Get message history from a channel.

        Args:
            args: Arguments for getting channel history, including:
                - channel_id: The ID of the channel to retrieve messages from
                - limit: Maximum number of messages to retrieve (default 10)
                - since: If provided, retrieves messages since this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')
                - before: If provided, retrieves messages before this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')

        Returns:
            Dict containing message history or error
        """
        try:
            session = await self.ensure_session()

            # Build query parameters
            params = {
                "channel": args.channel_id,
            }

            # If since is provided, calculate oldest timestamp
            if args.since is not None:
                # Get timestamp from since
                oldest_date = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
                oldest_ts = oldest_date.timestamp()
                params["oldest"] = str(oldest_ts)
                # When using since, we'll handle pagination ourselves
                # so we set a higher per-request limit
                params["limit"] = "1000"  # Maximum allowed by Slack API
            else:
                # Otherwise use the standard limit
                params["limit"] = str(args.limit)

            # If before is provided, calculate latest timestamp
            if args.before is not None:
                # Get timestamp from before
                latest_date = datetime.fromisoformat(args.before.replace("Z", "+00:00"))
                latest_ts = latest_date.timestamp()
                params["latest"] = str(latest_ts)

            # Make API request
            url = "https://slack.com/api/conversations.history"
            logger.info(
                f"Fetching history for channel {args.channel_id}"
                + (f", since {args.since}" if args.since else f", limit {args.limit}")
            )

            # For time-range based retrieval, we need to handle pagination
            all_messages = []
            has_more = True
            next_cursor = None

            pagination_count = 0
            max_pagination = 5

            message_count = 0
            max_messages = 100
            max_replies = 100
            while has_more and pagination_count < max_pagination and message_count < max_messages:
                # Add cursor for pagination if we have one
                if next_cursor:
                    params["cursor"] = next_cursor

                async with session.get(url, params=params) as response:
                    response_data = await response.json()

                    if not response_data.get("ok", False):
                        error_msg = response_data.get("error", "Unknown error")
                        logger.warning(f"Failed to fetch channel history: {error_msg}")
                        return response_data

                    # Add messages to our collection
                    if "messages" in response_data:
                        messages = response_data["messages"]
                        remaining_count = max_messages - message_count
                        messages = messages[:remaining_count]  # Limit to remaining message quota
                        all_messages.extend(messages)
                        message_count += len(messages)
                        logger.info(
                            f"Fetched {len(messages)} messages from channel {args.channel_id} (total: {message_count})"
                        )

                        # Limit replies to max_replies for each message
                        for message in messages:
                            if "reply_count" in message and message.get("reply_count", 0) > max_replies:
                                message["reply_count"] = max_replies
                                if "reply_users_count" in message:
                                    message["reply_users_count"] = min(message["reply_users_count"], max_replies)

                    # Check for pagination
                    has_more = response_data.get("has_more", False)
                    if (
                        has_more
                        and "response_metadata" in response_data
                        and "next_cursor" in response_data["response_metadata"]
                    ):
                        next_cursor = response_data["response_metadata"]["next_cursor"]
                        # If cursor is empty but has_more is True, stop to avoid infinite loop
                        if not next_cursor:
                            logger.warning("Pagination cursor was empty despite has_more=True, stopping pagination")
                            has_more = False
                    else:
                        has_more = False

                # If we've reached max messages or not using since, stop pagination
                if message_count >= max_messages or args.since is None:
                    break

                # Increment pagination counter
                pagination_count += 1

                # Log pagination progress
                if has_more:
                    logger.info(
                        f"Continuing pagination ({pagination_count}"
                        f"/{max_pagination}), {len(all_messages)}"
                        " messages fetched so far"
                    )

            # Create a raw response similar to the API but with all messages
            raw_result = {
                "ok": True,
                "messages": all_messages,
                "has_more": has_more,
                "channel_id": args.channel_id,
            }

            # Helper function to filter a message
            def filter_message(message):
                # Check if message has GitHub links or appears to be about code issues
                github_links = []
                if "text" in message:
                    text = message.get("text", "")
                    # Extract GitHub links using simple pattern matching
                    github_pattern = r"https://github\.com/[^/\s]+/[^/\s]+/(?:issues|pull)/\d+"
                    github_links = re.findall(github_pattern, text)

                # Create filtered message with minimal needed fields
                filtered_message = {
                    "ts": message.get("ts"),
                    "text": message.get("text", ""),
                    "user": message.get("user"),
                    "has_thread": "thread_ts" in message or "reply_count" in message,
                    "has_github_links": len(github_links) > 0,
                    "github_links": github_links,
                }
                return filtered_message

            # Create a filtered response with essential information
            filtered_messages = []
            for message in all_messages:
                # Extract thread info if available
                has_thread = "thread_ts" in message or "reply_count" in message
                thread_info = None

                # If message has a thread, fetch the replies
                if has_thread:
                    thread_ts = message.get("thread_ts") or message.get("ts")

                    # Prepare thread info with metadata
                    thread_info = {
                        "thread_ts": thread_ts,
                        "reply_count": message.get("reply_count", 0),
                        "reply_users_count": message.get("reply_users_count", 0),
                    }

                    # Fetch thread replies if there are any
                    if message.get("reply_count", 0) > 0:
                        # Call conversations.replies API with retry logic
                        thread_params = {
                            "channel": args.channel_id,
                            "ts": thread_ts,
                        }

                        max_retries = 3
                        retry_count = 0
                        success = False

                        while retry_count <= max_retries and not success:
                            try:
                                thread_url = "https://slack.com/api/conversations.replies"
                                if retry_count == 0:
                                    logger.info(f"Fetching replies for thread {thread_ts} in channel {args.channel_id}")
                                else:
                                    logger.info(
                                        f"Retrying thread {thread_ts} (attempt {retry_count + 1}/{max_retries + 1})"
                                    )

                                # Add delay to avoid rate limiting
                                # (Slack allows ~1 req/sec for Tier 3)
                                # Use exponential backoff for retries
                                if retry_count == 0:
                                    await asyncio.sleep(1.2)
                                else:
                                    # Exponential backoff: 2, 4, 8 seconds
                                    await asyncio.sleep(2**retry_count)

                                async with session.get(thread_url, params=thread_params) as thread_response:
                                    thread_data = await thread_response.json()

                                    if thread_data.get("ok", False) and "messages" in thread_data:
                                        thread_messages = thread_data.get("messages", [])
                                        logger.info(f"Fetched {len(thread_messages)} replies from thread {thread_ts}")

                                        # Filter the thread replies, excluding the parent message
                                        filtered_replies = []
                                        for reply in thread_messages:
                                            # Skip the parent message (first message in the thread)
                                            if reply.get("ts") == thread_ts:
                                                continue
                                            filtered_replies.append(filter_message(reply))

                                        # Add filtered replies to thread_info
                                        thread_info["replies"] = filtered_replies
                                        success = True
                                    else:
                                        error = thread_data.get("error", "Unknown error")
                                        # Check if it's a rate limit error
                                        if error == "rate_limited":
                                            logger.warning(f"Rate limited while fetching thread {thread_ts}")
                                            retry_count += 1
                                            if retry_count > max_retries:
                                                logger.error(f"Max retries exceeded for thread {thread_ts}, skipping")
                                                thread_info["replies"] = []
                                                thread_info["error"] = error
                                        else:
                                            # Non-rate-limit error, don't retry
                                            logger.warning(f"Failed to fetch thread replies: {error}")
                                            thread_info["replies"] = []
                                            thread_info["error"] = error
                                            break
                            except Exception as e:
                                logger.error(f"Error fetching thread replies: {str(e)}")
                                thread_info["replies"] = []
                                thread_info["error"] = str(e)
                                break
                    else:
                        # No replies to fetch
                        thread_info["replies"] = []

                # Create filtered message
                filtered_message = filter_message(message)

                # Add thread_info if available
                if has_thread:
                    filtered_message["thread_info"] = thread_info

                filtered_messages.append(filtered_message)

            filtered_result = {
                "channel_id": args.channel_id,
                "messages": (filtered_messages[: args.limit] if args.since is None else filtered_messages),
                "total_count": len(filtered_messages),
                "time_range": f"since {args.since}" if args.since is not None else None,
            }

            logger.info(
                f"Successfully fetched {len(filtered_result['messages'])} messages total from channel {args.channel_id}"
            )

            # Return filtered data (raw only in debug mode to reduce response size)
            return {"filtered": filtered_result, "raw": raw_result if IsDebug() else None}

        except Exception as e:
            logger.error(f"Error in get_channel_history: {str(e)}")
            return {"error": str(e)}

    async def get_thread_replies(self, args: GetThreadRepliesArgs) -> Dict[str, Any]:
        """Get replies from a thread.

        Args:
            args: Arguments for getting thread replies

        Returns:
            Dict containing thread replies or error
        """
        try:
            session = await self.ensure_session()

            # Build query parameters
            params = {
                "channel": args.channel_id,
                "ts": args.thread_ts,
            }

            # Make API request
            url = "https://slack.com/api/conversations.replies"
            logger.info(f"Fetching replies for thread {args.thread_ts} in channel {args.channel_id}")

            async with session.get(url, params=params) as response:
                response_data = await response.json()

                # Log the response summary
                if "messages" in response_data:
                    logger.info(f"Fetched {len(response_data['messages'])} replies from thread {args.thread_ts}")
                else:
                    logger.warning(f"Failed to fetch thread replies: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in get_thread_replies: {str(e)}")
            return {"error": str(e)}

    async def get_users(self, args: GetUsersArgs) -> Dict[str, Any]:
        """Get users from the workspace.

        Args:
            args: Arguments for getting users

        Returns:
            Dict containing users information or error
        """
        try:
            session = await self.ensure_session()

            # Build query parameters
            params = {
                "limit": str(args.limit),
                "team_id": self.team_id,
            }

            if args.cursor:
                params["cursor"] = args.cursor

            # Make API request
            url = "https://slack.com/api/users.list"
            logger.info(f"Fetching users with params: {params}")

            async with session.get(url, params=params) as response:
                response_data = await response.json()

                # Log the response summary
                if "members" in response_data:
                    logger.info(f"Fetched {len(response_data['members'])} users from Slack")
                else:
                    logger.warning(f"Failed to fetch users: {response_data.get('error', 'Unknown error')}")

                return response_data
        except Exception as e:
            logger.error(f"Error in get_users: {str(e)}")
            return {"error": str(e)}

    async def search_messages(self, args: SearchMessagesArgs) -> Dict[str, Any]:
        """Search for messages across the workspace using Slack's search API.

        Uses the search.messages endpoint which performs server-side filtering.
        Requires a user token (SLACK_USER_TOKEN) with search:read scope — bot
        tokens cannot call this endpoint.

        Args:
            args: Search arguments including query, optional user_id/channel/since/before filters.

        Returns:
            Dict containing matched messages or error.
        """
        try:
            # search.messages requires a user token (xoxp-), not a bot token (xoxb-)
            user_token = os.environ.get("SLACK_USER_TOKEN")
            if not user_token:
                return {
                    "error": (
                        "search.messages requires a user token. "
                        "Set SLACK_USER_TOKEN environment variable with a token "
                        "that has the search:read scope. "
                        "Bot tokens (SLACK_BOT_TOKEN) cannot call this endpoint."
                    )
                }

            # Build the full query by appending convenience modifiers
            parts = [args.query.strip()] if args.query.strip() else []

            if args.user_id:
                parts.append(f"from:<@{args.user_id}>")

            if args.channel:
                # Slack search accepts channel names (general) or #channel-name.
                # Channel IDs (C.../CFFF...) don't work reliably in the in: modifier,
                # so we pass them through as-is and note this in the result.
                channel_val = args.channel.lstrip("#")
                parts.append(f"in:{channel_val}")

            if args.since:
                since_date = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
                parts.append(f"after:{since_date.strftime('%Y-%m-%d')}")

            if args.before:
                before_date = datetime.fromisoformat(args.before.replace("Z", "+00:00"))
                parts.append(f"before:{before_date.strftime('%Y-%m-%d')}")

            full_query = " ".join(parts)
            logger.info(f"Searching Slack messages with query: {full_query!r}")

            # Use a one-off session with the user token (separate from the bot token session)
            headers = {
                "Authorization": f"Bearer {user_token}",
                "Content-Type": "application/json",
            }

            all_matches = []
            page = 1
            count_per_page = min(args.count, 100)

            async with aiohttp.ClientSession(headers=headers) as search_session:
                while len(all_matches) < args.count:
                    params = {
                        "query": full_query,
                        "count": str(count_per_page),
                        "page": str(page),
                        "highlight": "false",
                        "sort": "timestamp",
                        "sort_dir": "desc",
                        "team_id": self.team_id,
                    }

                    url = "https://slack.com/api/search.messages"
                    async with search_session.get(url, params=params) as response:
                        data = await response.json()

                    if not data.get("ok", False):
                        error = data.get("error", "Unknown error")
                        logger.warning(f"search.messages failed: {error}")
                        if error == "not_authed" or error == "invalid_auth":
                            return {
                                "error": (
                                    f"Authentication failed ({error}). "
                                    "Ensure SLACK_USER_TOKEN is a valid user token (xoxp-...) "
                                    "with search:read scope."
                                )
                            }
                        return {"error": error, "query": full_query}

                    messages_block = data.get("messages", {})
                    matches = messages_block.get("matches", [])
                    paging = messages_block.get("paging", {})

                    all_matches.extend(matches)

                    total_pages = paging.get("pages", 1)
                    logger.info(
                        f"Page {page}/{total_pages}: got {len(matches)} matches "
                        f"(total so far: {len(all_matches)})"
                    )

                    if page >= total_pages or not matches:
                        break
                    page += 1

            # Trim to requested count and format output
            trimmed = all_matches[: args.count]
            formatted = []
            for m in trimmed:
                formatted.append(
                    {
                        "ts": m.get("ts"),
                        "text": m.get("text", ""),
                        "user": m.get("user"),
                        "username": m.get("username", ""),
                        "channel": {
                            "id": m.get("channel", {}).get("id"),
                            "name": m.get("channel", {}).get("name"),
                        },
                        "permalink": m.get("permalink"),
                    }
                )

            return {
                "ok": True,
                "query": full_query,
                "total_matches": len(all_matches),
                "returned": len(formatted),
                "messages": formatted,
                "note": (
                    "channel filter uses channel name, not ID — "
                    "if no results, try the channel name instead of ID"
                    if args.channel and args.channel[0].upper() in "BCDFGHJKLMNPQRSTVWXYZ"
                    else None
                ),
            }

        except Exception as e:
            logger.error(f"Error in search_messages: {str(e)}")
            return {"error": str(e)}

    async def get_user_profile(self, args: GetUserProfileArgs) -> Dict[str, Any]:
        """Get a user's profile information including display name and real name.

        Checks a local SQLite cache first. On cache miss (or force_refresh),
        calls the Slack API and stores the result.

        Args:
            args: Arguments for getting user profile containing user_id and optional force_refresh

        Returns:
            Dict containing user profile or error dict if the request fails
        """
        cache = _get_user_profile_cache()

        # Check cache first (unless force_refresh)
        if not args.force_refresh:
            try:
                cached = await cache.get(args.user_id)
                if cached is not None:
                    logger.info(f"Cache hit for user {args.user_id}")
                    return cached
            except Exception as e:
                logger.warning(f"Cache read failed for user {args.user_id}: {e}")

        # Cache miss or force_refresh — call Slack API with rate-limit retry
        max_retries = 3
        retry_count = 0

        while retry_count <= max_retries:
            try:
                session = await self.ensure_session()

                params = {
                    "user": args.user_id,
                    "include_labels": "true",
                }

                url = "https://slack.com/api/users.profile.get"
                if retry_count == 0:
                    logger.info(f"Fetching profile for user {args.user_id} from Slack API")
                else:
                    logger.info(
                        f"Retrying profile fetch for user {args.user_id} (attempt {retry_count + 1}/{max_retries + 1})"
                    )

                async with session.get(url, params=params) as response:
                    response_data = await response.json()

                    if "profile" in response_data:
                        profile = response_data["profile"]
                        logger.info(
                            f"Successfully fetched profile for user {args.user_id}: "
                            f"display_name='{profile.get('display_name')}', "
                            f"real_name='{profile.get('real_name')}'"
                        )
                        # Store in cache
                        try:
                            await cache.set(args.user_id, response_data)
                            logger.info(f"Cached profile for user {args.user_id}")
                        except Exception as e:
                            logger.warning(f"Cache write failed for user {args.user_id}: {e}")
                        return response_data

                    error = response_data.get("error", "Unknown error")
                    if error == "ratelimited":
                        retry_count += 1
                        if retry_count > max_retries:
                            logger.error(f"Max retries exceeded for user profile {args.user_id}")
                            return response_data
                        retry_after = int(response_data.get("retry_after", 2**retry_count))
                        logger.warning(f"Rate limited fetching profile for {args.user_id}, retrying in {retry_after}s")
                        await asyncio.sleep(retry_after)
                    else:
                        logger.warning(f"Failed to fetch user profile: {error}")
                        return response_data
            except Exception as e:
                logger.error(f"Error in get_user_profile: {str(e)}")
                return {"error": str(e)}

        return {"ok": False, "error": "max_retries_exceeded"}


# Initialize global client
slack_client = None


async def ensure_slack_client() -> SlackClient:
    """Ensure that a Slack client exists and is ready.

    Returns:
        The initialized Slack client
    """
    global slack_client

    if slack_client is None:
        slack_client = SlackClient()

    return slack_client


async def list_channels(args: ListChannelsArgs) -> Dict[str, Any]:
    """List channels in the workspace.

    Args:
        args: Arguments for listing channels

    Returns:
        Dict containing channels information or error
    """
    client = await ensure_slack_client()
    return await client.list_channels(args)


async def post_message(args: PostMessageArgs) -> Dict[str, Any]:
    """Post a message to a channel.

    Args:
        args: Arguments for posting a message

    Returns:
        Dict containing message information or error
    """
    client = await ensure_slack_client()
    return await client.post_message(args)


async def reply_to_thread(args: ReplyToThreadArgs) -> Dict[str, Any]:
    """Reply to a thread in a channel.

    Args:
        args: Arguments for replying to a thread

    Returns:
        Dict containing reply information or error
    """
    client = await ensure_slack_client()
    return await client.reply_to_thread(args)


async def add_reaction(args: AddReactionArgs) -> Dict[str, Any]:
    """Add a reaction to a message.

    Args:
        args: Arguments for adding a reaction

    Returns:
        Dict containing reaction information or error
    """
    client = await ensure_slack_client()
    return await client.add_reaction(args)


async def get_channel_history(args: GetChannelHistoryArgs) -> Dict[str, Any]:
    """Get message history from a channel.

    Args:
        args: Arguments for getting channel history, including:
            - channel_id: The ID of the channel to retrieve messages from
            - limit: Maximum number of messages to retrieve (default 10)
            - since: If provided, retrieves messages since this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')
            - before: If provided, retrieves messages before this ISO 8601 timestamp (e.g. '2023-04-01T00:00:00Z')

    Returns:
        Dict containing message history or error
    """
    client = await ensure_slack_client()
    return await client.get_channel_history(args)


async def get_thread_replies(args: GetThreadRepliesArgs) -> Dict[str, Any]:
    """Get replies from a thread.

    Args:
        args: Arguments for getting thread replies

    Returns:
        Dict containing thread replies or error
    """
    client = await ensure_slack_client()
    return await client.get_thread_replies(args)


async def get_users(args: GetUsersArgs) -> Dict[str, Any]:
    """Get users from the workspace.

    Args:
        args: Arguments for getting users

    Returns:
        Dict containing users information or error
    """
    client = await ensure_slack_client()
    return await client.get_users(args)


async def search_messages(args: SearchMessagesArgs) -> Dict[str, Any]:
    """Search for messages across the workspace using Slack's search API.

    Performs server-side filtering via search.messages. Requires SLACK_USER_TOKEN
    with search:read scope.

    Args:
        args: Search arguments including query and optional convenience filters.

    Returns:
        Dict containing matched messages or error.
    """
    client = await ensure_slack_client()
    return await client.search_messages(args)


async def get_user_profile(args: GetUserProfileArgs) -> Dict[str, Any]:
    """Get a user's profile information including display name and real name.

    This retrieves the user's Slack profile which includes their display_name,
    real_name, email, and other profile fields. Use this to get human-readable
    names for a user when you only have their user ID.

    Args:
        args: Arguments for getting user profile containing user_id

    Returns:
        Dict containing user profile with display_name and real_name, or error
    """
    client = await ensure_slack_client()
    return await client.get_user_profile(args)


async def cleanup_user_cache():
    """Close the user profile cache DB connection."""
    global _user_profile_cache
    if _user_profile_cache is not None:
        await _user_profile_cache.close()
        _user_profile_cache = None
        logger.info("User profile cache cleaned up")


# Cleanup function for server shutdown
async def cleanup_slack_client():
    """Clean up the Slack client and cache when the server is shutting down."""
    global slack_client

    await cleanup_user_cache()

    if slack_client is not None:
        await slack_client.close()
        slack_client = None
        logger.info("Slack client cleaned up")
