"""Run the installed Agent's real speech function per profile, faking only provider synthesis."""
import base64
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import tts
from talaria_sidecar.errors import InvalidParams
from tools import tts_tool

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
(home / '.env').write_text('VOICE_TOOLS_OPENAI_KEY=synthetic-root-key\n')
voice = home / 'profiles' / 'voice'
voice.mkdir(parents=True)
(voice / '.env').write_text('VOICE_TOOLS_OPENAI_KEY=synthetic-voice-key\n')
commands = {'mycmd': {'type': 'command', 'command': 'never-run {output_path}', 'output_format': 'wav'}}

methods = {}
class Registry:
    def method(self, name):
        return lambda fn: methods.setdefault(name, fn)
tts.register(Registry())
engines, outputs = [], []
expected_key = 'synthetic-root-key'

def speak(engine, file_str, tts_config):
    assert tts_config['speed'] == 1.5
    assert tts_tool._resolve_provider_key('VOICE_TOOLS_OPENAI_KEY', 'openai') == expected_key
    engines.append(engine)
    outputs.append(Path(file_str).parent)
    Path(file_str).write_bytes(b'synthetic-audio')
    return file_str

def builtin(engine, text, file_str, tts_config, instructions):
    speak(engine, file_str, tts_config)

def command(text, file_str, provider, command_config, tts_config):
    return speak(provider, file_str, tts_config)

def synthesize(directory, configured, requested):
    (directory / 'config.yaml').write_text(json.dumps({'tts': {'provider': configured, 'providers': commands}}))
    engines.clear()
    return methods['tts.synthesize'](None, {'profile_home': str(directory), 'text': 'Hello', 'provider': requested, 'speed': 1.5})

def refused(directory, configured, requested):
    try:
        synthesize(directory, configured, requested)
    except InvalidParams as error:
        assert engines == [], engines
        return str(error)
    raise AssertionError(f'{requested} was not refused under {configured}')

# Only SDK availability and the vendor call are replaced; config, routing, output paths and delivery are the Agent's.
with patch.object(tts_tool, '_select_builtin_engine', lambda provider: (provider, None)), \
        patch.object(tts_tool, '_synthesize_builtin', builtin), patch.object(tts_tool, '_generate_command_tts', command):
    for directory in (home, voice, home):
        expected_key = 'synthetic-voice-key' if directory == voice else 'synthetic-root-key'
        for provider in [*tts_tool._BUILTIN_DISPATCH, 'edge', 'mycmd']:
            result = synthesize(directory, provider, provider)
            assert result == {'provider': provider, 'format': 'wav' if provider == 'mycmd' else 'mp3', 'audio_b64': base64.b64encode(b'synthetic-audio').decode()}, result
            assert engines == [provider], engines
        assert synthesize(directory, 'nous', 'nous')['provider'] == engines[0] == 'openai'
        assert 'gemini' in refused(directory, 'gemini', 'openai')
        assert 'unknown TTS provider' in refused(directory, 'unregistered', 'unregistered')
assert outputs and all(not path.exists() for path in outputs)
