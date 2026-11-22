"""TAL-2656: a profile create goes through the Agent's ``provision_profile`` where it exists, sharing the launch profile's
keys and accounts only when asked; an older Agent keeps the core create and refuses to share them."""

from __future__ import annotations

import pathlib
import sys
import types
from contextlib import nullcontext
from dataclasses import dataclass, field

import pytest

from conftest import AGENT_DIR, requires_agent
from talaria_sidecar import home as sidecar_home
from talaria_sidecar.errors import InvalidParams, RpcError
from talaria_sidecar.methods import profiles


@dataclass(frozen=True)
class _Request:
    name: str
    clone_from: str | None = None
    clone_config: bool = False
    alias: bool = True
    quiet: bool = True
    mirror_credentials: bool = True

    @property
    def fresh(self) -> bool:
        return not (self.clone_from or self.clone_config)


@dataclass
class _Result:
    path: pathlib.Path
    mirrored: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)


class _Native:
    """A synthetic ``provision_profile``: makes the home, records each request, and reports the warnings it is given.
    It never starts the default-plugin installer, so nothing reaches the network."""

    def __init__(self, base: pathlib.Path) -> None:
        self.base, self.requests, self.seeded, self.warnings = base, [], [], []

    def provision(self, request: _Request) -> _Result:
        self.requests.append(request)
        path = self.base / "profiles" / request.name
        if path.exists():
            raise FileExistsError(f"Profile '{request.name}' already exists")
        path.mkdir(parents=True)
        mirrored = {"env": request.mirror_credentials, "auth": "shared", "model_inherited": request.mirror_credentials, "voice": False}
        return _Result(path=path, mirrored=mirrored, warnings=list(self.warnings))


@pytest.fixture
def base(tmp_path: pathlib.Path) -> pathlib.Path:
    home = tmp_path / "hermes"
    home.mkdir()
    return home


def _install(monkeypatch: pytest.MonkeyPatch, *, native: _Native | None, core=None) -> None:
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    agent_profiles = types.ModuleType("hermes_cli.profiles")
    agent_profiles.create_profile = core or (lambda *a, **k: pytest.fail("the core create ran"))
    agent_profiles.seed_profile_skills = lambda *a, **k: None
    if native is not None:
        agent_profiles._seed_model_config = native.seeded.append
        provision = types.ModuleType("hermes_cli.profile_provision")
        provision.ProfileCreateRequest = _Request
        provision.provision_profile = native.provision
        provision.redact_create_text = lambda text: str(text).replace("sk-secret", "***")
        monkeypatch.setitem(sys.modules, "hermes_cli.profile_provision", provision)
    else:
        monkeypatch.setitem(sys.modules, "hermes_cli.profile_provision", None)  # import raises ImportError
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", agent_profiles)
    monkeypatch.setattr(sidecar_home, "scoped_home", lambda home, **_: nullcontext(home))


def test_native_create_shares_keys_only_when_asked_and_keeps_partial_warnings(monkeypatch: pytest.MonkeyPatch, base: pathlib.Path) -> None:
    native = _Native(base)
    _install(monkeypatch, native=native)
    assert profiles.native_provision() is not None

    path, provisioning = profiles.create_profile(base, "plain", clone_from=None, clone_config=False)
    assert path.is_dir() and native.requests[-1].mirror_credentials is False and native.requests[-1].alias is False
    assert native.seeded == [path], "a fresh unshared profile keeps the launch model block the core create gave it"
    assert provisioning == {"warnings": [], "inherited": []}

    native.warnings = ["bundled skills: key sk-secret refused", *(f"step {i}: " + "x" * 900 for i in range(30))]
    path, provisioning = profiles.create_profile(base, "heir", clone_from=None, clone_config=False, inherit_credentials=True)
    assert path.is_dir(), "a failed post-create step leaves the profile in place"
    assert native.requests[-1].mirror_credentials is True and native.seeded == [base / "profiles" / "plain"]
    assert provisioning["inherited"] == ["keys", "logins", "model"]
    assert provisioning["warnings"][0] == "bundled skills: key *** refused"
    assert len(provisioning["warnings"]) == profiles._PROVISION_WARNINGS_MAX
    assert max(map(len, provisioning["warnings"])) == profiles._PROVISION_WARNING_CHARS

    profiles.create_profile(base, "copy", clone_from="plain", clone_config=True)
    assert (native.requests[-1].clone_from, native.requests[-1].clone_config, native.requests[-1].mirror_credentials) == ("plain", True, False)
    assert len(native.seeded) == 1, "a clone brings its source's model"
    with pytest.raises(RpcError) as refused:
        profiles.create_profile(base, "copy", clone_from=None, clone_config=False)
    assert refused.value.data == {"condition": "conflict"}


def test_older_agent_keeps_the_core_create_and_refuses_to_share_keys(monkeypatch: pytest.MonkeyPatch, base: pathlib.Path) -> None:
    created = []

    def core(name, **kwargs):
        created.append((name, kwargs))
        (base / "profiles" / name).mkdir(parents=True)

    _install(monkeypatch, native=None, core=core)
    assert profiles.native_provision() is None
    with pytest.raises(InvalidParams):
        profiles.create_profile(base, "heir", clone_from=None, clone_config=False, inherit_credentials=True)
    assert created == [] and not (base / "profiles" / "heir").exists()
    path, provisioning = profiles.create_profile(base, "plain", clone_from=None, clone_config=False)
    assert provisioning is None and path.is_dir()
    assert created == [("plain", {"clone_from": None, "clone_config": False, "clone_all": False, "no_alias": True})]


@requires_agent
def test_real_agent_shares_keys_only_when_asked(handshaken, hermes_home: pathlib.Path) -> None:
    """The supported Agent's real create in a disposable home: what each profile holds, per release."""
    native = AGENT_DIR is not None and (AGENT_DIR / "hermes_cli" / "profile_provision.py").is_file()
    (hermes_home / ".env").write_text("OPENROUTER_API_KEY=sk-or-root-key\nTELEGRAM_BOT_TOKEN=123:root-bot\n", encoding="utf-8")
    (hermes_home / "config.yaml").write_text("model:\n  provider: openrouter\n  default: openai/gpt-5\n", encoding="utf-8")
    home = str(hermes_home)
    assert handshaken.result("profiles.list", {"base_home": home})["inherit_credentials"] is native

    plain = handshaken.result("profiles.create", {"base_home": home, "name": "plain"})
    plain_home = hermes_home / "profiles" / "plain"
    assert "sk-or-root-key" not in ((plain_home / ".env").read_text(encoding="utf-8") if (plain_home / ".env").exists() else "")
    assert not (plain_home / "auth.json").exists()
    assert "openai/gpt-5" in (plain_home / "config.yaml").read_text(encoding="utf-8"), "the unshared profile keeps the launch model"
    assert plain["provisioning"] == ({"warnings": [], "inherited": []} if native else None)

    copy = handshaken.result("profiles.create", {"base_home": home, "name": "copy", "clone_from": "default", "clone_config": True})
    copy_env = (hermes_home / "profiles" / "copy" / ".env").read_text(encoding="utf-8")
    assert "sk-or-root-key" in copy_env and "root-bot" not in copy_env, "a clone keeps the source's keys and leaves its bot behind"
    assert copy["profile"]["name"] == "copy"

    if not native:
        message, _ = handshaken.call("profiles.create", {"base_home": home, "name": "heir", "inherit_credentials": True})
        assert "cannot share keys" in message["error"]["message"] and not (hermes_home / "profiles" / "heir").exists()
        return
    heir = handshaken.result("profiles.create", {"base_home": home, "name": "heir", "inherit_credentials": True})
    heir_env = (hermes_home / "profiles" / "heir" / ".env").read_text(encoding="utf-8")
    assert "sk-or-root-key" in heir_env and "root-bot" not in heir_env, "shared keys leave the launch bot's token behind"
    assert {"keys", "logins"} <= set(heir["provisioning"]["inherited"])
    assert heir["provisioning"]["warnings"] == []
