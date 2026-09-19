# Frontend parity matrix (HWEB-100)

This document is the checked-in inventory of every user-visible capability the
legacy frameworkless frontend (`static/*.js`, `static/index.html`,
`static/style.css`) provided, and the owner, route, and verification of each
capability in the TanStack Start / React / TypeScript frontend under
`frontend/`. It is a contract document: a row may not be removed silently. A
capability that is intentionally different or deferred must say so in the
`Status` column with the approval reference.

Status vocabulary:

| Status | Meaning |
|---|---|
| `pass` | Behaviour reproduced and covered by the named verification. |
| `partial` | Core behaviour reproduced; a listed sub-behaviour is reduced. The `Notes` column names it. |
| `deferred` | Not reproduced in this migration. Requires the separate product approval named in `Notes` before merge. |

Verification vocabulary: `vitest` (unit / reducer / contract / React Testing
Library component test under `frontend/src/**/*.test.ts(x)`), `pw` (Playwright
end-to-end against the built frontend and the Python server, `frontend/e2e/`),
`py` (pytest route / contract test), `manual` (checked in a browser during the
HWEB-100 validation pass; no automated test yet).

Status at the end of checkpoint 8 (this revision is the truthful inventory
the ticket requires; every row was re-checked against `frontend/src`):

| Status | Rows |
|---|---|
| `pass` | 70 |
| `partial` | 28 |
| `deferred` | 9 |

Deferred rows need the product decision recorded in the PR before merge.

## 1. Authentication and identity

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| A1 | Password login form with locale strings, invalid-password and connection-failed messages | `routes.py` `_LOGIN_PAGE_HTML`, `static/login.js` | `routes/login.tsx`, `features/auth/LoginPage.tsx` | `/login` | vitest (`LoginPage.test.tsx`), pw (`auth.spec.ts`), py | pass | Server still 302s unauthenticated app routes to `/login?next=`; the SPA renders the form. |
| A2 | Safe `?next=` redirect after login (rejects protocol-relative, control chars, nested login chains) | `static/login.js` `_safeNextPath` | `features/auth/safeNextPath.ts` | `/login` | vitest, pw | pass | Same rules; server-side `_safe_login_redirect_path` unchanged. |
| A3 | OIDC login link and callback bounce | `routes.py` `_oidc_login_html` | `LoginPage.tsx` reads `bootstrap.auth.oidc_enabled` | `/login` | vitest, py (`test_hweb100_bootstrap.py`) | pass | Callback remains server-owned at `/api/auth/oidc/callback`. |
| A4 | Passkey login (WebAuthn get) and passkey registration in Settings | `static/login.js`, `panels.js` | `features/auth/passkeys.ts`, `LoginPage.tsx`, `settings/SystemSection.tsx` | `/login`, `/settings/system` | vitest (codec), manual | pass | WebAuthn ceremony itself needs a real authenticator. |
| A5 | Logout clears boot snapshots and returns to login | `boot.js` | `features/auth/useLogout.ts` | any | manual | pass | Validated-JSON persisted state cleared by key prefix. |
| A6 | Auth-disabled acknowledgement banner | `ui.js` | `settings/SystemSection.tsx` | `/settings/system` | manual | partial | Acknowledgement is a Settings, System control; there is no shell-wide banner. |
| A7 | CSRF header on same-origin unsafe requests, exempting login and CSP report | inline fetch monkeypatch in `index.html` | `api/client.ts` adds `X-Hermes-CSRF-Token` from `/api/bootstrap` | all | vitest (`client.test.ts`), py | pass | No fetch monkeypatch; the single client module is the only HTTP path (ESLint-enforced). |
| A8 | Stale-client detection and hard refresh banner | `ui.js` `staleClientBanner` | none | app shell | none | deferred | The service worker activates new builds on next load (`SKIP_WAITING`); no in-app version-mismatch banner. |

## 2. Onboarding and profiles

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| B1 | First-run onboarding wizard (status, probe, provider setup, OAuth start/poll/cancel, complete) | `static/onboarding.js` | `routes/onboarding.tsx`, `features/onboarding/OnboardingPage.tsx` | `/onboarding` | pw (route), manual | partial | Status, probe, provider setup, OAuth start and complete are implemented; OAuth poll/cancel controls are not exposed in the page. |
| B2 | Workspace add during onboarding | `onboarding.js` | `features/onboarding/OnboardingPage.tsx` | `/onboarding` | manual | pass | |
| B3 | Profile list, active profile, switch, create, delete | `panels.js`, `boot.js` titlebar dropdown | `features/profiles/ProfilesPage.tsx`, `shell/ProfileMenu.tsx` (Base UI Menu) | `/profiles`, titlebar | pw (route), manual | pass | Profile switch invalidates all Query caches and tears down the stream. |
| B4 | Single-profile (isolated) mode hides switcher | `ui.js` | `shell/ProfileMenu.tsx` | app shell | manual | pass | |
| B5 | Profile-scoped session visibility (409 `session_profile_mismatch`) | `sessions.js` | `features/chat/useTranscript.ts` | `/session/$id` | vitest (`client.test.ts` error kinds), manual | pass | Mapped to a typed error state with a switch-profile action. |

## 3. Sessions and navigation

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| C1 | Canonical `/` and `/session/<encoded-id>` URLs; history restore; last-session restore | `sessions.js` `_appRootPath`, inline boot scripts | `routes/_app.index.tsx`, `routes/_app.session.$sessionId.tsx`; `lib/persisted.ts` | `/`, `/session/$id` | pw (`shell.spec.ts`), vitest (`appRoot.test.ts`), py | pass | Restores by validated `hermes-webui-session` key; no `innerHTML` snapshots. |
| C2 | Legacy `?session=` / `?session_id=` query and `#settings` hash launch flows | inline scripts, `boot.js` | `routes/_app.tsx`, `routes/_app.index.tsx` redirects | `/` | pw (hash redirect) | pass | Redirects to canonical routes. |
| C3 | PWA launch flows `?source=pwa&action=new-chat` | `pwa-startup.js`, `boot.js` | `contracts/url.ts`, `routes/_app.index.tsx` | `/` | manual | pass | |
| C4 | New chat (titlebar, rail brand, sidebar) | `sessions.js` `newChat` | `features/sessions/useNewChat.ts` | app shell | manual | pass | |
| C5 | Session list: grouping, pin, archive, project groups, search filter, source filters (CLI, Claude Code, cron, webhook, kanban), all-profiles toggle | `sessions.js` | `features/sessions/SessionListPanel.tsx` | sidebar | pw (home), manual | partial | Day grouping, pinned/archived sections, text filter and source badges are implemented. Project-group sections and the all-profiles toggle are not; the list is not virtualised. |
| C6 | Live sidebar sync (`sessions_changed`) | `sessions.js` | `features/sessions/SessionListPanel.tsx` via `api/sse.ts` `openSessionListStream` on `GET /api/sessions/events` | sidebar | pw (console gate), manual | pass | Invalidates the session list query; one EventSource per panel plus a visibility-gated poll. |
| C7 | Rename, duplicate, delete, move to project, pin, archive, export, import (JSON and CLI), regenerate title, branch/fork, truncate, undo, retry | `sessions.js`, context menu | `features/sessions/SessionContextMenu.tsx` (Base UI Menu) | sidebar, chat header | manual | partial | Truncate, undo and retry are not in the menu; the rest is. |
| C8 | Project groups create/rename/delete | `sessions.js` | `api/endpoints.ts` (`/api/projects`), `SessionContextMenu.tsx` move-to-project | sidebar | manual | partial | Move to project is available; project create/rename/delete UI is not. |
| C9 | Sidebar collapse, resize handle, mobile drawer, hidden/reordered tabs | `boot.js`, inline scripts | `shell/Sidebar.tsx`, `shell/Rail.tsx`, `shell/nav.ts`, `lib/persisted.ts` | app shell | manual | pass | Persisted as validated JSON; applied before first paint by the entry module (`data-*` on `<html>`). |
| C10 | Composer drafts per session (`/api/session/draft`) | `sessions.js` | `features/composer/useDraft.ts` | chat | manual | pass | |
| C11 | Session status polling, stream reattach on return, bfcache reattach | `messages.js` | `stream/connection.ts` | chat | vitest (`reducer.test.ts`), manual | partial | Reattach on route entry and after reconnect backoff is implemented; there is no `pageshow`/`visibilitychange` hook for bfcache restores. |
| C12 | Public share create/revoke and read-only share page | `panels.js`, `share.html`, `share.js` | `routes/share.$token.tsx`, `features/share/SharePage.tsx`, `SharedTranscript.tsx` | `/share/$token` | py (`noindex` shell), manual | pass | Share page is a route of the same SPA; unauthenticated shell allowed for `/share/*`. |
| C13 | Handoff summary and compression-recovery cards | `messages.js`, `sessions.js` | `features/chat/ChatView.tsx` | chat | manual | partial | Compression and handoff state are surfaced inline in the chat view, not as dedicated cards. |
| C14 | Worktree status/remove for worktree sessions | `sessions.js` | `features/sessions/SessionContextMenu.tsx`, `useNewChat.ts` | sidebar | manual | pass | |
| C15 | Session search (`/api/sessions/search`) | `sessions.js` | `features/chat/useSessionSearch.ts`, `SessionListPanel.tsx` | sidebar | manual | pass | |
| C16 | Unknown paths return HTTP 404 from Python; unknown nested client paths render the not-found route | `routes.py` catch-all | `api/spa_shell.py` allowlist; `routes/__root.tsx` `notFoundComponent` | any | py (`test_hweb100_spa_shell_routes.py`), pw | pass | SPA shell never shadows `/api/*`, `/assets/*`, `/extensions/*`, `/plugins/*`, `/static/*`, `/sw.js`, `/manifest.json`, `/health`. |
| C17 | Subpath mount support for shell, assets, manifest, service worker, API, sessions, extension panels | `<base href>` inline script, `/session/static/` alias | Server-emitted `<base href>` depth prefix; router `basepath` from `document.baseURI`; relative asset URLs | all | py (`base_href_for`), pw (`deep links`), vitest (`appRoot.test.ts`) | partial | Depth-relative base is verified for `/session/<id>`; a reverse-proxied `/mount/` prefix has not been exercised end to end. |

## 4. Chat transcript and streaming

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| D1 | Send message via `POST /api/chat/start`, optimistic user row adopting server turn identity | `messages.js` `send()` | `stream/connection.ts` `startTurn`, `stream/reducer.ts` | chat | vitest (`reducer.test.ts`) | pass | |
| D2 | Live token streaming (`token`, `interim_assistant`, `already_streamed`, `reasoning_echo`) | `messages.js` | `stream/reducer.ts` | chat | vitest | pass | Ordering and idempotency proven in reducer tests. |
| D3 | Reasoning / thinking blocks with titles, collapsed by default, reduced-motion aware | `messages.js`, `assistant_turn_anchors.js` | `features/chat/blocks/ReasoningBlock.tsx` | chat | manual | pass | |
| D4 | Tool call cards (`tool`, `tool_complete`), worklog summary, transparent stream mode, event timestamps | `ui.js`, `assistant_turn_anchors.js` | `features/chat/blocks/ToolCard.tsx`, `Worklog.tsx`, `LiveTurnView.tsx` | chat | vitest (reducer), manual | partial | Worklog summary and tool cards are implemented; the transparent-stream toggle is a Settings, Conversation preference whose live view is not distinct from the worklog. |
| D5 | Approval card (`approval` event, once/session/always/deny/skip-all, pending counter, collapse, keyboard Enter) | `index.html` `#approvalCard`, `messages.js` | `features/chat/ApprovalCard.tsx` (alertdialog semantics inline) | chat | vitest (`ApprovalCard.test.tsx`), py | pass | |
| D6 | Clarification card (`clarify` event, choices, countdown, custom answer) | `#clarifyCard`, `messages.js` | `features/chat/ClarifyCard.tsx` | chat | vitest (`ApprovalCard.test.tsx`), py | pass | |
| D7 | Terminal exits: `done`, `stream_end`, `apperror` (typed), `cancel`, `error` legacy | `messages.js` | `stream/reducer.ts` | chat | vitest | pass | Every exit clears in-flight state and releases the EventSource. |
| D8 | Cancel (Stop button, `/stop`), interrupt, queue, steer, stop-and-send, leftover steer | `messages.js`, `boot.js` `cancelStream` | `stream/connection.ts`, `features/composer/Composer.tsx`, `ChatView.tsx` | chat | vitest (reducer cancel), manual | pass | |
| D9 | Reconnect and journal replay (`/api/chat/stream/status`, `replay=1`, `after_seq`, `after_event_id`) | `messages.js` | `stream/connection.ts` | chat | vitest (reducer seq dedupe), manual | partial | Reconnect with backoff and `replay=1` from the last event id are implemented; `after_seq` is not sent. |
| D10 | Session replacement / profile change tears down the live stream without cancelling the backend run | `messages.js` `closeLiveStream` | `stream/connection.ts` `teardown` | chat | vitest | pass | |
| D11 | Compression (`compressing`, `compressed`, continuation session redirect) | `messages.js` | `stream/reducer.ts`, `ChatView.tsx` | chat | vitest | pass | |
| D12 | Context window ring, `context_status`, `metering`, TPS badge, cost | `ui.js` | `features/chat/LiveTurnView.tsx`, `Composer.tsx` | composer | manual | partial | Context usage and metering are shown; there is no cost readout. |
| D13 | Title updates (`title`, `title_status`) and adaptive titlebar | `messages.js`, `ui.js` | `stream/reducer.ts`, `shell/Titlebar.tsx` | chat | vitest | pass | |
| D14 | Goals (`goal`, `goal_continue`) and todos (`todo_state`) panels | `messages.js`, `panels.js` | `stream/reducer.ts`, `features/todos/todoStore.ts`, `routes/_app.todos.tsx` | chat, `/todos` | manual | pass | |
| D15 | Background completion notifications (`bg_task_complete`, `/api/bg-task-complete-ack`, `/api/process-complete-ack`) | `messages.js` | `stream/connection.ts` | app shell | manual | pass | |
| D16 | Subagent / delegated session cards and view-only subagent sessions | `ui.js`, `sessions.js` | `features/chat/toolKind.ts` (delegation tool kinds) | chat | manual | partial | Delegation tool calls render as tool cards; there is no dedicated subagent card or view-only mode. |
| D17 | Historical transcript hydration with windowed load (`msg_limit`, `msg_before`), jump-to-start, scroll-to-bottom, auto-follow toggle | `sessions.js`, `messages.js` | `features/chat/Transcript.tsx` (TanStack Virtual), `useTranscript.ts` | chat | manual | pass | |
| D18 | Edit, regenerate, fork from message, copy, select-text reply/refine | `messages.js` | `features/chat/MessageRow.tsx` | chat | manual | partial | Edit, regenerate, fork and copy are implemented; select-text reply/refine is not. |
| D19 | Attachments: click, drag/drop, paste image and text, tray, upload rollback, size limit from bootstrap | `boot.js`, `messages.js`, `/api/upload` | `features/composer/Attachments.tsx`, `Composer.tsx`, `api/client.ts` upload | composer | manual | pass | |
| D20 | Media snapshots and image lightbox, Mermaid lightbox, export | `ui.js` | `features/chat/MessageRow.tsx` (inline images) | chat | manual | deferred | Images render inline; no lightbox dialog. |
| D21 | Voice: dictation (SpeechRecognition), voice mode, TTS (browser, Edge TTS via `/api/tts`, extension TTS capability) | `boot.js`, `ui.js` | `features/voice/dictation.ts`, `features/voice/tts.ts` | composer | manual | pass | Browser speech APIs need a real browser and microphone. |
| D22 | Workspace terminal panel (xterm, fit, web links, resize, dock, restart) | `terminal.js`, CDN xterm | `features/terminal/TerminalPanel.tsx` with bundled `@xterm/xterm` | composer | manual | partial | No dock toggle. CDN dependency removed. |
| D23 | Runtime notice stack (offline, reconnect, agent unavailable, provider failure, thread error) with live regions | `ui.js` HWEB-11 | `features/notices/RuntimeNoticeStack.tsx` | chat | manual | pass | Same priority order and single-slot rules. |
| D24 | Server-stopped overlay and cross-tab shutdown broadcast | `boot.js` | `settings/SystemSection.tsx` (shutdown/restart actions) | app shell | manual | deferred | No full-screen stopped overlay or cross-tab broadcast. |
| D25 | Update banner (check/apply/force/clear lock, summary, permissions) | `panels.js`, `ui.js` | `settings/SystemSection.tsx` | `/settings/system` | manual | partial | Update check/apply live in Settings, System; there is no shell banner. |
| D26 | Conversation outline / minimap | `outline.js` | none | chat | none | deferred | |
| D27 | Selection context chips (named context blocks) | `messages.js` | none | composer | none | deferred | |
| D28 | Slash commands: registry, parser, autocomplete dropdown, bundles, MoA, `/api/commands/exec` | `commands.js` | `features/composer/commands.ts`, `CommandPalette.tsx` | composer | vitest (`commands.test.ts`) | pass | |
| D29 | Saved prompts popup | `messages.js` | none | composer | none | deferred | `/api/saved-prompts` is untouched server-side. |
| D30 | YOLO pill and per-session yolo toggle | `boot.js` | `features/composer/Composer.tsx`, `ChatView.tsx` | composer | manual | pass | |
| D31 | Model chip and dropdown (groups, provider, live refresh, explicit pick), reasoning effort chip, toolsets chip, personality | `ui.js`, `panels.js` | `features/composer/chips.tsx`, `Composer.tsx` | composer | manual | pass | |
| D32 | Workspace chip and dropdown, workspace files panel toggle | `workspace.js` | `features/composer/chips.tsx`, `ChatView.tsx` | composer | manual | pass | |
| D33 | Provider quota chip | `ui.js` | `settings/ProvidersSection.tsx` | `/settings/providers` | manual | partial | Quotas are shown in Settings, Providers, not as a composer chip. |
| D34 | Send key preference (Enter vs Ctrl+Enter), Shift+Enter newline, busy input modes | `boot.js` | `features/composer/Composer.tsx` | composer | manual | pass | |
| D35 | Hero composer (empty state) docking after first message, workspace-aware headline | `ui.js` HWEB-1 | `features/chat/ChatView.tsx` | chat | pw (home), manual | pass | |
| D36 | Keyboard shortcuts (new chat, focus composer, toggle sidebar, escape) | `boot.js` | `shell/useShortcuts.ts` | app shell | manual | pass | Same key map. |

## 5. Rendering

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| E1 | GitHub-flavoured Markdown, incomplete streamed Markdown | `ui.js` `renderMd`, `smd.min.js` | Streamdown (`features/chat/render/Markdown.tsx`) | chat, share | vitest (`render/text.test.ts`), manual | pass | |
| E2 | Code blocks: Shiki highlighting, language label, copy, download, wrapping and overflow containment | `ui.js`, Prism CDN | `@streamdown/code` with Shiki | chat | manual | pass | Prism and CDN removed. |
| E3 | Tables: header/cell spacing, pipe protection, copy as TSV/Markdown, CSV rendering | `ui.js` | Streamdown tables | chat | manual | partial | Streamdown's built-in table controls; CSV rendering is not special-cased. |
| E4 | Task lists, links (safe target/rel), images (data URLs allowed, remote per CSP), blockquotes | `ui.js` | Streamdown | chat | manual | pass | |
| E5 | Math via KaTeX (vendored) | `ui.js`, `static/vendor/katex` | `@streamdown/math` (bundled KaTeX CSS/fonts) | chat | manual | pass | Fonts bundled; CSP `font-src 'self' data:`. |
| E6 | Mermaid diagrams with toolbar and lightbox | `ui.js` | `@streamdown/mermaid` | chat | manual | partial | Diagrams render; no lightbox. |
| E7 | CJK-aware rendering | none explicit | `@streamdown/cjk` | chat | manual | pass | |
| E8 | Hostile input: raw HTML escaped, `javascript:` links stripped, no `innerHTML` outside the reviewed adapter | `ui.js` sanitizer | Streamdown default sanitization; `features/chat/render/` is the single reviewed raw-HTML directory | chat | vitest (`text.test.ts`), ESLint rule | pass | ESLint forbids `dangerouslySetInnerHTML`/`innerHTML` outside `features/chat/render/`. |
| E9 | Render user Markdown toggle | `ui.js` | `features/chat/Transcript.tsx`, `settings/ConversationSection.tsx` | chat | manual | pass | |
| E10 | Data image renderer, file links (`/api/file/raw`), office document preview | `ui.js`, `workspace.js` | `api/endpoints.ts`, `features/workspace/WorkspacePanel.tsx` preview | chat, workspace | manual | partial | Workspace preview covers text and Markdown; office documents download instead of previewing. |
| E11 | Large Markdown preview performance (lazy worklog render, render cache) | `ui.js` | React memoisation + TanStack Virtual transcript | chat | manual | pass | |

## 6. Panels

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| F1 | Tasks (cron jobs): list, create, update, delete, run, pause, resume, history, output, delivery options, gateway notice, all-profiles toggle | `panels.js` | `routes/_app.tasks.tsx`, `features/tasks/TasksPage.tsx` | `/tasks` | pw (route), manual | partial | Run history view is not implemented; the rest is. |
| F2 | Kanban: boards, board switch, filters, summary, task detail, log, comments, links, dispatch, bulk, config, events stream | `panels.js` | `routes/_app.kanban.tsx`, `features/kanban/KanbanPage.tsx` | `/kanban` | pw (route), manual | partial | Boards, log, comments, links and dispatch are implemented; filters, summary, bulk actions, board config and the events stream are not. |
| F3 | Skills: list, search, categories, content, save, delete, toggle, usage stats | `panels.js`, `hub.js` | `routes/_app.skills.tsx`, `features/skills/SkillsPage.tsx` | `/skills` | pw (route), manual | pass | |
| F4 | Memory: MEMORY.md, USER.md, SOUL.md, project context, write | `panels.js` | `routes/_app.memory.tsx`, `features/memory/MemoryPage.tsx` | `/memory` | pw (route), manual | pass | |
| F5 | Workspaces: list, add, remove, rename, reorder, suggest, git badge, terminal remote backend flag | `panels.js`, `workspace.js` | `routes/_app.workspaces.tsx`, `features/workspaces/WorkspacesPage.tsx` | `/workspaces` | pw (route), manual | partial | No per-workspace git badge (the git endpoints are session-scoped) and no remote-backend flag. |
| F6 | Workspace files panel: tree, hidden files toggle, preview, create/rename/move/delete, save, reveal, open in VS Code, folder download, git status/diff/stage/commit/push/pull/branches/stash | `workspace.js` | `features/workspace/WorkspacePanel.tsx` | chat side panel | manual | partial | Tree, hidden toggle, preview, save, open in VS Code, download and git status/branch are implemented; create/rename/move/delete, reveal, and git diff/stage/commit/push/pull/stash are not. |
| F7 | Profiles hub | `panels.js` | see B3 | `/profiles` | pw (route) | pass | |
| F8 | Todos panel | `panels.js` | `routes/_app.todos.tsx`, `features/todos/TodosPage.tsx` | `/todos` | pw (route) | pass | |
| F9 | Insights (usage by day, provider cost history, wiki status/browse) | `panels.js` | `routes/_app.insights.tsx`, `features/insights/InsightsPage.tsx` | `/insights` | pw (route), manual | partial | Usage and cost history are rendered as accessible tables with inline SVG bars; wiki status/browse is not implemented. |
| F10 | Logs (file select, tail, refresh, hint) | `panels.js` | `routes/_app.logs.tsx`, `features/logs/LogsPage.tsx` | `/logs` | pw (route), manual | pass | |
| F11 | Settings: appearance, conversation, preferences, providers, plugins, extensions, system, help | `panels.js`, `index.html` `#panelSettings` | `routes/_app.settings.*.tsx`, `features/settings/*` | `/settings`, `/settings/$section` | pw (settings route), manual | partial | Appearance, conversation, preferences (send key, bot name, visibility), providers (list, quotas, delete, default), plugins (read-only), extensions, system (health, updates, password, passkeys, shutdown/restart) and help are implemented. Not implemented: language is set from Appearance only, auto-scroll preference, self-hosted provider add, auxiliary models, MCP servers/tools. Unknown section renders not-found. |
| F12 | Hermes Dashboard link (rail) | `boot.js` `openHermesDashboard` | `shell/Rail.tsx` from `/api/dashboard/status` | rail | manual | pass | |
| F13 | Dashboard plugins (`/plugins/<name>`, manifest tabs) | `api/plugins.py`, `panels.js` | Unified extension platform: plugin manifests surfaced as extension manifests with one sandboxed iframe panel (`/dashboard-plugins/<name>/index.html`) | `/ext/$extensionId` | py (`test_hweb100_extension_platform.py`), manual | pass | Legacy IIFE injection into the core page is gone. |
| F14 | Hub layout (collection as the main view, detail with Back) | `hub.js` | `features/hub/HubRoute.tsx` | native routes | pw (rail navigation) | partial | Hubs are single-page collections; detail views are inline rather than routed with Back. |
| F15 | Notes sources / search / item | `panels.js` | none | `/memory` | none | deferred | `/api/notes` is untouched server-side. |
| F16 | Rollback checkpoints list/diff/restore | `workspace.js` | none | workspace | none | deferred | |
| F17 | Escape hatch file browser (`/api/escape/*`) | `workspace.js` | none | workspace | none | deferred | |

## 7. Appearance, localisation, platform

| ID | Capability | Legacy source | New owner | Route | Verification | Status | Notes |
|---|---|---|---|---|---|---|---|
| G1 | Theme axis (light, dark, system) and legacy theme aliases (`slate`, `solarized`, `monokai`, `nord`, `oled`) | inline `<head>` script, `boot.js` | `theme/boot.ts` runs first in the entry module; `theme/tokens.css` | all | vitest (`boot.test.ts`), pw (theme persists across reload) | pass | No inline script: the entry module applies the class before React renders and CSS `color-scheme` avoids a flash under `prefers-color-scheme`. |
| G2 | Skin axis (all 21 skins) as CSS custom properties consumed by Tailwind utilities | `style.css` | `theme/skins.ts` (tokens and skins as data, rendered by the `hermesTheme` Vite plugin), `theme/tailwind.css` `@theme` mapping | all | vitest (`skins.test.ts`), manual | pass | Swatch picker reads the skin data. |
| G3 | Font size preference, full-width chat | inline scripts, `style.css` | `app/appearance.ts`, tokens | all | manual | pass | |
| G4 | RTL: persisted state, `dir` attribute, mirrored layout | inline script, `boot.js` | `app/appearance.ts`, logical CSS properties | all | manual | pass | |
| G5 | Languages: 15 locales with fallback to English, interpolation, plural helpers, runtime switch, server `language` setting and `hermes-lang` persistence | `i18n.js`, `api/i18n_assets.py` | Paraglide JS (`frontend/messages/*.json`, `project.inlang/`), `i18n/runtime.ts` | all | vitest (`locales.test.ts`), build gate (`i18n-gate.mjs`) | pass | Build fails on missing English keys, placeholder mismatch, or locale key drift. |
| G6 | Speech locale (`_speech`) per language | `i18n.js` | `i18n/locales.ts` | voice | vitest | pass | |
| G7 | PWA: manifest, install prompt, standalone classes, offline shell, update activation, scope and subpath | `manifest.json`, `sw.js`, `pwa-startup.js` | `scripts/build-sw.mjs` (Workbox injectManifest), `frontend/src/sw.ts`, `public/manifest.webmanifest` | all | py (`/sw.js`, manifest routes), manual | partial | Shell precache, runtime asset cache, `SKIP_WAITING` activation and `Service-Worker-Allowed` are implemented; there is no in-app install prompt. |
| G8 | Responsive: desktop rail + sidebar, narrow, mobile drawer, bottom tab bar and composer config sheet, safe areas, touch targets | `style.css`, `boot.js`, `hub.js` tab bar | `shell/*` utilities, `theme/components/shell.css`, `MobileNav.tsx`, `Tabbar.tsx` | all | manual | pass | |
| G9 | Accessibility: accessible names, live regions, focus management, keyboard menus/dialogs, reduced motion | `index.html`, `ui.js` | Base UI primitives (`ui/*`), `aria-live` regions in chat and notices | all | vitest (`ApprovalCard.test.tsx` roles), manual | pass | |
| G10 | Presence lease (HWEB-97) | `presence.js` | `api/client.ts` presence header | app shell | manual | partial | Presence is sent with requests; there is no dedicated lease renewal loop. |
| G11 | Client event log (`/api/client-events/log`) and CSP report | `ui.js` | `api/client.ts`, `api/endpoints.ts` | all | vitest (`client.test.ts` CSRF exemption) | pass | |
| G12 | Extensions: settings storage, configure registrations, turn lifecycle subscriptions, skins, TTS engines, session-open handlers, sidecar consent and proxy | `extension_settings.js`, `boot.js`, `api/extensions.py` | Unified sandboxed protocol: `extensions/host.ts`, `sdk.ts`, `registry.ts`, `contracts/extension.ts`, `api/extension_manifests.py` | `/ext/$id`, `/settings/extensions` | vitest (`host.test.ts` incl. hostile messages), py (`test_hweb100_extension_platform.py`) | pass | Intentional break documented in the migration guide; no compatibility shim. Custom Configure editors and session-open handlers are replaced by the panel and lifecycle events. |
| G13 | Shell unavailable page when the template fails to render | `routes.py` `_serve_shell_unavailable` | unchanged server path, wrapped around `spa_shell.serve_shell` | `/` | py (`test_home_route_html_error.py`) | pass | |

## 8. States

Every route and panel covers: empty, loading, success, error (typed
`ApiError`), unauthorized (401 redirect to `/login?next=` handled once in the
client module), disconnected (offline notice), and malformed payload (Zod
failure rendered as a typed error with a retry action, never as a blank pane)
through `ui/States.tsx`. Cancellation and stale states rely on TanStack Query
defaults (aborted queries are discarded; stale data refetches on focus). Root
and route error boundaries (`routes/__root.tsx` `errorComponent`,
`features/shell/ErrorBoundary.tsx`) offer retry and reload; a failed lazy
chunk triggers the route error boundary with a reload action.

## 8a. Legacy Python browser suites removed

These `tests/*.py` Playwright suites asserted the legacy DOM and CSS contracts
of earlier tickets and cannot run against the React markup. Their behaviours
are covered by the rows above and by the Node Playwright suite (`frontend/e2e`);
removed with this migration rather than ported:

| File | Ticket / issue | Behaviour | Now covered by |
|---|---|---|---|
| `test_hweb1_composer_hero.py` | HWEB-1 | Composer as the new-conversation hero | C-rows, `shell.spec.ts` home |
| `test_hweb2_chat_column.py` | HWEB-2 | One shared reading column | manual |
| `test_hweb3_user_message_collapse.py` | HWEB-3 | User bubble width and folding | X5 (bubbles redesigned) |
| `test_hweb6_chat_code_and_tables.py` | HWEB-6 | Quiet code blocks and tables | E-rows, manual |
| `test_hweb7_composer_overflow.py` | HWEB-7 | Composer overflow panel | C-rows (fit stages), manual |
| `test_hweb9_scroll_to_end_pill.py` | HWEB-9 | Scroll-to-end pill | D-rows (jump buttons) |
| `test_hweb10_mobile_composer_collapse.py` | HWEB-10 | Phone composer collapse | C-rows (`cf-collapsed`), manual |
| `test_hweb12_turn_minimap.py` | HWEB-12 | Turn minimap | not carried (no minimap in the React shell; see D16) |
| `test_hweb37_shell_cache_and_locale_split.py` | HWEB-37 | Legacy JS shell caching and locale split | Vite hashed assets, Paraglide (section 7) |
| `test_inline_handler_arg_escaping.py` | — | `jsArg()` in legacy inline handlers | no inline handlers exist |
| `test_issue5638_user_row_intrinsic_height_collapse.py` | #5638 | User row intrinsic height | X5 |
| `test_issue5932_kanban_board_default_workdir_layout.py` | #5932 | Kanban board modal layout | `shell.spec.ts` hubs, manual |
| `test_issue6906_kanban_modal_height_cap.py` | #6906 | Kanban modal reachable in short windows | manual |

Kept and adapted: `test_hweb72_oidc_synthetic_provider.py` (href compared as a
resolved URL), `test_layout_helpers.py` (waits for `main.main`, canonical
paths), `test_issue1361_cancel_data_loss.py`, `test_docker_docs_and_readonly.py`,
`test_issue6066_workspace_sort_*`. The legacy `browser-smoke` and
`conversation-lifecycle` workflows (which drove the legacy UI) are removed; the
Node suite runs once in the `frontend` job. It checks browser behavior and
console errors without screenshot comparisons. UI changes still require PR
before/after evidence and manual responsive review.

## 9. Intentional differences

| Ref | Difference | Reason | Approval |
|---|---|---|---|
| X1 | Injected extension scripts/styles, `window.hermesExt`, `registerHermesSkin`, `registerHermesTtsEngine`, and dashboard plugin IIFE injection are removed | Required by HWEB-100 (unified sandboxed protocol) | HWEB-100 ticket text |
| X2 | Prism, `smd.min.js`, CDN xterm are removed in favour of bundled Streamdown, Shiki, `@xterm/xterm` | Required by HWEB-100 | HWEB-100 ticket text |
| X3 | Cached HTML boot snapshots (`hermes-boot:*` `innerHTML`) are removed; the boot restores validated JSON state and renders through React | Required by HWEB-100 | HWEB-100 ticket text |
| X4 | Login and share pages are routes of the same SPA shell instead of separate server-rendered HTML | Explicit routes required by HWEB-100 | HWEB-100 ticket text |
| X5 | Chat hierarchy (HWEB-105): user turns are right-aligned bubbles; the assistant turn has no name row or brandmark; live tokens/s is a muted line under the reply | Ticket owner's design decision during LAN validation | Ticket owner, LAN preview, 2026-09-15 |
| X6 | Shell geometry: rail, sidebar and workspace panel sit on the frame tone; the main pane is an edge-to-edge card with square corners that meets its neighbours through concave seam fillets (legacy: bordered islands with gaps on every side) | Ticket owner asked for the shadcn "inset" sidebar look, then for no top/bottom gap with fluid joins | Ticket owner, LAN preview, 2026-09-16 |
| X7 | App titlebar hidden at 641px and up in every display mode except window-controls-overlay (legacy showed it in installed and fullscreen modes) | Ticket owner: "pointless" on desktop | Ticket owner, 2026-09-16 |
| X8 | Workspace panel: stays mounted and animates closed; a persistent edge tab on the panel's left edge (frame tone, concave joins) flips between open and close arrows and slides with the panel; resize highlight follows the tab and seam curves (legacy: floating pill hidden while open, panel unmounted on close) | Ticket owner requests during LAN validation | Ticket owner, 2026-09-16 |
| X9 | Clicking the active rail tab toggles the sidebar on desktop (legacy: Cmd/Ctrl+B only) | Ticket owner request | Ticket owner, 2026-09-16 |
| X10 | Phone titlebar title is centred on the bar; the balancing spacer is dropped (legacy centred the title 32px left of the screen centre because the right group held a spacer and two buttons) | Inherited bug, fixed on request | Ticket owner, 2026-09-16 |
| X11 | Boot: a blocking pre-paint script sets theme, skin and shell state before first paint; a CSS frame skeleton paints while the module mounts; the sidebar list, last transcript, settings, profiles, workspaces and projects hydrate from a validated JSON snapshot (`hermes-boot:queries`, 2 MB cap, transcript dropped first). No HTML is restored (see X3). The composer opens at the bottom for any session not remembered as empty (`hermes-webui-session-empty`) | Legacy boot behaviour re-established without `innerHTML` snapshots | Ticket owner, 2026-09-16 |
