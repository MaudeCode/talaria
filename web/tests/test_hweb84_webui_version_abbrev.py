"""HWEB-84 — WEBUI_VERSION must not change shape when it is recomputed.

`git describe` defaults to `core.abbrev=auto`, sizing the short SHA from the
repository's object count, so the same commit can describe as `a42c991` in one
process and `a42c9917` in another. `WEBUI_VERSION` is computed once at import,
but `tests/test_issue1579_whats_new_link_404.py` drops `api.updates` from
`sys.modules` and re-imports it, which recomputes the constant. An earlier
`from api.updates import WEBUI_VERSION` keeps the old string while a late
in-function import — the `/sw.js` route does exactly that — reads the new one.

On CI the two disagreed and `/sw.js` served a cache name the test did not expect.

The load-bearing test here is `test_describe_is_stable_when_the_repo_abbrev_changes`:
it drives git's own `core.abbrev` knob, which is what `auto` resolves to, and so
fails against an unpinned `_describe_git_version` rather than merely restating
the implementation.
"""

from __future__ import annotations

import importlib
import pathlib
import re
import subprocess
import sys

import pytest

from api import updates


REPO_ROOT = pathlib.Path(__file__).parent.parent


def _git(repo: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30
    )


@pytest.fixture
def tagless_repo(tmp_path):
    """A committed, tagless checkout — the shape CI's shallow clone leaves behind."""
    if not updates._resolve_git_executable():
        pytest.skip("git executable not available")
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "Test")
    (repo / "f.txt").write_text("x", encoding="utf-8")
    _git(repo, "add", "f.txt")
    made = _git(repo, "commit", "-q", "-m", "initial")
    if made.returncode != 0:
        pytest.skip(f"could not create a test repo: {made.stderr[:200]}")
    return repo


def _sha_of(described: str) -> str:
    """Return the object-name part of a describe string.

    Tagless `--always` output is the bare abbreviated sha; tagged output ends in
    `-g<sha>`. An exact tag has no object name at all.
    """
    return described.rsplit("-g", 1)[-1] if "-g" in described else described


def test_describe_is_stable_when_the_repo_abbrev_changes(tagless_repo):
    """The real regression: two describes of one commit must agree.

    `core.abbrev` is exactly what `auto` resolves to, so setting it is a faithful
    stand-in for the object-count growth that moved it on CI — and it fails
    against the unpinned helper, which honours the config.
    """
    _git(tagless_repo, "config", "core.abbrev", "7")
    first = updates._describe_git_version(tagless_repo)
    _git(tagless_repo, "config", "core.abbrev", "12")
    second = updates._describe_git_version(tagless_repo)

    assert first and second
    assert first == second, (
        "_describe_git_version() followed the repository's abbrev setting, so two "
        "computations of the same commit disagree — this is what let the /sw.js "
        f"route and its test see different versions ({first!r} vs {second!r})"
    )
    assert re.fullmatch(r"[0-9a-f]{8}", _sha_of(first)), (
        f"expected a pinned 8-character object name, got {first!r}"
    )


def test_detect_webui_version_is_stable_across_a_reimport(tagless_repo, monkeypatch):
    """Replay the sequence the shard hit, with the abbrev moving underneath it.

    A bare re-import cannot fail on its own — nothing changes between the two
    computations — so this drives the same knob to make the re-import meaningful.
    """
    monkeypatch.setattr(updates, "REPO_ROOT", tagless_repo)
    _git(tagless_repo, "config", "core.abbrev", "7")
    bound = updates._detect_webui_version()
    _git(tagless_repo, "config", "core.abbrev", "12")
    late = updates._detect_webui_version()

    assert bound == late, (
        "a re-import of api.updates would rebind WEBUI_VERSION to a different "
        "string, so a module-level binding and a late in-function import disagree"
    )


def test_reimport_leaves_one_live_api_updates_module():
    """Guard the isolation this file's own re-import could break.

    Restoring only `sys.modules['api.updates']` would leave the `api` package
    attribute pointing at the second module, so `from api import updates` and
    `importlib.import_module('api.updates')` would return different objects with
    separate caches.
    """
    import api

    first = sys.modules["api.updates"]
    del sys.modules["api.updates"]
    try:
        second = importlib.import_module("api.updates")
        assert second is not first
    finally:
        sys.modules["api.updates"] = first
        api.updates = first

    from api import updates as via_package

    assert via_package is first
    assert importlib.import_module("api.updates") is first


def test_describe_passes_the_pinned_flag_to_git(tagless_repo, monkeypatch):
    """The flag must reach git, not just exist as a constant."""
    seen = []
    real = updates._run_git

    def _record(args, cwd, **kwargs):
        seen.append(list(args))
        return real(args, cwd, **kwargs)

    monkeypatch.setattr(updates, "_run_git", _record)
    updates._describe_git_version(tagless_repo)

    describe = next((a for a in seen if a and a[0] == "describe"), None)
    assert describe is not None, seen
    assert f"--abbrev={updates._GIT_DESCRIBE_ABBREV}" in describe


def test_real_checkout_describes_to_a_pinned_width():
    """End-to-end on this repository, whatever shape its describe takes."""
    described = updates._describe_git_version(REPO_ROOT)
    if not described:
        pytest.skip("git describe unavailable in this checkout")
    base = described.split("-dirty-", 1)[0]
    if "-g" not in base:
        # An exact tag carries no object name; --abbrev does not replace it.
        assert base, described
        return
    assert re.fullmatch(r"[0-9a-f]{8}", _sha_of(base)), described
