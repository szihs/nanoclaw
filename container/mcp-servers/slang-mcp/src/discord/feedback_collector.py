"""Standalone Discord button interaction listener.

Run as a separate process alongside the MCP server.
Handles feedback button clicks (Resolved/Helpful/Not Helpful)
and writes results to DISCORD_FEEDBACK_DIR/feedback.jsonl.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import discord

logging.basicConfig(level=logging.INFO, format="[button-listener] %(message)s")
logger = logging.getLogger(__name__)

FEEDBACK_DIR = os.environ.get("DISCORD_FEEDBACK_DIR", "/tmp/discord-feedback")


class FeedbackView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    async def _check_op(self, interaction):
        """Only the thread owner (OP) can click feedback buttons."""
        channel = interaction.channel
        if isinstance(channel, discord.Thread) and channel.owner_id:
            if interaction.user.id != channel.owner_id:
                await interaction.response.send_message(
                    "Only the thread author can provide feedback.", ephemeral=True
                )
                return False
        return True

    def _save_feedback(self, label, interaction):
        os.makedirs(FEEDBACK_DIR, exist_ok=True)
        entry = json.dumps({
            "label": label,
            "message_id": str(interaction.message.id) if interaction.message else None,
            "channel_id": str(interaction.channel_id),
            "user": interaction.user.name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        path = os.path.join(FEEDBACK_DIR, "feedback.jsonl")
        with open(path, "a") as f:
            f.write(entry + "\n")
        logger.info(f"Feedback saved: {label} by {interaction.user.name}")

    @discord.ui.button(label="Resolved", style=discord.ButtonStyle.green, custom_id="feedback:resolved")
    async def resolved(self, interaction, button):
        if not await self._check_op(interaction):
            return
        self._save_feedback("resolved", interaction)
        await interaction.response.edit_message(view=self._disabled_view("Resolved"))

    @discord.ui.button(label="Helpful", style=discord.ButtonStyle.blurple, custom_id="feedback:helpful")
    async def helpful(self, interaction, button):
        if not await self._check_op(interaction):
            return
        self._save_feedback("helpful", interaction)
        await interaction.response.edit_message(view=self._disabled_view("Helpful"))

    @discord.ui.button(label="Not Helpful", style=discord.ButtonStyle.grey, custom_id="feedback:not_helpful")
    async def not_helpful(self, interaction, button):
        if not await self._check_op(interaction):
            return
        self._save_feedback("not_helpful", interaction)
        await interaction.response.edit_message(view=self._disabled_view("Not Helpful"))

    def _disabled_view(self, selected):
        view = discord.ui.View(timeout=None)
        for item in self.children:
            b = discord.ui.Button(
                label=f"{item.label} {'(selected)' if item.label == selected else ''}",
                style=discord.ButtonStyle.green if item.label == selected else discord.ButtonStyle.grey,
                custom_id=item.custom_id,
                disabled=True,
            )
            view.add_item(b)
        return view


WATCHED_FORUM_IDS = set(os.environ.get("DISCORD_WATCHED_FORUMS", "1494023079666647200").split(","))


def _save_thread_reply(message: discord.Message):
    """Save a human reply in a watched forum thread."""
    os.makedirs(FEEDBACK_DIR, exist_ok=True)
    entry = json.dumps({
        "type": "thread_reply",
        "message_id": str(message.id),
        "thread_id": str(message.channel.id),
        "thread_name": getattr(message.channel, "name", ""),
        "parent_id": str(message.channel.parent_id) if hasattr(message.channel, "parent_id") else None,
        "user": message.author.name,
        "content": message.content,
        "timestamp": message.created_at.isoformat(),
    })
    with open(os.path.join(FEEDBACK_DIR, "thread_replies.jsonl"), "a") as f:
        f.write(entry + "\n")
    logger.info(f"Thread reply saved: {message.author.name} in {getattr(message.channel, 'name', '?')}")


async def main():
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if not token:
        logger.error("DISCORD_BOT_TOKEN not set")
        return

    intents = discord.Intents.default()
    intents.message_content = True
    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        client.add_view(FeedbackView())
        logger.info(f"Connected as {client.user}, listening for button clicks and thread replies")

    @client.event
    async def on_message(message: discord.Message):
        if message.author.bot:
            return
        if not isinstance(message.channel, discord.Thread):
            return
        if message.channel.parent_id and str(message.channel.parent_id) in WATCHED_FORUM_IDS:
            _save_thread_reply(message)

    await client.start(token)


if __name__ == "__main__":
    asyncio.run(main())
