"""Exercise installed speech registration and profile scopes, with no provider calls."""
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
config = {'tts': {'providers': {'mycmd': {'type': 'command', 'command': 'never-run {output_path}', 'output_format': 'wav'}}}}
for directory in (home, voice):
    (directory / 'config.yaml').write_text(json.dumps(config))

methods = {}
class Registry:
    def method(self, name):
        return lambda fn: methods.setdefault(name, fn)
tts.register(Registry())
outputs = []
expected_key = 'synthetic-root-key'
def generate(text, *, output_path, speed, provider):
    assert text == 'Hello' and speed == 1.5
    assert tts_tool._resolve_provider_key('VOICE_TOOLS_OPENAI_KEY', 'openai') == expected_key
    path = Path(output_path).with_suffix('.wav' if provider == 'mycmd' else '.mp3')
    outputs.append(path.parent)
    path.write_bytes(b'synthetic-audio')
    return json.dumps({'success': True, 'provider': provider, 'file_paths': [str(path)]})

with patch.object(tts_tool, 'text_to_speech_tool', generate):
    for directory in (home, voice, home):
        expected_key = 'synthetic-voice-key' if directory == voice else 'synthetic-root-key'
        for provider in [*tts_tool._BUILTIN_DISPATCH, 'edge', 'mycmd']:
            result = methods['tts.synthesize'](None, {'profile_home': str(directory), 'text': 'Hello', 'provider': provider, 'speed': 1.5})
            assert result == {'provider': provider, 'format': 'wav' if provider == 'mycmd' else 'mp3', 'audio_b64': base64.b64encode(b'synthetic-audio').decode()}, result
        try:
            methods['tts.synthesize'](None, {'profile_home': str(directory), 'text': 'Hello', 'provider': 'unregistered'})
        except InvalidParams:
            pass
        else:
            raise AssertionError('unknown provider silently fell back')
assert outputs and all(not path.exists() for path in outputs)
