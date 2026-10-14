"""TAL-798: the Agent's managed llama.cpp runtime against the pinned Agent: ``providers.local_models`` lists the GGUFs
staged in a disposable home, and a turn on the local provider while its server is off fails as that, not as a
missing credential."""

from __future__ import annotations

import pathlib

import pytest

from conftest import SidecarProcess, assert_matches, requires_agent

pytestmark = requires_agent

# The server stays off: no managed boot, no llama.cpp download.
OFF = "model:\n  provider: llamacpp\n  default: tiny-test-Q4_K_M\nlocal_runtime:\n  enabled: false\n"


def _stage(home: pathlib.Path, name: str) -> None:
    models = home / "models"
    models.mkdir(exist_ok=True)
    (models / name).write_bytes(b"GGUF")


@pytest.fixture
def sidecar(hermes_home: pathlib.Path):
    (hermes_home / "config.yaml").write_text(OFF)
    proc = SidecarProcess(hermes_home)
    yield proc
    proc.close()


def test_staged_ggufs_are_the_local_models(sidecar: SidecarProcess, hermes_home: pathlib.Path) -> None:
    params = {"profile_home": str(hermes_home)}
    empty = sidecar.result("providers.local_models", params)
    assert_matches("providers.local_models", empty)
    assert empty == {"provider_id": "llamacpp", "models": [], "current_endpoint": None}

    _stage(hermes_home, "tiny-test-Q4_K_M.gguf")
    _stage(hermes_home, "notes.txt")
    staged = sidecar.result("providers.local_models", params)
    assert_matches("providers.local_models", staged)
    assert staged == {"provider_id": "llamacpp", "models": ["tiny-test-Q4_K_M"], "current_endpoint": None}


def test_a_turn_on_the_local_provider_with_its_server_off_is_local_runtime_unavailable(sidecar: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _stage(hermes_home, "tiny-test-Q4_K_M.gguf")
    home = str(hermes_home)
    message, _ = sidecar.call("providers.resolve_runtime", {"profile_home": home, "requested": "llamacpp", "target_model": "tiny-test-Q4_K_M"})
    assert message["error"]["data"]["condition"] == "local_runtime_unavailable", message
    assert "turned off" in message["error"]["message"]
    # The profile's own provider, when the turn names none.
    message, _ = sidecar.call("providers.resolve_runtime", {"profile_home": home})
    assert message["error"]["data"]["condition"] == "local_runtime_unavailable", message
    # The inference-provider environment, when neither the turn nor the profile names one.
    (hermes_home / "config.yaml").write_text("local_runtime:\n  enabled: false\n")
    env = SidecarProcess(hermes_home, env={"HERMES_INFERENCE_PROVIDER": "llama.cpp"})
    try:
        message, _ = env.call("providers.resolve_runtime", {"profile_home": home, "target_model": "tiny-test-Q4_K_M"})
    finally:
        env.close()
    assert message["error"]["data"]["condition"] == "local_runtime_unavailable", message
    (hermes_home / "config.yaml").write_text(OFF)

    message, _ = sidecar.call("chat.start", {"profile_home": home, "session_id": "sess-local", "stream_id": "st-local", "user_message": "hi",
                                             "workspace": home, "conversation_history": [], "model": "tiny-test-Q4_K_M", "model_provider": "llamacpp"})
    assert message["error"]["data"]["condition"] == "local_runtime_unavailable", message
    assert "turned off" in message["error"]["message"]
