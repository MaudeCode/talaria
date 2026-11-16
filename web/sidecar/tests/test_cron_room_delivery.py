"""Room choices require the installed Agent's delivery parser, never a version guess."""
from types import SimpleNamespace
import contextlib
import subprocess

import pytest

from talaria_sidecar.methods import cron
from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


@pytest.mark.parametrize('supported', [False, True])
def test_room_support_requires_the_delivery_parser(monkeypatch, tmp_path, supported):
    module = SimpleNamespace(_KNOWN_DELIVERY_PLATFORMS={'telegram'})
    if supported:
        module.parse_room_deliver_token = lambda token: token
    monkeypatch.setattr(cron.importlib, 'import_module', lambda name: module)
    methods = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    cron.register(Registry())
    result = methods['cron.delivery_options'](None, {'profile_home': str(tmp_path)})
    assert result['room_delivery_supported'] is supported
    assert [p['value'] for p in result['platforms']] == ['local', 'origin', 'telegram']


@requires_agent
def test_real_agent_room_delivery_posts_one_scheduled_message(handshaken, hermes_home):
    supported = (AGENT_DIR / 'cron/scheduler_delivery_room.py').exists()
    options = handshaken.result('cron.delivery_options', {'profile_home': str(hermes_home)})
    assert options['room_delivery_supported'] is supported
    if not supported:
        return
    code = """
import sys
sys.path.insert(0, sys.argv[1])
from cron.scheduler_delivery import _deliver_result
from gateway.hosted_rooms import create_room, default_db_path, local_authority_gateway_id, read_events
store = default_db_path()
create_room(store, room_id='digest-room', name='Digest', authority_gateway_id=local_authority_gateway_id(), members=[
    {'member_id': 'one', 'profile': 'default', 'handle': 'one'},
    {'member_id': 'two', 'profile': 'helper', 'handle': 'two'},
])
job = {'id': 'nightly', 'name': 'Nightly digest', 'deliver': 'room:digest-room'}
assert _deliver_result(job, 'Synthetic scheduled result') is None
events = read_events(store, room_id='digest-room')['events']
posts = [event for event in events if event['kind'] == 'message.user']
assert len(posts) == 1, posts
assert posts[0]['actor']['id'] == 'cron:nightly', posts
assert posts[0]['payload']['text'] == 'Synthetic scheduled result', posts
"""
    result = subprocess.run([AGENT_PYTHON, '-c', code, str(AGENT_DIR)], env=isolated_env(hermes_home), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def _delivery_options(monkeypatch, plugins_by_home, labels_by_home):
    """Run cron.delivery_options against a synthetic Agent whose plugin registry is profile-scoped."""
    current = {}

    @contextlib.contextmanager
    def scoped(home):
        current['home'] = str(home)
        yield home

    scheduler = SimpleNamespace(
        _KNOWN_DELIVERY_PLATFORMS={'telegram'},
        _iter_home_target_platforms=lambda: iter(plugins_by_home[current['home']]),
    )

    def get(name):
        label = labels_by_home[current['home']].get(name)
        return None if label is None else SimpleNamespace(name=name, label=label)

    def import_module(name):
        if name == 'gateway.platform_registry':
            if labels_by_home is None:
                raise ImportError(name)
            return SimpleNamespace(platform_registry=SimpleNamespace(get=get))
        return scheduler

    monkeypatch.setattr(cron.importlib, 'import_module', import_module)
    monkeypatch.setattr(cron, 'scoped_home', scoped)
    methods = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    cron.register(Registry())
    return lambda home: methods['cron.delivery_options'](None, {'profile_home': str(home)})['platforms']


def test_delivery_labels_come_from_each_profiles_platform_registry(monkeypatch, tmp_path):
    work, home = tmp_path / 'work', tmp_path / 'home'
    options = _delivery_options(
        monkeypatch,
        {str(work): ['teams', 'dingtalk'], str(home): ['teams']},
        {
            # `irc` is registered but not a delivery platform: a label never admits a platform.
            str(work): {'telegram': 'Telegram', 'teams': 'Microsoft Teams', 'dingtalk': '', 'irc': 'IRC'},
            str(home): {'telegram': 'Telegram', 'teams': 'Teams Personal'},
        },
    )
    assert options(work) == [
        {'value': 'local', 'label': 'Local (save output only)'},
        {'value': 'origin', 'label': 'Origin (reply to creator)'},
        {'value': 'dingtalk', 'label': 'Dingtalk'},
        {'value': 'teams', 'label': 'Microsoft Teams'},
        {'value': 'telegram', 'label': 'Telegram'},
    ]
    assert [(p['value'], p['label']) for p in options(home)[2:]] == [('teams', 'Teams Personal'), ('telegram', 'Telegram')]


def test_delivery_labels_fall_back_to_capitalized_names_without_a_registry(monkeypatch, tmp_path):
    options = _delivery_options(monkeypatch, {str(tmp_path): ['teams']}, None)
    assert [(p['value'], p['label']) for p in options(tmp_path)[2:]] == [('teams', 'Teams'), ('telegram', 'Telegram')]
