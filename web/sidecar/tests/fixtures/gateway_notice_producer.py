"""Capture real plugin post/edit replay on the selected Agent, without a daemon or model."""
import asyncio
import json
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
from gateway.plugin_messages import PostTarget, post, edit
from gateway.session_events import SessionEvents

fixture = json.loads(Path(sys.argv[2]).read_text())
stream = SessionEvents()
stream.epoch = "owner-epoch"
target = PostTarget(platform="local", chat_id=fixture["session_id"],
                    live=SimpleNamespace(event_stream=stream), notice_key="plugin-message:fixture:job")


async def produce():
    first = await post(target, "Plugin started", plugin_id="fixture")
    assert first["ok"], first
    final = await edit(target, first["message_id"], "Plugin finished", plugin_id="fixture")
    assert final["edited"] and final["message_id"] == first["message_id"], final


asyncio.run(produce())
replay = stream.since("owner-epoch", 0)
assert replay["events"] == fixture["events"], replay
assert all("execution_generation" not in event for event in replay["events"])
