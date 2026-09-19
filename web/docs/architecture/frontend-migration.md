# Frontend architecture: TanStack Start, React, TypeScript (HWEB-100)

Status: implemented by HWEB-100. This document is the authoritative description
of the browser application after the migration. `ARCHITECTURE.md` links here
for the frontend half of the system; the Python half is unchanged in ownership.

## 1. Runtime and server ownership

- Python (`server.py`, `api/`) is the only application server. It owns
  authentication, CSRF, profiles, sessions, filesystem access, processes, agent
  execution, every `/api/*` route, SSE relays, extension sidecar consent and
  proxying, and persistence.
- The browser application is a production-built single-page app: React 19,
  strict TypeScript, TanStack Start in SPA mode, TanStack Router, TanStack
  Query, TanStack Form, TanStack Virtual, Zod 4, Base UI, Tailwind CSS,
  Paraglide JS, Streamdown, `vite-plugin-pwa`.
- The Start plugin runs in SPA mode to produce the prerendered shell and the
  client bundle. No Node process runs in production, so server functions and
  server routes are not used today; the ticket owner lifted the ban on them, so
  a future Node runtime may adopt them.
- Same-origin REST and SSE contracts are preserved. Zod schemas under
  `frontend/src/contracts/` describe them so a future TypeScript handler can
  implement an endpoint without changing React callers.

## 2. Repository layout

```
frontend/                       editable source (npm package "hermes-webui-frontend")
  package.json, package-lock.json
  vite.config.ts                Start SPA plugin, React, Tailwind, Paraglide, PWA injectManifest
  tsconfig.json                 strict, noUncheckedIndexedAccess, verbatimModuleSyntax
  eslint.config.js              typescript-eslint, react-hooks, custom no-raw-fetch / no-innerHTML rules
  vitest.config.ts              jsdom environment, setup with jest-dom
  playwright.config.ts          Node Playwright against the built assets + Python server
  project.inlang/settings.json  Paraglide project (base locale en, all locales)
  messages/<locale>.json        one message catalogue per locale (inlang message format)
  scripts/                      build-time gates (i18n parity, generated-output diff)
  src/
    entry.tsx                   theme/dir boot, base-url freeze, router + query providers
    router.tsx                  route tree, basepath, scroll restoration, not-found, error boundary
    routes/                     TanStack Router file routes (see section 4)
    contracts/                  Zod schemas: http, sse, bootstrap, url, persisted, extension
    api/                        the single typed same-origin client and Query hooks
    stream/                     chat stream reducer, connection, lifecycle hooks
    features/                   UI by domain (auth, onboarding, sessions, chat, composer, panels, settings...)
    shell/                      titlebar, rail, sidebar, layout, shortcuts
    theme/                      tokens.css (carried-forward custom properties), boot.ts, tailwind.css
    i18n/                       Paraglide runtime glue, locale metadata, speech locales
    extensions/                 sandboxed host, bridge, manifest loading
    lib/                        small utilities (persisted JSON, safeNextPath, base url)
    sw.ts                       custom service worker (injectManifest)
  e2e/                          Playwright functional specs
static/dist/                    committed production output served by Python
  index.html                    prerendered SPA shell with token placeholders
  assets/*.[hash].js|css        hashed chunks
  sw.js, manifest.webmanifest, workbox-*.js
static/brand/                   brand artwork (SVG/PNG favicons, apple touch icon)
```

`static/dist/` is generated. It is committed so `git clone && python3 bootstrap.py`,
`pip install`, and the container image work without Node. CI rebuilds from a
clean `npm ci`; `frontend/scripts/check-dist.mjs` verifies the committed output
against a clean build on demand (the CI diff gate was removed by the ticket
owner's scope amendment).

## 3. Build and serving

- `npm run build` in `frontend/` runs: Paraglide compile, i18n parity gate,
  `tsc --noEmit`, ESLint, Vite production build with `base: './'`, PWA service
  worker injection, then writes `static/dist/`. Source maps are off unless
  `HERMES_WEBUI_SOURCEMAP=1`.
- Determinism: Vite's content hashes are stable for identical inputs; the build
  strips timestamps and sorts precache entries. `check-dist.mjs` rebuilds to a
  temporary directory and diffs byte-for-byte.
- Python serves the shell from `static/dist/index.html` for the SPA allowlist
  (section 4). It substitutes three placeholders at request time:
  `__WEBUI_VERSION__`, `__BASE_HREF__` (a relative depth prefix such as `./`
  or `../`, computed from the request path so subpath mounts need no
  configuration), and `__LANG__` for the `<html lang>` attribute. No CSRF token,
  language JSON, upload limit, or extension config is embedded in HTML any
  more; the client fetches `/api/bootstrap`.
- Hashed assets are served from `<mount>/assets/*` (the shell references them as
  `./assets/<hash>` relative to its base href) and, for tooling, from
  `/static/dist/assets/*`; both carry immutable caching and are auth-exempt.
  `/sw.js` maps to `static/dist/sw.js` with `Service-Worker-Allowed: /` and
  `Cache-Control: no-store`. `/manifest.json` and `/manifest.webmanifest` map to
  the generated manifest.
- The base URL is frozen once: `entry.tsx` reads `document.baseURI`, writes the
  absolute value back to the `<base>` element so later `pushState` navigations
  do not move it, exposes it as `appRoot`, and gives TanStack Router
  `basepath = appRoot.pathname`. All API and asset URLs derive from `appRoot`.

### Development server

`HERMES_WEBUI_DEV_PROXY=http://127.0.0.1:8797 npm run dev -- --host 0.0.0.0 --port 8798` (from `frontend/`) serves
the app from source with hot module replacement. The Vite dev server forwards `api/`, `static/`, `extensions/`,
`plugins/`, and `dashboard-plugins/` requests at any mount depth to the Python server named in the variable, which
keeps state, sessions and auth; everything else is served by Vite. The dev document has no Python-injected `<base>`,
so `freezeAppRoot` treats the origin root as the mount in development (`import.meta.env.DEV`). Without the variable,
`npm run dev` runs the bare Start dev server. Passkey-only authentication is not supported through a loopback dev
origin because WebAuthn credentials remain bound to the deployed hostname; password authentication remains usable.

From the repository root, `./ctl.sh start --remote` is the attached wrapper for
this mode. It reads `HERMES_WEBUI_DEV_PROXY` from the ignored `.env`, binds the
local frontend to loopback, and forwards any remaining arguments to Vite.

## 4. Routing contract

TanStack Router owns canonical URLs, path and search parsing, navigation,
history, scroll restoration, not-found, and route error boundaries. Routes are
file-based under `frontend/src/routes/`:

| Route | Purpose | Auth |
|---|---|---|
| `/` | Chat: restores the last session or shows the empty state. Validated search: `session`, `session_id` (redirect to `/session/$id`), `source`, `action` (`new-chat`). Legacy `#settings` and `#sessions` hashes redirect. | required |
| `/session/$sessionId` | Chat for one session. Encoded id validated by `SessionIdSchema`. | required |
| `/tasks`, `/tasks/$jobId` | Scheduled jobs | required |
| `/kanban` | Kanban board; board and filter state in validated search params | required |
| `/skills`, `/skills/$name` | Skills | required |
| `/memory` | Memory, notes | required |
| `/workspaces`, `/workspaces/$index` | Workspaces | required |
| `/profiles`, `/profiles/$name` | Profiles | required |
| `/todos` | Current task list | required |
| `/insights` | Insights; `days` search param | required |
| `/logs` | Logs; `file`, `tail` search params | required |
| `/settings`, `/settings/$section` | Settings; section is an enum guard | required |
| `/ext/$extensionId` | Sandboxed extension panel | required |
| `/onboarding` | First-run wizard | required (server) |
| `/login` | Login | none |
| `/share/$token` | Public read-only share | none |
| `*` | Client not-found for allowlisted prefixes only | |

Python serves the shell for exactly these prefixes: `/`, `/index.html`,
`/session/`, `/tasks`, `/kanban`, `/skills`, `/memory`, `/workspaces`,
`/profiles`, `/todos`, `/insights`, `/logs`, `/settings`, `/ext/`, `/onboarding`,
`/login`, `/share`. Everything else keeps its server owner (`/api/*`, `/health`,
`/static/*`, `/sw.js`, `/manifest.*`, `/extensions/*`, `/plugins/*`,
`/dashboard-plugins/*`, `/favicon.ico`, `/search`) or returns 404. The
allowlist lives in `api/spa_routes.py` and is tested in
`tests/test_hweb100_spa_shell_routes.py`.

Unauthenticated requests to protected shell routes still receive the server's
302 to `/login?next=<safe path>`. The client never decides authorization; it
only renders what the server allows.

## 5. State ownership

| Concern | Owner | Notes |
|---|---|---|
| Bookmarkable URL state | TanStack Router | path params, validated search schemas (Zod), hash |
| Server resources (sessions list, session metadata, settings, profiles, models, panels) | TanStack Query | keys in `api/queryKeys.ts`; mutations invalidate by key family; profile switch resets the whole cache |
| Active chat stream | `stream/` reducer store (`useSyncExternalStore`) | connection state, event projection, in-flight turn, approvals/clarify prompts, metering, notices; never routed through Query |
| Local interaction state | React component state | menus, drafts before persist, collapse toggles |
| Persisted browser state | `lib/persisted.ts` | validated JSON only (`contracts/persisted.ts`); keys keep their legacy names where semantics are unchanged (`hermes-theme`, `hermes-skin`, `hermes-lang`, `hermes-webui-session`, `hermes-webui-sidebar-collapsed`, `hermes-webui-tab-order`, `hermes-webui-hidden-tabs`, `hermes-font-size`, `hermes-full-width-chat`, `hermes-rtl`) |
| Extension channels | `extensions/host.ts` | one `MessageChannel` per iframe, nonce and version handshake, capability table from the sanitized manifest |
| Service worker state | `sw.ts` | precache list injected by the build; runtime caches for hashed assets only |

## 6. Contracts and the backend migration seam

- `frontend/src/contracts/` holds browser-independent Zod 4 schemas: request
  bodies, responses, the normalized `ApiError`, `/api/bootstrap`, SSE events (a
  discriminated union by wire name), URL search params, persisted state, and
  extension protocol messages. Modules import only `zod`.
- `frontend/src/api/client.ts` is the only module that calls `fetch` or
  constructs `EventSource`. It resolves same-origin URLs from `appRoot`, adds
  the CSRF header to unsafe same-origin requests (except `/api/auth/login` and
  `/api/csp-report`), coalesces identical idempotent requests, retries network
  failures with the legacy policy, redirects once on 401, parses the response
  with the endpoint schema, and returns typed values. An ESLint rule fails the
  build on any other `fetch`/`EventSource` use.
- Fixtures under `frontend/src/contracts/__fixtures__/` are consumed by Vitest
  schema tests and by `tests/test_hweb100_contract_fixtures.py`, which asserts
  the live Python handlers still produce payloads that satisfy the same
  fixtures' shapes.
- `frontend/src/contracts/adapters/` proves the seam: an in-memory adapter
  implements the session read endpoint and the session rename mutation from the
  schemas alone, and the React hooks run against it in tests unchanged.

## 7. Bootstrap endpoint

`GET /api/bootstrap` returns public runtime configuration and initial state in
one validated payload: `webuiVersion`, `maxUploadBytes`, `csrfToken` (empty
when unauthenticated or auth disabled), `language`, `auth` (the
`/api/auth/status` payload), `onboarding` (`needs_onboarding`), `profile`
(active profile summary), `features` (dashboard link availability, terminal
remote backend, extension platform enabled). It replaces the inline
`window.__HERMES_CONFIG__`, `__HERMES_WEBUI_BUNDLE_VERSION__`, and
`__HERMES_EXTENSION_CONFIG__` globals. It is served without authentication
because it contains no secrets before login; the CSRF token is included only
for an authenticated session cookie.

## 8. Chat streaming

`stream/reducer.ts` is a pure reducer over the SSE union. `stream/connection.ts`
owns the `EventSource` lifecycle: open after `POST /api/chat/start`, reconnect
through `GET /api/chat/stream/status`, journal replay with `after_seq` and
`after_event_id`, and teardown. Every lifecycle exit is a reducer action with a
test: `done`, `stream_end`, `apperror`, `cancel`, legacy `error`, reconnect,
replay, session replacement, profile change, and unmount. Invariants from
`docs/rfcs/webui-run-state-consistency-contract.md` and
`docs/rfcs/stable-assistant-turn-anchors.md` are asserted in
`frontend/src/stream/reducer.test.ts`.

## 9. UI, styling, accessibility

- Theme system: `frontend/src/theme/skins.ts` is the single source of truth
  for tokens and skins (palette, semantic and component tiers; 21 `SkinSpec`
  entries as data; `renderThemeCss`). The `hermesTheme` Vite plugin serves the
  rendered cascade as `virtual:hermes-theme.css`; `tailwind.css` maps the same
  names into `@theme` so utilities consume tokens; component sheets under
  `theme/components/` (in `@layer app`, after utilities) never mention a skin
  or a theme and carry no colour literals (enforced by `skins.test.ts`). The
  per-skin overrides the legacy sheet expressed as `!important` rules became
  component tokens or one of two traits (`square-controls`, `card-sessions`).
  The legacy stylesheet was converted with `frontend/scripts/css-convert.mjs`
  (now a history tool); `docs/architecture/css-conversion-ledger.md` gives every
  one of its 4166 rules a disposition. `skins.test.ts` validates every skin's
  token contract and generated CSS.
- Base UI provides dialogs, alert dialogs, menus, popovers, tooltips, tabs,
  selects, comboboxes, and focus management. The composer command palette uses
  Base UI Combobox; the approval card keeps its inline placement but uses the
  Base UI focus trap semantics.
- Icons: `lucide-react`. Brand artwork: `static/brand/`.
- Reduced motion, RTL (logical properties), safe areas, 44px touch targets,
  accessible names, and live regions are preserved; RTL behaviour tests run in
  `dir="rtl"`.

## 10. Localisation

Paraglide JS compiles `frontend/messages/<locale>.json` into tree-shakeable
message functions with per-locale chunks. The runtime strategy is
`localStorage` (`hermes-lang`) then the server `language` setting from
bootstrap then `en`. No locale path segments. `frontend/scripts/i18n-gate.mjs`
fails the build when English is missing a key any locale defines, when
placeholders differ between English and a translation, or when a locale has a
key English lacks. Plural helpers for `ru`, `zh`, `zh-Hant` tool summaries are
ported as message variants.

## 11. Rendering

Streamdown renders Markdown with the `code` (Shiki), `mermaid`, `math`
(KaTeX), and `cjk` plugins only. Hermes structures (tool calls, reasoning,
approvals, clarification, file links, media, subagents, background processes,
goals, todos, lifecycle status) are typed React components fed from the stream
reducer and session payload, never Markdown strings. The only HTML sink is
Streamdown's own sanitized renderer; `dangerouslySetInnerHTML` is forbidden by
lint outside `frontend/src/features/chat/render/`, which contains no such use
today. The legacy renderer corpus is ported to
`frontend/src/features/chat/__fixtures__/markdown/` with differential
expectations.

## 12. Extensions

The unified sandboxed extension platform is specified in
[`extension-protocol-v1.md`](extension-protocol-v1.md) with the migration guide
in [`extension-migration-guide.md`](extension-migration-guide.md). In summary:
every extension UI runs in a sandboxed iframe served from `/extensions/` or
`/plugins/`; the host and the iframe communicate over a dedicated
`MessageChannel` after a nonce and version handshake; every message is
validated with Zod, bound to the owning iframe and extension id, checked against
declared capabilities, and bounded in size; skins are validated theme-token
maps; TTS and lifecycle hooks are opt-in capabilities; sidecar access goes
through the Python-owned consented proxy. Legacy injection and globals are gone.

## 13. PWA, assets, security

- `vite-plugin-pwa` in `injectManifest` mode with `frontend/src/sw.ts`
  precaches the hashed shell, cleans obsolete caches on activate, serves the
  offline shell for navigations, and never caches API responses. Update flow:
  `registerSW` with a prompt, `skipWaiting` on user confirmation, reload on
  `controllerchange`.
- CSP: `script-src 'self'` (no `'unsafe-inline'`, no CDN), `worker-src 'self'
  blob:`, `style-src 'self' 'unsafe-inline'` (inline `style` attributes from
  the rendering libraries; no inline `<style>` blocks), `font-src 'self' data:`,
  `connect-src` unchanged. `frame-src` unchanged (`'self'` plus operator
  extras) for sandboxed extension frames.
- Auth cookies, CSRF, profile scoping, authorization, and redirects are
  server-owned. Root and route error boundaries render retry and reload
  actions.
- Dependencies are pinned by `frontend/package-lock.json`. Update and audit
  with `npm --prefix frontend outdated`, `npm --prefix frontend audit`, then
  `npm --prefix frontend update <pkg>` followed by `npm run build` and,
  optionally, `npm run check-dist`.

## 13a. Scope amendments

Recorded on the ticket on 2026-09-15 by the ticket owner. Removed restrictions:
no global state library; TanStack Virtual only where already required; no Start
server functions or routes; the CI committed-output diff gate; the legacy theme
and skin custom properties as the authoritative design tokens. The legacy
stylesheet was the visual reference while the chrome was restyled with Tailwind.
Current UI changes use PR before/after evidence and manual review.

## 13b. Validation-round adjustments

Recorded after the ticket owner validated the built frontend on the LAN
preview (2026-09-15 and 2026-09-16). Product-visible changes are X5 to X11 in
the parity matrix. Mechanisms worth knowing:

- **Boot.** `frontend/src/theme/prepaint.js` is a blocking classic script in
  `<head>` (a hashed asset, never inlined as a `data:` URL, precached by the
  service worker) that applies the persisted theme, skin, collapsed sidebar and
  workspace-panel state before first paint. While `#app` is empty, pseudo-element
  rules in `shell.css` draw the frame (rail divider and main card). The query
  client hydrates a `dehydrate()` snapshot of the shell queries from
  `hermes-boot:queries` (validated with the contract schemas on the way in,
  stale on arrival, written 500 ms after each successful fetch and on
  `pagehide`). Login and logout clear the `hermes-boot:` prefix. The chat view
  assumes a session has content until its transcript says otherwise; only a
  session remembered in `hermes-webui-session-empty` opens in the hero layout.
- **Stylesheets** are imported by the root route, not the client entry, so the
  dev document links them in `<head>` too.
- **Shell geometry.** The main pane has no outer margin; the sidebar, the rail
  (while the sidebar is collapsed) and the workspace panel carry `.seam`
  children, card-coloured concave fillets built from radial gradients, the same
  construction as the workspace edge tab's joins. The side columns stack above
  `.composer-wrap` so their resize handles are never covered. Both resize
  highlights stop one seam radius short of the top and bottom and the seams draw
  an accent ring along their arc on hover.
- **Component sheets** keep every rule inside their `@layer app{}` block; an
  unlayered rule outranks layered ones regardless of specificity, which hid one
  hover rule during this round.
- **Dev server.** See "Development server" in section 3.

## 14. Testing

| Layer | Command | Covers |
|---|---|---|
| Types | `npm run typecheck` | strict TS, no emit |
| Lint | `npm run lint` | TS/React, service worker, contract rules |
| Unit | `npm run test` (Vitest) | contracts, reducer, router search schemas, Query invalidation, forms, extension protocol, PWA helpers, rendering adapter, hostile corpus |
| Behaviour | Vitest + RTL | focus, keyboard, live regions, forms, dialogs, menus, comboboxes, error states, reduced motion |
| End to end | `npm run e2e` (Node Playwright) | navigation, hard refresh, chat lifecycle with the deterministic gateway, reconnect, auth, onboarding, extensions, PWA update, subpath mount at desktop and mobile viewports |
| Python | `./scripts/test.sh` | SPA allowlist, bootstrap, auth/CSRF/profile boundaries, share, extension assets/sidecars, 404s, contract fixtures |
| Packaging | `tests/test_hweb100_packaging.py`, Docker smoke | wheel and container include `static/dist/` and run without Node |

Tests pin clocks, locale (`en`), data, and viewport for deterministic browser
checks.

## 15. Rollback

Revert the merge commit. The legacy frontend and its serving code return with
it; no data migration is involved. Persisted browser keys keep their legacy
names and JSON shapes, so a rolled-back client reads the same preferences.
Extension authors who migrated to the protocol would need the previous
extension build until the migration is re-applied.
