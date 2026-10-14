"""``stt.*``: speech-to-text through ``tools.transcription_tools`` (ported from api/upload.py)."""

from __future__ import annotations

import base64
import logging
import secrets
import tempfile
import threading
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.stt")


def capability() -> tuple[bool, str]:
    """The provider the Agent's own resolver would transcribe with, so the client never disagrees with ``stt.transcribe``.

    ``_get_provider`` passes an unknown explicit name through, so availability takes the Agent's
    ``check_voice_requirements`` bar: a built-in, a ``stt.providers.<name>`` command, or an available plugin."""
    try:
        from tools.transcription_tools import (
            BUILTIN_STT_PROVIDERS, _get_provider, _load_stt_config, _resolve_command_stt_provider_config)
        from tools.voice_mode import _check_plugin_stt_provider

        stt_config = _load_stt_config()
        provider = str(_get_provider(stt_config) or "none")
        if provider == "none":
            return False, "none"
        available = (provider in BUILTIN_STT_PROVIDERS
                     or _resolve_command_stt_provider_config(provider, stt_config) is not None
                     or _check_plugin_stt_provider(provider))
    except Exception:  # noqa: BLE001 - an Agent without STT, or a broken STT config
        return False, "none"
    return bool(available), provider


def streaming_available() -> bool:
    """``stt.streaming`` is on and the provider has a live wire with credentials (False on an Agent without one)."""
    try:
        from tools.transcription_streaming import streaming_available as agent_streaming_available

        return bool(agent_streaming_available())
    except Exception:  # noqa: BLE001 - an Agent without live STT, or a broken STT config
        return False


# Open live sessions by stream id: the ``stt.stream`` call owns each entry and removes it on every exit.
_STREAMS: dict[str, tuple[object, threading.Event]] = {}
_STREAMS_LOCK = threading.Lock()


def open_stream(ctx: CallContext):
    """The profile's live session relaying partials as ``partial`` frames, or None (run under the profile's home).

    ``capability`` first, so a plugin provider is discovered before the session opens."""
    available, _ = capability()
    if not (available and streaming_available()):
        return None
    from tools.transcription_streaming import open_streaming_session

    return open_streaming_session(on_partial=lambda text: ctx.emit("partial", {"text": text}))


def run_stream(ctx: CallContext, session, sample_rate: int) -> dict:
    """Announce the session's id, wait for ``stt.stream_audio`` to end the audio, and return its final transcript.

    The session's worker keeps the opener's profile context; every exit other than a final cancels it."""
    ended = threading.Event()
    stream_id = secrets.token_urlsafe(16)
    with _STREAMS_LOCK:
        _STREAMS[stream_id] = (session, ended)
    try:
        session.set_input_rate(sample_rate)
        ctx.emit("ready", {"stream_id": stream_id})
        while not ended.wait(0.1):
            ctx.check_cancelled()
        # Finalize off this thread so a cancel still reaches the session while the provider flushes.
        finalized: dict = {}
        finalizer = threading.Thread(target=lambda: finalized.update(result=session.finalize()), name="stt-stream-finalize", daemon=True)
        finalizer.start()
        while finalizer.is_alive():
            finalizer.join(0.1)
            ctx.check_cancelled()
        result = finalized.get("result")
    except BaseException:
        session.cancel()
        raise
    finally:
        with _STREAMS_LOCK:
            _STREAMS.pop(stream_id, None)
    if not isinstance(result, dict) or not result.get("success"):
        message = str(result.get("error") or "") if isinstance(result, dict) else ""
        raise RpcError(message or "Live transcription failed", condition="stt_failed")
    return {"transcript": str(result.get("transcript") or "").strip(), "provider": str(result.get("provider") or "")}


def stream_audio(stream_id: str, audio_b64: str, end: bool) -> dict:
    with _STREAMS_LOCK:
        entry = _STREAMS.get(stream_id)
    if entry is None:
        raise RpcError("Live transcription stream is closed", condition="stt_stream_closed")
    session, ended = entry
    if audio_b64:
        try:
            session.push_audio(base64.b64decode(audio_b64, validate=True))
        except ValueError as exc:
            raise InvalidParams("audio must be base64") from exc
    if end:
        ended.set()
    return {"ok": True}


def transcribe(audio_b64: str, suffix: str) -> dict:
    """The recording's transcript, emptied with ``filtered`` when it is a phrase Whisper invents on silent audio.

    The Agent's ``transcribe_recording`` filter over ``transcribe_audio``, without its voice-mode tagging (TAL-917).
    An Agent without the filter keeps the raw transcript."""
    try:
        from tools.transcription_tools import transcribe_audio
    except ImportError as exc:
        raise RpcError("Speech-to-text is unavailable on this server", condition="stt_unavailable") from exc
    try:
        data = base64.b64decode(audio_b64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise InvalidParams("audio must be base64") from exc
    suffix = suffix if suffix.startswith(".") and len(suffix) <= 8 and suffix[1:].isalnum() else ".webm"
    with tempfile.NamedTemporaryFile(prefix="talaria-stt-", suffix=suffix, delete=False) as tmp:
        path = tmp.name
        tmp.write(data)
    try:
        result = transcribe_audio(path)
    finally:
        Path(path).unlink(missing_ok=True)
    if not isinstance(result, dict) or not result.get("success"):
        message = str((result or {}).get("error") or "Transcription failed") if isinstance(result, dict) else "Transcription failed"
        lowered = message.lower()
        raise RpcError(message, condition="stt_unavailable" if "unavailable" in lowered or "not configured" in lowered else "stt_failed")
    transcript = str(result.get("transcript") or "").strip()
    try:
        from tools.voice_mode_transcript import is_whisper_hallucination
    except ImportError:
        return {"transcript": transcript, "filtered": False}
    if transcript and is_whisper_hallucination(transcript):
        return {"transcript": "", "filtered": True}
    return {"transcript": transcript, "filtered": False}


def register(registry) -> None:
    @registry.method("stt.capability")
    def capability_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            available, provider = capability()
            streaming = available and streaming_available()
        return {"available": bool(available), "provider": provider, "streaming": bool(streaming)}

    @registry.method("stt.transcribe")
    def transcribe_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return transcribe(str(params.get("audio_b64") or ""), str(params.get("suffix") or ".webm"))

    @registry.method("stt.stream")
    def stream_(ctx: CallContext, params: dict) -> dict:
        sample_rate = params.get("sample_rate")
        if not isinstance(sample_rate, int) or not 8000 <= sample_rate <= 48000:
            raise InvalidParams("sample_rate must be an integer from 8000 to 48000")
        # Open under the profile's home, then wait outside it: the scope is not held for the whole dictation.
        with scoped_home(profile_home_param(params)):
            session = open_stream(ctx)
        if session is None:
            raise RpcError("Live transcription is unavailable for the configured provider", condition="stt_stream_unavailable")
        return run_stream(ctx, session, sample_rate)

    @registry.method("stt.stream_audio")
    def stream_audio_(ctx: CallContext, params: dict) -> dict:
        return stream_audio(str(params.get("stream_id") or ""), str(params.get("audio_b64") or ""), bool(params.get("end")))
