"""HWEB-40: repeated per-request reads must not redo the work each time.

Two chokepoints, both reached many times per request or per turn:

  * ``_read_raw_settings_file`` backs every ``load_settings()`` call (at least
    one per ``GET /api/sessions``). It must read and parse settings.json once
    per on-disk generation — while still picking up a change with no restart.
  * the per-turn SKILL.md scan must not descend vendored dependency trees, and
    the skill-delete lookup built on it must not match a vendored ``SKILL.md``.
"""

import json

import pytest

from api import config as cfg
from api.streaming import _iter_skill_md_pruned


class _CountingSettingsFile:
    """Proxy for config.SETTINGS_FILE that counts real reads of the file.

    Only the attributes ``_read_raw_settings_file`` and its callers touch are
    forwarded, so an unexpected new access fails loudly rather than silently
    escaping the count.
    """

    def __init__(self, path):
        self._path = path
        self.reads = 0

    def stat(self):
        return self._path.stat()

    def exists(self):
        return self._path.exists()

    def read_text(self, **kwargs):
        self.reads += 1
        return self._path.read_text(**kwargs)

    @property
    def parent(self):
        return self._path.parent

    def __fspath__(self):
        return str(self._path)

    def __str__(self):
        return str(self._path)


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"marker": "aaa"}), encoding="utf-8")
    proxy = _CountingSettingsFile(path)
    monkeypatch.setattr(cfg, "SETTINGS_FILE", proxy)
    monkeypatch.setattr(cfg, "_settings_file_cache", {})
    return proxy


def test_repeated_load_settings_reads_the_file_once(settings_file):
    for _ in range(10):
        assert cfg.load_settings()["marker"] == "aaa"

    assert settings_file.reads == 1


def test_settings_change_is_picked_up_without_a_restart(settings_file):
    assert cfg.load_settings()["marker"] == "aaa"

    settings_file._path.write_text(json.dumps({"marker": "bbb"}), encoding="utf-8")

    assert cfg.load_settings()["marker"] == "bbb"
    assert settings_file.reads == 2


def test_atomic_replace_that_restores_mtime_is_still_seen(settings_file):
    """A same-size rename-into-place must not serve the previous parse forever."""
    original_stat = settings_file._path.stat()
    assert cfg.load_settings()["marker"] == "aaa"

    replacement = settings_file._path.parent / "next.json"
    # Same byte length as the original so (mtime, size) alone cannot tell the
    # two generations apart once the mtime is restored.
    replacement.write_text(json.dumps({"marker": "bbb"}), encoding="utf-8")
    replacement.replace(settings_file._path)
    import os

    os.utime(
        settings_file._path,
        ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
    )

    assert cfg.load_settings()["marker"] == "bbb"


def test_cached_settings_are_not_shared_with_callers(settings_file):
    settings_file._path.write_text(
        json.dumps({"marker": "aaa", "nested": {"keep": 1}}), encoding="utf-8"
    )

    first = cfg.load_settings()
    first["nested"]["keep"] = 999

    assert cfg.load_settings()["nested"] == {"keep": 1}


def _make_skill(root, *parts):
    skill_dir = root.joinpath(*parts)
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text("---\nname: x\n---\n", encoding="utf-8")
    return skill_dir


def test_skill_scan_skips_vendored_trees(tmp_path):
    skills_dir = tmp_path / "skills"
    real = _make_skill(skills_dir, "deploy")
    _make_skill(skills_dir, "deploy", "node_modules", "some-pkg", "deploy")
    _make_skill(skills_dir, "deploy", ".git", "deploy")

    assert list(_iter_skill_md_pruned(skills_dir)) == [real / "SKILL.md"]


def test_skill_scan_on_missing_dir_yields_nothing(tmp_path):
    assert list(_iter_skill_md_pruned(tmp_path / "absent")) == []
