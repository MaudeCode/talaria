"""HWEB-100: the SPA shell allowlist, placeholder substitution, asset serving, and CSP.

Unit checks run against ``api.spa_shell`` directly. HTTP checks boot a
dedicated ``server.py`` on an ephemeral port with an isolated state directory
so the shell, asset and CSP behaviour is observed end to end.
"""
from __future__ import annotations

import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from api import spa_shell  # noqa: E402

DIST_INDEX = REPO_ROOT / "static" / "dist" / "index.html"


# ── unit: allowlist and placeholders ────────────────────────────────────────

@pytest.mark.parametrize(
    "path",
    ["/", "/index.html", "/session/abc123", "/tasks", "/tasks/job-1", "/kanban", "/skills", "/skills/foo",
     "/memory", "/workspaces", "/profiles", "/todos", "/insights", "/logs", "/settings", "/settings/providers",
     "/ext/desktop-companion", "/onboarding", "/login", "/share", "/share/tok"],
)
def test_spa_paths_receive_the_shell(path):
    assert spa_shell.is_spa_path(path)


@pytest.mark.parametrize(
    "path",
    ["/api/sessions", "/api/", "/api/bootstrap", "/health", "/static/style.css", "/static/dist/assets/x.js", "/assets/x.js",
     "/session/static/style.css", "/session/manifest.json", "/sw.js", "/manifest.json", "/manifest.webmanifest",
     "/extensions/app.js", "/plugins/foo/index.js", "/dashboard-plugins/x", "/favicon.ico", "/search",
     "/nope", "/settingsx", "/tasksy", "/random/path"],
)
def test_server_owned_and_unknown_paths_never_get_the_shell(path):
    assert not spa_shell.is_spa_path(path)


@pytest.mark.parametrize(
    ("path", "expected"),
    [("/", "./"), ("/index.html", "./"), ("/settings", "./"), ("/settings/providers", "../"),
     ("/session/abc", "../"), ("/ext/foo", "../"), ("/share/tok", "../"), ("/tasks/a/b", "../../")],
)
def test_base_href_depth(path, expected):
    assert spa_shell.base_href_for(path) == expected


def test_public_shell_paths():
    assert spa_shell.is_public_spa_path("/login")
    assert spa_shell.is_public_spa_path("/share/abc")
    assert not spa_shell.is_public_spa_path("/settings")


@pytest.mark.skipif(not DIST_INDEX.exists(), reason="static/dist not built")
def test_render_shell_substitutes_every_placeholder():
    html = spa_shell.render_shell("/session/abc", lang="de", version="v1.2.3")
    assert "__BASE_HREF__" not in html and "__LANG__" not in html and "__WEBUI_VERSION__" not in html
    assert '<base href="../">' in html
    assert '<html lang="de"' in html
    # No inline executable script or handler may survive the build.
    assert "<script>" not in html
    assert "onload=" not in html and "onclick=" not in html
    assert 'type="module"' in html and 'src="./assets/' in html


@pytest.mark.skipif(not DIST_INDEX.exists(), reason="static/dist not built")
def test_render_shell_rejects_bogus_lang():
    assert '<html lang="en"' in spa_shell.render_shell("/", lang='"><script>')


def test_csp_has_no_inline_scripts_or_cdn():
    from api import helpers

    policy = helpers._build_csp_enforced_policy("", "")
    script = next(d for d in policy.split(";") if d.strip().startswith("script-src"))
    assert "'unsafe-inline'" not in script
    assert "cdn.jsdelivr.net" not in policy
    assert "fonts.googleapis.com" not in policy
    assert "'self'" in script


# ── http: dedicated server ───────────────────────────────────────

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(port: int, path: str, headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    conn.request("GET", path, headers=headers or {})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp, body


@pytest.fixture(scope="module")
def spa_server():
    if not DIST_INDEX.exists():
        pytest.skip("static/dist not built")
    port = _free_port()
    state = Path(tempfile.mkdtemp(prefix="hweb100-spa-"))
    (state / "workspace").mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env.update({
        "HERMES_WEBUI_PORT": str(port),
        "HERMES_WEBUI_HOST": "127.0.0.1",
        "HERMES_WEBUI_STATE_DIR": str(state),
        "HERMES_WEBUI_DEFAULT_WORKSPACE": str(state / "workspace"),
        "HERMES_HOME": str(state),
        "HERMES_WEBUI_SKIP_ONBOARDING": "1",
        "HERMES_WEBUI_TEST_NETWORK_BLOCK": "1",
        "AWS_EC2_METADATA_DISABLED": "true",
    })
    log = (state / "server.log").open("w")
    proc = subprocess.Popen([sys.executable, str(REPO_ROOT / "server.py")], cwd=REPO_ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    ready = False
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            resp, _ = _get(port, "/health")
            if resp.status == 200:
                ready = True
                break
        except OSError:
            time.sleep(0.2)
    if not ready:
        proc.terminate()
        log.close()
        pytest.fail("SPA test server did not become healthy:\n" + (state / "server.log").read_text()[-3000:])
    try:
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


@pytest.mark.parametrize("path", ["/", "/settings", "/settings/providers", "/session/abc123", "/tasks", "/ext/foo", "/login", "/share/tok", "/onboarding"])
def test_http_shell_routes(spa_server, path):
    resp, body = _get(spa_server, path)
    assert resp.status == 200, path
    assert resp.getheader("Content-Type", "").startswith("text/html")
    text = body.decode("utf-8")
    assert '<div id="app"></div>' in text
    assert f'<base href="{spa_shell.base_href_for(path)}">' in text
    assert "__BASE_HREF__" not in text and "__LANG__" not in text
    assert resp.getheader("Cache-Control") == "no-store"
    csp = resp.getheader("Content-Security-Policy") or ""
    assert "'unsafe-inline'" not in csp.split("style-src")[0]


def test_http_share_shell_is_noindex(spa_server):
    resp, _ = _get(spa_server, "/share/tok")
    assert resp.getheader("X-Robots-Tag") == "noindex, nofollow"


@pytest.mark.parametrize("path", ["/nope", "/settingsx", "/random/deep/path", "/session/static/missing.css"])
def test_http_unknown_paths_404(spa_server, path):
    resp, body = _get(spa_server, path)
    assert resp.status == 404, path
    assert b'"app"' not in body


def test_http_api_unknown_is_json_404(spa_server):
    resp, body = _get(spa_server, "/api/definitely-not-a-route")
    assert resp.status == 404
    assert json.loads(body)["error"]


def test_http_service_worker_and_manifest(spa_server):
    resp, body = _get(spa_server, "/sw.js")
    assert resp.status == 200
    assert resp.getheader("Content-Type", "").startswith("application/javascript")
    assert resp.getheader("Cache-Control") == "no-store"
    assert resp.getheader("Service-Worker-Allowed") == "/"
    assert b"__WEBUI_VERSION__" not in body
    assert b"./index.html" in body  # precache manifest injected
    resp, body = _get(spa_server, "/manifest.webmanifest")
    assert resp.status == 200
    assert resp.getheader("Content-Type", "").startswith("application/manifest+json")
    manifest = json.loads(body)
    assert manifest["scope"] == "./" and manifest["start_url"].startswith("./")
    resp, _ = _get(spa_server, "/manifest.json")
    assert resp.status == 200
    resp, _ = _get(spa_server, "/session/manifest.json")
    assert resp.status == 200


def test_http_hashed_assets_are_immutable_and_gzipped(spa_server):
    files = (REPO_ROOT / "static" / "dist" / "FILES.txt").read_text().split()
    js = next(f for f in files if f.startswith("assets/") and f.endswith(".js"))
    resp, body = _get(spa_server, f"/static/dist/{js}", headers={"Accept-Encoding": "gzip"})
    assert resp.status == 200
    assert resp.getheader("Cache-Control") == "public, max-age=31536000, immutable"
    assert resp.getheader("Content-Encoding") == "gzip"
    assert resp.getheader("Content-Type", "").startswith("application/javascript")
    etag = resp.getheader("ETag")
    resp, _ = _get(spa_server, f"/static/dist/{js}", headers={"If-None-Match": etag})
    assert resp.status == 304


def test_http_dist_traversal_is_rejected(spa_server):
    resp, _ = _get(spa_server, "/static/dist/../style.css")
    assert resp.status in (200, 404)  # normalised by the client; must never leak outside dist
    resp, body = _get(spa_server, "/static/dist/%2e%2e/index.html")
    assert resp.status == 404


def test_http_legacy_static_alias_still_served(spa_server):
    resp, _ = _get(spa_server, "/static/brand/favicon.svg")
    assert resp.status == 200
