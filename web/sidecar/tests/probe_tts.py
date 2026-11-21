"""Run the installed Agent's real speech function per profile, faking only provider synthesis."""
import base64
import json
import os
from pathlib import Path
import sys
import threading
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

# Overlapping Edge requests in two profiles each get their own spoken-language voice through the Agent's
# real loader and dispatch; an unrelated Agent read during the overlap sees the unmodified profile config.
profiles = {home: {'voice': 'fr-FR-DeniseNeural', 'voices': {'it': 'it-IT-IsabellaNeural'}},
            voice: {'voice': 'en-US-GuyNeural', 'voices': {'en': '${UNSET_VOICE}'}}}
for directory, edge in profiles.items():
    (directory / 'config.yaml').write_text(json.dumps({'tts': {'provider': 'edge', 'edge': edge}}))
written = {directory: (directory / 'config.yaml').read_bytes() for directory in profiles}
voices, results, unrelated = {}, {}, []
started, finish = threading.Barrier(3, timeout=30), threading.Barrier(3, timeout=30)

def overlapping(engine, text, file_str, tts_config, instructions):
    assert engine == 'edge' and tts_config['speed'] == 1.5
    voices[text] = tts_config['edge']['voice']
    started.wait()
    finish.wait()
    Path(file_str).write_bytes(b'synthetic-audio')

def request(directory, text):
    results[text] = methods['tts.synthesize'](None, {'profile_home': str(directory), 'text': text, 'provider': 'edge', 'speed': 1.5})

italian, english = 'Ciao, come stai oggi? Questo è un test della voce italiana.', 'The build is green and I will merge it now.'
with patch.object(tts_tool, '_select_builtin_engine', lambda provider: (provider, None)), \
        patch.object(tts_tool, '_synthesize_builtin', overlapping):
    workers = [threading.Thread(target=request, args=(home, italian)), threading.Thread(target=request, args=(voice, english))]
    for worker in workers:
        worker.start()
    started.wait()
    unrelated.append(tts_tool._load_tts_config())
    finish.wait()
    for worker in workers:
        worker.join(30)
assert voices == {italian: profiles[home]['voices']['it'], english: 'en-US-AvaNeural'}, voices
assert set(results) == {italian, english} and all(r['provider'] == 'edge' for r in results.values()), results
assert unrelated[0]['edge'] == profiles[home], unrelated
assert tts_tool._load_tts_config()['edge'] == profiles[home]
uncertain = []

def record(engine, text, file_str, tts_config, instructions):
    uncertain.append(tts_config['edge']['voice'])
    Path(file_str).write_bytes(b'synthetic-audio')

with patch.object(tts_tool, '_select_builtin_engine', lambda provider: (provider, None)), \
        patch.object(tts_tool, '_synthesize_builtin', record):
    methods['tts.synthesize'](None, {'profile_home': str(home), 'text': 'Ok thanks', 'provider': 'edge', 'speed': 1.5})
assert uncertain == [profiles[home]['voice']], uncertain
assert {directory: (directory / 'config.yaml').read_bytes() for directory in profiles} == written
