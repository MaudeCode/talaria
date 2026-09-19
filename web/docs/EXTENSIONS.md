# WebUI Extensions

Hermes WebUI supports a small, opt-in extension surface for self-hosted installs.
An extension ships a **panel document** that runs in a sandboxed iframe and
talks to the WebUI through a capability-gated protocol; it never runs inside
the core page. The protocol is specified in
[`architecture/extension-protocol-v1.md`](architecture/extension-protocol-v1.md);
extensions written for the injected-script surface follow
[`architecture/extension-migration-guide.md`](architecture/extension-migration-guide.md).

> **Trust model — read this first.** Extension code runs in an `<iframe
> sandbox>` with an opaque origin: no cookies, no same-origin API access, no
> access to the host DOM or storage. It reaches the server, the current session,
> settings, storage and the UI only through the methods its manifest declares
> in `capabilities`, and the server refuses `/api/*` requests that carry
> `Origin: null`. That is a much smaller blast radius than the previous
> injected-script surface, but an extension can still show misleading UI, call
> its consented sidecar, and read what its capabilities expose. **Only enable
> extensions from the vetted gallery or sources you trust.** If you set
> `HERMES_WEBUI_EXTENSION_DIR` yourself, do not point it at a user-writable
> directory on a shared host.

This is intentionally not a plugin marketplace or dependency system. It is a
safe escape hatch for local dashboards, internal tooling, and workflow-specific
panels that should not live in core Hermes WebUI.

> **The vetted extension library.** The curated, one-click-installable extensions
> that appear in the gallery live in a separate public repo:
> **[hermes-webui/hermes-webui-extensions](https://github.com/hermes-webui/hermes-webui-extensions)**.
> "In the registry == vetted." That repo holds the entries, the authoring
> conventions ([`docs/extension-entry.md`](https://github.com/hermes-webui/hermes-webui-extensions/blob/main/docs/extension-entry.md)),
> the JSON schema, and the CI safety gates. This document covers the WebUI-side
> *infrastructure* (manifest contract, panel serving, capabilities, install
> client); see the library repo to browse existing extensions or contribute a
> new one.

## What extensions can do

Extensions can:

- serve files from one configured local directory at `/extensions/...`
- add a rail entry that opens their panel document at `/ext/<id>`
- declare **capabilities** and call the matching host methods: `settings`,
  `storage`, `sidecar`, `lifecycle` (turn start/complete/error/cancel events),
  `theme`, `tts`, `navigate`, `toast`, `session`
- declare a **skin** (design tokens) the user can pick in Settings, Appearance
- declare a **TTS engine** the user can pick for spoken replies
- reach a consented loopback sidecar through the fixed per-extension proxy path

Extensions cannot:

- run script or style in the core page, read its DOM, globals, cookies or storage
- call `/api/*` directly (sandboxed documents are refused before authentication)
- bypass WebUI authentication or serve files outside the extension directory
- register new WebUI backend routes or proxy arbitrary traffic outside the
  fixed consented sidecar path described below
- change Hermes Agent permissions, models, memory, or tools except through the
  capabilities above

## Manifest shape

`extensions.json` (or a gallery entry's `extension.json`) lists entries:

```json
{
  "extensions": [
    {
      "id": "hello-panel",
      "name": "Hello Panel",
      "version": "1.0.0",
      "panel": "hello-panel/index.html",
      "nav": { "label": "Hello" },
      "capabilities": ["settings", "storage", "toast", "session", "lifecycle"],
      "settings_schema": [
        { "key": "greeting", "type": "string", "label": "Greeting", "default": "Hi" }
      ],
      "permissions": { "network_external": false },
      "theme": { "key": "mint", "name": "Mint", "scheme": "light", "tokens": { "--bg": "#f4fffa", "--accent": "#0b6b4a" } },
      "tts": { "id": "voicevox", "label": "VOICEVOX (local)" },
      "sidecar": { "type": "loopback", "origin": "http://127.0.0.1:17787", "health_path": "/health", "proxy_auth": "token-v1" }
    }
  ]
}
```

- `id` is `^[a-z][a-z0-9_-]{0,63}$` and doubles as the settings/storage
  namespace and the `/ext/<id>` route.
- `panel` is a relative path inside the extension directory; it is served at
  `/extensions/<panel>` with a `sandbox` Content-Security-Policy. An entry
  without `panel` is headless (skin, TTS or sidecar only).
- `capabilities`, `settings_schema`, `theme`, `tts` and `sidecar` are
  sanitized by `api/extension_manifests.py`; rejected fields produce stable
  warning codes in `GET /api/extensions/manifests` and never reach the client
  raw.
- `scripts` and `stylesheets` are ignored. An entry that has only those is
  listed as **needs migration** in Settings, Extensions and never runs.

The complete example lives in
[`examples/extensions/hello-panel/`](examples/extensions/hello-panel/).

## Writing a panel

```html
<script src="../../static/dist/extension-sdk.js"></script>
<script>
  Hermes.connect().then(async (hermes) => {
    const { values } = await hermes.call('settings.get')
    hermes.on('turn:complete', (ev) => console.log('turn done', ev.sessionId))
  })
</script>
```

`extension-sdk.js` is built from `frontend/src/extensions/sdk.ts` and served
from `static/dist`. Load it with a relative URL so subpath mounts work. The
handshake, message bounds, method table, error codes and events are in the
protocol document.

## Configuration

### One-click install (no configuration required)

For a single-user self-hosted instance you do not need to configure anything.
Open **Settings → Extensions**, pick an extension from the gallery, and click
**Install** — it just works. The first install creates a WebUI-managed
extension directory under your state dir (`STATE_DIR/extensions`, e.g.
`~/.hermes/webui/extensions/`) and installs into it; gallery-installed
extensions appear in the rail on the next reload with no environment
variables and no restart of your shell.

The gallery registry is cached for five minutes. A refresh runs as a single
bounded fetch outside the cache lock; concurrent gallery opens receive the
existing cached list, or a temporary unavailable response when no cache exists.

The managed directory lives alongside your sessions and settings in the
WebUI-owned state dir. That is a different trust domain from "a world-writable
directory on a shared box": only the WebUI process (and whoever can already
write your `~/.hermes` state) can place code there. The trust model above still
applies, so only install extensions from the vetted gallery or sources you
trust.

Some gallery entries need more than WebUI assets. If an extension declares
post-install guidance or lifecycle requirements such as a loopback sidecar or a
native host, Settings -> Extensions shows a **Next step** note on the card after
install. For example, Desktop Companion can install the WebUI bridge from the
gallery, but the desktop pet is only visible after the local Desktop Companion
app is started.

### Manual / advanced configuration (optional)

`HERMES_WEBUI_EXTENSION_DIR` is **optional** and overrides the managed default.
Set it when you want extensions to live in a specific directory you control
(e.g. a checked-out bundle, or a path mounted into a container). When set it
must point to an existing directory; WebUI never auto-creates an admin-specified
path:

```bash
export HERMES_WEBUI_EXTENSION_DIR=/path/to/my-extensions
export HERMES_WEBUI_EXTENSION_MANIFEST=extensions.json   # relative to the directory (default)
./start.sh
```

The manifest lists entries with the fields shown in [Manifest shape](#manifest-shape).
Paths are relative to the extension directory, must not traverse outside it,
and dot-prefixed segments are rejected. A manifest entry may declare
`"enabled": false` to stay listed but inactive; users can toggle installed
entries from Settings, Extensions. `HERMES_WEBUI_EXTENSION_SCRIPT_URLS` and
`HERMES_WEBUI_EXTENSION_STYLESHEET_URLS` are no longer honoured: there is no
injection surface. Move those assets into a panel document.

### Sidecar proxy authentication (`proxy_auth`)

The loopback port a sidecar binds is reachable by **any local process**, and the
proxy strips every inbound credential (cookies, `Authorization`, CSRF, `x-hermes-*`)
before forwarding — so a sidecar cannot, on its own, tell a proxied request from a
direct one. The `proxy_auth` field closes that gap:

- **`token-v1`** (recommended for any sidecar that mutates state) — WebUI mints a
  per-extension secret at `STATE_DIR/sidecar-auth/<id>.token` (mode `0600`) and
  injects it as the `X-Hermes-Sidecar-Token` header on every proxied request. The
  sidecar resolves the token file in this order — `HERMES_EXT_SIDECAR_TOKEN_FILE`
  → `$HERMES_WEBUI_STATE_DIR/sidecar-auth/<id>.token` →
  `$HERMES_HOME/webui/sidecar-auth/<id>.token` → platform default
  (`~/.hermes/webui/…`, `%LOCALAPPDATA%\hermes\webui\…` on Windows) — and must
  validate the header on every route except `/health`, returning **`401` on a
  missing/mismatched token** and **`503` when the token file is absent/unreadable**.
  The canonical scaffold in the extensions repository (`examples/`, see
  `docs/SIDECAR_CONTRACT.md`) does all of this for you — do not hand-roll it.
- **absent (or the explicit literal `"legacy"`)** — **legacy** mode (no token;
  unchanged behavior). Only appropriate for read-only, non-sensitive sidecars.
- Any **other** value fails closed (the sidecar declaration is rejected).

**Auth-off posture:** WebUI authentication is optional and off by default. Because
the consent endpoint and proxy route are unauthenticated in that mode, `token-v1`
fails closed regardless of whether the sidecar origin is loopback: consent and proxy
resolution return `403` until WebUI authentication is configured. Otherwise, any
caller that can reach WebUI could ask core to inject the token and use it as a
forwarding oracle. The extensions panel exposes the `local_unprotected` posture so
the operator is told to enable authentication before granting consent. The token
protects against other-UID and sandboxed local callers; it does **not** defend against
arbitrary same-UID code (which can read the token file, WebUI's own signing key, or
run the sidecar's tool directly).

Extension entries may declare browser-local settings when they also request
extension-owned storage:

```json
{
  "id": "desktop-companion",
  "permissions": {
    "storage": {
      "owned": true
    }
  },
  "settings_schema": [
    {
      "key": "show_badge",
      "type": "boolean",
      "label": "Show badge",
      "default": true
    },
    {
      "key": "mode",
      "type": "enum",
      "label": "Mode",
      "options": [
        {"value": "compact", "label": "Compact"},
        {"value": "full", "label": "Full"}
      ],
      "default": "compact"
    }
  ]
}
```

Extension settings (`settings_schema`) and storage are browser-local and
reached from the panel through the `settings.*` and `storage.*` protocol
methods; see [`architecture/extension-protocol-v1.md`](architecture/extension-protocol-v1.md).

## URL rules

Injected asset URLs are deliberately restricted:

- must be same-origin paths
- must start with `/extensions/` or `/static/` after manifest normalization
- must not include a URL scheme, host, fragment, quote, angle bracket, newline,
  NUL byte, or backslash
- must not contain dot-segments or dotfiles after percent-decoding

Allowed examples:

```text
/extensions/hello-panel/index.html
/extensions/app.css
/extensions/index.html?v=1
/static/theme.css
```

Rejected examples:

```text
https://example.com/index.html
//example.com/index.html
javapanel:alert(1)
/api/session
/extensions/index.html#fragment
```

These restrictions keep the existing Content Security Policy intact and avoid
turning the extension hook into a third-party panel loader. Invalid configured
URLs are ignored rather than injected.

## Trusted local sidecars

Manifest-bundled extensions may integrate with a trusted local sidecar process,
such as a desktop companion listening on `http://127.0.0.1:17787`. A sandboxed
panel has an opaque origin and cannot call the sidecar itself; it declares the
`sidecar` capability and calls `sidecar.fetch`, which the host forwards to the
fixed per-extension proxy path after explicit persisted user consent. WebUI
diagnostics in Settings, Extensions probe the declared health URL from the
host page. WebUI does not create arbitrary extension-owned backend routes.

Loopback sidecar origins are already included in WebUI's enforced CSP
`connect-src` directive:

```text
http://127.0.0.1:*
http://localhost:*
http://ipc.localhost
ws://127.0.0.1:*
ws://localhost:*
```

The wildcard ports above cover any loopback port, including
`http://127.0.0.1:17787`. For a trusted non-loopback origin that you explicitly
control, append the exact origin with `HERMES_WEBUI_CSP_CONNECT_EXTRA` before
starting WebUI:

```bash
HERMES_WEBUI_CSP_CONNECT_EXTRA=https://companion.example.internal HERMES_WEBUI_EXTENSION_DIR=/path/to/my-extension/static HERMES_WEBUI_EXTENSION_MANIFEST=extensions.json ./start.sh
```

`HERMES_WEBUI_CSP_CONNECT_EXTRA` accepts space-separated `http(s)://` or
`ws(s)://` origins only. It rejects paths, directive injection, and invalid port
numbers. Avoid wildcard or remote origins unless you fully control the target.

## Loopback sidecar declarations

Sidecar declarations are sanitized before they appear in diagnostics:

- only `"type": "loopback"` is supported
- `origin` must be an `http` or `https` origin on `127.0.0.1`, `localhost`, or
  `[::1]`
- `origin` must not include a username, password, path, query string, or fragment
- `health_path` is optional and defaults to `/health`
- when present, `health_path` must start with `/` and must not contain a scheme,
  host, query string, fragment, quotes, control characters, backslashes, empty
  segments, whitespace, or path traversal

Invalid sidecars are skipped with a stable warning code such as
`sidecar_origin_rejected`, `sidecar_type_unsupported`,
`sidecar_health_path_rejected`, or `sidecar_invalid`. Raw rejected origins and
paths are never returned by the status endpoint. If `health_path` is omitted,
diagnostics use `/health`; if `health_path` is present but invalid, the sidecar is
skipped rather than probed.

## Embedding an external web app in an iframe

By default the WebUI's Content-Security-Policy only allows it to embed
**same-origin** content in an `<iframe>` (the `frame-src` directive falls back to
`'self'`). An extension that wants to pin an external self-hosted web app — a
Grafana board, Vaultwarden, a personal dashboard — as a tab therefore needs the
operator to widen `frame-src`, opt-in, via an environment variable:

```bash
# space-separated http(s) origins; optional *. subdomain wildcard and port.
export HERMES_WEBUI_CSP_FRAME_EXTRA="https://grafana.example.com https://*.dash.example.com:8443"
```

Rules and guarantees:

- Only `http(s)` origins are accepted (an iframe `src` is always http(s)).
  Entries may include a `*.` subdomain wildcard and a port or `*` port; a path,
  a `ws://`/`wss://` scheme, an invalid port, or any attempt to inject another
  directive is rejected and the whole value is ignored (with a logged warning).
- This mirrors the existing `HERMES_WEBUI_CSP_CONNECT_EXTRA` knob (which widens
  `connect-src` for `fetch`/WebSocket); the two are independent.
- It only governs what the WebUI page may **embed**. It does **not** touch
  `frame-ancestors`, which stays `'none'` — so widening `frame-src` never lets
  another site embed the WebUI itself.
- Default-off: with the variable unset, the policy is unchanged (same-origin
  iframes only).

An "external app tab" extension should document the exact origin(s) it needs so
the operator can set this knob deliberately, rather than assuming a wide-open
policy.

## Static file serving

When `HERMES_WEBUI_EXTENSION_DIR` points at an existing directory, files under
that directory are available below `/extensions/`:

```text
/path/to/my-extension/hello-panel/index.html  ->  /extensions/hello-panel/index.html
/path/to/my-extension/hello-panel/panel.js    ->  /extensions/hello-panel/panel.js
```

Every HTML response carries `Content-Security-Policy: sandbox allow-scripts
allow-forms allow-popups allow-downloads allow-modals; frame-ancestors 'self'`
and `X-Frame-Options: SAMEORIGIN`, so a panel opened directly in a tab runs
with the same restrictions as inside the WebUI.

The static handler is sandboxed:

- path traversal is rejected, including encoded traversal
- dotfiles and dot-directories are not served
- symlinks that resolve outside the extension directory are rejected
- missing or invalid extension directories behave as disabled
- manifest paths must be relative files inside the configured extension directory
- malformed, missing, or oversized manifests are ignored without enabling unsafe URLs
- failures return a generic 404 without exposing local filesystem paths

## Security notes

Only enable extensions from directories you control. Extension JavaScript runs
in a sandboxed iframe with an opaque origin and reaches the WebUI only through
the capabilities its manifest declares; the server refuses `/api/*` requests
with `Origin: null` before authentication.

For shared or remotely exposed installations:

- keep `HERMES_WEBUI_PASSWORD` enabled
- bind to loopback unless you intentionally expose the service
- review extension code before enabling it
- prefer small, auditable extension files
- avoid serving generated or user-writable directories as extension roots

## Registering a custom theme (skin)

Declare a `theme` block in the manifest:

```json
"theme": { "key": "e-ink", "name": "E-Ink", "scheme": "light", "colors": ["#ffffff", "#000000", "#000000"], "tokens": { "--bg": "#ffffff", "--text": "#000000", "--accent": "#000000" } }
```

The host lists it in Settings, Appearance as "E-Ink (from <extension>)" and,
when selected, sets the allowlisted tokens as CSS custom properties on the
document root. Token names are limited to the palette allowlist and values to
hex, `rgb()`, `hsl()`, colour keywords, simple lengths or a bare RGB triple.
No stylesheet is injected. The persisted `hermes-skin` key keeps the namespaced
skin key (`<extension-id>-<key>`), so a removed extension falls back to the
default skin.

## Registering a custom TTS engine

Declare `tts: { "id": "voicevox", "label": "VOICEVOX (local)" }` in the manifest
and, from the panel, register the synthesiser:

```javascript
Hermes.connect().then((hermes) => {
  hermes.registerTts({ id: 'voicevox', label: 'VOICEVOX (local)' }, async (text, { voice, rate, pitch }) => {
    const res = await hermes.call('sidecar.fetch', { path: 'synthesize', method: 'POST', body: JSON.stringify({ text, voice, rate, pitch }) })
    return base64ToArrayBuffer(res.body)
  })
})
```

The engine appears in Settings, Conversation. When selected, the host sends
`tts:synthesize` events to the panel and plays the returned audio buffer through
the same path as Edge TTS. The engine is only available while its panel is
open; the host falls back to the browser voice otherwise.

## Extension authoring guidance

A panel owns its whole document, so ordinary web development rules apply:
plain HTML/CSS/JS or any framework you like, loaded relatively. Keep these in
mind:

- Connect once (`Hermes.connect()`), then keep the returned API; a second
  handshake is refused.
- Declare only the capabilities you use. Requests for undeclared methods fail
  with `capability_denied` and are counted as protocol violations.
- Settings and storage are namespaced per extension id and persist in the
  user's browser; keep values small (32 KiB per storage value, 64 keys).
- Respect the host theme: read `theme.current` and listen for `theme:changed`
  to switch your own palette.
- Do not assume the panel is mounted at the site root: use relative URLs.
- Never embed credentials; the host injects sidecar auth for you.

### Contributing to the extension library

To publish an extension in the vetted gallery, open a PR against
**[hermes-webui/hermes-webui-extensions](https://github.com/hermes-webui/hermes-webui-extensions)**
following [`docs/extension-entry.md`](https://github.com/hermes-webui/hermes-webui-extensions/blob/main/docs/extension-entry.md)
(entry layout, `extension.json`/`manifest.json` shape, and the capability +
best-practice conventions). Every entry PR runs the repo's CI validators and
safety scan before it can merge, and merged entries are published to the registry
that powers Settings → Extensions.

## Diagnostics

Authenticated administrators can inspect sanitized extension configuration at:

```text
GET /api/extensions/status
```

The status endpoint is read-only and follows the normal WebUI authentication
rules. The same sanitized diagnostics are also shown in **Settings → Extensions**
for operators who prefer to inspect extension state from the browser. Installed
manifest entries can be enabled or disabled from that panel through the
authenticated `POST /api/extensions/toggle` endpoint. The toggle writes only a
WebUI-managed override in the WebUI state directory; it does not edit extension
manifests, fetch new extension assets, uninstall files, or add extension-owned
backend routes. Manifest entries with `"enabled": false` remain
manifest-disabled and cannot be re-enabled from WebUI.

The diagnostics return coarse manifest status, per-extension effective state, asset
counts, sanitized declared loopback sidecars, and warning codes for rejected or
unavailable configuration. `manifest.sidecar_count` counts accepted enabled loopback
sidecars from the manifest. `counts.sidecars` counts the sanitized
sidecar list returned in `sidecars`. `counts.manifest_extensions` counts
sanitized manifest extension entries with valid IDs, and `counts.user_disabled`
counts installed manifest entries currently suppressed by the WebUI-managed
override. `manifest.entry_count` counts the loaded top-level manifest object and
effectively enabled extension entries, not every extension object in the file. The endpoint and Settings panel do **not**
return `HERMES_WEBUI_EXTENSION_DIR`, resolved manifest paths, raw environment
values, rejected URL strings, rejected sidecar origins, rejected health paths, or
the override state-file path.

When sanitized loopback sidecars are present, **Settings → Extensions** renders a sidecar monitor card. The host page checks each declared `health_url` with `fetch(..., { credentials: 'omit', cache: 'no-store' })` and a short timeout. A successful HTTP response is shown as healthy, a non-OK HTTP response as unhealthy, and CORS/network/timeouts as unreachable or blocked; raw health response bodies are never rendered. If a healthy response includes an optional top-level `runtime` object, the panel may parse it and render only allowlisted scalar fields such as `sidecar`, `native_host`, `bridge`, `last_seen_at`, and `webui_origin`. This keeps sidecar-specific diagnostics machine-readable without making WebUI depend on any one extension's private payload shape.

The same card also exposes proxy consent through `POST /api/extensions/sidecar-proxy-consent` and reports the fixed per-extension sidecar path `/api/extensions/<extension-id>/sidecar/<relative-path>`. WebUI strips `Cookie`, `Authorization`, and CSRF headers before contacting the sidecar, and sidecar `Set-Cookie` headers are stripped before the browser sees the response. WebUI does not create arbitrary extension-owned backend routes; the proxy surface stays on that fixed per-extension sidecar path.

Settings, Extensions also renders each installed entry's declared
`settings_schema` and lets the user reset the extension's settings and clear its
storage. Those values live in the browser under `hermes.ext.settings.<id>` and
`hermes.ext.storage.<id>`; the panel reads and writes them through the
`settings.*` and `storage.*` methods.

## Minimal example

See [`examples/extensions/hello-panel/`](examples/extensions/hello-panel/): a
manifest, an `index.html` that loads the SDK, and `panel.js` that reads
settings, counts clicks in storage, shows a toast and logs lifecycle events.
Copy the directory into your extension root, add the entry to `extensions.json`,
reload the WebUI and open **Hello** in the rail.
