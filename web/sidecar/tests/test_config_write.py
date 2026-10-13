"""Config saves retain operator formatting and exact values on supported Agents."""

from __future__ import annotations

import json
import pathlib
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent


def agent_script(home: pathlib.Path, code: str) -> None:
    result = subprocess.run(
        [AGENT_PYTHON, "-c", "import sys; sys.path.insert(0, sys.argv[1]);\n" + code, str(AGENT_DIR)],
        env=isolated_env(home), capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@requires_agent
def test_config_set_preserves_comments_quotes_order_and_removals(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    capability = subprocess.check_output(
        [AGENT_PYTHON, "-c", "import sys; sys.path.insert(0, sys.argv[1]); from hermes_cli import config; print(hasattr(config, 'atomic_config_replace'))", str(AGENT_DIR)],
        env=isolated_env(hermes_home), text=True,
    ).strip()
    if capability != "True":
        pytest.skip("Agent predates the comment-preserving config writer")
    path = hermes_home / "config.yaml"
    path.write_text('# my provider notes\nmodel:\n  default: "test-model" # pinned for cost\n  provider: custom\n  obsolete: true\nagent:\n  max_turns: 10\nremoved: true\n')
    params = {"profile_home": str(hermes_home)}
    config = handshaken.result("config.get", params)["config"]
    del config["removed"]
    del config["model"]["obsolete"]
    config["agent"]["max_turns"] = 20
    config["new_setting"] = "café"
    handshaken.result("config.set", {**params, "config": config})
    text = path.read_text()
    assert "# my provider notes" in text
    assert '"test-model" # pinned for cost' in text
    assert text.index("model:") < text.index("agent:") < text.index("new_setting:")
    assert handshaken.result("config.get", params)["config"] == config


def backslash_corpus() -> list[str]:
    return [
        "A" * length + path + " " + "B" * 40 + suffix
        for length in range(60, 82)
        for path in ("C:\\Users\\test", "D:\\Central", "\\\\server\\share", "\\d+\\w+", "\\")
        for suffix in ("\t", "\n", "\x01")
    ]


@requires_agent
def test_config_set_round_trips_backslash_corpus(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    params = {"profile_home": str(hermes_home)}
    config = {"policy": backslash_corpus()}
    # Exercise both creation and replacement of an existing document.
    for _ in range(2):
        handshaken.result("config.set", {**params, "config": config})
        assert handshaken.result("config.get", params)["config"] == config


@requires_agent
def test_config_fallback_round_trips_backslash_corpus(hermes_home: pathlib.Path) -> None:
    (hermes_home / "desired.json").write_text(json.dumps({"policy": backslash_corpus()}))
    agent_script(hermes_home, '''
import os, json
from pathlib import Path
from unittest.mock import patch
from talaria_sidecar.methods import config

original_import = config.importlib.import_module
def without_writer(name):
    if name == "hermes_cli.config":
        raise ImportError("Agent config writer unavailable")
    return original_import(name)

path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
desired = json.loads((path.parent / "desired.json").read_text())
with patch.object(config.importlib, "import_module", side_effect=without_writer):
    config.write_config(path, desired)
assert config.read_config(path)["config"] == desired
''')


@pytest.mark.parametrize("modern", [False, True])
def test_config_retarget_during_serialization_leaves_both_targets_untouched(tmp_path: pathlib.Path, monkeypatch, modern: bool) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.errors import RpcError
    from talaria_sidecar.methods import config

    original, other, link = (tmp_path / name for name in ("original.yaml", "other.yaml", "config.yaml"))
    original.write_text("value: original\n")
    other.write_text("value: other\n")
    link.symlink_to(original)

    def retarget(*args, **kwargs):
        link.unlink()
        link.symlink_to(other)
        if modern:
            args[0].write_text("value: changed\n")
        return "value: changed\n"

    module = SimpleNamespace(atomic_config_replace=retarget) if modern else SimpleNamespace()
    monkeypatch.setattr(config.importlib, "import_module", lambda name: module)
    monkeypatch.setattr(config, "yaml_parser", lambda: SimpleNamespace(safe_dump=retarget))
    with pytest.raises(RpcError) as error:
        config.write_config(link, {"value": "changed"})
    assert error.value.data["condition"] == "config_changed"
    assert original.read_text() == "value: original\n"
    assert other.read_text() == "value: other\n"
    assert link.resolve() == other
    assert not list(tmp_path.glob(".config_*.tmp"))


def test_agent_writer_failure_does_not_fall_back_or_modify_target(tmp_path: pathlib.Path, monkeypatch) -> None:
    from types import SimpleNamespace

    from talaria_sidecar.methods import config

    path = tmp_path / "config.yaml"
    path.write_text("value: original\n")

    def fail(staged, desired):
        staged.write_text("partial write")
        raise OSError("writer failed")

    monkeypatch.setattr(config.importlib, "import_module", lambda name: SimpleNamespace(atomic_config_replace=fail))
    with pytest.raises(OSError, match="writer failed"):
        config.write_config(path, {"value": "changed"})
    assert path.read_text() == "value: original\n"
    assert not list(tmp_path.glob(".config_*.tmp"))
