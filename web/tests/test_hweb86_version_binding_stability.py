"""HWEB-86: one `api.updates` module per session, and `/sw.js` serves its version.

`tests/test_static_asset_resolver.py::test_service_worker_and_favicon_follow_selected_static_root`
failed intermittently in CI on a one-character version mismatch
(`13e27baa` served vs `13e27ba` expected). The cause was two live `api.updates`
module objects: `tests/test_issue1579_whats_new_link_404.py` dropped the module
from `sys.modules` and re-imported it, so a module that had bound
`WEBUI_VERSION` at import time held a value from the first instance while
product code read the second one's. `WEBUI_VERSION` is computed once per module
execution from `git describe --tags --always`, and on CI's tagless checkout that
falls back to a bare abbreviated SHA whose length git picks from prefix
ambiguity — so the two instances could disagree by one hex digit.
"""
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import api.updates

ROOT = Path(__file__).resolve().parent.parent


def test_evicting_api_updates_restores_the_original_module():
    """An unrestored eviction splits the module the next time anything imports it.

    `from api import updates` reads the attribute off the `api` package and does
    NOT re-execute, so the evicting test passes and the missing `sys.modules`
    entry goes unnoticed. The split happens later: product code doing a dotted
    `from api.updates import WEBUI_VERSION` finds nothing in `sys.modules` and
    re-executes the module, recomputing the version from a fresh `git describe`.
    """
    original = sys.modules["api.updates"]
    with patch.dict(sys.modules):
        sys.modules.pop("api.updates", None)
        from api import updates as attribute_import

        assert attribute_import is original, (
            "`from api import updates` reads the package attribute; it cannot "
            "detect the eviction, which is why this leak stayed invisible"
        )
    assert sys.modules["api.updates"] is original

    # The route's form, run after a properly restored eviction, must reuse the
    # one live module rather than re-executing it.
    from api.updates import WEBUI_VERSION as after_eviction

    assert sys.modules["api.updates"] is original, (
        "a dotted import re-executed api.updates: WEBUI_VERSION would be "
        "recomputed and could disagree with every value bound before now"
    )
    assert after_eviction == original.WEBUI_VERSION


def test_module_cache_and_package_attribute_agree():
    """The observable invariant: one module object, referenced consistently.

    A leaked eviction shows up here as `sys.modules` and the `api` package
    attribute pointing at different objects, whatever spelling caused it.
    """
    import api as api_package

    assert sys.modules["api.updates"] is api_package.updates
    assert sys.modules["api.updates"] is api.updates

    # The route's form must reuse that module rather than executing a second copy.
    before = sys.modules["api.updates"]
    from api.updates import WEBUI_VERSION

    assert sys.modules["api.updates"] is before
    assert api_package.updates is before
    assert WEBUI_VERSION == before.WEBUI_VERSION


def test_sw_js_serves_the_version_the_app_currently_reports(tmp_path, monkeypatch):
    """/sw.js must stamp the live WEBUI_VERSION, not one captured earlier."""
    import api.config as api_config

    static_root = tmp_path / "static"
    (static_root / "dist").mkdir(parents=True)
    (static_root / "dist" / "sw.js").write_text(
        "const version = '__WEBUI_VERSION__';\n", encoding="utf-8"
    )
    monkeypatch.setattr(api_config, "get_static_root", lambda: static_root)
    monkeypatch.setattr(api.updates, "WEBUI_VERSION", "vTEST-hweb86")

    handler = _get("/sw.js")
    assert handler.status == 200
    assert bytes(handler.body) == b"const version = 'vTEST-hweb86';\n"


def test_version_detection_handles_a_tagless_checkout(tmp_path):
    """Exercise the CI-only branch against a repository that really has no tags.

    A developer checkout has tags, so `git describe --tags --always` returns a
    descriptor and the bare-SHA fallback never runs locally — which is why the
    split only ever surfaced in CI. Build a tagless repo and drive the product
    helper through it, rather than asserting git's own `--always` guarantee.
    """
    repo = tmp_path / "tagless"
    repo.mkdir()

    def git(*args):
        result = subprocess.run(
            ["git", *args], cwd=str(repo), capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    git("init", "--quiet")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "HWEB-86 test")
    # Pin the abbreviation: with a global `core.abbrev=40`, `git describe
    # --always` legitimately returns the full object id and the shortening
    # assertion below would fail on a correctly working helper.
    git("config", "core.abbrev", "7")
    (repo / "file.txt").write_text("hweb86\n", encoding="utf-8")
    git("add", "file.txt")
    git("commit", "--quiet", "-m", "initial")

    assert git("tag") == "", "the repository under test must be tagless"

    described = api.updates._describe_git_version(repo)
    assert described, "_describe_git_version must resolve a tagless checkout"

    head = git("rev-parse", "HEAD")
    assert head.startswith(described), (
        f"expected an abbreviated SHA of {head}, got {described!r} — the tagless "
        "branch must fall back to the bare commit id"
    )
    assert described != head, (
        "expected the abbreviated form, not the full SHA (core.abbrev is pinned "
        "to 7 above so this does not depend on the developer's git config)"
    )


# Reuse the request harness from the sibling resolver test rather than rebuilding it.
from tests.test_static_asset_resolver import _get  # noqa: E402
