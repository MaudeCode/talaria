#!/usr/bin/env python3
"""Prove prefix-aware merges preserve downstream edits and reject dirty state."""

import os
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile


SCRIPT = Path(__file__).with_name("import-web-upstream").resolve()


def main():
    with tempfile.TemporaryDirectory(prefix="talaria-import-") as temporary:
        root = Path(temporary)
        env = {
            "PATH": os.environ["PATH"], "HOME": temporary,
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Fixture", "GIT_COMMITTER_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-02T03:04:05+00:00",
            "GIT_COMMITTER_DATE": "2026-01-02T03:04:05+00:00",
        }

        def git(repo, *args):
            return subprocess.check_output(
                ["git", "-C", str(repo), *args], env=env, text=True,
                stderr=subprocess.PIPE,
            ).strip()

        upstream = root / "upstream"
        git(root, "init", "-b", "main", str(upstream))
        (upstream / "server.py").write_text("upstream = 1\n")
        (upstream / "settings.py").write_text("setting = 1\n")
        (upstream / "legacy.py").write_text("# unchanged imported source\n")
        (upstream / "asset.bin").write_bytes(b"original\0asset")
        git(upstream, "add", ".")
        git(upstream, "commit", "-m", "initial upstream")
        original = git(upstream, "rev-parse", "HEAD")

        mono = root / "mono"
        git(root, "init", "-b", "main", str(mono))
        (mono / "app").mkdir()
        (mono / "app/App.swift").write_text("// app identity unchanged\n")
        git(mono, "add", ".")
        git(mono, "commit", "-m", "initial app")
        app_base = git(mono, "rev-parse", "HEAD")
        git(mono, "subtree", "add", "--prefix=web", str(upstream), original)
        web_import = git(mono, "rev-parse", "HEAD")
        (mono / "web/server.py").write_text("talaria = 2\n")
        (mono / "web/asset.bin").write_bytes(b"integrated\0asset")
        git(mono, "commit", "-am", "downstream server")
        (upstream / "settings.py").write_text("setting = 3\n")
        git(upstream, "commit", "-am", "selected upstream change")
        selected = git(upstream, "rev-parse", "HEAD")
        subprocess.run([str(SCRIPT), selected, str(upstream)], cwd=mono, env=env, check=True)
        assert (mono / "web/server.py").read_text() == "talaria = 2\n"
        assert (mono / "web/settings.py").read_text() == "setting = 3\n"
        assert (mono / "web/UPSTREAM_BASE_SHA").read_text().strip() == selected
        assert (mono / "app/App.swift").read_text() == "// app identity unchanged\n"
        assert not (mono / "settings.py").exists()
        git(mono, "commit", "-m", "import selected upstream change")
        git(mono, "merge-base", "--is-ancestor", selected, "HEAD")
        integration_tip = git(mono, "rev-parse", "HEAD")
        rejected = subprocess.run([str(SCRIPT), original, str(upstream)], cwd=mono, env=env,
                                  capture_output=True, text=True)
        assert rejected.returncode != 0 and "recorded Web base" in rejected.stderr
        assert (mono / "web/UPSTREAM_BASE_SHA").read_text().strip() == selected
        git(mono, "checkout", "-b", "released", app_base)
        git(mono, "merge", "--no-ff", "-m", "merge migration PR", integration_tip)
        merged_tip = git(mono, "rev-parse", "HEAD")
        spec = importlib.util.spec_from_file_location(
            "rehearsal", SCRIPT.with_name("rehearse-monorepo.py"),
        )
        rehearsal = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rehearsal)
        for index, target in enumerate((web_import, integration_tip, merged_tip)):
            rebuilt = root / f"rebuilt-{index}"
            git(root, "clone", "--no-checkout", str(mono), str(rebuilt))
            git(rebuilt, "checkout", "--detach", web_import)
            rehearsal.apply_integration_tree(mono, rebuilt, web_import, target, env)
            assert git(rebuilt, "write-tree") == git(mono, "rev-parse", f"{target}^{{tree}}")
            git(rebuilt, "merge-base", "--is-ancestor", original, "HEAD")
        (mono / "web/settings.py").write_text("uncommitted work\n")
        rejected = subprocess.run([str(SCRIPT), selected, str(upstream)], cwd=mono, env=env,
                                  capture_output=True, text=True)
        assert rejected.returncode != 0 and "local changes" in rejected.stderr
        assert (mono / "web/settings.py").read_text() == "uncommitted work\n"
        git(mono, "restore", "web/settings.py")
        (upstream / "server.py").write_text("upstream = 4\n")
        git(upstream, "commit", "-am", "conflicting upstream change")
        conflicting = git(upstream, "rev-parse", "HEAD")
        result = subprocess.run([str(SCRIPT), conflicting, str(upstream)], cwd=mono,
                                env=env, capture_output=True, text=True)
        assert result.returncode != 0
        assert git(mono, "diff", "--name-only", "--diff-filter=U") == "web/server.py"
        assert "talaria = 2" in (mono / "web/server.py").read_text()
        assert (mono / "app/App.swift").read_text() == "// app identity unchanged\n"
        (mono / "docs").mkdir()
        (mono / "docs/monorepo-sources.json").write_text(json.dumps({
            "webImportCommit": web_import, "sources": {"web": {"commit": original}},
        }))
        spec = importlib.util.spec_from_file_location(
            "ruff_lint", SCRIPT.parent.parent / "web/scripts/ruff_lint.py",
        )
        lint = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lint)
        lint.REPO_ROOT = str(mono / "web")
        baseline, changed = lint._changed_py_files(app_base)
        assert baseline == web_import
        assert set(changed) == {"server.py", "settings.py"}
        # Once the base already contains Web, metadata cannot skip new changes.
        baseline, _ = lint._changed_py_files("HEAD")
        assert baseline == git(mono, "rev-parse", "HEAD")
        (mono / "docs/monorepo-sources.json").write_text(json.dumps({
            "webImportCommit": baseline, "sources": {"web": {"commit": original}},
        }))
        try:
            lint._changed_py_files(app_base)
        except RuntimeError as error:
            assert "Invalid monorepo" in str(error)
        else:
            raise AssertionError("Modified Web tree was accepted as a pure import")
    print("Prefix-aware import, merged/binary rehearsal, ancestry, and dirty-state checks passed.")


if __name__ == "__main__":
    main()
