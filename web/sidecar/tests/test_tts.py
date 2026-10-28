"""TTS owns bounded temporary audio; the Agent owns provider configuration and synthesis."""
import base64
import contextlib
import json
import sys
import types
from pathlib import Path

import pytest

from talaria_sidecar.errors import InvalidParams, RpcError
from talaria_sidecar.methods import build_methods


@pytest.fixture
def tts_call(monkeypatch, tmp_path):
    tool = types.ModuleType('tools.tts_tool')
    tool._BUILTIN_DISPATCH = {'piper': (), 'gemini': (), 'future-provider': ()}
    tool._load_tts_config = lambda: {'providers': {'mycmd': {'type': 'command'}}}
    tool._resolve_command_provider_config = lambda provider, config: config['providers'].get(provider)
    monkeypatch.setitem(sys.modules, 'tools', types.ModuleType('tools'))
    monkeypatch.setitem(sys.modules, 'tools.tts_tool', tool)
    homes = []
    outputs = []

    class Runtime:
        def load(self):
            pass

        def ensure_current(self):
            pass

    methods = build_methods(Runtime())

    def call(generator, provider='piper', **params):
        def generate(text, *, output_path, speed=None, provider=None):
            outputs.append(Path(output_path).parent)
            return generator(text, Path(output_path), speed, provider)

        tool.text_to_speech_tool = generate
        assert 'tts.synthesize' in methods, 'registered TTS synthesis must be callable through the sidecar'
        from talaria_sidecar.methods import tts

        @contextlib.contextmanager
        def scope(home):
            homes.append(home)
            yield home

        monkeypatch.setattr(tts, 'scoped_home', scope)
        return methods['tts.synthesize'](None, {'profile_home': str(tmp_path), 'text': 'Hello', 'provider': provider, **params})

    return call, homes, outputs


def audio(parts):
    def generate(text, output, speed, provider):
        assert text == 'Hello'
        paths = []
        for index, (suffix, data) in enumerate(parts):
            path = output.with_name(f'part-{index}.{suffix}')
            path.write_bytes(data)
            paths.append(str(path))
        return json.dumps({'success': True, 'file_paths': paths, 'provider': provider})
    return generate


@pytest.mark.parametrize('suffix', ['mp3', 'wav', 'flac'])
def test_synthesize_returns_audio_and_removes_tempdir(tts_call, tmp_path, suffix):
    call, homes, outputs = tts_call
    result = call(audio([(suffix, b'audio')]), speed=1.5)
    assert result == {'provider': 'piper', 'format': suffix, 'audio_b64': base64.b64encode(b'audio').decode()}
    assert homes == [tmp_path]
    assert outputs and all(not path.exists() for path in outputs)


def test_mp3_parts_keep_their_order(tts_call):
    call, _, outputs = tts_call
    result = call(audio([('mp3', b'first'), ('mp3', b'second')]))
    assert base64.b64decode(result['audio_b64']) == b'firstsecond'
    assert all(not path.exists() for path in outputs)


@pytest.mark.parametrize('provider', ['edge', 'gemini', 'future-provider', 'mycmd'])
def test_accepts_agent_registered_providers(tts_call, provider):
    call, _, _ = tts_call
    assert call(audio([('mp3', b'audio')]), provider=provider)['provider'] == provider


def test_unknown_provider_never_falls_back_to_edge(tts_call):
    call, _, outputs = tts_call
    with pytest.raises(InvalidParams, match='unknown TTS provider'):
        call(lambda *args: pytest.fail('unknown provider must never invoke Agent synthesis'), provider='bogus')
    assert outputs == []


@pytest.mark.parametrize('parts', [[], [('wav', b'first'), ('wav', b'second')], [('mp3', b'first'), ('wav', b'second')], [('ogg', b'audio')], [('mp3', b'')], [('mp3', b'x' * (8 * 1024 * 1024 + 1))], [('mp3', b'x' * (4 * 1024 * 1024)), ('mp3', b'x' * (4 * 1024 * 1024 + 1))]])
def test_unusable_audio_fails_and_removes_tempdir(tts_call, parts):
    call, _, outputs = tts_call
    with pytest.raises(RpcError) as error:
        call(audio(parts))
    assert error.value.data['condition'] == 'tts_failed'
    assert outputs and all(not path.exists() for path in outputs)


@pytest.mark.parametrize('reply', [json.dumps({'success': False, 'error': 'private provider detail'}), 'not JSON', '{}'])
def test_agent_failures_remove_tempdir(tts_call, reply):
    call, _, outputs = tts_call
    with pytest.raises(RpcError) as error:
        call(lambda *args: reply)
    assert error.value.data['condition'] == 'tts_failed'
    if 'private provider detail' in reply:
        assert 'private provider detail' in str(error.value)
    assert outputs and all(not path.exists() for path in outputs)


def test_generator_exception_removes_tempdir(tts_call):
    call, _, outputs = tts_call
    def broken(*args):
        raise OSError('failed writing audio')
    with pytest.raises(RpcError) as error:
        call(broken)
    assert error.value.data['condition'] == 'tts_failed'
    assert outputs and all(not path.exists() for path in outputs)


def test_speed_reaches_the_agent_unchanged(tts_call):
    call, _, _ = tts_call
    def generate(text, output, speed, provider):
        assert speed == 1.5 and provider == 'piper'
        return audio([('mp3', b'audio')])(text, output, speed, provider)
    call(generate, speed=1.5)


@pytest.mark.parametrize('params', [{'text': ''}, {'text': 'x' * 5001}, {'provider': ''}, {'speed': True}, {'speed': float('nan')}, {'speed': 0.4}, {'speed': 2.1}])
def test_invalid_params_never_call_the_agent(tts_call, params):
    call, _, outputs = tts_call
    with pytest.raises(InvalidParams):
        call(lambda *args: pytest.fail('invalid input reached synthesis'), **params)
    assert outputs == []


def test_audio_outside_the_tempdir_is_not_read_or_deleted(tts_call, tmp_path):
    call, _, outputs = tts_call
    outside = tmp_path / 'private.mp3'
    outside.write_bytes(b'private')
    with pytest.raises(RpcError) as error:
        call(lambda *args: json.dumps({'success': True, 'file_paths': [str(outside)]}))
    assert error.value.data['condition'] == 'tts_failed'
    assert outside.read_bytes() == b'private'
    assert all(not path.exists() for path in outputs)
