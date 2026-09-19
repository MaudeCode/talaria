"""Unified extension manifests for the sandboxed extension platform (HWEB-100).

Every extension UI runs in a sandboxed iframe and talks to the host over a
versioned message channel; there is no script or stylesheet injection into
the core page. This module projects the two legacy sources into one sanitized
manifest list:

* manifest-bundled and gallery-installed extensions (``api.extensions``);
* dashboard plugins (``api.plugins``), each exposed as one panel.

Legacy entries that only declare injected ``scripts``/``stylesheets`` and no
``panel`` cannot run; they are listed with ``legacy_injection: true`` so the
Settings page can point at the migration guide.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

PROTOCOL_VERSION = 1

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
_CAPABILITIES = ("settings", "storage", "sidecar", "lifecycle", "theme", "tts", "navigate", "toast", "session")
_SKIN_TOKENS = {
    "--bg", "--surface", "--surface2", "--surface-subtle", "--text", "--text2", "--muted",
    "--accent", "--accent2", "--accent3", "--accent-contrast", "--accent-hover",
    "--accent-text", "--accent-bg", "--accent-bg-strong", "--accent-rgb",
    "--border", "--border2", "--hover-bg", "--code-bg", "--code-text",
    "--sidebar", "--sidebar-text", "--user-bubble", "--assistant-bubble",
    "--success", "--warning", "--danger", "--info", "--link",
}
_SKIN_VALUE_RE = re.compile(
    r"^(#(?:[0-9a-fA-F]{3,8})|rg(?:b|ba)\(\s*[0-9.,%\s/]+\)|hsl(?:a)?\(\s*[0-9.,%\s/deg]+\)"
    r"|[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}|[a-zA-Z]{3,20}|[0-9.]+(?:px|em|rem|%)?)$"
)
_PANEL_RE = re.compile(r"^[A-Za-z0-9._/-]{1,300}$")


def _text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()
    return cleaned[:limit]


def _panel_url(extension_id: str, raw: object, *, base: str) -> tuple[str | None, list[str]]:
    """App-relative panel URL under the extension's own asset root, or None."""
    warnings: list[str] = []
    if raw is None:
        return None, warnings
    if not isinstance(raw, str) or not _PANEL_RE.match(raw) or ".." in raw.split("/") or raw.startswith("/"):
        warnings.append("panel_path_rejected")
        return None, warnings
    if not raw.lower().endswith(".html"):
        warnings.append("panel_not_html")
        return None, warnings
    return f"{base}/{raw.lstrip('./')}", warnings


def _theme(raw: object, extension_id: str) -> tuple[Dict[str, Any] | None, list[str]]:
    warnings: list[str] = []
    if raw is None:
        return None, warnings
    if not isinstance(raw, dict):
        warnings.append("theme_invalid")
        return None, warnings
    key = _text(raw.get("key") or raw.get("value") or raw.get("name"), 32).lower()
    key = re.sub(r"[^a-z0-9_-]", "", key)
    name = _text(raw.get("name") or raw.get("label") or key, 40)
    tokens_raw = raw.get("tokens")
    tokens: Dict[str, str] = {}
    if isinstance(tokens_raw, dict):
        for k, v in tokens_raw.items():
            if isinstance(k, str) and k in _SKIN_TOKENS and isinstance(v, str) and _SKIN_VALUE_RE.match(v.strip()):
                tokens[k] = v.strip()
    if not key or not _KEY_RE.match(key) or not name or not tokens:
        warnings.append("theme_rejected")
        return None, warnings
    scheme = raw.get("scheme")
    colors = [c.strip() for c in (raw.get("colors") or []) if isinstance(c, str) and _SKIN_VALUE_RE.match(c.strip())][:3] if isinstance(raw.get("colors"), list) else []
    out: Dict[str, Any] = {"key": f"{extension_id}-{key}" if not key.startswith(extension_id) else key, "name": name, "tokens": tokens, "colors": colors}
    if scheme in ("light", "dark"):
        out["scheme"] = scheme
    return out, warnings


def _tts(raw: object) -> Dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    tid = _text(raw.get("id"), 32).lower()
    label = _text(raw.get("label"), 60)
    if not _KEY_RE.match(tid) or tid in {"browser", "edge", "elevenlabs"} or not label:
        return None
    return {"id": tid, "label": label}


def _capabilities(raw: object, *, has_sidecar: bool, has_theme: bool, has_tts: bool) -> List[str]:
    caps: List[str] = []
    if isinstance(raw, list):
        for c in raw:
            if isinstance(c, str) and c in _CAPABILITIES and c not in caps:
                caps.append(c)
    # Declared structures imply their capability so a manifest cannot claim a
    # sidecar without the capability the host enforces at request time.
    if has_sidecar and "sidecar" not in caps:
        caps.append("sidecar")
    if has_theme and "theme" not in caps:
        caps.append("theme")
    if has_tts and "tts" not in caps:
        caps.append("tts")
    return caps


def _from_extension_entry(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    ext_id = _text(entry.get("id"), 64)
    if not _ID_RE.match(ext_id):
        return None
    raw_manifest = entry.get("manifest") if isinstance(entry.get("manifest"), dict) else entry
    base = f"extensions/{ext_id}"
    panel, warnings = _panel_url(ext_id, raw_manifest.get("panel"), base=base)
    theme, theme_warnings = _theme(raw_manifest.get("theme"), ext_id)
    warnings.extend(theme_warnings)
    tts = _tts(raw_manifest.get("tts"))
    sidecar = None
    raw_sidecar = entry.get("sidecar") if isinstance(entry.get("sidecar"), dict) else None
    if raw_sidecar and isinstance(raw_sidecar.get("origin"), str):
        sidecar = {"origin": raw_sidecar["origin"], "health_path": raw_sidecar.get("health_path") or "/health", "consented": bool(raw_sidecar.get("consented") or raw_sidecar.get("proxy_consented"))}
    scripts = entry.get("scripts") or raw_manifest.get("scripts") or []
    stylesheets = entry.get("stylesheets") or raw_manifest.get("stylesheets") or []
    legacy = bool((scripts or stylesheets) and not panel)
    nav = None
    raw_nav = raw_manifest.get("nav")
    if panel:
        label = _text(raw_nav.get("label") if isinstance(raw_nav, dict) else None, 40) or _text(entry.get("name") or raw_manifest.get("name"), 40) or ext_id
        icon = _text(raw_nav.get("icon") if isinstance(raw_nav, dict) else None, 40)
        nav = {"label": label, **({"icon": icon} if icon else {})}
    permissions = entry.get("permissions") if isinstance(entry.get("permissions"), dict) else {}
    settings_schema = entry.get("settings_schema") if isinstance(entry.get("settings_schema"), list) else []
    enabled_flag = entry.get("effective_enabled")
    if enabled_flag is None:
        enabled_flag = entry.get("enabled", True)
    return {
        "id": ext_id,
        "name": _text(entry.get("name") or raw_manifest.get("name"), 80) or ext_id,
        "version": _text(entry.get("version") or raw_manifest.get("version"), 40),
        "description": _text(entry.get("description") or raw_manifest.get("description"), 300),
        "source": "gallery" if entry.get("gallery_installed") or entry.get("source") == "gallery" else "manifest",
        "enabled": bool(enabled_flag) and not legacy,
        "panel": panel,
        "nav": nav,
        "capabilities": _capabilities(raw_manifest.get("capabilities"), has_sidecar=sidecar is not None, has_theme=theme is not None, has_tts=tts is not None),
        "permissions": {str(k): bool(v) for k, v in permissions.items() if isinstance(k, str)},
        "settings_schema": settings_schema,
        "theme": theme,
        "tts": tts,
        "sidecar": sidecar,
        "legacy_injection": legacy,
        "warnings": warnings,
    }


def _from_dashboard_plugin(name: str, manifest: Dict[str, Any], enabled: bool) -> Dict[str, Any] | None:
    if not _ID_RE.match(name):
        return None
    tab = manifest.get("tab") if isinstance(manifest.get("tab"), dict) else {}
    label = _text(tab.get("name") or manifest.get("label") or manifest.get("name"), 40) or name
    return {
        "id": name,
        "name": _text(manifest.get("label") or manifest.get("name"), 80) or name,
        "version": _text(manifest.get("version"), 40),
        "description": _text(manifest.get("description"), 300),
        "source": "plugin",
        "enabled": bool(enabled),
        "panel": f"dashboard-plugins/{name}/index.html",
        "nav": {"label": label},
        "capabilities": ["settings", "storage", "toast", "session"],
        "permissions": {},
        "settings_schema": [],
        "theme": None,
        "tts": None,
        "sidecar": None,
        "legacy_injection": False,
        "warnings": [],
    }


def build_manifests(*, extension_status: Dict[str, Any], plugin_manifests: Dict[str, Dict[str, Any]], plugin_enabled) -> Dict[str, Any]:
    manifests: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for entry in extension_status.get("extensions") or []:
        if not isinstance(entry, dict):
            continue
        m = _from_extension_entry(entry)
        if m and m["id"] not in seen:
            seen.add(m["id"])
            manifests.append(m)
    for name, manifest in sorted((plugin_manifests or {}).items()):
        if name in seen or not isinstance(manifest, dict):
            continue
        m = _from_dashboard_plugin(name, manifest, bool(plugin_enabled(name)))
        if m:
            seen.add(name)
            manifests.append(m)
    return {"protocol_version": PROTOCOL_VERSION, "manifests": manifests}
