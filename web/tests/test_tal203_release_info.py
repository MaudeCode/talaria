import json
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest

from api import release_info, routes


def test_health_reports_development_without_claiming_a_release(monkeypatch):
    responses = []
    monkeypatch.setattr(routes, "j", lambda handler, payload, **kwargs: responses.append(payload))
    routes._handle_health(None, SimpleNamespace(query=""))
    metadata = responses[0]["release"]
    assert metadata["sourceRevision"] is None
    assert metadata["releaseSet"] is None
    assert metadata["contracts"] == {"appWeb": [1], "webRelay": [2]}
    assert metadata["compatibleAgent"] == release_info.COMPATIBLE_AGENT


def test_packaged_contract_versions_match_canonical_source():
    root = Path(__file__).resolve().parents[2]
    assert json.loads((root / "web/api/contract_versions.json").read_text()) == json.loads((root / "contracts/versions.json").read_text())


def test_stamped_release_metadata_is_validated(tmp_path):
    path = tmp_path / "release.json"
    document = {
        "tag": "web-v2.1.0",
        "version": "2.1.0", "sourceRevision": "a" * 40, "releaseSet": "a" * 40,
        "upstreamBase": "b" * 40, "contracts": {"appWeb": [1], "webRelay": [2]},
        "compatibleAgent": release_info.COMPATIBLE_AGENT,
    }
    path.write_text(json.dumps(document))
    assert release_info.load_release_info(path) == document
    document["tag"] = "web-exp-v2.1.0"
    path.write_text(json.dumps(document))
    assert release_info.load_release_info(path)["tag"] == "web-exp-v2.1.0"
    for field, value in (("sourceRevision", "main"), ("releaseSet", "c" * 40), ("compatibleAgent", {}), ("contracts", {}), ("version", "latest"), ("secret", "must not be exposed")):
        path.write_text(json.dumps({**document, field: value}))
        with pytest.raises(ValueError):
            release_info.load_release_info(path)


@pytest.mark.parametrize("component", ["app", "web", "relay"])
def test_stamp_requires_clean_exact_checkout_and_cannot_overwrite(tmp_path, component):
    root = Path(__file__).resolve().parents[2]
    for relative in ("scripts/stamp-release.py", "web/api/__init__.py", "web/api/release_info.py", "web/api/agent_dependency.json", "web/api/contract_versions.json", "contracts/versions.json", "relay/convex/releaseInfo.json", "app/Talaria/Resources/Info.plist", "app/TalariaLiveActivityWidget/Resources/Info.plist"):
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, target)
    (tmp_path / ".gitignore").write_text("__pycache__/\nweb/api/_release.json\n")
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], cwd=tmp_path, check=True)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True).strip()
    (tmp_path / "web/UPSTREAM_BASE_SHA").write_text(sha + "\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "record upstream"], cwd=tmp_path, check=True)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True).strip()
    command = [sys.executable, str(tmp_path / "scripts/stamp-release.py"), component, "--version", "2.1.0", "--source-revision", sha]
    if component == "relay":
        assert subprocess.run(command, capture_output=True).returncode != 0
        command += ["--deployment-id", "synthetic-relay"]
    elif component == "app":
        assert subprocess.run(command, capture_output=True).returncode != 0
        command += ["--build-number", "321"]
    dirty = tmp_path / "untracked.txt"
    dirty.write_text("must not enter release")
    assert subprocess.run(command, capture_output=True).returncode != 0
    dirty.unlink()
    wrong_source = ["b" * 40 if word == sha else word for word in command]
    assert subprocess.run(wrong_source, capture_output=True).returncode != 0
    metadata = json.loads(subprocess.check_output(command, text=True))
    assert metadata["sourceRevision"] == sha
    assert metadata["releaseSet"] == sha
    if component == "app":
        for bundle in ("Talaria", "TalariaLiveActivityWidget"):
            info = plistlib.loads((tmp_path / f"app/{bundle}/Resources/Info.plist").read_bytes())
            assert info["TalariaRelease"] == metadata
            assert info["CFBundleVersion"] == "321"
            assert info["CFBundleShortVersionString"] == "2.1.0"
    else:
        destination = "web/api/_release.json" if component == "web" else "relay/convex/releaseInfo.json"
        assert json.loads((tmp_path / destination).read_text()) == metadata
    assert subprocess.run(command, capture_output=True).returncode != 0
