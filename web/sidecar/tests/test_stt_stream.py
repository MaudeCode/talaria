"""``stt.stream`` / ``stt.stream_audio``: live dictation through the Agent's streaming session (TAL-802).

The provider is a synthetic in-process STT plugin whose stream session counts the 16 kHz bytes it receives, so every
partial, the final transcript, and the host-side resampling are observable without a network or an account. A cancel's
handling of the session is ``stt.run_stream``'s own, proved in-process over a scripted session.
"""

from __future__ import annotations

import base64
import io
import json
import threading
import time
from types import SimpleNamespace

import pytest

from conftest import SidecarProcess, requires_agent
from talaria_sidecar.errors import Cancelled, InvalidParams, RpcError
from talaria_sidecar.methods import Registry, stt
from talaria_sidecar.rpc import CallContext, RpcServer

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
        reply = EVENTS.with_name("reply.txt")
        transcript = reply.read_text() if reply.exists() else f" final {self.received} bytes "
        return {"success": True, "transcript": transcript, "provider": "fake-live"}


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
        assert sidecar.result("stt.capability", {"profile_home": str(hermes_home)}) == {"available": True, "provider": "fake-live", "streaming": True, "warm_supported": False}
        (hermes_home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["fake_live"]}, "stt": {"provider": "fake-live", "streaming": False}}))
        assert sidecar.result("stt.capability", {"profile_home": str(hermes_home)}) == {"available": True, "provider": "fake-live", "streaming": False, "warm_supported": False}
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
        assert inbox.response(stream)["result"] == {"transcript": "final 3200 bytes", "filtered": False, "provider": "fake-live"}
        assert inbox.events(stream) == ["ready", "partial", "result"]
        assert _events(log) == ["open", "finalize"]
        # The id is released with the call.
        message, _ = sidecar.call("stt.stream_audio", {"stream_id": stream_id, "audio_b64": _pcm(10)})
        assert message["error"]["data"]["condition"] == "stt_stream_closed"
    finally:
        sidecar.close()


@requires_agent
def test_stream_final_drops_a_silence_hallucination(hermes_home):
    """TAL-917: the live final goes through the same Whisper filter as ``stt.transcribe``."""
    log = _seed(hermes_home, streaming=True)
    log.with_name("reply.txt").write_text("Thank you.")
    sidecar = SidecarProcess(hermes_home)
    try:
        inbox = Inbox(sidecar)
        stream = sidecar.request("stt.stream", {"profile_home": str(hermes_home), "sample_rate": 16000})
        stream_id = inbox.frame(stream, "ready")["data"]["stream_id"]
        assert inbox.response(sidecar.request("stt.stream_audio", {"stream_id": stream_id, "end": True}))["result"] == {"ok": True}
        assert inbox.response(stream)["result"] == {"transcript": "", "filtered": True, "provider": "fake-live"}
    finally:
        sidecar.close()


class ScriptedSession:
    """An Agent streaming session that records what ``run_stream`` asks of it; ``finalize`` holds until released."""

    def __init__(self):
        self.calls: list[str] = []
        self.finalizing, self.release = threading.Event(), threading.Event()

    def set_input_rate(self, rate):
        self.calls.append(f"rate {rate}")

    def finalize(self):
        self.calls.append("finalize")
        self.finalizing.set()
        self.release.wait(10)  # the test's ceiling, never its verdict
        self.calls.append("finalized")
        return {"success": True, "transcript": "late", "provider": "scripted"}

    def cancel(self):
        self.calls.append("cancel")


def _streaming(session: ScriptedSession):
    """``run_stream`` on its own thread with a real call context; returns (ctx, stream id, thread, outcome)."""
    stdout = io.BytesIO()
    ctx = CallContext(RpcServer({}, stdout=stdout), 7, "stt.stream")
    outcome: dict = {}

    def run():
        try:
            outcome["result"] = stt.run_stream(ctx, session, 16000)
        except BaseException as exc:  # noqa: BLE001 - asserted by the test
            outcome["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not (ready := [m["params"]["data"]["stream_id"] for m in map(json.loads, stdout.getvalue().splitlines()) if m["params"]["event"] == "ready"]):
        assert time.monotonic() < deadline, "the stream never announced its id"
        time.sleep(0.01)
    return ctx, ready[0], thread, outcome


def _closed(stream_id: str) -> str:
    with pytest.raises(RpcError) as closed:
        stt.stream_audio(stream_id, "", True)
    return closed.value.data["condition"]


def test_cancel_closes_the_session_without_finalizing():
    session = ScriptedSession()
    ctx, stream_id, thread, outcome = _streaming(session)
    ctx.cancel_event.set()
    thread.join(10)
    assert not thread.is_alive() and isinstance(outcome.get("error"), Cancelled), outcome
    assert session.calls == ["rate 16000", "cancel"]
    # The id is released with the call.
    assert _closed(stream_id) == "stt_stream_closed"


def test_cancel_during_a_slow_finalize_cancels_the_session():
    session = ScriptedSession()
    ctx, stream_id, thread, outcome = _streaming(session)
    assert stt.stream_audio(stream_id, "", True) == {"ok": True}
    assert session.finalizing.wait(10)
    ctx.cancel_event.set()
    thread.join(10)
    try:
        # The call (and its slot) is released while the provider is still finalizing.
        assert not thread.is_alive() and isinstance(outcome.get("error"), Cancelled), outcome
        assert session.calls == ["rate 16000", "finalize", "cancel"]
        assert _closed(stream_id) == "stt_stream_closed"
    finally:
        session.release.set()


@pytest.mark.parametrize("sample_rate", [7999, 48001, 16000.0])
def test_stream_refuses_an_invalid_rate_before_opening_a_session(monkeypatch, tmp_path, sample_rate):
    opened = []
    monkeypatch.setattr(stt, "open_stream", lambda ctx: opened.append(ctx))
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    stt.register(registry)
    with pytest.raises(InvalidParams):
        registry.methods["stt.stream"](None, {"profile_home": str(tmp_path), "sample_rate": sample_rate})
    assert opened == []


@requires_agent
def test_stream_refuses_when_streaming_is_off(hermes_home):
    log = _seed(hermes_home, streaming=False)
    sidecar = SidecarProcess(hermes_home)
    try:
        message, frames = sidecar.call("stt.stream", {"profile_home": str(hermes_home), "sample_rate": 16000})
        assert frames == []
        assert message["error"]["data"]["condition"] == "stt_stream_unavailable"
        assert _events(log) == []
    finally:
        sidecar.close()
