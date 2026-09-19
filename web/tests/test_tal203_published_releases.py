from copy import deepcopy
import urllib.request

import pytest

from api import talaria_releases as releases


def published_fixture(monkeypatch):
    sha = "a" * 40
    manifest = {
        "schemaVersion": 1, "releaseSet": sha, "status": "complete",
        "contracts": {"appWeb": {"web": [1]}, "webRelay": {"web": [2]}},
        "agent": {"version": "0.21.3", "sourceRevision": "d" * 40},
        "components": {"web": {
            "tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": sha,
            "releaseSet": sha, "image": "ghcr.io/maudecode/talaria-web@sha256:" + "b" * 64,
            "upstreamBase": "e" * 40,
        }},
    }
    entries = [
        {"tag_name": "web-v99.0.0", "published_at": "synthetic", "assets": []},
        {"tag_name": "release-set-" + "c" * 40, "published_at": None, "draft": True},
        {"tag_name": "release-set-" + sha, "published_at": "synthetic", "assets": [{"name": "release-set.json", "id": 123}]},
    ]
    requests = []

    def get_json(path, *, asset=False):
        requests.append((path, asset))
        assert path in ("/releases?per_page=100&page=1", "/releases/assets/123")
        return manifest if asset else entries

    monkeypatch.setattr(releases, "_get_json", get_json)
    return manifest, entries, requests


def test_only_completed_release_sets_advertise_updates(monkeypatch):
    manifest, _, requests = published_fixture(monkeypatch)
    result = releases.published_web_release()
    assert result["tag"] == "web-v2.0.0"
    assert result["sourceRevision"] == manifest["releaseSet"]
    assert requests == [("/releases?per_page=100&page=1", False), ("/releases/assets/123", True)]
    assert "MaudeCode/talaria/releases/tag/release-set-" in result["release_url"]


@pytest.mark.parametrize("field,value", [("status", "candidate"), ("releaseSet", "main"), ("schemaVersion", 2)])
def test_rejects_partial_or_inconsistent_manifests(monkeypatch, field, value):
    manifest, _, _ = published_fixture(monkeypatch)
    manifest[field] = value
    with pytest.raises(releases.ReleaseUnavailable):
        releases.published_web_release()


@pytest.mark.parametrize("field,value", [("sourceRevision", "main"), ("version", "3.0.0"), ("image", "ghcr.io/maudecode/talaria-web:latest"), ("releaseSet", "d" * 40)])
def test_rejects_mutable_web_references(monkeypatch, field, value):
    manifest, _, _ = published_fixture(monkeypatch)
    manifest["components"]["web"][field] = value
    with pytest.raises(releases.ReleaseUnavailable):
        releases.published_web_release()


def test_experimental_channel_and_unchanged_web_identity(monkeypatch):
    manifest, entries, _ = published_fixture(monkeypatch)
    old_web = deepcopy(manifest["components"]["web"])
    manifest["releaseSet"] = "e" * 40
    entries[-1]["tag_name"] = "release-set-" + manifest["releaseSet"]
    assert releases.published_web_release()["releaseSet"] == old_web["releaseSet"]
    manifest["components"]["web"]["tag"] = "web-exp-v2.0.0"
    assert releases.published_web_release("experimental")["tag"] == "web-exp-v2.0.0"
    with pytest.raises(releases.ReleaseUnavailable):
        releases.published_web_release("stable")


def test_download_redirect_cannot_forward_private_repo_token():
    request = urllib.request.Request(releases.API_ROOT + "/releases/assets/123", headers={"Authorization": "Bearer synthetic-private-token"})
    handler = releases._AssetRedirect()
    redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/synthetic")
    assert redirected.get_header("Authorization") is None
    for url in ("http://release-assets.githubusercontent.com/synthetic", "https://attacker.example/synthetic"):
        with pytest.raises(releases.ReleaseUnavailable):
            handler.redirect_request(request, None, 302, "Found", {}, url)


def test_selects_publication_order_not_response_array_order(monkeypatch):
    manifest, entries, _ = published_fixture(monkeypatch)
    older = deepcopy(manifest)
    older["releaseSet"] = "c" * 40
    entries[-1]["published_at"] = "2026-09-19T00:00:00Z"
    entries.insert(0, {"tag_name": "release-set-" + "c" * 40,
                      "published_at": "2026-09-18T00:00:00Z",
                      "assets": [{"name": "release-set.json", "id": 456}]})
    monkeypatch.setattr(releases, "_get_json", lambda path, asset=False: (
        manifest if path.endswith("/123") else older if path.endswith("/456") else entries
    ))
    assert releases.published_web_release()["manifestReleaseSet"] == manifest["releaseSet"]


@pytest.mark.parametrize("broken", [None, [], "invalid"])
def test_malformed_component_metadata_is_unavailable(monkeypatch, broken):
    manifest, _, _ = published_fixture(monkeypatch)
    manifest["components"] = broken
    with pytest.raises(releases.ReleaseUnavailable):
        releases.published_web_release()


def test_history_lookup_stops_at_its_deadline(monkeypatch):
    _, _, requests = published_fixture(monkeypatch)
    clock = iter([0, 0, 16])
    monkeypatch.setattr(releases, "monotonic", lambda: next(clock))
    with pytest.raises(releases.ReleaseUnavailable, match="deadline"):
        releases.published_web_release()
    assert len(requests) == 1
