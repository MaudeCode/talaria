# Security model

Read this before changing auth, path handling, uploads, streaming, environment
handling, or anything the Relay accepts. It describes how Talaria Web and the
Relay decide who may do what, and where each rule lives in code.

Each rule names the file and the symbol that enforces it. Paths starting with
`web/` or `relay/` are relative to the repository root. Every other path is
relative to `web/packages/server/src/`. When a rule here and the code disagree,
the code wins: fix this document in the same change.

## 1. Who is trusted for what

The server decides **owner authority** once per request in
`auth/gate.ts` `sessionCanManageServer`, and handlers read it through
`auth/gate.ts` `requestCanManageServer`:

- With sign-in off, every request is the owner.
- With sign-in on and no session, no request is the owner.
- An OIDC login defers to `auth/oidc.ts` `OidcService.sessionCanManageServer`.
  With an owner policy (`webui_oidc.owner_claim` and `owner_values`), only a
  login carrying the owner claim is the owner, even when it is bound to a
  profile. Without a policy, an unbound OIDC login is the owner.
- A password, passkey or trusted-header login is the owner when it has no
  `bound_profile`. A session record with no login type is not the owner while
  an OIDC owner policy is configured.

A **profile-bound login** is a trusted-header login mapped to a profile through
`TALARIA_WEB_GROUP_PROFILE_MAP` (`auth/gate.ts` `trustedAuthBoundProfile`), or
an OIDC login mapped to one. The gate forces its request profile and refuses
any other with `403 Profile access forbidden` (`auth/gate.ts`
`applyBoundSessionProfile`, `trustedSessionAllowsActiveProfile`).

A **person** exists only with `TALARIA_WEB_PERSON_ISOLATION` on and sign-in on;
only a validated OIDC issuer and subject identify one (`auth/person.ts`
`personIsolationEnabled`, `personIdentity`). Every person, a server owner
included, sees only the sessions they own; owner authority adds only the
sessions no person owns (legacy, imported, scheduled, Agent state)
(`auth/person.ts` `personMaySee`). Owner authority over the host and profiles
is separate from that session boundary.

| Actor | May reach | Enforced by |
|---|---|---|
| Unauthenticated visitor | The public surface in section 3 only: sign-in routes, trimmed health and bootstrap, static assets, share reads, grant-bearing frames | `auth/gate.ts` `checkAuth`, `isPublicPath` |
| Share-link holder | One sanitized session snapshot, until the share is revoked or its session is deleted | `sessions/shares.ts` `ShareStore` |
| Sandboxed frame (HTML preview, `show` block, extension panel, dashboard plugin) | Its own grant's files. It cannot call `/api/` (an `Origin: null` request gets 403) and its CSP denies network calls | `app.ts` `createApp` dispatch; `workspace/preview.ts` `PREVIEW_CSP`; `sessions/show.ts` `SHOW_FRAME_CSP`; `tools/extensions.ts` `EXTENSION_PANEL_SANDBOX_CSP` |
| Non-owner login (profile-bound, or a non-owner person) | Its own profile and the sessions it may see. No owner-only route (section 4), no all-profile listing, a fenced workspace (section 5), scoped media and Kanban | `auth/gate.ts` `isOperatorOnly`; `api/sessions-router.ts` `profileReach`; `workspace/workspaces.ts` `WorkspaceRegistry.resolveTrusted`; `workspace/media.ts` `mediaAccessFor`; `api/automation-router.ts` `kanbanAssignees` |
| Server owner | Host administration, code execution and every profile. Under person isolation, only their own sessions plus unowned ones. A workspace inside Web state is still refused | `auth/gate.ts` `sessionCanManageServer`; `auth/person.ts` `personMaySee`; `workspace/workspaces.ts` `WorkspaceRegistry.isInWebState` |
| Relay publisher (a Web server) | Signed writes of its own profiles' state to the Relay | `relay/convex/http.ts` `authenticatePublisher` |
| Relay device (the Talaria app) | Its account's devices and the publisher state its account is granted. Nothing on any Web server | `relay/convex/http.ts` `authenticateUser`; `relay/convex/lib/publisherVisibility.ts` `isPublisherStateVisible` |

## 2. Request pipeline

Every HTTP request and WebSocket upgrade enters through one `dispatch` closure
in `app.ts` `createApp`; `upgrade` calls the same handler. The steps run in this
order, and a refusal ends the request:

1. **Host allowlist.** An unexpected `Host` gets 421 before anything else runs
   (`app.ts` `rejectUnexpectedHost`; `http/origin.ts` `unexpectedRequestHost`).
2. **CORS preflight** answers `OPTIONS`.
3. **Profile cookie** is read into the request profile (`auth/gate.ts`
   `getProfileCookie`).
4. **Sandboxed callers.** `/api/` with `Origin: null` gets 403.
5. **Auth gate** (`auth/gate.ts` `checkAuth`): public paths pass; otherwise a
   session is required, owner-only routes need owner authority, and a bound
   login's profile is enforced. `POST /api/csp-report` skips this step.
6. **Startup wait.** Non-public `/api/` requests wait for startup recovery
   (`startup.ts` `STARTUP_IMMEDIATE_PATHS`).
7. **CSRF.** Unsafe `/api/` methods outside `auth/gate.ts` `isCsrfExemptPath`
   must pass `checkCsrf`: same-origin provenance
   (`http/origin.ts` `checkSameOriginBrowserRequest`) and, for a browser
   request with sign-in on, the `X-Hermes-CSRF-Token` header
   (`auth/store.ts` `CSRF_HEADER_NAME`, `AuthStore.verifyCsrfToken`).
8. **Session visibility.** A `session_id` the caller may not see answers 404
   (`api/session-visibility.ts` `guardQuerySessionId`; oRPC procedures use
   `requestSessionIdGuard`).
9. **Profile containment.** A profile whose home resolves outside the profiles
   root is refused with 400 (`profiles/profiles.ts` `ProfileService.escapes`).
10. **Write lease.** Every unsafe `/api/` request holds its profile's write
    lease, so a profile being deleted refuses it with 409
    (`profiles/profiles.ts` `ProfileService.beginWrite`).
11. **Routing:** SPA and static files, extension and dashboard-plugin assets,
    preview and `show` frames, raw and SSE routes, the extension sidecar proxy,
    the body-size cap (`app.ts` `bodyCap`), then the oRPC router.

A new route inherits every step by being registered in `RAW_GET_ROUTES`,
`RAW_POST_ROUTES`, `SSE_GET_ROUTES` or the oRPC router (`api/raw-routes.ts`,
`api/sse-routes.ts`, `api/router.ts`). There is no second entry point. A route
is public only if `isPublicPath` says so, and owner-only only if
`isOperatorOnly` says so or its handler checks `requestCanManageServer`.

## 3. Public surface

`auth/gate.ts` `PUBLIC_PATHS` and `isPublicPath` list every path that answers
without a session:

| Path | Before sign-in it returns | Code |
|---|---|---|
| `/health` | `status` and `agent.status` only | `api/router.ts` `healthPayload` |
| `/api/bootstrap` | No version, settings, profile, onboarding, features or shell; an empty `csrf_token` | `api/router.ts` `bootstrapPayload` |
| `/api/auth/status` | Sign-in methods offered; no `passkeys_count` | `auth/gate.ts` `authStatusPayload` |
| `/api/auth/login`, passkey options and login, OIDC start, callback and native start/exchange/cancel | Sign-in; login attempts and flow starts are rate-limited per client (section 7) | `api/router.ts`, `api/auth-raw.ts` |
| `/share`, `/share/*` | The app shell with `X-Robots-Tag: noindex, nofollow` | `app.ts` `handleSpa` |
| `/api/share/{token}` | The share's sanitized snapshot (`create` and `revoke` need a session) | `sessions/shares.ts` `ShareStore.load` |
| `/workspace-preview/*`, `/show-frame/*`, `/agent-dashboard-plugins/*` | Files a valid grant in the path authorizes | `api/raw-routes.ts` `handleWorkspacePreview`, `handleShowFrame`; `api/automation-raw.ts` `handleDashboardPlugin` |
| `/login`, `/sw.js`, manifests, `/favicon.ico`, `/static/*`, `/assets/*`, `/session/static/*` | Static app files | `app.ts` `handleSpa`, `serveFavicon` |
| `POST /api/csp-report` | 204; reports are capped at 64 KiB, 100 per peer per minute, and each logged line at 4096 characters | `api/tools-raw.ts` `handleCspReport`, `CSP_MAX_BODY` |

`/extensions/*`, `/dashboard-plugins/*` and `/plugins/*` are not public.

**Signed grants.** A sandboxed frame sends no cookie, so a capability in its URL
authorizes it. `auth/crypto.ts` `signAssetGrant` signs
`base64url(value).expiry` with HMAC under a namespace, so a grant from one
namespace never validates in another (`assetGrantValue`). Expiry is the end of
the next hour, 1 to 2 hours out.

- **HTML preview** (namespace `preview`, the auth signing key
  `auth/store.ts` `AuthStore.signingKey`) signs the folder that holds the
  previewed file. It is minted only after the caller could read the file
  (`workspace/preview.ts` `previewUrl`). It serves that folder and below; `../`,
  dot-prefixed segments, symlinks out and Web state answer 404
  (`workspace/preview.ts` `previewTarget`). A leaked grant reads that folder,
  minus dotfiles, until it expires.
- **`show` frame** (namespace `show`) signs one block id, minted on each read
  of the block after the visibility checks (`sessions/show.ts`
  `ShowService.get`, `showFrame`). A leaked grant shows that one block's HTML
  until it expires or the block is deleted.
- **Agent dashboard plugin** grants use a per-process random key, so a restart
  revokes them all, and are bound to the login cookie, profile home and login
  generation; a profile switch revokes them (`tools/dashboard-plugins.ts`
  `DashboardPlugins.panelGrant`, `invalidateOwner`). Each request rechecks that
  the plugin is still enabled. A leaked grant reads only that plugin's assets.
- **Share tokens** are 18 random bytes with no expiry. Revoking one sets
  `revoked_at`; a revoked token is never reissued, and a share of a deleted
  session returns nothing (`sessions/shares.ts` `ShareStore`).

**Frames and active content.**

- An extension static file whose type is not in `tools/extensions.ts`
  `INERT_MIME` (SVG, HTML, XML, text, wasm) carries
  `EXTENSION_PANEL_SANDBOX_CSP` (`tools/extensions.ts`
  `ExtensionService.staticFile`).
- Every dashboard-plugin response except the shared `plugin.css` is sandboxed,
  and a plugin is off until enabled under `dashboard_plugins` in settings
  (`tools/dashboard-plugins.ts` `DashboardPlugins.enabled`).
- Extension sidecar proxy responses drop the upstream security headers and are
  served as sandboxed `Content-Disposition: attachment` (`api/automation-raw.ts`
  `handleExtensionSidecarProxy`, `PROXY_DROPPED_RESPONSE_HEADERS`).

**Rendered content.**

- The server rewrites every remote Markdown image, image reference and HTML
  `<img>` in display text and share snapshots into a link
  (`workspace/media-refs.ts` `projectMediaRefs`, `linkRemoteImages`). The app
  CSP allows images from this origin, `data:` and `blob:` only (`http/csp.ts`).
- `/api/remote-image` relays only an image URL the server itself recorded from
  a tool result: https only, no redirects, public addresses only, raster types
  up to 16 MiB (`http/remote-image.ts` `vouchRemoteImage`, `publicImageFetch`).
- Exported transcripts strip control characters before reading a link's scheme
  and keep only `http(s):`, `mailto:`, `data:image/`, `#` and `/` links
  (`text/markdown.ts` `safeUrl`). Chat Markdown prefixes every element id with
  `user-content-` (`web/packages/frontend/src/features/chat/render/MarkdownRenderer.tsx`
  `CONTENT_ID_PREFIX`).

## 4. Owner-only surface

`auth/gate.ts` `checkAuth` answers `403 Owner session required` before any
handler runs when `isOperatorOnly(method, path)` is true:

- Every method on `OPERATOR_ONLY_PATHS`, `/api/groups`, and every path under
  `OPERATOR_ONLY_PREFIXES` (`/api/terminal/`, `/api/onboarding/oauth/`,
  `/api/groups/`).
- Every method but GET and HEAD on `OPERATOR_ONLY_WRITES`
  (`/api/mcp/servers`, `/api/mcp/servers/{name}`, `/api/providers`).

The path is the normalized request path (`http/context.ts`
`normalizeRequestPath`). `auth/gate.test.ts`
`owner-only routes (TAL-2201)` owns the matrix: its `ROUTES` table must list
every owner-only route and a sample of open ones.

Some routes stay open but refuse owner-only fields inside the handler:

- Model selection refuses `advanced.base_url`, `api_key` and `api_key_clear`
  from a non-owner (`api/settings-router.ts` `requireOwnerForConnection`).
- Cron create and update refuse `script`, `no_agent`, a new monitor script and
  Group Chat (`room:`) delivery from a non-owner (`tools/crons.ts`
  `CronService.requireOwnerFields`, `requireRoomDeliveryAuthority`).
- Cron create and update, for every caller, take only the fields the route
  contract lists (`CronCreateInputSchema`, `CronUpdateInputSchema`) and refuse
  the scheduler's own bookkeeping such as `fire_claim` and `manual_run_prompt`.
  The sidecar repeats that allowlist and runs the installed Agent's prompt
  scan, provider/`base_url` origin check and Bot Chat profile check under the
  owning profile, on the effective stored pair (`methods/cron.py` `_admit_job`,
  TAL-2297).
- Answering an agent's secret request (`api/chat-router.ts` `clarify.respond`),
  deciding a proposal (`api/proposals-router.ts`), server logs
  (`api/tools-router.ts` `logs`) and passkey management (`api/router.ts`) are
  owner-only.
- Listing or searching across all profiles is owner-only and off in isolated
  profile mode; a non-owner's `all_profiles` is ignored. Claude Code
  transcripts are owner-only (`api/sessions-router.ts` `profileReach`,
  `requestProfileReach`; `sessions/service.ts` `personMaySeeForeign`).
- The server ships capability fields so clients hide what a non-owner cannot
  do: `can_manage_server` in auth status, read-only MCP and plugin rows
  (`tools/mcp.ts` `readOnlyRow`), and no `/terminal` command
  (`tools/commands.ts` `OWNER_COMMANDS`).

**When a new route belongs on the owner-only list.** Add it to
`OPERATOR_ONLY_PATHS`, `OPERATOR_ONLY_PREFIXES` or `OPERATOR_ONLY_WRITES`, and
to the matrix test, when it:

- runs code or a shell on the host outside the agent's approval flow;
- writes `config.yaml`, `.env`, provider credentials, or a model endpoint;
- makes the server fetch a URL the caller chooses;
- acts on more than one profile, or on every session on the server;
- installs, updates, or enables code (plugins, extensions, the server itself).

If only some fields of a route qualify, check `requestCanManageServer` in the
handler and refuse those fields with the same 403.

## 5. Filesystem

**Workspace trust per authority.** `workspace/workspaces.ts`
`WorkspaceRegistry.assertWorkspaceAuthority` decides which roots a caller may
use as a session workspace:

- Nobody may use a workspace inside Web state (`WorkspaceRegistry.isInWebState`).
- The owner may use anything under `$HOME`, a saved workspace, or anything
  under the boot default; system directories are refused
  (`WorkspaceRegistry.resolveTrusted`).
- A non-owner workspace must sit at or below the boot default, its profile's
  configured default, or one of its profile's saved workspaces. It must not
  contain `$HOME`, and it must not overlap Hermes home, Web state or `~/.ssh` in
  either direction (`WorkspaceRegistry.protectedFromNonOwner`). A saved root
  that breaks those rules authorizes nothing.
- File operations recheck the session's stored root against the caller's
  authority on every request (`api/sessions-router.ts` `fileOpsSession`).

**Path resolution and anchored opens.**

- `workspace/fs.ts` `safeResolve` and `safeResolveWs` resolve the existing
  prefix's symlinks and require the result to stay under the root. They are
  pathname checks only.
- Reads and writes then open the target through an anchored walk
  (`workspace/fs.ts` `openAnchoredFd`, `openAnchoredCreateFd`,
  `replaceAnchoredFile`, `renameAnchored`, `rmtreeAnchored`), which opens each
  component with `O_NOFOLLOW|O_DIRECTORY` so a symlink swapped in after the
  check is not followed. `withPinnedRoot` also requires the root to still be
  the same inode. A platform without no-follow directory opens is refused
  (`directoryOpenPolicy`).
- Listings drop symlinks that resolve to system paths (`workspace/fs.ts`
  `listAnchored`).

**Escape grants.** A workspace symlink that points outside the workspace opens
only through a read-only grant (`workspace/escape.ts` `EscapeGrants`):

- Minting needs a caller that passes `fileOpsSession` and a browser `Origin`
  (`api/sessions-router.ts` `escapeAuthorize`).
- A grant lasts 300 seconds (`ESCAPE_GRANT_TTL_SECONDS`) and is bound to the
  session, profile, workspace root and that root's device and inode.
- `/` and system directories are never granted (`workspace/workspaces.ts`
  `isBlockedSystemPath`), and Web state is excluded.
- For a non-owner, a link whose target contains `$HOME` or overlaps Hermes
  home, Web state or `~/.ssh` answers 404 with no grant: the same
  `WorkspaceRegistry.protectedFromNonOwner` fence as its workspaces
  (`api/sessions-router.ts` `escapeFence`). The owner's grants carry no fence.
- Every use rechecks the link target, root inode and expiry
  (`EscapeGrants.check`); a retargeted link deletes the grant.
  `EscapeGrants.resolve` re-resolves each request path and refuses system paths
  and, for a non-owner, fenced paths.

**Media.** `/api/media` (`api/raw-routes.ts` `handleMedia`) serves from roots
that `workspace/media.ts` `mediaAccessFor` derives from authority:

- The owner reaches Hermes home.
- A non-owner reaches its own profile home, without other profiles' homes, Web
  state or the attachment root, plus the attachment folder of the session it
  names (`mediaRootDecider`).
- Every caller also reaches the temp roots, the active workspace and
  `MEDIA_ALLOWED_ROOTS`.
- A file outside those roots is served when the session's assistant or a tool
  wrote it as a `MEDIA:` reference (`sessionMediaGrant`).
- Deny lists and hard-link checks always apply, and bytes are opened anchored
  at the authorizing root (`mediaPolicyDecider`, `serveFileBytes`).
- A share embeds `MEDIA:` images only from its own session's workspace and
  attachment folder: PNG, JPEG, GIF or WebP up to 512 KiB, checked by magic
  bytes (`sessions/shares.ts` `shareAllowedRoots`, `embedShareMedia`).

**Uploads and archives.**

- Upload bodies are capped by `TALARIA_WEB_MAX_UPLOAD_MB` (default 20) and
  names reduced to a sanitized basename (`workspace/upload.ts`
  `sanitizeUploadName`).
- Archive extraction (`workspace/extract.ts` `extractArchive`) allows at most
  `MAX_ARCHIVE_MEMBERS` members and `TALARIA_WEB_MAX_EXTRACTED_MB` of output,
  bounds decompression as it runs, extracts into a fresh folder with anchored
  exclusive creates, and rejects any member path that leaves it. Tar links and
  devices are skipped.
- Office previews and `.docx` saves (`workspace/office.ts`) preflight every
  archive before parsing: at most 256 members, 8,000,000 bytes uncompressed,
  per-part caps, a compression ratio of at most 200, member names that stay
  inside the archive, no ZIP64, no two entries sharing one member, compressed
  input no larger than the archive, and each member inflated no further than its
  declared size. XML parts with a `<!DOCTYPE` are refused and only the
  predefined and numeric entities expand. Each listed sheet or slide part is
  parsed once, and all the Office files of one upload share a single
  8,000,000-byte budget. A refusal answers 400. An uploaded Office file's
  `<name>.md` copy is an exclusive create beside it.
- Session titling reads at most the first 4,000 bytes of an opening user row's
  first `text/*` attachment, only from that session's own attachment folder in
  the blob store, and sends them to the title model alone
  (`sessions/titles.ts` `titleExchange`).

## 6. Agent-side execution

| Action | Who may do it | Code |
|---|---|---|
| Answer a tool approval | Anyone who may see the session | `api/chat-router.ts` `approvalRespond` |
| Answer a secret request | The owner | `api/chat-router.ts` `clarify.respond` |
| Add a `/goal` shell gate | The owner, through `/api/goal` only; the model's `goal_set` tool never can | `api/chat-router.ts` `goal`; `web/sidecar/talaria_sidecar/methods/goals.py` `authorize_gate` |
| Add or edit an MCP server (its `command` runs on the host) | The owner; others submit an `mcp_server` proposal the owner approves | `auth/gate.ts` `OPERATOR_ONLY_WRITES`; `api/proposals-router.ts` |
| Read or write Kanban tasks | The owner on any assignee; a bound login on its bound profile; other non-owners on their accessible profiles | `api/automation-router.ts` `kanbanAssignees`, `kanbanCall` |
| Dispatch Kanban tasks manually | The owner | `auth/gate.ts` `OPERATOR_ONLY_PATHS` |
| Create, edit, run or pause a cron job | Any login; scripts, `no_agent`, monitor scripts and room delivery need the owner | `tools/crons.ts` `CronService.requireOwnerFields`, `requireRoomDeliveryAuthority` |
| Use the host terminal | The owner | `auth/gate.ts` `OPERATOR_ONLY_PREFIXES` |
| Use Group Chat rooms (they run several profiles) | The owner | `auth/gate.ts` `isOperatorOnly` |

When an MCP server's URL origin or stdio command changes, its stored headers,
auth, OAuth, certificates and environment are dropped, and a saved-back
redacted value keeps the stored secret (`tools/mcp.ts` `McpService.update`,
`endpointOf`). A delegation route keeps its stored `api_key` only while its
`provider` and `base_url` stay the same
(`web/sidecar/talaria_sidecar/methods/delegation.py` `clean_routes`). The main
model, each auxiliary slot and the top-level delegation block drop their
`api_key`, `key_env`, `api_key_env` and `api_mode` when a write or reset gives
them another provider or endpoint; a key entered with that write stays, and a
bare `custom` endpoint keeps its key across paths on one origin
(`config/agent-config.ts` `bindCredentialsToRoute`). A key a save enters or
changes in one of those blocks lands in the profile's `.env` under the Agent's
own name (`config_secret_refs`), and `config.yaml` stores only its `${NAME}`
reference; inline keys a save leaves alone stay. A name another endpoint
reads with a different key, or an administrator-managed name, refuses the
whole save before either file changes, and the sidecar never publishes the
key into its process environment
(`web/sidecar/talaria_sidecar/methods/config.py` `_route_entered_credentials`).
Agents before v0.23.2 keep the key inline.

## 7. Deployment

**Bind and sign-in.** The server binds `127.0.0.1` by default
(`config.ts` `loadConfig`). Before listening, it refuses a bind beyond
loopback when no sign-in method (password, passkey, OIDC, trusted header) is
configured, and exits with code 78 unless `TALARIA_WEB_ALLOW_UNAUTHENTICATED`
is set (`startup.ts` `refuseUnauthenticatedBind`).

**Hosts and origins.** `http/origin.ts` `allowedHostNames` accepts `localhost`,
any IP literal, the bind host, the hosts of `TALARIA_WEB_ALLOWED_ORIGINS` and
every name in `TALARIA_WEB_ALLOWED_HOSTS`. `X-Forwarded-Host` is checked in
addition to `Host`, never instead of it, and only with
`TALARIA_WEB_TRUST_FORWARDED_HOST` from a listed proxy
(`unexpectedRequestHost`).

**Proxies.** A forwarded identity or client address counts only from a peer
in `TALARIA_WEB_TRUSTED_PROXY_CIDRS`; loopback is not implicit
(`http/origin.ts` `rawPeerIsTrustedProxy`).

- Trusted-header sign-in (`TALARIA_WEB_TRUSTED_AUTH_HEADER`) from any other
  peer drops the trusted session (`auth/gate.ts` `ensureTrustedAuthSession`).
- Rate limits key on the socket peer unless `TALARIA_WEB_TRUST_FORWARDED_FOR`
  is on and the peer is a listed proxy (`http/origin.ts` `throttleClientIp`).

**Sign-in.**

- Password and passkey login: 5 attempts per client per minute
  (`auth/store.ts` `checkLoginRate`).
- Passkey options, browser OIDC start and native OIDC start: 10 per client per
  minute each (`runtime.ts` `passkeyOptionsLimiter`, `browserOidcLimiter`,
  `nativeOidcLimiter`).
- Passkeys require user verification, and a full challenge store evicts the
  requesting client's own oldest challenge first (`auth/passkeys.ts`
  `authenticationOptions`, `storeChallenge`).
- Browser OIDC binds its state to an HttpOnly cookie set on the browser that
  started it (`api/auth-raw.ts` `oidcStateCookie`, `handleOidcCallback`).
  Native OIDC follows [native-oidc-auth.md](native-oidc-auth.md).
- Setting, changing or clearing the password signs out every other session
  (`auth/store.ts` `AuthStore.revokeSessionsExcept`).
- Any registered passkey keeps sign-in on; the passkey flag only decides
  whether passkey sign-in is offered (`auth/store.ts` `AuthStore.isAuthEnabled`).
- The session cookie is HttpOnly and SameSite=Lax, and Secure on TLS or with
  `TALARIA_WEB_SECURE` (`http/context.ts` `authCookieHeader`).

**Direct TLS.** Setting only one of `TALARIA_WEB_TLS_CERT` and
`TALARIA_WEB_TLS_KEY`, or a pair that cannot load, stops startup; there is no
plain-HTTP fallback (`config.ts` `loadConfig`; `server.ts` `startServer`).

**Docker.**

- Every compose file publishes `127.0.0.1:8787` and sets
  `TALARIA_WEB_ALLOW_UNAUTHENTICATED=1` only for that loopback publish
  (`web/docker-compose.yml`). Publishing beyond loopback needs a password and
  that line removed.
- The container runs the server as the unprivileged `hermeswebui` user and
  ships no sudo (`web/Dockerfile`, `web/docker_init.bash`).
- First start installs the Agent's Python dependencies with TLS verification
  on, and stops if `uv` is missing (`web/docker_init.bash`).
- The optional session bridge (`web/docker-compose.session-bridge.yml`,
  `web/sidecar/talaria_sidecar/gateway_bridge.py`) gives the Web container
  operator access to the Gateway chats of the profiles the helper lists, over a
  Unix socket and no port. Both ends require Linux `SO_PEERCRED` with their own
  UID and a canonical, non-symlink socket path, `0600` in a `0700` directory
  owned by that UID (`check_peer`, `private_path`). Web sends a profile name
  only; the helper maps it to its own home and refuses any it does not list
  (`profile_home`). The helper mints the native ticket and never sends it, a
  path or a diagnostic to Web (`_attest`, `handle`). Web refuses an owner whose
  profile id does not match the name it derived from its own layout, or whose
  instance does not hold the `state.db` it reads (`_mapped_profile`,
  `_bound_store`), and never falls back to local discovery when the bridge is
  configured (`methods/gateway_sessions.py` `_discover`). Rooms, which need a
  subject-scoped ticket, are refused over it.

## 8. Updates and supply chain

- A Stable self-update reads the `release-set.json` of the matching
  `release-set-<sha>` GitHub release, downloads the npm tarball, checks its
  SHA-512 against the manifest's `npmIntegrity`, and installs it from disk with
  `--ignore-scripts`; only `node-pty` is rebuilt. Name, version, provenance,
  bins and dependencies are checked and a self-check runs; any failure keeps
  the installed package (`tools/updates.ts` `publishedWebRelease`,
  `applyNpmWebUpdate`).
- An Experimental update checks the GHCR blob against its manifest layer's
  digest and size (`tools/updates.ts` `ghcrExperimental`).
- Releases ship an `npm-shrinkwrap.json` with an integrity hash for every
  transitive dependency (`releases/build.py` `web_shrinkwrap`).
- Images pin Node and uv by digest (`web/Dockerfile` `NODE_IMAGE`,
  `relay/bridge/Dockerfile`), and `scripts/check-hosted-runners.py` refuses
  unpinned images and piped install scripts in them.
- Applying an update is owner-only (`auth/gate.ts` `OPERATOR_ONLY_PATHS`).
- Updates carry no signature or attestation check; integrity rests on the
  GitHub release and GHCR digests.

## 9. Relay

**Credentials.**

- The app signs in with an Apple identity token, checked for signature,
  issuer, audience, expiry, nonce and replay (`relay/convex/lib/appleIdentity.ts`
  `verifyAppleIdentityToken`). It receives an opaque 30-day Relay session
  token (`relay/convex/http.ts` `authenticateUser`).
- A Web server is a publisher identified by its canonical origin. It holds an
  Ed25519 key, stored only on the Web server, and signs
  `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA-256(body)` on every request
  (`sessions/relay.ts` `signedHeaders`). The Relay accepts a timestamp within 5
  minutes, refuses a reused nonce, a disabled publisher or a revoked key, and
  verifies the signature (`relay/convex/http.ts` `authenticatePublisher`;
  `relay/convex/publishers.ts` `authorizePublisherMutation`).
- The feedback operator token is stored only as a SHA-256
  (`relay/convex/lib/feedback.ts` `operatorAccess`). The bridge's Kanvil and
  sanitizer credentials never reach the Relay (`relay/bridge/bridge.ts`
  `readConfig`).

**Invitations.** A signed-in user creates a single-use invitation for one
origin, valid 10 minutes (`relay/convex/pairing.ts`
`createPublisherInvitation`). Redeeming it from another origin fails with
`invalid_invitation` and does not consume it. Re-registering a publisher that
has a current key needs a signature from that key's owner
(`redeemPublisherInvitation`, `redeemProfileInvitation`). The owner revokes a
publisher's keys with `DELETE /v1/publisher-keys`, which invalidates older
keys, invitations and published state (`relay/convex/subscriptions.ts`
`revokePublisherKeys`).

**Abuse limits.**

- Apple sign-in costs 30 attempts per client address per minute before any
  verification; the 300-per-minute Relay-wide budget is charged only for
  verified tokens (`relay/convex/auth.ts` `consumeAppleAuthAttemptBudget`,
  `acceptAppleSignIn`).
- Push tokens must be 64 to 200 hex characters
  (`relay/convex/lib/validators.ts` `apnsToken`).
- Feedback is budgeted per owner, origin and install, unsigned reports cannot
  attach files, and ticket titles are plain text of at most 120 characters
  (`relay/convex/feedback.ts` `submit`; `relay/bridge/bridge.ts` `ticketTitle`).
- Only a separate sanitizer process decodes feedback media; it holds no Relay
  or Kanvil credential (`relay/bridge/sanitizer.ts` `main`).

**What the Relay stores.** It has no application-level encryption.

- Hashed: session, invitation and upload tokens, Apple identity tokens and
  install ids (SHA-256); the Apple subject (HMAC with `APPLE_SUBJECT_HASH_KEY`,
  `relay/convex/lib/appleIdentity.ts` `subjectHash`).
- Plaintext (`relay/convex/schema.ts`): publisher origins and labels, public
  keys, device labels and push tokens; session titles, deep links, a tool's
  64-character target label, decision and notice titles (`sessionStates`);
  completion rows; APNs payloads (`deliveryJobs`); feedback reports and their
  attachments.
- Retention (`relay/convex/cleanup.ts` `prunePass`, every 5 minutes): session
  state 3 minutes active, 15 minutes terminal, 24 hours unconfirmed; sessions
  and invitations at expiry; acknowledged completions 7 days and
  unacknowledged 30; delivery jobs and ended Live Activities 7 days; revoked
  keys and devices 30 days; delivered feedback 7 days and pending 30; stored
  attachments 7 days or at acknowledgement. Accounts, publishers, grants and
  active devices have no expiry.

**No route into a Web server.** The Relay calls out only to Apple's key set and
APNs (`relay/convex/http.ts` `appleKeys`;
`relay/convex/lib/apnsTransport.node.ts`). It stores and compares publisher
origins but never requests them. Every exchange starts at the Web server
(`sessions/relay.ts` `RelayPublisher.put`, `RelayService.relayPost`).

## 10. Known accepted risks

- A previewed HTML page can navigate itself to another URL carrying its own
  address. That address reads its folder, minus dotfiles, until the grant
  expires (`workspace/preview.ts` `previewUrl`).
- Removing the last sign-in method from a running server beyond loopback is
  caught only at the next start (`startup.ts` `refuseUnauthenticatedBind`).
- Every DNS name other than `localhost` must be listed in
  `TALARIA_WEB_ALLOWED_HOSTS`; IP literals always pass
  (`http/origin.ts` `allowedHostNames`).
- Onboarding locality and request logging still treat loopback as local
  without a CIDR list (`api/settings-router.ts` `onboardingRequestIsLocal`).
- Session state, sign-in challenges, OIDC pending flows and escape grants live
  in one process; a multi-process deployment needs shared state
  (`auth/store.ts`, `auth/oidc.ts`, `workspace/escape.ts`).
- Non-owners keep the temp roots, the active workspace and
  `MEDIA_ALLOWED_ROOTS` in `/api/media`, and an agent-written `MEDIA:`
  reference can authorize a file outside the caller's roots
  (`workspace/media.ts` `mediaAccessFor`, `sessionMediaGrant`).
- Tool approvals need only session visibility, not owner authority
  (`api/chat-router.ts` `approvalRespond`).
- The Agent's control socket and the optional session bridge trust every
  process of their UID. A command a chat runs in the Web container under that
  UID (a local terminal tool) can reach any profile the helper lists, as it can
  already read every profile's home, credentials and cron jobs in the shared
  `hermes-home`, and reach `gateway.sock` in a single-container install. Keep
  profiles that must stay apart on separate UIDs or deployments
  (`web/sidecar/talaria_sidecar/gateway_bridge.py` `check_peer`).
- Remote-image relay ids live in memory, so an old relay URL answers 404 after
  a restart (`http/remote-image.ts` `vouchRemoteImage`).
- Apple sign-in budgets key on the client address, so users behind one NAT
  share one budget (`relay/convex/http.ts` `appleAuthClientKey`).
- Relay health checks are cached per isolate, not globally
  (`relay/convex/http.ts` `healthCache`).

Open defects, tracked rather than accepted:

- TAL-2585: a profile-bound login can give a cron job another visible profile
  as its execution profile (`tools/crons.ts`
  `CronService.accessibleProfileNames`).
