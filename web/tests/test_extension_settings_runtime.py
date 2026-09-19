"""Runtime tests for browser-local extension settings."""

from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest


ROOT = Path(__file__).parent.parent
EXTENSION_SETTINGS_JS = ROOT / "static" / "extension_settings.js"


def _run_node(script: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is required for extension settings runtime tests")
    result = subprocess.run(
        [node, "-e", script],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_documented_configure_consumer_is_safe_on_older_core_without_register_configure():
    """The EXTENSIONS.md consumer pattern must not throw on an OLDER E0 Core
    build where ``register()`` and ``settings`` exist but ``registerConfigure``
    does not — the optional-chained form ``ext?.settings?.registerConfigure?.()``
    degrades to ``undefined`` instead of a TypeError, so extension init survives.
    Regression for the doc example at docs/EXTENSIONS.md (#7111 gate)."""
    script = textwrap.dedent(
        """
        const assert = require('assert');

        // Simulate an OLDER boot-trusted E0 handle: register() returns an ext
        // whose settings object has NO registerConfigure (the capability the
        // current Core adds). This is exactly what a pre-#7111 Core exposes.
        global.window = {
          hermesExt: {
            register(id) {
              return { id, settings: { get() { return null; }, set() { return false; } } };
            }
          }
        };

        let initReached = false;
        // The documented consumer pattern, verbatim from docs/EXTENSIONS.md.
        const ext = window.hermesExt?.register?.("dictionary-manager");
        const unregister = ext?.settings?.registerConfigure?.(({ opener, restoreFocus }) => {
          // never called on old Core
          return true;
        });
        initReached = true;  // must be reached — no throw above

        assert.strictEqual(initReached, true, 'extension init must survive missing registerConfigure');
        assert.strictEqual(unregister, undefined, 'registerConfigure absent => optional call yields undefined');

        // Sanity: the UNGUARDED form WOULD throw, proving the guard is load-bearing.
        let threw = false;
        try {
          ext.settings.registerConfigure(() => {});
        } catch (e) {
          threw = true;
        }
        assert.strictEqual(threw, true, 'unguarded call is expected to throw on old Core (guard is required)');
        """
    )
    _run_node(script)
