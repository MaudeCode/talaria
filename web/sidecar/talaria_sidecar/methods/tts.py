"""``tts.synthesize``: bounded audio through the Agent's own speech providers."""
from __future__ import annotations

import base64
import contextvars
import functools
import json
import math
import re
import tempfile
import threading
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

MAX_AUDIO_BYTES = 8 * 1024 * 1024

# Approved exception to Agent-only speech policy (TAL-2262): for Edge, the sidecar picks the voice from
# the spoken language; the Agent still owns synthesis, chunking, speed, credentials and audio.
_LANGUAGE_WORDS = {
    'it': frozenset({'il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'di', 'che', 'non', 'per', 'con', 'sono',
                     'questo', 'questa', 'anche', 'più', 'già', 'perché', 'cosa', 'come', 'quando', 'adesso',
                     'oggi', 'molto', 'così', 'ma'}),
    'en': frozenset({'the', 'and', 'is', 'are', 'you', 'for', 'with', 'this', 'that', 'not', 'have', 'what',
                     'when', 'there', 'from', 'would', 'should', 'about', 'can', 'will', 'your', 'but', 'just',
                     'very'}),
}
_LANGUAGE_VOICES = {'en': 'en-US-AvaNeural', 'it': 'it-IT-ElsaNeural'}
# Reviewed upstream Hermes WebUI Edge allowlist; a configured per-language voice must be one of these.
_EDGE_VOICES = frozenset({
    'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural',
    'zh-CN-YunyangNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-AvaNeural', 'en-US-EmmaNeural',
    'en-US-JennyNeural', 'en-GB-SoniaNeural', 'en-US-AndrewMultilingualNeural', 'en-US-AvaMultilingualNeural',
    'en-US-BrianMultilingualNeural', 'en-US-EmmaMultilingualNeural', 'it-IT-ElsaNeural', 'it-IT-DiegoNeural',
    'it-IT-IsabellaNeural', 'it-IT-GiuseppeMultilingualNeural', 'fr-CA-AntoineNeural', 'fr-CA-JeanNeural',
    'fr-CA-SylvieNeural', 'fr-CA-ThierryNeural', 'fr-FR-DeniseNeural', 'fr-FR-EloiseNeural',
    'fr-FR-HenriNeural', 'fr-FR-RemyMultilingualNeural', 'fr-FR-VivienneMultilingualNeural',
    'id-ID-GadisNeural'})
# This request's Edge voice and whether the Agent's config loader applied it.
_edge_voice: contextvars.ContextVar[dict | None] = contextvars.ContextVar('talaria_tts_edge_voice', default=None)
_install_lock = threading.Lock()


def _spoken_language(text: str) -> str | None:
    """Stopword/accent vote: three words, two votes and a strict winner, else no language."""
    words = re.findall(r"[a-zàèéìòù']+", text.lower())
    if len(words) < 3:
        return None
    votes = {lang: sum(word in vocabulary for word in words) for lang, vocabulary in _LANGUAGE_WORDS.items()}
    votes['it'] += sum(any(char in 'àèéìòù' for char in word) for word in words)
    winner = max(votes, key=votes.get)
    if votes[winner] >= 2 and all(count < votes[winner] for lang, count in votes.items() if lang != winner):
        return winner
    return None


def _language_voice(text: str, config: dict) -> str | None:
    try:  # The Agent's own spoken-text cleaner, exactly as text_to_speech_tool applies it.
        from tools.tts_text_normalize import prepare_spoken_text
        text = prepare_spoken_text(text, max_chars=None)
    except Exception:
        text = text.strip()
    language = _spoken_language(text)
    if language is None:
        return None
    edge = config.get('edge')
    voices = edge.get('voices') if isinstance(edge, dict) else None
    configured = voices.get(language) if isinstance(voices, dict) else None
    if isinstance(configured, str) and '${' not in configured and configured.strip() in _EDGE_VOICES:
        return configured.strip()
    return _LANGUAGE_VOICES[language]


def _install_voice_loader(tts_tool) -> None:
    """Wrap the Agent's config loader once; only a call inside a voice context sees a changed copy."""
    with _install_lock:
        if getattr(tts_tool._load_tts_config, '_talaria_edge_voice', False):
            return
        original = tts_tool._load_tts_config

        @functools.wraps(original)
        def load(*args, **kwargs):
            config = original(*args, **kwargs)
            request = _edge_voice.get()
            if request is None or not isinstance(config, dict):
                return config
            request['applied'] = True
            edge = config.get('edge')
            return {**config, 'edge': {**(edge if isinstance(edge, dict) else {}), 'voice': request['voice']}}

        load._talaria_edge_voice = True
        tts_tool._load_tts_config = load


def synthesize(text: str, provider: str, speed: float | None = None) -> dict:
    from tools import tts_tool

    # `tts.provider` is the Agent's only engine selector; v0.23.2 removed the ignored per-call argument.
    config = tts_tool._load_tts_config()
    configured = tts_tool._get_provider(config)
    if tts_tool._get_provider({'provider': provider}) != configured:
        raise InvalidParams(f'TTS engine {provider} is not this profile\'s configured engine {configured}')
    provider = configured
    if (provider != 'edge' and provider not in tts_tool._BUILTIN_DISPATCH
            and tts_tool._resolve_command_provider_config(provider, config) is None):
        raise InvalidParams(f'unknown TTS provider {provider}')
    voice = _language_voice(text, config) if provider == 'edge' else None
    request = {'voice': voice, 'applied': False}
    if voice is not None:
        _install_voice_loader(tts_tool)
    token = _edge_voice.set(request if voice is not None else None)
    try:
        with tempfile.TemporaryDirectory(prefix='talaria-tts-') as directory:
            root = Path(directory).resolve()
            result = json.loads(tts_tool.text_to_speech_tool(
                text, output_path=str(root / 'speech.mp3'), speed=speed))
            if voice is not None and not request['applied']:
                raise ValueError('Agent speech no longer reads the tts config Talaria uses to select the Edge voice')
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
    finally:
        _edge_voice.reset(token)


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
