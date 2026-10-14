"""``stt.transcribe`` drops the phrases Whisper invents on silent audio, as the Agent's own dictation does (TAL-917).

The provider is a synthetic in-process STT plugin that answers with the text in ``reply.txt`` beside it, so the real
``transcribe_audio`` path and the Agent's own hallucination filter run without a network or an account.
"""

from __future__ import annotations

import base64
import json
import sys
from types import ModuleType

import pytest

from conftest import SidecarProcess, requires_agent
from talaria_sidecar.methods import stt

PLUGIN = '''
import pathlib

from agent.transcription_provider import TranscriptionProvider


class FakeFile(TranscriptionProvider):
    @property
    def name(self):
        return "fake-file"

    def transcribe(self, file_path, *, model=None, language=None, **extra):
        reply = pathlib.Path(__file__).with_name("reply.txt").read_text()
        return {"success": True, "transcript": reply, "provider": "fake-file"}


def register(ctx):
    ctx.register_transcription_provider(FakeFile())
'''

AUDIO = base64.b64encode(b"synthetic-audio").decode()


@requires_agent
def test_transcribe_drops_silence_hallucinations_and_keeps_speech(hermes_home):
    plugin = hermes_home / "plugins" / "fake_file"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(json.dumps({"name": "fake_file", "version": "0.1.0", "description": "file STT probe"}))
    (plugin / "__init__.py").write_text(PLUGIN)
    # JSON is valid YAML.
    (hermes_home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["fake_file"]}, "stt": {"provider": "fake-file"}}))
    sidecar = SidecarProcess(hermes_home)
    try:
        def transcribe(reply: str) -> dict:
            (plugin / "reply.txt").write_text(reply)
            return sidecar.result("stt.transcribe", {"profile_home": str(hermes_home), "audio_b64": AUDIO, "suffix": ".m4a"})

        for reply in ("Thank you.", "you", "Thank you. Thank you."):
            assert transcribe(reply) == {"transcript": "", "filtered": True}, reply
        assert transcribe(" Ship the release notes. ") == {"transcript": "Ship the release notes.", "filtered": False}
    finally:
        sidecar.close()


def test_transcribe_without_the_agent_filter_keeps_the_transcript(monkeypatch):
    tools = ModuleType("tools")
    transcription = ModuleType("tools.transcription_tools")
    transcription.transcribe_audio = lambda path: {"success": True, "transcript": "Thank you."}
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.transcription_tools", transcription)
    # An Agent release before the filter: importing it raises ImportError.
    monkeypatch.setitem(sys.modules, "tools.voice_mode_transcript", None)
    assert stt.transcribe(AUDIO, ".m4a") == {"transcript": "Thank you.", "filtered": False}
