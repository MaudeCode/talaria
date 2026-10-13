"""``stt.*``: speech-to-text through ``tools.transcription_tools`` (ported from api/upload.py)."""

from __future__ import annotations

import base64
import logging
import tempfile
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


def transcribe(audio_b64: str, suffix: str) -> str:
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
    return str(result.get("transcript") or "").strip()


def register(registry) -> None:
    @registry.method("stt.capability")
    def capability_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            available, provider = capability()
        return {"available": bool(available), "provider": provider}

    @registry.method("stt.transcribe")
    def transcribe_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"transcript": transcribe(str(params.get("audio_b64") or ""), str(params.get("suffix") or ".webm"))}
