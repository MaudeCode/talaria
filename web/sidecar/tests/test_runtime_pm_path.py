"""PM tool activation at the sidecar's Agent-import boundary, without a real Agent."""

import os
import sys
import types

import pytest


@pytest.mark.parametrize("managed", [True, False])
def test_runtime_resolves_managed_tools_before_agent_import(tmp_path, monkeypatch, managed):
    from talaria_sidecar import runtime as runtime_module

    agent = tmp_path / "agent"
    agent.mkdir()
    bin_dir = tmp_path / "store" / "bin"
    if managed:
        (agent / "pm").mkdir()
        (agent / "pm" / "__init__.py").write_text(
            "import os\n"
            f"def store_first_path(path):\n    return {str(bin_dir)!r} + os.pathsep + path\n"
        )
    # The Agent resolves its tools while run_agent imports, so record the PATH it saw then.
    (agent / "run_agent.py").write_text("import os\nPATH_AT_IMPORT = os.environ['PATH']\nclass AIAgent: pass\n")
    monkeypatch.syspath_prepend(str(agent))
    for name in ("pm", "run_agent"):
        monkeypatch.setitem(sys.modules, name, None)  # restored, or removed, after the test
        del sys.modules[name]
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", types.ModuleType("hermes_cli.auth"))
    monkeypatch.setattr(runtime_module, "read_agent_revision", lambda agent_dir, module_path: None)  # no git checkout here
    monkeypatch.setenv("PATH", "/usr/bin")
    runtime = runtime_module.AgentRuntime(tmp_path / "home", agent)
    runtime.load()
    assert runtime.loaded is True
    expected = str(bin_dir) + os.pathsep + "/usr/bin" if managed else "/usr/bin"
    assert sys.modules["run_agent"].PATH_AT_IMPORT == expected
    assert os.environ["PATH"] == expected
