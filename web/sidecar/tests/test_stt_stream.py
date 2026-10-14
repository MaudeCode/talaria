"""``stt.stream`` / ``stt.stream_audio``: live dictation through the Agent's streaming session (TAL-802).

The provider is a synthetic in-process STT plugin whose stream session counts the 16 kHz bytes it receives, so every
partial, the final transcript, and the host-side resampling are observable without a network or an account.
"""

from __future__ import annotations

import base64
import json

import pytest

from conftest import SidecarProcess, requires_agent

PLUGIN = '''
import pathlib

from agent.transcription_provider import TranscriptionProvider, TranscriptionStreamSession

EVENTS = pathlib.Path(__file__).with_name("events.log")


def _log(line):
    with EVENTS.open("a") as f:
        f.write(line + "\\n")


class _Session(TranscriptionStreamSession):
    def __init__(self):
        self.received = 0

    def push_audio(self, chunk):
        self.received += len(chunk)

    def partial_transcript(self):
        return f"heard {self.received} bytes" if self.received else ""

    def finalize(self):
        _log("finalize")
        return {"success": True, "transcript": f" final {self.received} bytes ", "provider": "fake-live"}


class FakeLive(TranscriptionProvider):
    @property
    def name(self):
        return "fake-live"

    @property
    def streaming_capable(self):
        return True

    def open_stream_session(self, *, language=None, prompt=None):
        _log("open")
        return _Session()

    def transcribe(self, file_path, *, model=None, language=None, **extra):
        return {"success": True, "transcript": "from file", "provider": "fake-live"}


def register(ctx):
    ctx.register_transcription_provider(FakeLive())
'''


def _seed(home, *, streaming: bool):
    plugin = home / "plugins" / "fake_live"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(json.dumps({"name": "fake_live", "version": "0.1.0", "description": "live STT probe"}))
    (plugin / "__init__.py").write_text(PLUGIN)
    # JSON is valid YAML.
    (home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["fake_live"]}, "stt": {"provider": "fake-live", "streaming": streaming}}))
    return plugin / "events.log"


def _events(log) -> list[str]:
    return log.read_text().split() if log.exists() else []


def _pcm(samples: int) -> str:
    return base64.b64encode(b"\x10\x00" * samples).decode()


class Inbox:
    """Every message the sidecar sends, in arrival order, so interleaved calls are read without dropping any."""

    def __init__(self, sidecar: SidecarProcess):
        self.sidecar, self.arrived, self._unread = sidecar, [], []

    def _take(self, match) -> dict:
        while True:
            for i, message in enumerate(self._unread):
                if match(message):
                    return self._unread.pop(i)
            message = self.sidecar.next_message(timeout=30)
            assert message is not None, "sidecar closed"
            self.arrived.append(message)
            self._unread.append(message)

    def frame(self, request_id: int, event: str) -> dict:
        return self._take(lambda m: m.get("method") == "stream" and m["params"]["id"] == request_id and m["params"]["event"] == event)["params"]

    def response(self, request_id: int) -> dict:
        return self._take(lambda m: m.get("id") == request_id and "method" not in m)

    def events(self, request_id: int) -> list[str]:
        """The call's stream events and its response (``result``/``error``), in arrival order."""
        return [m["params"]["event"] if m.get("method") == "stream" else ("result" if "result" in m else "error")
                for m in self.arrived if m.get("id") == request_id or (m.get("method") == "stream" and m["params"]["id"] == request_id)]


@requires_agent
def test_capability_reports_streaming_only_when_enabled(hermes_home):
    _seed(hermes_home, streaming=True)
    sidecar = SidecarProcess(hermes_home)
    try:
        assert sidecar.result("stt.capability", {"profile_home": str(hermes_home)}) == {"available": True, "provider": "fake-live", "streaming": True}
        (hermes_home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["fake_live"]}, "stt": {"provider": "fake-live", "streaming": False}}))
        assert sidecar.result("stt.capability", {"profile_home": str(hermes_home)}) == {"available": True, "provider": "fake-live", "streaming": False}
    finally:
        sidecar.close()


@requires_agent
def test_stream_relays_partials_then_returns_the_sessions_final(hermes_home):
    log = _seed(hermes_home, streaming=True)
    sidecar = SidecarProcess(hermes_home)
    try:
        inbox = Inbox(sidecar)
        stream = sidecar.request("stt.stream", {"profile_home": str(hermes_home), "sample_rate": 48000})
        stream_id = inbox.frame(stream, "ready")["data"]["stream_id"]
        # 4800 samples at 48 kHz are 1600 at 16 kHz: the host resamples before the provider sees them.
        pushed = sidecar.request("stt.stream_audio", {"stream_id": stream_id, "audio_b64": _pcm(4800)})
        assert inbox.response(pushed)["result"] == {"ok": True}
        assert inbox.frame(stream, "partial")["data"] == {"text": "heard 3200 bytes"}
        ended = sidecar.request("stt.stream_audio", {"stream_id": stream_id, "end": True})
        assert inbox.response(ended)["result"] == {"ok": True}
        assert inbox.response(stream)["result"] == {"transcript": "final 3200 bytes", "provider": "fake-live"}
        assert inbox.events(stream) == ["ready", "partial", "result"]
        assert _events(log) == ["open", "finalize"]
        # The id is released with the call.
        message, _ = sidecar.call("stt.stream_audio", {"stream_id": stream_id, "audio_b64": _pcm(10)})
        assert message["error"]["data"]["condition"] == "stt_stream_closed"
    finally:
        sidecar.close()


@requires_agent
def test_cancel_closes_the_session_without_finalizing(hermes_home):
    log = _seed(hermes_home, streaming=True)
    sidecar = SidecarProcess(hermes_home)
    try:
        inbox = Inbox(sidecar)
        stream = sidecar.request("stt.stream", {"profile_home": str(hermes_home), "sample_rate": 16000})
        stream_id = inbox.frame(stream, "ready")["data"]["stream_id"]
        sidecar.request("rpc.cancel", {"id": stream})
        assert inbox.response(stream)["error"]["data"]["condition"] == "cancelled"
        message, _ = sidecar.call("stt.stream_audio", {"stream_id": stream_id, "end": True})
        assert message["error"]["data"]["condition"] == "stt_stream_closed"
        assert _events(log) == ["open"]
    finally:
        sidecar.close()


@requires_agent
@pytest.mark.parametrize("sample_rate", [16000, 7999])
def test_stream_refuses_when_streaming_is_off_or_the_rate_is_invalid(hermes_home, sample_rate):
    log = _seed(hermes_home, streaming=sample_rate != 16000)
    sidecar = SidecarProcess(hermes_home)
    try:
        message, frames = sidecar.call("stt.stream", {"profile_home": str(hermes_home), "sample_rate": sample_rate})
        assert frames == []
        expected = "stt_stream_unavailable" if sample_rate == 16000 else None
        assert message["error"].get("data", {}).get("condition") == expected
        assert _events(log) == []
    finally:
        sidecar.close()
