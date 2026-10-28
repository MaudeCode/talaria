"""``tts.synthesize``: bounded audio through the Agent's own speech providers."""
from __future__ import annotations

import base64
import json
import math
import tempfile
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

MAX_AUDIO_BYTES = 8 * 1024 * 1024


def synthesize(text: str, provider: str, speed: float | None = None) -> dict:
    from tools import tts_tool

    if (provider != 'edge' and provider not in tts_tool._BUILTIN_DISPATCH
            and tts_tool._resolve_command_provider_config(provider, tts_tool._load_tts_config()) is None):
        raise InvalidParams(f'unknown TTS provider {provider}')
    try:
        with tempfile.TemporaryDirectory(prefix='talaria-tts-') as directory:
            root = Path(directory).resolve()
            result = json.loads(tts_tool.text_to_speech_tool(
                text, output_path=str(root / 'speech.mp3'), speed=speed, provider=provider))
            if not isinstance(result, dict) or result.get('success') is not True:
                message = result.get('error') if isinstance(result, dict) else None
                raise ValueError(str(message or 'Agent speech generation failed'))
            paths = result.get('file_paths')
            if not isinstance(paths, list) or not paths:
                raise ValueError('Agent returned no audio files')
            audio = bytearray()
            audio_format = ''
            for raw_path in paths:
                path = Path(raw_path).resolve()
                if not path.is_relative_to(root):
                    raise ValueError('Agent audio escaped the temporary directory')
                suffix = path.suffix.lower().lstrip('.')
                if suffix not in ('mp3', 'wav', 'flac') or (len(paths) > 1 and suffix != 'mp3'):
                    raise ValueError('Agent returned unsupported audio parts')
                audio_format = suffix
                with path.open('rb') as source:
                    part = source.read(MAX_AUDIO_BYTES - len(audio) + 1)
                if not part or len(audio) + len(part) > MAX_AUDIO_BYTES:
                    raise ValueError('Agent audio is empty or exceeds 8 MiB')
                audio.extend(part)
            return {'provider': str(result.get('provider') or provider), 'format': audio_format,
                    'audio_b64': base64.b64encode(audio).decode('ascii')}
    except Exception as error:
        raise RpcError(str(error), condition='tts_failed') from error


def register(registry) -> None:
    @registry.method('tts.synthesize')
    def synthesize_(ctx: CallContext, params: dict) -> dict:
        text, provider, speed = params.get('text'), params.get('provider'), params.get('speed')
        if not isinstance(text, str) or not text.strip() or len(text) > 5000:
            raise InvalidParams('text must contain 1 to 5000 characters')
        if not isinstance(provider, str) or not provider.strip():
            raise InvalidParams('provider is required')
        if speed is not None and (isinstance(speed, bool) or not isinstance(speed, (int, float))
                                  or not math.isfinite(speed) or not 0.5 <= speed <= 2):
            raise InvalidParams('speed must be a number from 0.5 to 2')
        with scoped_home(profile_home_param(params)):
            return synthesize(text, provider, speed)
