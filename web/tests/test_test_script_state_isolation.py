"""Regression checks for pre-Python test state isolation."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEST_SH = (ROOT / "scripts" / "test.sh").read_text(encoding="utf-8")
PIN_LIMIT_TEST = (ROOT / "tests" / "test_configurable_pinned_sessions_limit.py").read_text(
    encoding="utf-8"
)


def test_test_runner_overrides_live_state_before_starting_python():
    """A WebUI-spawned test run must not let early imports bind production state."""
    boundary = TEST_SH.index('PYTHON_BIN="$(select_python)"')
    prefix = TEST_SH[:boundary]

    assert "HERMES_WEBUI_TEST_STATE_DIR" in prefix
    assert "export HERMES_WEBUI_STATE_DIR=" in prefix
    assert "export HERMES_HOME=" in prefix
    assert "export HERMES_BASE_HOME=" in prefix
    assert "export HERMES_CONFIG_PATH=" in prefix
    assert "export HERMES_WEBUI_DEFAULT_WORKSPACE=" in prefix


def test_pin_limit_integration_tests_restore_observed_value():
    """Cleanup must not reset an operator's configured cap to the product default."""
    assert 'original_limit = get("/api/settings")' in PIN_LIMIT_TEST
    assert 'restore_pin_limit(original_limit)' in PIN_LIMIT_TEST
    assert 'post("/api/settings", {"pinned_sessions_limit": 3})' not in PIN_LIMIT_TEST
