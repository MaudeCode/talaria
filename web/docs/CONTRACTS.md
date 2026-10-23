# Project Contracts

This is the index of Talaria Web's contracts, RFCs, design constraints, and
review expectations. It routes you to the source documents; follow each
document's own status and scope.

Use it when starting a change so the relevant contract is visible before code
is edited.

## Start here

- [`AGENTS.md`](../AGENTS.md): entry point for AI assistants, safety rules,
  and the change guidelines.
- [`README.md`](../README.md): product overview, quick start, configuration,
  and docs index.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md): components, module layout, state
  ownership, and design constraints.

## Runtime, durability, and state contracts

- Server-owned derivation: clients are display-only. The server computes every
  value a client renders and ships it through `packages/contracts`; see
  server-owned state in the root [`AGENTS.md`](../../AGENTS.md).
- [`docs/rfcs/webui-run-state-consistency-contract.md`](rfcs/webui-run-state-consistency-contract.md):
  consistency rules for streaming, recovery, replay, model-context
  reconstruction, compression, and sidebar metadata, plus the review
  checklist for run-state changes.
- [`docs/rfcs/live-to-final-assistant-replies.md`](rfcs/live-to-final-assistant-replies.md):
  product model for long-running assistant replies: live process text, tool
  activity, recovery, terminal outcomes, display projections (Compact
  Worklog, Transparent Stream, Final answer only), and the final-answer
  boundary. The server stamps each message's `_turn_id` and attaches every
  completed turn's `activity_scene_v1`; every terminal chat frame carries
  `terminal_state` (`TurnTerminalStateSchema`). Web and iOS render those
  fields and derive none of them.
- [`docs/rfcs/session-sse-contract-v1.md`](rfcs/session-sse-contract-v1.md):
  chat and per-session SSE event names, `event_id` cursors and resume, the
  run-journal replay source, `session_snapshot` fallback, the session detail
  `transcript_seq` cursor, and persisted tool-call outcomes.
- [`docs/sse-streams.md`](sse-streams.md): every SSE endpoint, approval and
  clarify prompts, the merged sidebar stream, heartbeats, and the live
  dictation WebSocket.
- [`docs/remote-workspaces.md`](remote-workspaces.md): remote terminal
  profiles (SSH, Docker), target-side path preservation, and the
  `profileSupportsLocalIo` host-isolation gate.
- [`docs/architecture/sidecar-rpc.md`](architecture/sidecar-rpc.md) and
  [`docs/architecture/agent-api-contract.md`](architecture/agent-api-contract.md):
  the sidecar RPC that is the server's only boundary to Hermes Agent, and the
  tested Agent identity.
- [`docs/architecture/contract-package.md`](architecture/contract-package.md):
  the `packages/contracts` layout and the committed OpenAPI document.
- [`docs/rfcs/README.md`](rfcs/README.md): RFC conventions and index.

## Authentication contracts

- [`docs/native-oidc-auth.md`](native-oidc-auth.md): native-app OIDC handoff
  endpoints, state ownership, PKCE and server binding, callback contents,
  single-use exchange, cancellation, and compatibility behavior.

When a change touches streaming, recovery, replay, compression, context
reconstruction, cancellation, approval/clarify, session metadata, or run state,
read the relevant RFC before editing. In the PR description, name the state
layer or event/control surface affected and include a regression test or manual
verification for the relevant invariant.

## Frontend application contracts

- [`docs/architecture/frontend-migration.md`](architecture/frontend-migration.md):
  the browser application architecture: TanStack Start SPA shell,
  Router-owned URLs, Query-owned server state, the reducer-owned chat stream,
  Zod contracts, Paraglide localisation, Streamdown rendering, PWA build, CSP,
  and the build/serve pipeline for `static/dist/`. Start here for any change
  under `packages/frontend/`.
- [`docs/architecture/extension-protocol-v1.md`](architecture/extension-protocol-v1.md)
  and [`docs/architecture/extension-migration-guide.md`](architecture/extension-migration-guide.md):
  the sandboxed extension protocol and the migration path from the injection
  and dashboard-plugin interfaces.

## UI, UX, and theme contracts

- [`DESIGN.md`](../DESIGN.md): the calm-console direction: conversation first,
  quiet metadata, restrained accents, and progressive disclosure for debugging
  detail.
- [`docs/UIUX-GUIDE.md`](UIUX-GUIDE.md): contributor-facing synthesis of the
  UI/UX principles.
- [`THEMES.md`](../THEMES.md): the theme and skin axes, the token vocabulary in
  `packages/frontend/src/theme/skins.ts`, and extension skins.

For UI or UX work, attach before/after evidence to the PR, verify desktop,
narrow, and mobile states, and prefer stable class/data hooks over one-off
visual behavior.

## Choosing the relevant contract

Before editing, identify which contract family the task exercises. This is a
routing check, not a request to read every document. When it helps clarify
scope, add this note to the PR or task handoff:

```markdown
## Contract Routing

Task type:
Touched areas:
Relevant docs:
- `AGENTS.md`
- `docs/CONTRACTS.md`
- <subsystem-specific documents>
Scope boundaries:
Evidence needed before claiming done:
```

## Contract changes

A PR that intentionally changes an existing contract includes a
`Contract Change` section in its body with the previous contract, the new
contract, the affected docs and tests, and the compatibility or migration
reason. Contract tests and their docs move together; a test must not silently
redefine a contract by asserting the opposite behavior.

## PR checklist

Before opening or updating a PR, verify the body against the root PR template
(`.github/PULL_REQUEST_TEMPLATE.md`) and confirm:

- The PR solves one logical problem; unrelated refactors are split out.
- UI/UX changes include before/after evidence (uploaded attachments, never
  committed files) and responsive-state coverage.
- Runtime or streaming changes name the state layer or invariant being changed
  and list the regression or manual check.
- Clients render server contract fields; a value a client computes that the
  server could send moves to the server.
- Contract-affecting PRs include `Contract Routing`; intentional contract
  changes also include `Contract Change`.
- Onboarding or setup validation used isolated `HERMES_HOME` and
  `HERMES_WEBUI_STATE_DIR` unless the operator explicitly asked for real
  state.
- Docs are updated or explicitly not needed, and the change has a
  `changelog.d/TAL-<number>.json` fragment (see the root `AGENTS.md`).
- New dependencies, build tools, frameworks, or long-lived processes have an
  explicit benefit and rollback story.
- Secrets, private paths, and personal notes stay out of tracked docs.

## Setup, onboarding, and operational references

- [`TESTING.md`](../TESTING.md): test gates and manual checks.
- [`docs/onboarding.md`](onboarding.md): first-run wizard and provider setup.
- [`docs/onboarding-agent-checklist.md`](onboarding-agent-checklist.md): safety
  rules for assistant-led install, reinstall, bootstrap, provider setup, local
  model setup, Docker onboarding, and WSL onboarding.
- [`docs/docker.md`](docker.md): Docker Compose setup, common failures, and
  bind-mount migration.
- [`docs/troubleshooting.md`](troubleshooting.md): diagnostic flows for common
  failures.
- [`docs/EXTENSIONS.md`](EXTENSIONS.md): administrator-controlled extensions.

Outbound draft review extends tool result views with an `outbound_draft` locator.
It is not trusted content or authorization. `/api/session/outbound-draft` resolves
that locator against the session's actual tool result and a consented registered
producer. A transcript directive alone cannot open a draft. The initial adapter
supports only the reviewed Draft Cards store revision; unsupported or disabled
producers return `draft: null`. Native Desktop JavaScript is never executed.

The producer owns draft content and versions in its profile-local database.
Talaria's adapter checks session identity, complete raw revision and version in
one SQLite transaction before editing or approving. Its additive
`talaria_outbound_approvals` table records one approval per artifact/version;
existing producer tables remain readable by Stable. Edits clear approval, stale
or superseded actions refuse, and masked content cannot be edited or approved.
A lost write acknowledgment requires a fresh read, never an automatic write
retry. Approval records consent only; it neither sends nor submits a chat turn.
Sending remains subject to the existing Agent tool permissions and admission.

Chat readiness and runtime refusals share the optional `agent_runtime_reason`,
`agent_update_state`, `retryable`, and `restart_scheduled` fields. The server
projects typed sidecar evidence into `update_active`, `recovery_incomplete`,
`source_changed`, or `unknown`; HTTP refusals and journalled SSE errors carry the
same projection as `/api/health/agent`. Source changes require a verified revision
mismatch and do not prove that an update completed. Older responses without a
reason use neutral runtime-unavailable wording. These fields do not change
update notification history or authorize service recovery or a Web restart.

Session model switches use the profile's Agent selection guards before changing
model, context figures, workspace, or cached Agent. `POST /api/session/update`
returns HTTP 409 with `type: model_confirmation_required`, Agent `warnings`,
a display-ready `error`, and `confirm_token`. Cancel sends nothing. A confirmed
retry includes that token and the original selection; a changed session, route,
context measurement, or warning requires fresh confirmation. Successful updates
retain the ordinary session envelope. Clients without this flow retain their old
model and receive the actionable error. Global/default model setters are separate.

Chat-originated `POST /api/reasoning` effort changes include `session_id`, including
reset requests with `effort: ""`. The server checks the target's profile and canonical
writability before writing config. Native and other read-only chats receive HTTP 409
with `code: reasoning_unsupported`; missing chats receive 404. Neither refusal changes
profile defaults. Explicit profile settings omit `session_id`. The independent
`display: show|hide` preference still writes only the Web display setting.

`GET /api/reasoning` advertises `supports_session_scope: true` only with this guard.
Independently updated clients check that capability before chat effort/reset writes.
An absent or false flag prevents the write and requires a server update. A failed
read also prevents the write and propagates its error; clients never retry without
context. Explicit profile settings remain
available without the capability. The flag is additive and optional for old-server
decoding.

Native scheduled-chat refusals use the existing terminal `apperror` fields. Only
the recognized owner descriptor `cron_session_read_only` maps to `type` and
`code`, redacted owner `message`, and `retryable: false`. Other owner failures
retain the generic error. The sidecar brackets its initial retained-event replay
with a `replaying` snapshot flag and `replay_complete`; the server settles an idle
attachment only after that replay drains. This stream change bumps the internal
sidecar RPC protocol to 50, so mismatched server/sidecar pairs fail the handshake.
Descriptors are scoped to the session,
authority, replay epoch, execution generation and admission, and are discarded on
replacement or replay gaps. Web hides Retry when the server sends `retryable:
false`; absent fields retain older-server behavior.

Web completion audio uses optional `web_audio` instructions on the live global session feed.
The shared terminal projection supplies a stable run identity, persisted server/profile scope,
eligibility and expiry. The server filters instructions to the request's profile; initial,
history and reconnect snapshots carry none. Coalesced invalidations retain at most 32 instructions.
The browser never infers completion from text or transcript rows. Its existing bounded IndexedDB
playback claim ledger serializes attempts across tabs, including failed or muted attempts.
Settings > Preferences stores sound, volume, local quiet hours and at most one local audio file
in browser storage. Audio files are limited to 1 MiB and 10 seconds; preview requires a click.
Storage or autoplay failure stays quiet. Web audio does not change Relay/APNs policy, viewed
acknowledgements, speech preferences or background-process notification settings.

Explicit prompt queues use `/api/prompt-queues` and its versioned edit/action
routes. Creating a run saves a draft; only `start` or `resume` authorizes dispatch.
The server owns target profile/project/backend fences, ordered steps, availability,
admission claims and receipts, current step, phase and permitted actions. Clients
render these fields and optimistically show their own writes with rollback.
Stale control revisions return 409; receipt-only progress preserves the control
revision so a still-permitted Pause or Cancel remains usable during admission. Pause and cancel hold successors, including when a
step is already dispatching; they do not interrupt an admitted turn.

Runs are additive private documents under `prompt-queues/`, scoped to the
creating authenticated owner and profile. A durable dispatch claim precedes the
shared chat admission. Direct steps settle from the exact run journal after
worker release. Native steps use the canonical owner submit path and its exact
admission receipt, fenced by authority epoch. A lost acknowledgement without a
receipt remains unknown across reload/restart and is never resubmitted. A later
confirmed completion after uncertainty leaves remaining steps paused for an
explicit Resume. Failed or refused steps stop the run. No schedule or recurring
execution is created. App adoption is tracked separately in TAL-1356.


## Managed session buffers

The Files list/read/save procedures accept `source: "managed"` for the fixed
Agent devkit backend. Omitting it keeps workspace behavior. Managed operations
resolve the visible session and active profile before using the existing admitted
Agent plugin host, with no workspace resolution or native path supplied by the
client. An opaque `buffer-…` identity from the list is the only read/save target.
The existing Files editor renders server metadata and read-only decisions.

`plugins.buffers` admits only an already enabled and consented devkit API, even
when its manifest has no compatible Web panel. It never loads the Desktop UI,
installs, enables, promotes, clears, or recreates missing buffers. Deleted or
unverifiable native sessions are read-only. Inventory and text are bounded to
200 buffers and 256 KiB per buffer; malformed or oversized replies fail closed.
Native paths are discarded. The API explicitly advertises
`write_semantics: "unconditional"`: this backend has no conditional revision
operation. A save can replace concurrent native edits. Unknown outcomes retain
the editor draft and reconcile by reading; they never trigger an automatic PUT
retry. Cleanup continues to belong to the plugin.

## Kanban inspection

`GET /api/kanban/inspection` returns one profile-scoped snapshot for the Kanban
Timeline and Relationships views. An optional `board` restricts the read to that
live board; omission inspects the active profile's live boards. It never reads
another profile. The sidecar reads at most 32 boards, 500 tasks and 2,000 edges
without initializing or migrating databases. `truncated` explicitly marks an
incomplete graph. Board-qualified `key` values disambiguate task IDs.

The server applies the ordinary assignee, tenant, search and archived filters
before traversing visible dependencies, and supplies transitive `ancestors`,
`descendants`, `cycle`, `running_lineage`, task action capabilities and actual
`timing`. `running_only=1` keeps running tasks and their ancestors/descendants.
Unknown timestamps, durations and timeline positions remain null. Running task
durations use the current attempt's actual start and the snapshot's
`generated_at`; creation timestamps never become effort dates. Relationships
are dependencies across the displayed boards, not inferred task provenance.
Both layouts use the same query and existing task detail/actions. The existing
board event stream invalidates it; a visible-page refresh also covers writes on
other boards. Profile switching clears the existing Query cache and closes the
previous detail selection. The shared fixture is
`contracts/fixtures/kanban-inspection.json` at the repository root.

## Canonical message reactions

Canonical message reactions use the closed `react` owner action on
`POST /api/chat/owner-action`. The request has only `session_id`, a positive
`row_id`, and one allowed `emoji` or null for removal. The authenticated owner
writes as `user`; sending the same emoji toggles it off. The sidecar checks the
owner's boot revision and current snapshot row before forwarding the write.
The owner resolves the current physical lineage and authorizes the mutation.
An uncertain native error or lost acknowledgement triggers readback and never a second toggle.

Each canonical message's optional `reaction_view` supplies counts, the user's
selection, permitted actions and each action's optimistic display result. Web
renders these fields with rollback on refusal. Old owners have no permitted
reaction actions, and direct chats have no reaction writer. The existing shared
viewer watch reads reaction metadata on its observation tick because the native
owner emits no reaction event. Reaction-only snapshots invalidate display data;
they cannot start or settle a turn. Detaching the last viewer releases this
readback with its existing subscription. This extends sidecar RPC version 55.

Loaded Web history reconciles reactions through bounded transcript windows in the
same Query invalidation family as the tail. Server window offsets delimit the
loaded interval; readback retains its rows and scroll position across the window cap.


## Memory compaction

`POST /api/memory/compaction/preview` accepts `section` (`memory` or `user`) and the
loaded section `revision`. The server uses `aux.complete` on `compression` with
no main-model fallback. The source and model output are bounded to 32,000 bytes
and 128 entries. Secret-bearing entries and entries containing `<protected>` or
`[protected]` are retained locally. Other entries are compacted as data. Memory
files lack per-entry history provenance, so the derived prompt always carries
`data_use: ["no_training", "zero_retention"]` through the existing auxiliary privacy
gate. Inability to enforce that policy is explicit, never a permissive fallback.

The returned source, proposed text and diff are server-owned and always redacted.
The opaque signed receipt contains no secrets and binds the profile home, source
revision, exact proposal, result revision and a 30-minute expiry. It needs no
persistent proposal store. Clients apply only `{receipt}` to
`POST /api/memory/compaction/apply`, never resubmit displayed text. The existing
mask restoration, Agent format/character check, and locked compare-and-write
protect the save. Changed source or expired/foreign receipt returns 409 and
requires a new preview. A lost acknowledgment is read back against the exact
proposed revision; neither server nor client blindly replays the write.

`contracts/fixtures/memory-compaction.json` and the generated OpenAPI document
carry the same preview/apply interface for the downstream App consumer. These
user-requested previews are distinct from the Agent's pending-write queue; both
use the shared Web proposal review presentation.
