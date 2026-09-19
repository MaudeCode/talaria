# Migrating an extension to protocol v1

HWEB-100 removed injected scripts and stylesheets, `window.hermesExt`,
`window.registerHermesSkin`, `window.registerHermesTtsEngine`, session-open
handlers, and the dashboard-plugin IIFE loader. This guide maps each legacy
integration to the sandboxed protocol described in
[`extension-protocol-v1.md`](extension-protocol-v1.md).

## 1. Ship a panel document

Before: `extensions.json` listed `scripts` and `stylesheets` that ran inside the
WebUI page with full session authority.

After: add `panel` (an HTML file under your extension directory) and, if the
panel should appear in the rail, `nav`. Your script runs inside that document,
in a sandboxed iframe. Move your stylesheet into the panel; it can no longer
style the core page.

```json
{ "id": "my-ext", "panel": "my-ext/index.html", "nav": { "label": "My Ext" }, "capabilities": ["settings", "storage", "toast"] }
```

```html
<script src="../../static/dist/extension-sdk.js"></script>
<script>
  Hermes.connect().then(async (hermes) => {
    const { values } = await hermes.call('settings.get')
    document.body.textContent = values.greeting
  })
</script>
```

The Settings page lists an entry that still has only `scripts` as
"needs migration"; it never executes.

## 2. Settings and storage

| Legacy | Protocol |
|---|---|
| `hermesExt.settings.forExtension(id).get(key)` | `await hermes.call('settings.get', { key })` |
| `.set(key, value)` | `await hermes.call('settings.set', { key, value })` (schema-validated) |
| `.reset()` | `await hermes.call('settings.reset')` |
| `hermesExt.storage.forExtension(id).get/set/remove/clear` | `storage.get`, `storage.set`, `storage.remove`, `storage.clear`, `storage.keys` |

Declare `settings` and `storage` in `capabilities`. Values keep the legacy
`localStorage` keys, so existing user settings carry over.

## 3. Turn lifecycle

| Legacy | Protocol |
|---|---|
| `ext.events.on('turn:complete', handler)` | `hermes.on('turn:complete', handler)` (declares `lifecycle`) |

The payload shape is unchanged: `{ type, sessionId, streamId, timestamp,
startedAt?, endedAt?, status? }`. Only the four turn events exist; there is no
token, tool, approval, or metrics stream.

## 4. Custom Configure editors

The `registerConfigure` hook is gone. Render your configuration UI inside your
own panel document. Settings, Extensions links to the panel with **Open**.

## 5. Skins

| Legacy | Protocol |
|---|---|
| `window.registerHermesSkin({ name, value, scheme, colors, tokens })` | manifest `theme: { key, name, scheme, colors, tokens }` |

Same token allowlist and value rules. The skin appears in Settings, Appearance
as "<name> (from <extension>)" and is applied as custom properties; no CSS is
injected. Live theme editors should write the manifest and ask the user to
reload, or expose a panel that previews tokens locally.

## 6. TTS engines

| Legacy | Protocol |
|---|---|
| `window.registerHermesTtsEngine({ id, label, synthesize })` | manifest `tts: { id, label }` plus `hermes.registerTts({ id, label }, synthesize)` |

`synthesize(text, { voice, rate, pitch })` must resolve an `ArrayBuffer`; the
SDK transfers it to the host, which plays it through the same audio path as
Edge TTS.

## 7. Sidecars

Direct browser calls to a loopback sidecar are no longer possible from the
sandboxed panel (opaque origin, no `connect-src` exemption). Declare the
sidecar in the manifest, ask the user for consent once in Settings, Extensions,
and call `hermes.call('sidecar.fetch', { path, method, headers, body })`. The
Python proxy enforces consent, target validation, and auth injection.

## 8. Dashboard plugins

A dashboard plugin (`~/.hermes/plugins/<name>/dashboard/`) needs no manifest
change. Its panel is served at `dashboard-plugins/<name>/index.html`: your own
`dist/index.html` if present, otherwise a generated wrapper that loads
`dist/style.css`, `dist/index.js` and the SDK. The IIFE runs inside the sandbox
with `#root` and `#app` mount nodes. Anything that reached into the WebUI page
(`window.parent`, shared globals, cookies) must move to protocol methods.

## 9. Things that no longer exist

- Styling or scripting the core page; reading `S`, `INFLIGHT`, or other globals.
- Calling `/api/*` with the user's session from extension code. Use the
  capabilities; propose a new method if one is missing.
- `HERMES_WEBUI_EXTENSION_SCRIPT_URLS` / `_STYLESHEET_URLS` injection. The
  variables are ignored; move the assets into a panel.

## 10. Checklist

1. Add `panel`, `nav`, `capabilities` (and `theme`, `tts`, `sidecar` if used).
2. Replace `hermesExt.*` calls with `hermes.call(...)`.
3. Load the SDK relatively and connect before using the API.
4. Reload the WebUI, open Settings, Extensions: the entry should show its
   capabilities, no `legacy_injection` notice, and **Open** should render the
   panel.
5. Watch the browser console in the host page: protocol violations are logged
   with the extension id.
