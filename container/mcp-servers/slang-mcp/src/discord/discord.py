"""Discord API integration module for MCP server."""
# pyright: reportOptionalMemberAccess=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportArgumentType=false, reportGeneralTypeIssues=false, reportPossiblyUnboundVariable=false

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

# Add dotenv import
from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator

import discord

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("discord-api")

# Discord client instance
client = None

# Initialize Discord bot with necessary intents
intents = discord.Intents.default()
intents.message_content = True
intents.members = True

from ..config import IsDebug  # noqa: E402


#
# Data Models
#
class SendMessageArgs(BaseModel):
    """Arguments for the send_message tool."""

    channel_id: str = Field(..., description="Discord channel ID")
    content: str = Field(..., description="Message content")


class ReadMessagesArgs(BaseModel):
    """Arguments for the read_messages tool."""

    channel_id: str = Field(..., description="Discord channel ID")
    limit: Optional[int] = Field(
        10, description="Number of messages to fetch (max 100)"
    )

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v):
        if v < 1:
            raise ValueError("Limit must be at least 1")
        if v > 100:
            raise ValueError("Limit cannot exceed 100")
        return v


class GetUserInfoArgs(BaseModel):
    """Arguments for the get_user_info tool."""

    user_id: str = Field(..., description="Discord user ID")


class ModerateMessageArgs(BaseModel):
    """Arguments for the moderate_message tool."""

    channel_id: str = Field(..., description="Channel ID containing the message")
    message_id: str = Field(..., description="ID of message to moderate")
    reason: str = Field(..., description="Reason for moderation")
    timeout_minutes: Optional[int] = Field(
        None, description="Optional timeout duration in minutes"
    )

    @field_validator("timeout_minutes")
    @classmethod
    def validate_timeout_minutes(cls, v):
        if v is not None:
            if v < 0:
                raise ValueError("Timeout minutes cannot be negative")
            if v > 40320:  # 4 weeks in minutes
                raise ValueError("Timeout cannot exceed 4 weeks (40320 minutes)")
        return v


class GetServerInfoArgs(BaseModel):
    """Arguments for the get_server_info tool."""

    server_id: str = Field(..., description="Discord server (guild) ID")


class ListMembersArgs(BaseModel):
    """Arguments for the list_members tool."""

    server_id: str = Field(..., description="Discord server (guild) ID")
    limit: Optional[int] = Field(100, description="Maximum number of members to fetch")

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v):
        if v < 1:
            raise ValueError("Limit must be at least 1")
        if v > 1000:
            raise ValueError("Limit cannot exceed 1000")
        return v


class AddRoleArgs(BaseModel):
    """Arguments for the add_role tool."""

    server_id: str = Field(..., description="Discord server (guild) ID")
    user_id: str = Field(..., description="User ID to add role to")
    role_id: str = Field(..., description="Role ID to add")
    reason: Optional[str] = Field(None, description="Reason for adding the role")


class RemoveRoleArgs(BaseModel):
    """Arguments for the remove_role tool."""

    server_id: str = Field(..., description="Discord server (guild) ID")
    user_id: str = Field(..., description="User ID to remove role from")
    role_id: str = Field(..., description="Role ID to remove")
    reason: Optional[str] = Field(None, description="Reason for removing the role")


class CreateChannelArgs(BaseModel):
    """Arguments for the create_channel tool."""

    server_id: str = Field(..., description="Discord server (guild) ID")
    name: str = Field(..., description="Channel name")
    type: str = Field("text", description="Channel type ('text', 'voice', 'category')")
    topic: Optional[str] = Field(None, description="Channel topic (for text channels)")
    parent_id: Optional[str] = Field(
        None, description="Category ID to place channel under"
    )

    @field_validator("type")
    @classmethod
    def validate_type(cls, v):
        if v not in ["text", "voice", "category"]:
            raise ValueError("Channel type must be one of: 'text', 'voice', 'category'")
        return v

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        if len(v) < 1 or len(v) > 100:
            raise ValueError("Channel name must be between 1 and 100 characters")
        return v


async def init_discord_client():
    """Initialize Discord client and connect to Discord API.

    This is called when the server starts to establish a connection to Discord.

    Returns:
        The initialized Discord client

    Raises:
        ValueError: If DISCORD_BOT_TOKEN is not set
        TimeoutError: If client initialization times out
        Exception: For other initialization errors
    """
    global client

    # Handle closed event loops by creating a new one if needed
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            logger.info("Event loop was closed, creating a new one")
            asyncio.set_event_loop(asyncio.new_event_loop())
    except RuntimeError:
        logger.info("No event loop found, creating a new one")
        asyncio.set_event_loop(asyncio.new_event_loop())

    # If client exists but is closed, clean it up first
    if client and (hasattr(client, "is_closed") and client.is_closed()):
        logger.info("Cleaning up closed Discord client before creating a new one")
        client = None

    # If client is already initialized and connected, return it
    if client and hasattr(client, "is_ready") and client.is_ready():
        return client

    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not token:
        logger.error("DISCORD_BOT_TOKEN not found in environment variables")
        raise ValueError("DISCORD_BOT_TOKEN not set")

    # Create a new client with intents
    client = discord.Client(intents=intents)

    # Set up the on_ready event before starting
    ready_event = asyncio.Event()

    @client.event
    async def on_ready():
        logger.info(f"Discord client initialized as {client.user}")
        ready_event.set()

    # Start the client
    try:
        # Create a task to run the client
        connect_task = asyncio.create_task(client.start(token))

        # Wait for the client to be ready
        await asyncio.wait_for(ready_event.wait(), timeout=30)

        logger.info("Discord client connected and ready")
        return client
    except asyncio.TimeoutError:
        logger.error("Timed out waiting for Discord client to be ready")
        if "connect_task" in locals() and not connect_task.done():
            connect_task.cancel()
            try:
                await connect_task
            except asyncio.CancelledError:
                pass
        if client:
            await cleanup_discord_client()
        raise TimeoutError("Discord client initialization timed out")
    except Exception as e:
        logger.error(f"Error initializing Discord client: {str(e)}")
        if "connect_task" in locals() and not connect_task.done():
            connect_task.cancel()
            try:
                await connect_task
            except asyncio.CancelledError:
                pass
        if client:
            await cleanup_discord_client()
        raise e


async def cleanup_discord_client():
    """Clean up Discord client when server is shutting down.

    This function ensures the Discord client is properly closed and cleaned up
    to prevent connection leaks or hanging connections.
    """
    global client

    if client:
        try:
            logger.info("Closing Discord client connection...")
            # Check if the client has is_closed method and is not already closed
            if hasattr(client, "is_closed") and not client.is_closed():
                # Check if event loop is still open
                try:
                    loop = asyncio.get_event_loop()
                    if not loop.is_closed():
                        # Close the client gracefully
                        await client.close()
                        # Give it a moment to clean up
                        await asyncio.sleep(0.1)
                    else:
                        # If loop is already closed, we can't properly close
                        logger.warning(
                            "Event loop already closed during client cleanup"
                        )
                except RuntimeError:
                    logger.warning("No event loop found during client cleanup")
            else:
                logger.info("Discord client was already closed")

            # Set global client to None regardless
            client = None
            logger.info("Discord client disconnected successfully")
        except Exception as e:
            logger.error(f"Error during Discord client cleanup: {str(e)}")
            # Force client to None even if cleanup fails
            client = None


async def send_message(args: SendMessageArgs) -> Dict[str, Any]:
    """Send a message to a Discord channel.

    Args:
        args: Arguments for sending a message

    Returns:
        Dict containing message information or error
    """
    global client

    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert channel_id to int
        channel_id = int(args.channel_id)

        # Get the channel
        channel = client.get_channel(channel_id)
        if not channel:
            try:
                channel = await client.fetch_channel(channel_id)
            except discord.NotFound:
                return {"error": f"Channel with ID {channel_id} not found"}
            except discord.Forbidden:
                return {
                    "error": f"Not authorized to access channel with ID {channel_id}"
                }

        # Send the message
        message = await channel.send(args.content)

        # Return message data
        return {
            "message_id": str(message.id),
            "channel_id": str(message.channel.id),
            "content": message.content,
            "timestamp": message.created_at.isoformat(),
            "url": message.jump_url,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in send_message: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in send_message: {str(e)}")
        return {"error": str(e)}


def filter_message_data(message) -> dict:
    """Filter Discord message data to include only essential fields.

    Args:
        message: Raw Discord message data

    Returns:
        Filtered message data with only essential fields

    The filtering strategy:
    1. Keeps minimal core message data (content, timestamp, author name/display)
    2. Conditionally includes optional data (attachments, embeds, mentions) only if present
    3. Removes rarely used fields and identifiers
    """
    # Core message data that's always included
    filtered = {
        "content": message.content,
        "timestamp": message.created_at.isoformat(),
        "author": {
            "name": message.author.name,
            "display_name": message.author.display_name,
            "bot": message.author.bot,
        },
    }

    # Only include attachments if present and not empty
    if message.attachments:
        filtered["attachments"] = [
            {
                "filename": attachment.filename,
                "url": attachment.url,
                "content_type": attachment.content_type,
            }
            for attachment in message.attachments
        ]

    # Only include embeds if present and not empty
    if message.embeds:
        filtered["embeds"] = []
        for embed in message.embeds:
            embed_dict = embed.to_dict()
            filtered_embed = {}

            # Only keep specific embed fields
            if "provider" in embed_dict:
                filtered_embed["provider"] = embed_dict["provider"]
            if "description" in embed_dict:
                filtered_embed["description"] = embed_dict["description"]
            if "url" in embed_dict:
                filtered_embed["url"] = embed_dict["url"]
            if "title" in embed_dict:
                filtered_embed["title"] = embed_dict["title"]

            if filtered_embed:  # Only add if we have any data
                filtered["embeds"].append(filtered_embed)

    # Only include mentions if present and not empty
    if message.mentions:
        filtered["mentions"] = [
            user.name for user in message.mentions
        ]  # Using names instead of IDs

    return filtered


async def read_messages(args: ReadMessagesArgs) -> Dict[str, Any]:
    """Read messages from a Discord channel.

    Args:
        args: Arguments for reading messages

    Returns:
        Dict containing messages or error
    """
    global client

    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert channel_id to int
        channel_id = int(args.channel_id)

        # Get the channel
        channel = client.get_channel(channel_id)
        if not channel:
            try:
                channel = await client.fetch_channel(channel_id)
            except discord.NotFound:
                return {"error": f"Channel with ID {channel_id} not found"}
            except discord.Forbidden:
                return {
                    "error": f"Not authorized to access channel with ID {channel_id}"
                }

        # Fetch messages
        raw_messages = []
        if isinstance(channel, discord.TextChannel):
            async for message in channel.history(limit=args.limit):
                raw_messages.append(message)
        elif isinstance(channel, discord.ForumChannel):
            # Create timezone-aware datetime in UTC
            now = datetime.now(timezone.utc)
            cutoff_time = now - timedelta(hours=48)
            # Sort threads by last message time and take only first 5
            sorted_threads = sorted(
                channel.threads,
                key=lambda thread: thread.last_message.created_at
                if thread.last_message
                else thread.created_at,
                reverse=True,
            )[:5]

            for thread in sorted_threads:
                async for message in thread.history(limit=args.limit):
                    # Now both datetimes are timezone-aware
                    if message.created_at >= cutoff_time:
                        raw_messages.append(message)
        else:
            raise ValueError("Unsupported channel type")

        # Filter messages
        filtered_messages = [filter_message_data(message) for message in raw_messages]

        # Return filtered response with optional raw data
        response = {
            "filtered": {
                "channel_id": str(channel_id),
                "channel_name": channel.name,
                "messages": filtered_messages,
                "total_count": len(filtered_messages),
            },
            "raw": raw_messages if IsDebug() else None,
        }

        return response

    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in read_messages: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in read_messages: {str(e)}")
        return {"error": str(e)}


async def ensure_client_connected():
    """Ensure that the Discord client is initialized and connected.

    This helper function checks if the client needs to be initialized or
    reconnected, and handles that process. It includes additional checks
    for event loop state and client health.

    Returns:
        The connected Discord client

    Raises:
        Exception: If client initialization fails
    """
    global client

    try:
        # First check if we have a valid event loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_closed():
                logger.info("Event loop was closed, creating new one")
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
        except RuntimeError:
            logger.info("No event loop found, creating new one")
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        # Now check client state
        if client:
            # Check if client is closed or not properly initialized
            if hasattr(client, "is_closed") and client.is_closed():
                logger.info("Discord client is closed, will reinitialize")
                await cleanup_discord_client()
            elif hasattr(client, "is_ready") and not client.is_ready():
                logger.info("Discord client not ready, will reinitialize")
                await cleanup_discord_client()
            else:
                try:
                    # Try a simple operation to verify client health
                    # Use wait_for to prevent hanging
                    await asyncio.wait_for(
                        client.fetch_user(client.user.id), timeout=5.0
                    )
                    logger.debug("Discord client verified as healthy")
                    return client
                except asyncio.TimeoutError:
                    logger.warning("Client health check timed out, will reinitialize")
                    await cleanup_discord_client()
                except Exception as e:
                    logger.warning(
                        f"Client health check failed: {str(e)}, will reinitialize"
                    )
                    await cleanup_discord_client()

        # Initialize new client if needed
        if not client:
            logger.info("Discord client not initialized or closed, initializing...")
            await init_discord_client()

        return client

    except Exception as e:
        logger.error(f"Error in ensure_client_connected: {str(e)}")
        # Clean up if something went wrong
        if client:
            await cleanup_discord_client()
        raise


async def get_user_info(args: GetUserInfoArgs) -> Dict[str, Any]:
    """Get information about a Discord user.

    Args:
        args: Arguments for getting user info

    Returns:
        Dict containing user information or error
    """
    global client

    try:
        # Ensure client is connected
        client = await ensure_client_connected()

        # Convert user_id to int
        user_id = int(args.user_id)

        # Get the user
        user = client.get_user(user_id)
        if not user:
            try:
                user = await client.fetch_user(user_id)
            except discord.NotFound:
                return {"error": f"User with ID {user_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access user with ID {user_id}"}

        # Safely handle avatar URLs
        avatar_url = None
        if user.avatar:
            avatar_url = str(
                user.avatar.url if hasattr(user.avatar, "url") else user.avatar
            )

        # Safely handle banner URLs
        banner_url = None
        if hasattr(user, "banner") and user.banner:
            banner_url = str(
                user.banner.url if hasattr(user.banner, "url") else user.banner
            )

        # Return user data
        return {
            "id": str(user.id),
            "name": user.name,
            "display_name": user.display_name,
            "discriminator": (
                user.discriminator if hasattr(user, "discriminator") else None
            ),
            "bot": user.bot,
            "created_at": user.created_at.isoformat(),
            "avatar_url": avatar_url,
            "banner_url": banner_url,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in get_user_info: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in get_user_info: {str(e)}")
        return {"error": str(e)}


async def moderate_message(args: ModerateMessageArgs) -> Dict[str, Any]:
    """Moderate a message in a Discord channel.

    Args:
        args: Arguments for moderating a message

    Returns:
        Dict containing result or error
    """
    global client

    try:
        # Ensure client is connected
        client = await ensure_client_connected()

        # Convert IDs to int
        channel_id = int(args.channel_id)
        message_id = int(args.message_id)

        # Get the channel
        channel = client.get_channel(channel_id)
        if not channel:
            try:
                channel = await client.fetch_channel(channel_id)
            except discord.NotFound:
                return {"error": f"Channel with ID {channel_id} not found"}
            except discord.Forbidden:
                return {
                    "error": f"Not authorized to access channel with ID {channel_id}"
                }

        # Get the message
        try:
            message = await channel.fetch_message(message_id)
        except discord.NotFound:
            return {"error": f"Message with ID {message_id} not found"}
        except discord.Forbidden:
            return {"error": f"Not authorized to access message with ID {message_id}"}

        # Delete the message
        await message.delete(reason=args.reason)

        # If timeout specified, timeout the user
        timeout_result = None
        if args.timeout_minutes is not None and isinstance(
            channel.guild, discord.Guild
        ):
            member = channel.guild.get_member(message.author.id)
            if member:
                timeout_duration = timedelta(minutes=args.timeout_minutes)
                try:
                    # Try newer Discord.py method first
                    await member.timeout(timeout_duration, reason=args.reason)
                except AttributeError:
                    # Fall back to older method if available
                    if hasattr(member, "timeout_for"):
                        await member.timeout_for(timeout_duration, reason=args.reason)
                    else:
                        # If both methods fail, return a warning but continue
                        logger.warning(
                            f"Could not timeout user {member.id} - method not available"
                        )

                timeout_result = {
                    "user_id": str(member.id),
                    "timeout_minutes": args.timeout_minutes,
                    "expires_at": (datetime.now() + timeout_duration).isoformat(),
                }

        # Return result
        return {
            "success": True,
            "moderated_message": {
                "id": str(message.id),
                "channel_id": str(channel.id),
                "author_id": str(message.author.id),
                "content": message.content,  # Include for audit purposes
            },
            "reason": args.reason,
            "timeout": timeout_result,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in moderate_message: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in moderate_message: {str(e)}")
        return {"error": str(e)}


async def get_server_info(args: GetServerInfoArgs) -> Dict[str, Any]:
    """Get information about a Discord server.

    Args:
        args: Arguments for getting server info

    Returns:
        Dict containing server information or error
    """
    global client

    try:
        # Ensure client is connected
        client = await ensure_client_connected()

        # Convert server_id to int
        server_id = int(args.server_id)

        # Get the server
        guild = client.get_guild(server_id)
        if not guild:
            try:
                guild = await client.fetch_guild(server_id)
            except discord.NotFound:
                return {"error": f"Server with ID {server_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access server with ID {server_id}"}

        # Get role information
        roles = []
        for role in guild.roles:
            roles.append(
                {
                    "id": str(role.id),
                    "name": role.name,
                    "color": role.color.value,
                    "position": role.position,
                    "permissions": str(role.permissions.value),
                    "mentionable": role.mentionable,
                    "hoist": role.hoist,  # Shows members separately in the member list
                }
            )

        # Get channel information
        channels = []
        for channel in guild.channels:
            channel_info = {
                "id": str(channel.id),
                "name": channel.name,
                "type": str(channel.type),
                "position": channel.position,
            }

            # Add category info if applicable
            if hasattr(channel, "category") and channel.category:
                channel_info["category"] = {
                    "id": str(channel.category.id),
                    "name": channel.category.name,
                }

            # Add text channel specific info
            if isinstance(channel, discord.TextChannel):
                channel_info["topic"] = channel.topic
                channel_info["slowmode_delay"] = channel.slowmode_delay
                channel_info["nsfw"] = channel.is_nsfw()

            # Add voice channel specific info
            if isinstance(channel, discord.VoiceChannel):
                channel_info["bitrate"] = channel.bitrate
                channel_info["user_limit"] = channel.user_limit

            channels.append(channel_info)

        # Safely handle icon URL
        icon_url = None
        if guild.icon:
            icon_url = str(guild.icon.url if hasattr(guild.icon, "url") else guild.icon)

        # Safely handle banner URL
        banner_url = None
        if hasattr(guild, "banner") and guild.banner:
            banner_url = str(
                guild.banner.url if hasattr(guild.banner, "url") else guild.banner
            )

        # Return server data
        return {
            "id": str(guild.id),
            "name": guild.name,
            "description": guild.description,
            "owner_id": str(guild.owner_id),
            "icon_url": icon_url,
            "banner_url": banner_url,
            "member_count": guild.member_count,
            "created_at": guild.created_at.isoformat(),
            "premium_tier": guild.premium_tier,
            "premium_subscription_count": guild.premium_subscription_count,
            "roles": roles,
            "channels": channels,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in get_server_info: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in get_server_info: {str(e)}")
        return {"error": str(e)}


async def list_members(args: ListMembersArgs) -> Dict[str, Any]:
    """List members in a Discord server.

    Args:
        args: Arguments for listing members

    Returns:
        Dict containing members or error
    """
    global client

    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert server_id to int
        server_id = int(args.server_id)

        # Get the server
        guild = client.get_guild(server_id)
        if not guild:
            try:
                guild = await client.fetch_guild(server_id)
            except discord.NotFound:
                return {"error": f"Server with ID {server_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access server with ID {server_id}"}

        logger.info(f"Retrieving members for guild: {guild.name} (ID: {guild.id})")

        # Ensure members are loaded - handle different Discord.py versions
        try:
            if not guild.chunked:
                await guild.chunk()
        except AttributeError:
            # If chunked property or chunk method isn't available, continue anyway
            logger.warning(f"Could not chunk guild {server_id} - method not available")

        # Get members
        members = []
        member_list = list(guild.members)[: args.limit]
        logger.info(f"Found {len(member_list)} members in guild {guild.id}")

        for member in member_list:
            try:
                # Get roles
                roles = [
                    {
                        "id": str(role.id),
                        "name": role.name,
                        "color": role.color.value,
                        "position": role.position,
                    }
                    for role in member.roles
                    if role.id != guild.id  # Exclude @everyone
                ]

                # Safely handle avatar URL
                avatar_url = None
                if hasattr(member, "avatar") and member.avatar:
                    avatar_url = str(
                        member.avatar.url
                        if hasattr(member.avatar, "url")
                        else member.avatar
                    )

                # Safely handle timeout property which might have different names
                timeout_until = None
                # Modern Discord.py uses communication_disabled_until as a property
                if (
                    hasattr(member, "communication_disabled_until")
                    and member.communication_disabled_until
                ):
                    timeout_until = member.communication_disabled_until.isoformat()
                # Some versions use timeout as a property (check if it's not a method)
                elif (
                    hasattr(member, "timeout")
                    and member.timeout
                    and not callable(member.timeout)
                ):
                    timeout_until = member.timeout.isoformat()
                # No need to call timeout() as it's a setter method, not a getter

                # Add member data
                member_data = {
                    "id": str(member.id),
                    "name": member.name,
                    "display_name": member.display_name,
                    "discriminator": (
                        member.discriminator
                        if hasattr(member, "discriminator")
                        else None
                    ),
                    "bot": member.bot,
                    "avatar_url": avatar_url,
                    "roles": roles,
                    "status": (
                        str(member.status) if hasattr(member, "status") else "unknown"
                    ),
                    "timeout_until": timeout_until,
                }

                # Safely add joined_at
                if hasattr(member, "joined_at") and member.joined_at:
                    member_data["joined_at"] = member.joined_at.isoformat()
                else:
                    member_data["joined_at"] = None

                # Safely add premium_since
                if hasattr(member, "premium_since") and member.premium_since:
                    member_data["premium_since"] = member.premium_since.isoformat()
                else:
                    member_data["premium_since"] = None

                members.append(member_data)

            except Exception as member_error:
                logger.error(
                    f"Error processing member {getattr(member, 'id', 'unknown')}: {str(member_error)}"
                )
                # Continue with next member instead of failing completely
                continue

        # Return members
        logger.info(
            f"Successfully processed {len(members)} members for guild {guild.id}"
        )
        return {
            "server_id": str(server_id),
            "server_name": guild.name,
            "members": members,
            "member_count": len(members),
            "total_member_count": guild.member_count,
        }
    except Exception as e:
        logger.error(f"Error in list_members: {str(e)}")
        return {"error": str(e)}


async def add_role(args: AddRoleArgs) -> Dict[str, Any]:
    """Add a role to a user in a Discord server.

    Args:
        args: Arguments for adding a role

    Returns:
        Dict containing success status and user/role details, or error message
    """
    global client
    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert IDs to integers
        server_id = int(args.server_id)
        user_id = int(args.user_id)
        role_id = int(args.role_id)

        # Get the server
        guild = client.get_guild(server_id)
        if not guild:
            try:
                guild = await client.fetch_guild(server_id)
            except discord.NotFound:
                return {"error": f"Server with ID {server_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access server with ID {server_id}"}

        # Get the member
        member = guild.get_member(user_id)
        if not member:
            try:
                member = await guild.fetch_member(user_id)
            except discord.NotFound:
                return {"error": f"Member with ID {user_id} not found in server"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access member with ID {user_id}"}

        # Get the role
        role = guild.get_role(role_id)
        if not role:
            return {"error": f"Role with ID {role_id} not found in server"}

        # Add the role
        await member.add_roles(role, reason=args.reason)

        # Return result
        return {
            "success": True,
            "user": {
                "id": str(member.id),
                "name": member.name,
                "display_name": member.display_name,
            },
            "role": {
                "id": str(role.id),
                "name": role.name,
            },
            "server_id": str(guild.id),
            "reason": args.reason,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in add_role: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in add_role: {str(e)}")
        return {"error": str(e)}


async def remove_role(args: RemoveRoleArgs) -> Dict[str, Any]:
    """Remove a role from a user in a Discord server.

    Args:
        args: Arguments for removing a role

    Returns:
        Dict containing success status and user/role details, or error message
    """
    global client

    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert IDs to int
        server_id = int(args.server_id)
        user_id = int(args.user_id)
        role_id = int(args.role_id)

        # Get the server
        guild = client.get_guild(server_id)
        if not guild:
            try:
                guild = await client.fetch_guild(server_id)
            except discord.NotFound:
                return {"error": f"Server with ID {server_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access server with ID {server_id}"}

        # Get the member
        member = guild.get_member(user_id)
        if not member:
            try:
                member = await guild.fetch_member(user_id)
            except discord.NotFound:
                return {"error": f"Member with ID {user_id} not found in server"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access member with ID {user_id}"}

        # Get the role
        role = guild.get_role(role_id)
        if not role:
            return {"error": f"Role with ID {role_id} not found in server"}

        # Check if member has the role
        if role not in member.roles:
            return {"error": f"Member does not have the role with ID {role_id}"}

        # Remove the role
        await member.remove_roles(role, reason=args.reason)

        # Return result
        return {
            "success": True,
            "user": {
                "id": str(member.id),
                "name": member.name,
                "display_name": member.display_name,
            },
            "role": {
                "id": str(role.id),
                "name": role.name,
            },
            "server_id": str(guild.id),
            "reason": args.reason,
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in remove_role: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in remove_role: {str(e)}")
        return {"error": str(e)}


async def create_channel(args: CreateChannelArgs) -> Dict[str, Any]:
    """Create a channel in a Discord server.

    Args:
        args: Arguments for creating a channel

    Returns:
        Dict containing success status and channel details, or error message
    """
    global client

    try:
        # Ensure the client is connected
        await ensure_client_connected()

        # Convert server_id to int
        server_id = int(args.server_id)

        # Get the server
        guild = client.get_guild(server_id)
        if not guild:
            try:
                guild = await client.fetch_guild(server_id)
            except discord.NotFound:
                return {"error": f"Server with ID {server_id} not found"}
            except discord.Forbidden:
                return {"error": f"Not authorized to access server with ID {server_id}"}

        # Get parent category if specified
        parent = None
        if args.parent_id:
            parent_id = int(args.parent_id)
            parent = guild.get_channel(parent_id)
            if not parent or not isinstance(parent, discord.CategoryChannel):
                return {"error": f"Parent category with ID {parent_id} not found"}

        # Create channel params based on type
        kwargs = {"name": args.name}
        if args.type == "text" and args.topic:
            kwargs["topic"] = args.topic
        if parent:
            kwargs["category"] = parent

        # Create the channel
        if args.type == "text":
            channel = await guild.create_text_channel(**kwargs)
        elif args.type == "voice":
            channel = await guild.create_voice_channel(**kwargs)
        elif args.type == "category":
            channel = await guild.create_category(**kwargs)
        else:
            return {"error": f"Invalid channel type: {args.type}"}

        # Return result
        return {
            "success": True,
            "channel": {
                "id": str(channel.id),
                "name": channel.name,
                "type": args.type,
                "position": channel.position,
                "parent_id": str(channel.category.id) if channel.category else None,
                "topic": channel.topic if hasattr(channel, "topic") else None,
            },
            "server_id": str(guild.id),
        }
    except asyncio.CancelledError:
        logger.error("Discord operation was cancelled")
        return {"error": "Operation cancelled"}
    except RuntimeError as e:
        if "Event loop is closed" in str(e):
            logger.error("Event loop was closed, please retry the operation")
            # Reset the client so it will be reinitialized on the next call
            if client:
                await cleanup_discord_client()
            return {"error": "Discord connection was closed, please retry"}
        logger.error(f"Runtime error in create_channel: {str(e)}")
        return {"error": str(e)}
    except Exception as e:
        logger.error(f"Error in create_channel: {str(e)}")
        return {"error": str(e)}
