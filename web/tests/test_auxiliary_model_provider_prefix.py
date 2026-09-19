"""Regression coverage for provider-qualified auxiliary model persistence.

``GET /api/models`` may expose WebUI-only ``@provider:model`` routing IDs, but
auxiliary configuration stores provider and model in separate fields.  The
provider-native model value must be used by both the settings UI and the shared
backend persistence boundary.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[1]
PANELS_JS_PATH = REPO / "static" / "panels.js"
NODE = shutil.which("node")


@pytest.mark.parametrize(
    ("provider", "requested_model", "persisted_model"),
    [
        (
            "my-local-ai-gateway",
            "@my-local-ai-gateway:example-side-model",
            "example-side-model",
        ),
        (
            "custom",
            "@custom:router-alias:chat-model",
            "router-alias:chat-model",
        ),
        ("custom:backup", "@custom:backup:model:free", "model:free"),
        (
            "my-local-ai-gateway",
            "vendor/example-model",
            "vendor/example-model",
        ),
        (
            "my-local-ai-gateway",
            "example-side-model",
            "example-side-model",
        ),
    ],
)
def test_set_auxiliary_model_persists_provider_native_model(
    monkeypatch,
    tmp_path,
    provider,
    requested_model,
    persisted_model,
):
    from api import config

    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "auxiliary:\n  vision:\n    provider: auto\n    model: ''\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(config, "reload_config", lambda: None)
    monkeypatch.setattr(
        config,
        "resolve_model_provider",
        lambda model: (model, provider, None),
    )

    result = config.set_auxiliary_model("vision", provider, requested_model)

    saved = config._load_yaml_config_file(config_path)["auxiliary"]["vision"]
    assert saved["provider"] == provider
    assert saved["model"] == persisted_model
    assert result["provider"] == provider
    assert result["model"] == persisted_model


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("my-local-ai-gateway", "@other-gateway:other-model"),
        ("my-local-ai-gateway", "@my-local-ai-gateway:"),
        ("auto", "@my-local-ai-gateway:example-side-model"),
    ],
)
def test_set_auxiliary_model_rejects_invalid_qualified_pair_without_write(
    monkeypatch,
    tmp_path,
    provider,
    model,
):
    from api import config

    config_path = tmp_path / "config.yaml"
    original = (
        "auxiliary:\n"
        "  vision:\n"
        "    provider: openai\n"
        "    model: gpt-5.5\n"
    )
    config_path.write_text(original, encoding="utf-8")
    monkeypatch.setattr(config, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(config, "reload_config", lambda: None)

    with pytest.raises(ValueError, match="provider-qualified auxiliary model"):
        config.set_auxiliary_model("vision", provider, model)

    assert config_path.read_text(encoding="utf-8") == original
