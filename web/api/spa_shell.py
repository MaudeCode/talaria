"""Serve the production frontend build from ``static/dist`` (HWEB-100).

The browser application is a TanStack Start SPA whose deterministic build is
committed under ``static/dist``. This module owns the three server-side
concerns the shell needs:

* the route allowlist: which paths receive the shell (everything else keeps
  its server owner or 404s);
* request-time substitution of the placeholders the build leaves in
  ``index.html`` (``__BASE_HREF__``, ``__LANG__``, ``__WEBUI_VERSION__``);
* serving hashed assets, the service worker, and the web manifest.

No secrets, CSRF tokens, language JSON, or extension config are embedded in
HTML: the client fetches ``/api/bootstrap``.
"""

from __future__ import annotations

import gzip
import mimetypes
import threading
from pathlib import Path
from urllib.parse import quote

# Paths that receive the SPA shell. Exact matches or prefix matches (trailing
# slash entries). Keep in sync with frontend/src/routes and
# docs/architecture/frontend-migration.md section 4.
SPA_EXACT_PATHS: frozenset[str] = frozenset(
    {
        "/",
        "/index.html",
        "/sessions",
        "/tasks",
        "/kanban",
        "/skills",
        "/memory",
        "/workspaces",
        "/profiles",
        "/todos",
        "/insights",
        "/logs",
        "/settings",
        "/onboarding",
        "/login",
        "/share",
    }
)
SPA_PREFIX_PATHS: tuple[str, ...] = (
    "/session/",
    "/tasks/",
    "/kanban/",
    "/skills/",
    "/memory/",
    "/workspaces/",
    "/profiles/",
    "/settings/",
    "/ext/",
    "/share/",
)
# Server-owned prefixes that must never be shadowed by the shell even when they
# nest under an allowlisted prefix (e.g. ``/session/static/`` legacy alias).
SERVER_OWNED_PREFIXES: tuple[str, ...] = (
    "/api/",
    "/assets/",
    "/static/",
    "/extensions/",
    "/plugins/",
    "/dashboard-plugins/",
    "/session/static/",
)
SERVER_OWNED_EXACT: frozenset[str] = frozenset(
    {"/health", "/sw.js", "/manifest.json", "/manifest.webmanifest", "/favicon.ico", "/search", "/session/manifest.json", "/session/manifest.webmanifest"}
)

# Shell routes that are reachable without an authenticated session.
SPA_PUBLIC_EXACT: frozenset[str] = frozenset({"/login", "/share"})
SPA_PUBLIC_PREFIXES: tuple[str, ...] = ("/share/",)

_ASSET_MIME = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
}
_COMPRESSIBLE = {".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".txt", ".map"}

_CACHE_LOCK = threading.Lock()
_ASSET_CACHE: dict[str, tuple[tuple[int, int], bytes, bytes | None, str]] = {}
_SHELL_CACHE: dict[str, tuple[tuple[int, int], str]] = {}


def dist_root() -> Path:
    from api import config as api_config

    return (api_config.get_static_root() / "dist").resolve()


def dist_available() -> bool:
    return (dist_root() / "index.html").is_file()


def is_server_owned(path: str) -> bool:
    return path in SERVER_OWNED_EXACT or any(path.startswith(p) for p in SERVER_OWNED_PREFIXES)


def is_spa_path(path: str) -> bool:
    """True when ``path`` should receive the SPA shell."""
    if is_server_owned(path):
        return False
    if path in SPA_EXACT_PATHS:
        return True
    return any(path.startswith(p) for p in SPA_PREFIX_PATHS)


def is_public_spa_path(path: str) -> bool:
    return path in SPA_PUBLIC_EXACT or any(path.startswith(p) for p in SPA_PUBLIC_PREFIXES)


def base_href_for(path: str) -> str:
    """Relative prefix from the request path back to the mount root.

    ``/`` and ``/settings`` -> ``./``; ``/session/abc`` -> ``../``. Computed
    from the request path alone, so a reverse proxy that strips a mount prefix
    needs no configuration and no inline script.
    """
    segments = [s for s in path.split("/") if s]
    depth = max(0, len(segments) - 1)
    return "../" * depth if depth else "./"


def _read_shell_template() -> str:
    index_path = dist_root() / "index.html"
    st = index_path.stat()
    sig = (st.st_size, st.st_mtime_ns)
    with _CACHE_LOCK:
        cached = _SHELL_CACHE.get(str(index_path))
        if cached and cached[0] == sig:
            return cached[1]
    text = index_path.read_text(encoding="utf-8")
    with _CACHE_LOCK:
        _SHELL_CACHE[str(index_path)] = (sig, text)
    return text


def render_shell(path: str, *, lang: str = "en", version: str = "") -> str:
    """Substitute request-time placeholders in the committed shell."""
    from api.updates import WEBUI_VERSION

    template = _read_shell_template()
    safe_lang = lang if lang and lang.replace("-", "").isalnum() and len(lang) <= 16 else "en"
    return (
        template.replace("__BASE_HREF__", base_href_for(path))
        .replace("__LANG__", safe_lang)
        .replace("__WEBUI_VERSION__", quote(version or WEBUI_VERSION, safe=""))
    )


def _send_bytes(handler, data: bytes, content_type: str, *, cache_control: str, extra_headers: dict | None = None, gz: bytes | None = None, etag: str | None = None) -> bool:
    from api.helpers import _accepts_gzip, _security_headers

    if etag and handler.headers.get("If-None-Match") == etag:
        handler.send_response(304)
        _security_headers(handler)
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache_control)
        handler.end_headers()
        return True
    body = data
    handler.send_response(200)
    _security_headers(handler)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Cache-Control", cache_control)
    handler.send_header("Vary", "Accept-Encoding")
    if etag:
        handler.send_header("ETag", etag)
    for k, v in (extra_headers or {}).items():
        handler.send_header(k, v)
    if gz is not None and _accepts_gzip(handler):
        handler.send_header("Content-Encoding", "gzip")
        body = gz
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if getattr(handler, "command", "GET") != "HEAD":
        handler.wfile.write(body)
    return True


def _load_asset(file: Path) -> tuple[bytes, bytes | None, str]:
    st = file.stat()
    sig = (st.st_size, st.st_mtime_ns)
    key = str(file)
    with _CACHE_LOCK:
        cached = _ASSET_CACHE.get(key)
        if cached and cached[0] == sig:
            return cached[1], cached[2], cached[3]
    raw = file.read_bytes()
    gz = gzip.compress(raw, compresslevel=6) if file.suffix.lower() in _COMPRESSIBLE and len(raw) > 1024 else None
    etag = f'W/"{sig[0]:x}-{sig[1]:x}"'
    with _CACHE_LOCK:
        _ASSET_CACHE[key] = (sig, raw, gz, etag)
    return raw, gz, etag


def serve_dist_file(handler, rel: str, *, cache_control: str | None = None, extra_headers: dict | None = None) -> bool:
    """Serve ``static/dist/<rel>``; returns False when the file does not exist."""
    root = dist_root()
    try:
        file = (root / rel).resolve()
        file.relative_to(root)
    except (ValueError, OSError):
        return False
    if not file.is_file():
        return False
    raw, gz, etag = _load_asset(file)
    ext = file.suffix.lower()
    ct = _ASSET_MIME.get(ext)
    if ct is None:
        guessed, enc = mimetypes.guess_type(file.name)
        ct = guessed if guessed and not enc else "application/octet-stream"
    if cache_control is None:
        # Hashed assets are immutable; everything else revalidates.
        cache_control = "public, max-age=31536000, immutable" if rel.startswith("assets/") else "no-cache"
    return _send_bytes(handler, raw, ct, cache_control=cache_control, extra_headers=extra_headers, gz=gz, etag=etag)


def serve_shell(handler, path: str, *, lang: str = "en", extra_headers: dict | None = None) -> bool:
    html = render_shell(path, lang=lang).encode("utf-8")
    headers = {"X-Frame-Options": "DENY"}
    if extra_headers:
        headers.update(extra_headers)
    return _send_bytes(handler, html, "text/html; charset=utf-8", cache_control="no-store", extra_headers=headers, gz=gzip.compress(html, compresslevel=6))


def serve_service_worker(handler) -> bool:
    """``/sw.js``: version-substituted, never cached, allowed at the mount root scope."""
    root = dist_root()
    sw = root / "sw.js"
    if not sw.is_file():
        return False
    from api.updates import WEBUI_VERSION

    text = sw.read_text(encoding="utf-8").replace("__WEBUI_VERSION__", quote(WEBUI_VERSION, safe=""))
    data = text.encode("utf-8")
    return _send_bytes(handler, data, "application/javascript; charset=utf-8", cache_control="no-store", extra_headers={"Service-Worker-Allowed": "/"})


def serve_manifest(handler) -> bool:
    return serve_dist_file(handler, "manifest.webmanifest", cache_control="no-cache")
