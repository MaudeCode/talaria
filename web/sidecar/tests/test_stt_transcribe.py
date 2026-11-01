"""``stt.transcribe`` drops the phrases Whisper invents on silent audio, as the Agent's own dictation does (TAL-917).

The provider is a synthetic in-process STT plugin that answers with the text in ``reply.txt`` beside it, so the real
``transcribe_audio`` path and the Agent's own hallucination filter run without a network or an account.
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
from types import ModuleType

import pytest

from conftest import SidecarProcess, requires_agent
from talaria_sidecar.errors import RpcError
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


@requires_agent
def test_transcribe_reports_a_clean_empty_command_provider_run_as_no_speech(hermes_home, tmp_path):
    """TAL-1608: a command provider that exits 0 and writes nothing answers an empty transcript, not ``stt_failed``.

    The real Agent command provider runs a shell command: ``silent`` records the file it was handed and prints nothing;
    ``crashed`` quotes the same diagnostic on stderr and exits nonzero, which stays a failure."""
    seen = tmp_path / "seen.txt"
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (hermes_home / "config.yaml").write_text(json.dumps({"stt": {"provider": "silent", "providers": {
        "silent": {"type": "command", "command": f"printf %s {{input_path}} > {seen}"},
        "crashed": {"type": "command", "command": "echo 'Command STT provider wrote no output file at /x.txt and produced no stdout' >&2; exit 3"},
    }}}))
    sidecar = SidecarProcess(hermes_home, env={"TMPDIR": str(scratch)})
    try:
        params = {"profile_home": str(hermes_home), "audio_b64": AUDIO, "suffix": ".webm"}
        assert sidecar.result("stt.transcribe", params) == {"transcript": "", "filtered": False, "no_speech": True}
        recording = pathlib.Path(seen.read_text())
        assert recording.name.startswith("talaria-stt-") and recording.parent == scratch.resolve()
        assert not recording.exists()
        (hermes_home / "config.yaml").write_text((hermes_home / "config.yaml").read_text().replace('"provider": "silent"', '"provider": "crashed"'))
        message, _ = sidecar.call("stt.transcribe", params)
        assert message["error"]["data"]["condition"] == "stt_failed", message
        assert "exited with code 3" in message["error"]["message"]
        assert list(scratch.iterdir()) == []
    finally:
        sidecar.close()


def _agent_transcribing(monkeypatch, result):
    tools = ModuleType("tools")
    transcription = ModuleType("tools.transcription_tools")
    transcription.transcribe_audio = lambda path: result
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.transcription_tools", transcription)
    monkeypatch.setitem(sys.modules, "tools.voice_mode_transcript", None)


@pytest.mark.parametrize("error", [
    "Command STT provider wrote no output file at /tmp/hermes-cmd-stt-x/transcript.txt and produced no stdout",
    "  command STT provider wrote no output file at /synthetic/transcript.txt and produced no stdout.\n",
])
def test_transcribe_recognizes_only_the_complete_clean_empty_diagnostic(monkeypatch, error):
    _agent_transcribing(monkeypatch, {"success": False, "error": error})
    assert stt.transcribe(AUDIO, ".webm") == {"transcript": "", "filtered": False, "no_speech": True}


@pytest.mark.parametrize(("result", "condition"), [
    ({"success": False, "error": "STT command provider 'x' exited with code 7: stderr: produced no stdout"}, "stt_failed"),
    ({"success": False, "error": "stderr: Command STT provider wrote no output file at /tmp/x.txt and produced no stdout"}, "stt_failed"),
    ({"success": False, "error": "Command STT provider wrote no output file\nand produced no stdout"}, "stt_failed"),
    ({"success": False, "error": "Command STT provider wrote no output file at /a.txt\rTraceback: boom and produced no stdout"}, "stt_failed"),
    ({"success": False, "error": "Command STT provider wrote no output file at /a.txt and produced no stdout\nTraceback: boom"}, "stt_failed"),
    ({"success": False, "error": "Command STT provider wrote no output file at  and produced no stdout"}, "stt_failed"),
    ({"success": False, "error": "No transcript produced"}, "stt_failed"),
    ({"success": False, "error": "warning: no output"}, "stt_failed"),
    ({"success": False}, "stt_failed"),
    (None, "stt_failed"),
    ("Command STT provider wrote no output file at /a.txt and produced no stdout", "stt_failed"),
    ({"success": False, "error": "No STT provider available: not configured"}, "stt_unavailable"),
    ({"success": False, "error": "Command STT provider failed: [Errno 5] Input/output error"}, "stt_failed"),
])
def test_transcribe_keeps_every_other_failure_a_failure(monkeypatch, result, condition):
    _agent_transcribing(monkeypatch, result)
    with pytest.raises(RpcError) as excinfo:
        stt.transcribe(AUDIO, ".webm")
    assert excinfo.value.data["condition"] == condition
