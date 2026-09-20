"""``stt.*``: speech-to-text through ``tools.transcription_tools`` (ported from api/upload.py)."""

from __future__ import annotations

import base64
import logging
import os
import tempfile
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.stt")


def capability() -> tuple[bool, str]:
    try:
        import tools.transcription_tools as stt
    except ImportError:
        return False, "none"
    try:
        load_cfg = getattr(stt, "_load_stt_config", None)
        stt_config = load_cfg() if callable(load_cfg) else {}
        cfg = stt_config if isinstance(stt_config, dict) else {}
        is_enabled = getattr(stt, "is_stt_enabled", None)
        if callable(is_enabled) and not is_enabled(stt_config):
            return False, "none"
        has_flags = any(hasattr(stt, n) for n in ("_HAS_FASTER_WHISPER", "_HAS_OPENAI", "_HAS_MISTRAL"))
        get_provider = getattr(stt, "_get_provider", None)
        if callable(get_provider) and not has_flags:
            provider = str(get_provider(stt_config) or "none")
            return provider not in ("", "none"), provider or "none"

        def env(name):
            getter = getattr(stt, "get_env_value", None)
            try:
                if callable(getter):
                    return str(getter(name) or "").strip()
            except Exception:  # noqa: BLE001
                return ""
            return os.getenv(name, "").strip()

        def helper(name) -> bool:
            fn = getattr(stt, name, None)
            try:
                return bool(fn()) if callable(fn) else False
            except Exception:  # noqa: BLE001
                return False

        def local_command_available() -> bool:
            return helper("_has_local_command") and helper("_find_ffmpeg_binary")

        def command_provider_available(provider) -> bool:
            resolver = getattr(stt, "_resolve_command_stt_provider_config", None)
            try:
                return callable(resolver) and resolver(provider, cfg) is not None
            except Exception:  # noqa: BLE001
                return False

        def resolve(provider):
            if provider == "local":
                return "local" if getattr(stt, "_HAS_FASTER_WHISPER", False) else "local_command" if local_command_available() else "none"
            if provider == "local_command":
                return "local_command" if local_command_available() else "local" if getattr(stt, "_HAS_FASTER_WHISPER", False) else "none"
            if provider == "groq":
                return "groq" if getattr(stt, "_HAS_OPENAI", False) and env("GROQ_API_KEY") else "none"
            if provider == "openai":
                return "openai" if getattr(stt, "_HAS_OPENAI", False) and helper("_has_openai_audio_backend") else "none"
            if provider == "mistral":
                return "mistral" if getattr(stt, "_HAS_MISTRAL", False) and env("MISTRAL_API_KEY") else "none"
            if provider == "xai":
                try:
                    from tools.xai_http import resolve_xai_http_credentials

                    return "xai" if resolve_xai_http_credentials().get("api_key") else "none"
                except Exception:  # noqa: BLE001
                    return "none"
            if provider == "elevenlabs":
                return "elevenlabs" if env("ELEVENLABS_API_KEY") else "none"
            return provider if command_provider_available(provider) else "none"

        if "provider" in cfg:
            configured = str(cfg.get("provider") or "local")
            provider = resolve(configured)
            return provider != "none", provider if provider != "none" else configured
        for candidate in ("local", "local_command", "groq", "openai", "mistral", "xai", "elevenlabs"):
            provider = resolve(candidate)
            if provider != "none":
                return True, provider
        return False, "none"
    except Exception:  # noqa: BLE001
        return False, "none"


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
