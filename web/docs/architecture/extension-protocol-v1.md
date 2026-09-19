# Hermes WebUI extension protocol, version 1

Status: implemented by HWEB-100. This replaces the injected-script extension
surface and the dashboard-plugin IIFE loader with one sandboxed capability
protocol. There is no compatibility shim: an extension either ships a panel
document that speaks this protocol or it is listed as needing migration.

## Trust model

- Every extension UI runs in an `<iframe sandbox="allow-scripts allow-forms
  allow-popups allow-downloads allow-modals">`. The document has an opaque
  origin: no cookies, no same-origin API access, no access to the host DOM,
  React tree, or storage. The server adds a matching `sandbox` CSP to every
  extension HTML response and refuses `/api/*` requests that carry
  `Origin: null`, so a panel cannot call the API directly even by accident.
- The host (the main WebUI page) is the only party with session authority. An
  extension reaches the server, the session, settings, storage, and the UI only
  through the methods below, each gated by a capability the manifest declares.
- Sidecar consent, token provisioning, target validation, and proxy policy stay
  Python-owned (`/api/extensions/<id>/sidecar/<path>`). The host forwards
  `sidecar.fetch` requests to that proxy with its own credentials; the panel
  never sees them.

## Manifest

`GET /api/extensions/manifests` returns `{ protocol_version: 1, manifests: [...] }`
where each entry is the sanitized projection the client validates with
`ExtensionManifestSchema` (`frontend/src/contracts/extension.ts`):

| Field | Meaning |
|---|---|
| `id` | `^[a-z][a-z0-9_-]{0,63}$`; the extension directory name or plugin name |
| `name`, `version`, `description` | display metadata, length-bounded |
| `source` | `manifest` (extension directory), `gallery` (one-click install), `plugin` (dashboard plugin) |
| `enabled` | effective enablement (manifest flag, user toggle, plugin setting) |
| `panel` | app-relative URL of the sandboxed document (`extensions/<id>/panel.html`, `dashboard-plugins/<name>/index.html`) or `null` for a headless extension |
| `nav` | `{ label, icon? }` rail entry when a panel exists |
| `capabilities` | subset of `settings storage sidecar lifecycle theme tts navigate toast session` |
| `permissions` | declared `permissions` map, shown to the user (for example `network_external`) |
| `settings_schema` | sanitized scalar fields (`boolean string number integer enum`) rendered by the host |
| `theme` | declarative skin: `{ key, name, scheme?, colors?, tokens }` with the allowlisted token names and value shapes |
| `tts` | `{ id, label }` when the extension provides a speech engine |
| `sidecar` | `{ origin, health_path, consented }` for a loopback sidecar |
| `legacy_injection` | `true` when the entry only declares injected scripts/styles; it never runs |
| `warnings` | stable warning codes from sanitization |

Extension directory manifest (`extensions.json` entry) additions over the
legacy shape:

```json
{
  "id": "hello-panel",
  "name": "Hello Panel",
  "version": "1.0.0",
  "panel": "hello-panel/index.html",
  "nav": { "label": "Hello" },
  "capabilities": ["settings", "storage", "toast", "session", "lifecycle"],
  "settings_schema": [{ "key": "greeting", "type": "string", "label": "Greeting", "default": "Hi" }],
  "theme": { "key": "e-ink", "name": "E-Ink", "scheme": "light", "tokens": { "--bg": "#ffffff", "--text": "#000000", "--accent": "#000000" } },
  "tts": { "id": "voicevox", "label": "VOICEVOX (local)" },
  "sidecar": { "type": "loopback", "origin": "http://127.0.0.1:17787", "health_path": "/health" }
}
```

`scripts` and `stylesheets` are ignored by the platform; an entry that has only
those fields is reported with `legacy_injection: true`.

## Handshake

1. The host creates the iframe with `src = panel` and a `MessageChannel`.
2. On the iframe `load` event the host posts
   `{ type: "hermes:hello", version: 1, nonce, extensionId, capabilities }`
   to the frame with `postMessage(msg, "*", [port2])`. The target origin must be
   `"*"` because the frame's origin is opaque; the transferred port is what
   binds the channel to that iframe, and nobody else receives `port2`.
3. The panel replies on the port: `{ type: "hermes:ready", version: 1, nonce, sdkVersion? }`.
4. The host accepts protocol messages on the port only, and only with the nonce
   it issued. `window.postMessage` from the frame after the handshake is
   ignored and recorded as a violation. A missing ready within 8 seconds fails
   the panel with `handshake_timeout`. A different `version` fails with
   `version_mismatch`.

## Messages

All messages are JSON-serialisable objects at most 64 KiB (measured as UTF-8 of
the JSON encoding). Every message carries `nonce`.

Panel to host:

- `{ type: "request", nonce, id, method, params? }`: `id` is a non-negative
  integer; `method` is one of the methods below.
- `{ type: "tts:result", nonce, requestId, ok: false, error }`: failure reply
  to a `tts:synthesize` event.
- `{ type: "tts:audio", nonce, requestId, audio: ArrayBuffer }` with the buffer
  transferred: success reply to `tts:synthesize` (1 byte to 8 MiB).

Host to panel:

- `{ type: "response", nonce, id, ok: true, result }` or
  `{ type: "response", nonce, id, ok: false, error: { code, message } }`.
- `{ type: "event", nonce, name, payload }` for `turn:start`, `turn:complete`,
  `turn:error`, `turn:cancel`, `theme:changed`, `tts:synthesize`.

Error codes: `capability_denied`, `malformed_message`, `message_too_large`,
`nonce_mismatch`, `version_mismatch`, `request_before_ready`, `unknown_setting`,
`invalid_value`, `storage_full`, `no_sidecar`, `tts_not_declared`,
`result_too_large`, `internal`.

## Methods

| Method | Capability | Params | Result |
|---|---|---|---|
| `settings.get` | `settings` | `{ key? }` | `{ value }` or `{ values }`; defaults come from `settings_schema` |
| `settings.set` | `settings` | `{ key, value }` | `{ value }`; type and enum validated against the schema |
| `settings.reset` | `settings` | | `{ values }` |
| `storage.get` | `storage` | `{ key }` | `{ value: string \| null }` |
| `storage.set` | `storage` | `{ key, value }` | `{ ok }`; values up to 32 KiB, at most 64 keys per extension |
| `storage.remove`, `storage.clear`, `storage.keys` | `storage` | | |
| `sidecar.fetch` | `sidecar` | `{ path, method?, headers?, body? }` | `{ status, headers, body }` via the Python proxy; requires a declared sidecar and persisted consent |
| `lifecycle.subscribe` | `lifecycle` | `{ events }` | `{ events }`; later `event` messages carry `{ type, sessionId, streamId, timestamp, startedAt?, endedAt?, status? }` |
| `lifecycle.unsubscribe` | `lifecycle` | | `{ ok }` |
| `session.current` | `session` | | `{ sessionId, title }` (bounded) |
| `theme.current` | `theme` | | `{ theme, skin, dark }` |
| `toast.show` | `toast` | `{ text, ttl? }` | `{ ok }`; text prefixed with the extension name, at most 200 characters |
| `navigate.session` | `navigate` | `{ sessionId }` | `{ ok }` |
| `tts.register` | `tts` | `{ id, label }` | `{ ok }`; must match the manifest `tts` block |

Settings and storage persist in the host's `localStorage` under
`hermes.ext.settings.<id>` and `hermes.ext.storage.<id>` as validated JSON,
the same keys the legacy accessors used.

## Skins

A manifest `theme` is applied by the host as CSS custom properties on the
document root when the user selects it in Settings, Appearance. Token names are
limited to the legacy allowlist and values to hex, `rgb()`, `hsl()`, colour
keywords, simple lengths, or a bare RGB triple. No stylesheet is injected.

## TTS

An extension with `tts` in its manifest calls `tts.register`. When the user
selects that engine, the host emits `tts:synthesize` with
`{ requestId, text, voice, rate, pitch }` and expects `tts:audio` (transferred
buffer) or `tts:result` with `ok: false` within 30 seconds.

## SDK

`static/dist/extension-sdk.js` exposes `Hermes.connect(): Promise<api>` with
`api.call(method, params)`, `api.on(event, listener)`, and
`api.registerTts(engine, synthesize)`. Load it from the panel document with a
relative URL (`../../static/dist/extension-sdk.js` from
`extensions/<id>/index.html`). The SDK is plain JavaScript and works without
a build step; see `docs/examples/extensions/hello-panel/`.

## Server rules

- `/extensions/*` serves files from the configured extension directory; HTML
  responses carry `Content-Security-Policy: sandbox …`.
- `/dashboard-plugins/<name>/index.html` serves the plugin's `dist/index.html`,
  or a generated wrapper around `dist/index.js` and `dist/style.css` that loads
  the SDK, when the plugin is enabled in Settings.
- `/api/*` with `Origin: null` is refused with 403 before authentication.
- `/api/extensions/<id>/sidecar/<path>` keeps its same-origin provenance check
  and persisted consent; the host is the only caller.
