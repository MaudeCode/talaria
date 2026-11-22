"""Room delivery posts through the installed Agent, and delivery labels come from each profile's platform registry."""
from types import SimpleNamespace
import contextlib
import subprocess

from talaria_sidecar.methods import cron
from conftest import AGENT_DIR, AGENT_PYTHON, STORE_PRELUDE, isolated_env, requires_agent


@requires_agent
def test_real_agent_room_delivery_posts_one_scheduled_message(handshaken, hermes_home):
    options = handshaken.result('cron.delivery_options', {'profile_home': str(hermes_home)})
    assert options['room_delivery_supported'] is True
    # From v0.23.3 the install's room store sits behind the storage handle and each call names its placement.
    # agent-shim: pre-persistence-store
    code = "import sys\nsys.path.insert(0, sys.argv[1])\n" + STORE_PRELUDE + """
from cron.scheduler_delivery import _deliver_result
from gateway.hosted_rooms import create_room, default_db_path, local_authority_gateway_id, read_events
rooms, placement = (store, {'placement': 'shared'}) if store else (default_db_path(), {})
create_room(rooms, **placement, room_id='digest-room', name='Digest', authority_gateway_id=local_authority_gateway_id(), members=[
    {'member_id': 'one', 'profile': 'default', 'handle': 'one'},
    {'member_id': 'two', 'profile': 'helper', 'handle': 'two'},
])
job = {'id': 'nightly', 'name': 'Nightly digest', 'deliver': 'room:digest-room'}
assert _deliver_result(job, 'Synthetic scheduled result') is None
events = read_events(rooms, **placement, room_id='digest-room')['events']
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
