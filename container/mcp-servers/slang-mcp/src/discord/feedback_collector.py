"""Discord feedback collector and summon button service.

Standalone process that:
1. Auto-posts a "Get Bot Help" button on new forum threads
2. Handles summon button clicks — saves requests for the agent
3. Handles feedback button clicks (Resolved/Helpful/Not Helpful)
4. Captures human replies in watched forum threads
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import discord

logging.basicConfig(level=logging.INFO, format="[feedback-collector] %(message)s")
logger = logging.getLogger(__name__)

FEEDBACK_DIR = os.environ.get("DISCORD_FEEDBACK_DIR", "/tmp/discord-feedback")
WATCHED_FORUM_IDS = set(
    f.strip() for f in os.environ.get("DISCORD_WATCHED_FORUMS", "1494023079666647200").split(",") if f.strip()
)


# ── Summon View ─────────────────────────────────────────────────────────────

class SummonView(discord.ui.View):
    """Button posted on every new forum thread. OP clicks to summon the bot."""

    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Get Bot Help",
        style=discord.ButtonStyle.blurple,
        custom_id="summon:get_help",
        emoji="🤖",
    )
    async def get_help(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        if isinstance(channel, discord.Thread) and channel.owner_id:
            if interaction.user.id != channel.owner_id:
                await interaction.response.send_message(
                    "Only the thread author can summon the bot.", ephemeral=True
                )
                return

        os.makedirs(FEEDBACK_DIR, exist_ok=True)
        entry = json.dumps({
            "type": "summon",
            "thread_id": str(interaction.channel_id),
            "thread_name": getattr(interaction.channel, "name", ""),
            "parent_id": str(channel.parent_id) if isinstance(channel, discord.Thread) and channel.parent_id else None,
            "message_id": str(interaction.message.id) if interaction.message else None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        with open(os.path.join(FEEDBACK_DIR, "summon_requests.jsonl"), "a") as f:
            f.write(entry + "\n")
        logger.info(f"Summon request saved for thread: {getattr(interaction.channel, 'name', '?')}")

        button.label = "Bot summoned!"
        button.style = discord.ButtonStyle.green
        button.disabled = True
        await interaction.response.edit_message(view=self)


# ── Feedback View ───────────────────────────────────────────────────────────

_active_selections: dict[str, set[str]] = {}


class FeedbackView(discord.ui.View):
    """Toggle buttons for rating bot replies: Resolved / Helpful / Not Helpful."""

    def __init__(self):
        super().__init__(timeout=None)

    async def _check_op(self, interaction):
        channel = interaction.channel
        if isinstance(channel, discord.Thread) and channel.owner_id:
            if interaction.user.id != channel.owner_id:
                await interaction.response.send_message(
                    "Only the thread author can provide feedback.", ephemeral=True
                )
                return False
        return True

    def _save_feedback(self, label, action, interaction):
        os.makedirs(FEEDBACK_DIR, exist_ok=True)
        entry = json.dumps({
            "label": label,
            "action": action,
            "message_id": str(interaction.message.id) if interaction.message else None,
            "channel_id": str(interaction.channel_id),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        with open(os.path.join(FEEDBACK_DIR, "feedback.jsonl"), "a") as f:
            f.write(entry + "\n")
        logger.info(f"Feedback {action}: {label}")

    async def _toggle(self, label, interaction):
        if not await self._check_op(interaction):
            return
        msg_id = str(interaction.message.id) if interaction.message else ""
        selections = _active_selections.setdefault(msg_id, set())
        if label in selections:
            selections.discard(label)
            self._save_feedback(label, "removed", interaction)
        else:
            selections.add(label)
            self._save_feedback(label, "added", interaction)
        await interaction.response.edit_message(view=self._updated_view(selections))

    @discord.ui.button(label="Resolved", style=discord.ButtonStyle.grey, custom_id="feedback:resolved")
    async def resolved(self, interaction, button):
        await self._toggle("resolved", interaction)

    @discord.ui.button(label="Helpful", style=discord.ButtonStyle.grey, custom_id="feedback:helpful")
    async def helpful(self, interaction, button):
        await self._toggle("helpful", interaction)

    @discord.ui.button(label="Not Helpful", style=discord.ButtonStyle.grey, custom_id="feedback:not_helpful")
    async def not_helpful(self, interaction, button):
        await self._toggle("not_helpful", interaction)

    @staticmethod
    def _updated_view(selections):
        view = FeedbackView()
        for item in view.children:
            label = {
                "feedback:resolved": "resolved",
                "feedback:helpful": "helpful",
                "feedback:not_helpful": "not_helpful",
            }.get(item.custom_id, "")
            if label in selections:
                item.style = (
                    discord.ButtonStyle.green if label == "resolved"
                    else discord.ButtonStyle.blurple if label == "helpful"
                    else discord.ButtonStyle.red
                )
            else:
                item.style = discord.ButtonStyle.grey
        return view


# ── Thread reply capture ────────────────────────────────────────────────────

def _save_thread_reply(message: discord.Message):
    os.makedirs(FEEDBACK_DIR, exist_ok=True)
    entry = json.dumps({
        "type": "thread_reply",
        "message_id": str(message.id),
        "thread_id": str(message.channel.id),
        "thread_name": getattr(message.channel, "name", ""),
        "parent_id": str(message.channel.parent_id) if hasattr(message.channel, "parent_id") else None,
        "content": message.content,
        "timestamp": message.created_at.isoformat(),
    })
    with open(os.path.join(FEEDBACK_DIR, "thread_replies.jsonl"), "a") as f:
        f.write(entry + "\n")
    logger.info(f"Thread reply saved in {getattr(message.channel, 'name', '?')}")


# ── Main ────────────────────────────────────────────────────────────────────

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
        client.add_view(SummonView())
        client.add_view(FeedbackView())
        logger.info(f"Connected as {client.user}")
        logger.info(f"Watching forums: {WATCHED_FORUM_IDS}")

    @client.event
    async def on_thread_create(thread: discord.Thread):
        """Auto-post summon button on new forum threads."""
        if not thread.parent_id or str(thread.parent_id) not in WATCHED_FORUM_IDS:
            return
        # Wait briefly for the thread to be fully created
        await asyncio.sleep(2)
        try:
            await thread.send(
                "🤖 *Need help? Click the button below for a bot-assisted answer.*",
                view=SummonView(),
            )
            logger.info(f"Summon button posted in new thread: {thread.name}")
        except Exception as e:
            logger.error(f"Failed to post summon button in {thread.name}: {e}")

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
