"""``stt.warm`` pre-loads the profile's local STT engine through the Agent's ``warm_stt_provider`` (TAL-916)."""

from __future__ import annotations

import contextlib
import sys
import types

from talaria_sidecar.methods import stt


def _methods(monkeypatch, homes: list) -> dict:
    """The ``stt.*`` handlers, with ``scoped_home`` recording the profile home each call runs under."""
    @contextlib.contextmanager
    def scoped(home):
        homes.append(str(home))
        yield home

    monkeypatch.setattr(stt, "scoped_home", scoped)
    methods: dict = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)

    stt.register(Registry())
    return methods


def _call(methods: dict, name: str, home) -> dict | None:
    return methods.get(name, lambda ctx, params: None)(None, {"profile_home": str(home)})


def _install_lease(monkeypatch, warm) -> None:
    module = types.ModuleType("tools.stt_lease")
    module.warm_stt_provider = warm
    monkeypatch.setitem(sys.modules, "tools.stt_lease", module)


def test_warm_runs_the_agent_warmer_under_the_profile_home(monkeypatch, tmp_path) -> None:
    homes: list = []
    _install_lease(monkeypatch, lambda: {"provider": "local", "warmed": True, "action": "loaded", "elapsed_ms": 1200})
    result = _call(_methods(monkeypatch, homes), "stt.warm", tmp_path)
    assert result == {"provider": "local", "warmed": True, "action": "loaded"}
    assert homes == [str(tmp_path)]


def test_warm_passes_the_agent_error_through(monkeypatch, tmp_path) -> None:
    _install_lease(monkeypatch, lambda: {"provider": "local", "warmed": False, "action": "error", "error": "faster-whisper not installed"})
    result = _call(_methods(monkeypatch, []), "stt.warm", tmp_path)
    assert result == {"provider": "local", "warmed": False, "action": "error", "error": "faster-whisper not installed"}


def test_warm_without_the_agent_lease_module_reports_not_warmed(monkeypatch, tmp_path) -> None:
    monkeypatch.setitem(sys.modules, "tools.stt_lease", None)
    monkeypatch.setattr(stt, "capability", lambda: (True, "openai"))
    result = _call(_methods(monkeypatch, []), "stt.warm", tmp_path)
    assert result == {"provider": "openai", "warmed": False, "action": "unsupported"}


def test_capability_reports_warm_only_for_the_local_engine_the_agent_can_warm(monkeypatch, tmp_path) -> None:
    def warm_supported(available: bool, provider: str) -> bool | None:
        monkeypatch.setattr(stt, "capability", lambda: (available, provider))
        return (_call(methods, "stt.capability", tmp_path) or {}).get("warm_supported")

    monkeypatch.setattr(stt, "streaming_available", lambda: False)
    _install_lease(monkeypatch, lambda: {})
    methods = _methods(monkeypatch, [])
    assert warm_supported(True, "local") is True
    # Remote and command providers keep nothing resident: the Agent's warmer would no-op.
    assert warm_supported(True, "openai") is False
    assert warm_supported(True, "local_command") is False
    assert warm_supported(False, "local") is False
    monkeypatch.setitem(sys.modules, "tools.stt_lease", None)
    assert warm_supported(True, "local") is False
