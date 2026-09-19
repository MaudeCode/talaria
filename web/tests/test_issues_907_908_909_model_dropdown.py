"""Regression tests for issues #907, #908, #909 — model dropdown fixes."""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# ── #907: Normalized dedup in _addLiveModelsToSelect ─────────────────────────

# ── #908: window._defaultModel updated on settings save ─────────────────────

# ── #909: Injected default model label quality ───────────────────────────────

class TestIssue909InjectedModelLabel:
    """The server must use a proper label for the injected default model (not raw lowercase ID)."""

    def test_get_label_for_model_helper_exists(self):
        import api.config as config
        assert hasattr(config, '_get_label_for_model'), (
            "api/config.py must define _get_label_for_model() for the injected default label (#909)"
        )

    def test_label_helper_capitalizes_bare_id(self):
        from api.config import _get_label_for_model
        label = _get_label_for_model('minimax/minimax-m2.7', [])
        assert label != 'minimax-m2.7', (
            "_get_label_for_model should not return the raw lowercase ID (#909)"
        )
        # Should capitalize: "Minimax M2.7" or similar
        assert label[0].isupper(), "Label should start with an uppercase letter"

    def test_label_helper_uses_catalog_when_available(self):
        from api.config import _get_label_for_model
        existing_groups = [
            {"provider": "Nous", "models": [
                {"id": "minimax/minimax-m2.7", "label": "Minimax M2.7 (Nous)"}
            ]}
        ]
        label = _get_label_for_model('minimax/minimax-m2.7', existing_groups)
        assert label == "Minimax M2.7 (Nous)", (
            "_get_label_for_model should prefer catalog label over generated one"
        )

    def test_label_helper_strips_at_prefix_for_lookup(self):
        from api.config import _get_label_for_model
        existing_groups = [
            {"provider": "Nous", "models": [
                {"id": "minimax/minimax-m2.7", "label": "Minimax M2.7"}
            ]}
        ]
        # @nous:minimax/minimax-m2.7 should match minimax/minimax-m2.7 in catalog
        label = _get_label_for_model('@nous:minimax/minimax-m2.7', existing_groups)
        assert label == "Minimax M2.7", (
            "_get_label_for_model must strip @provider: prefix before catalog lookup"
        )

    def test_config_uses_label_helper_not_raw_split(self):
        from pathlib import Path
        config_src = (Path(__file__).resolve().parent.parent / "api" / "config.py").read_text()
        # The raw label-building pattern should be replaced by the helper
        assert "_get_label_for_model" in config_src, (
            "api/config.py must call _get_label_for_model() for injected default model labels (#909)"
        )
        # The old raw pattern should NOT be present in the injection block
        old_pattern = 'default_model.split("/")[-1] if "/" in default_model else default_model'
        label_sections = [
            config_src[i:i+200]
            for i in [m.start() for m in re.finditer(r'label\s*=\s*', config_src)]
        ]
        for sec in label_sections:
            assert old_pattern not in sec, (
                "api/config.py still uses raw split-based label for injected default model (#909)"
            )
