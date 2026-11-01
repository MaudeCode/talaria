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
readback with its existing subscription. This extends sidecar RPC version 57.

Loaded Web history reconciles reactions through bounded transcript windows in the
same Query invalidation family as the tail. Server window offsets delimit the
loaded interval; readback retains its rows and scroll position across the window cap.


## Native profile discussions

`/api/groups` advertises the running native driver's capabilities and its seatable
profiles intersected with profiles managed by this server. Unsupported, stopped
and inactive owners advertise no actions. Discussions attach to an existing
profile-bound owner; no request starts a gateway or constructs an Agent.

`/api/groups/action` accepts a closed operation union. Every existing-room write
carries the server's opaque room identity. Member approvals and Retry/Discard
also carry the current native member/task/execution generation and approval id.
The native service owns the durable room, task ledger, control receipts and
attachment custody. The Web server owns authorization, bounded display windows,
attribution, safe errors, member phases and permitted actions. Clients render
these fields through the shared transcript, composer and approval components.

`/api/groups/view` returns a server-ordered window. `before_seq` requests an older
window; returning to the latest window resumes observation. One authenticated
`/api/groups/stream` observer per owner/profile/room holds the native log cursor
while viewers exist. Snapshots replace the displayed window, so replay cannot
duplicate rows. Gaps or authority replacement rebuild a bounded snapshot. The
last viewer releases observation without stopping native execution.

Uploads use `/api/groups/upload`; the server classifies the declared MIME, and
the native store validates MIME, bytes and room custody. The server verifies
native upload/download digests and sizes. Downloads require the room identity,
committed event id and attachment id; no Agent path is exposed. An uncertain
write is read back, never automatically repeated. `/api/groups/receipt` reconciles
a user's send identity against the native log. An unconfirmed receipt stays
unknown. Before dispatch, `/api/groups/send-identity` resolves the caller's
occurrence id to its native event id without querying or changing an owner.
The optimistic row uses that server-issued identity to converge on a streamed
persisted row, including while the POST response is delayed. Definite refusals
restore the draft and files immediately, without reconciliation reads.
Multi-profile discussions require the existing server-owner authority. The
shared authentication gate protects the whole group API namespace, including
streams and file downloads, before native RPC. A profile-bound trusted-header
or OIDC login cannot use another managed profile through a room.
App adoption is tracked separately in TAL-1378.

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

## Saved skill revisions

`GET /api/skills/revisions` is read-only. It inspects the enabled, consented,
reviewed Hermetic store without importing producer code, calling its API,
creating directories, migrating legacy data or recovering background processes.
The fixed native registration/source gate is shared with outbound draft review.
Unsupported backends and ambiguous declared skill names are unavailable.

The sidecar reads at most 64 directory entries, 32 KiB and 512 lines per revision,
and 256 KiB of provenance. It opens the profile ancestors, skill and history
files without following symlinks and validates each saved filename's hash prefix
against the full SHA-256 of its bytes. No saved revision is synthesized from
current content. Metadata includes full content hashes, the reviewed backend
revision, actual timestamps and known actors. Missing provenance stays unknown.
Revision IDs bind profile home, resolved skill identity and content; stale or
foreign selections are refused. Clients render the sidecar's ordering, current
markers, selected content and comparison. The HTTP projection redacts display
text and actors, retaining raw content hashes only as provenance.

`replay_available` is true when two saved revisions exist to compare. It only offers
the replay plan below; inspection itself never grants execution, provider use, a
judge, skill edits or tool effects. The shared synthetic fixture is
`contracts/fixtures/skill-revisions.json` at the repository root. Existing skill
content/edit/delete/toggle/linked-file endpoints retain their contracts.

## Saved-check replay

`GET /api/skills/replays/plan` is the consent summary for replaying the skill's
saved Hermetic cases against two exact revisions (`baseline`, `candidate`). The
sidecar (`skills.replay_plan`) reads the revisions through the inspection adapter
above and the cases from `hermetic/cases.jsonl` with Hermetic's update/delete
semantics; a malformed row fails closed. Each case's fixture is the recorded turn
from the session store up to its user message: recorded tool results only, the
newest 120 KB, and minimal definitions for the recorded tool names. Its ID binds
profile home, skill and the exact fixture. Cases without a recorded turn are
counted in `unavailable_cases`, never invented. At most 12 cases are planned.

Only the OpenRouter route executes: its exact HTTPS API honors a per-request
`provider.max_price`. Any other main-model provider or base URL is
`route_unsupported` before a call. The server reserves a finite budget
(`SkillReplayBudgetSchema`): 2 calls per case, 1,500 output tokens per call, each
case's prompt bound (UTF-8 bytes plus template overhead, which byte-level
tokenizers cannot undercut) and one price ceiling chosen so the sum of every
call's reservation stays within `max_cost_usd` (default $0.50, at most $5).

`POST /api/skills/replays` admits one confirmed request bound to the
authenticated owner, active profile, skill, both revisions, the exact case
fixture IDs, route and budget. The server re-plans and refuses any drift (409
`replay_drift`) before a call. `request_id` makes admission idempotent: a retry
after an uncertain acknowledgement returns the admitted job; reuse for a
different replay is 409 `replay_request_reused`. One replay runs per owner and
profile (409 `replay_busy`). Each owner and profile keeps its 20 newest finished
jobs; an older job leaves an admission receipt in `skill-replay-receipts`, so
retrying its `request_id` is 409 `replay_pruned` and never runs again.

Jobs are private documents in the `skill-replays` namespace. Runs execute in
order; each is persisted `dispatched` before `skills.replay_case` sends exactly
one request (no retry, no redirect). The sidecar re-derives the revision bytes,
fixture, prompt bound and route and refuses drift before sending. Planned tool
calls are recorded and scored with Hermetic's code checks; nothing runs a tool,
judge, skill write or background job. A provider HTTP failure is `error`; a lost
transport or sidecar failure after dispatch is `unknown` and never resent. A
reported cost, prompt or output beyond the call's reservation fails the job
(`budget_exceeded`) and skips its successors. Cancellation skips every unsent
call and keeps the dispatched call's actual outcome. A restart turns active jobs
`interrupted`: dispatched calls become `unknown`, unsent calls `skipped`.
`GET /api/skills/replays` and cancel see only the admitting owner's jobs in the
active profile; a foreign job is 404. The server projects state, per-case runs,
summaries and reported cost; clients render them. Shared fixtures are
`contracts/fixtures/skill-replay-plan.json` and `skill-replay-job.json`.

## Persistent delegation settings

`GET /api/model/auxiliary` includes optional `delegation` settings. The native
Agent registry supplies configured/effective mode, availability, recovery reason,
fixed-model eligibility, registered modes and current profile names. Missing or
unavailable modes retain their saved identity and never select another backend.
Older Agents report unsupported mode editing while retaining saved route blocks.

`POST /api/model/auxiliary/delegation` selects a backend through native
`set_global_backend`, or replaces one complete `model_map` / `profile_routes`
block through the existing serialized config owner. Mode/route writes and Reset All
require the existing server-owner authority. Non-owners receive `can_edit: false`,
an empty profile registry and no named route blocks; the ordinary profile-local
fixed-model picker remains available when active. Native canonical route keys
and parsers validate saves. Read responses omit API keys and request overrides;
`original_name` preserves hidden values across renames. An omitted fallback list
keeps its native meaning, and an empty list stays explicitly empty. Profile routes
require existing native profile identities and explicit lending consent in Web.
The shared fixture is `contracts/fixtures/delegation-settings.json`.

All auxiliary writes use the existing exclusive optimistic resource owner: show
the choice immediately, roll back refusals, reconcile unknown outcomes without
replaying, and fence stale responses after a profile switch. Reset All restores
the native Default backend as well as fixed model overrides. Session overrides
and delegation execution are separate. This extends sidecar RPC version 63.

## Project chat defaults

A project in `projects.json` can carry `workspaces`, `default_workspace`, `model`
and `model_provider` (TAL-1032). The keys are additive, so Stable reads the file;
a row from upstream with only a single `workspace` reads as that one bound default.
`GET /api/projects` returns the normalized fields plus `model_option_id`, the catalog
entry the saved pair selects, or null when it is unbound or no longer offered.

`POST /api/projects/bind` changes only the fields it names. Each workspace must pass
the same trust check as a new chat's workspace and is stored as its canonical path,
deduplicated. The default must be one of the bound workspaces; null starts new chats
in the profile default, and an empty list clears every workspace. A model needs its
provider: a bare id never selects one. A new pair must be one the catalog offers, while
re-sending the saved pair keeps a choice the catalog dropped. The whole request is
validated before the one write, so a refusal leaves the project unchanged.

`POST /api/session/new` with a visible `project_id` fills the workspace the request
omits, or one it inherited from the previous chat, with the project default, and fills
model and provider when the request names neither. The worktree preflight and the
created session read the same resolved body, resolved only when a chat is created, so a
referenced creation's retry matches its original request. A project outside the request's
active profile is a 404, even when the body names its profile, a deleted bound default refuses creation rather than starting elsewhere, and a Safe
or Ignore config chat refuses a project: its Agent-owned chat is display-only in Web. Web's project
New chat sends only the project and the user's picks. The shared fixture is
`contracts/fixtures/project-bindings.json`.

## Coding-agent profile import

Owner-only `/api/profile/import` discovers the OS user's default `.claude`,
`.codex` and `.cursor` source directories. `/preview` accepts only an agent ID;
`/apply` accepts only an opaque receipt. `/result?receipt=…` reconciles without
running the importer. Web renders the server's dispositions and secret names.
App adoption is tracked separately in TAL-1494.

The adapter requires an installed, enabled catalog `agent-importers` plugin at
the immutable revision in `sidecar/agent_importer.json`, with matching native
API hashes. It never installs or enables a plugin. The real owning profile must
pass the shared config-write management guard before inspection and before
publication. An unavailable policy fails closed. The server refuses imports
with a custom active config path because the native API targets the default
profile config file. `catalog_required: false` hides unrelated installation
actions on these refusals. Unavailable plugins link to the existing catalog. No OpenClaw, credential migration, overwrite mode,
provider sign-in or automatic sync scheduling is included.

Preview writes no source or profile files. Read-only home binding skips credential hydration, terminal initialization and process recovery; unsupported catalog pins refuse before importing legacy config owners. The native path-based API receives
private temporary copies of bounded, descriptor-read source and target inputs.
Symlinks, hard links, special files, overlapping trees and oversized inputs are
refused. Five-minute consent binds the profile, plugin and complete input
snapshots. Apply verifies those identities again before publishing staged native
results with descriptor-relative atomic writes. Live memory replacement holds the native persistent `.lock` inode across its final identity check and replacement, sharing exclusion with chat memory tools and `memory.write`. Lock files are excluded from snapshots and never replaced. Existing item conflicts remain
intact. Native memory backups and sync registration are preserved.

A private additive `.talaria-agent-imports/` record is synced before execution.
Retries return the recorded result; a crash cannot replay native work. Before
publication the record also saves expected output digests, allowing a lost final
acknowledgment to reconcile exact output bytes. Partial publication remains
unknown. Native exception text, contents and paths never cross the response
boundary. Only native kind/status and stripped secret names are exposed.

After publication the existing Skills/MCP reload owners refresh runtime views;
a failed reload leaves imported files saved and reports the remaining reload.
Server config/catalog caches and Web profile, memory, skill and MCP query
families invalidate. No service restarts. Stable ignores the additive record.

## Plan allowance display

The optional `plan_usage`, model `allowance`, and catalog `sections` fields extend
existing model and quota responses. Native inventory supplies plan gauges, model
usage levels, and `credits_pay`; the profile-scoped catalog owns classification
and Recommended/Other membership, including saved models outside the inventory.
An unknown tier, pending entitlement, expired window, or unknown credit balance
never becomes a promise of included usage or credit coverage. Only native
`credits_pay: true` permits coverage wording. Repeated pending reads retain labels
and recommendations within the same credential generation and mark gauges stale.

Direct and owner usage carry optional `plan_gauge` through metering, terminal
frames, persisted sessions, and journal replay. A complete direct snapshot, owner
payload with `calls`/`api_calls`, or terminal owner usage clears an omitted gauge;
partial owner ticks retain it. Owner snapshot reads bind stats to the same home,
authority, replay epoch, and execution generation. A replacement owner or turn
starts with no retained gauge. These additions use sidecar RPC version 66 and
remain optional for independently updated clients. They add no billing writer,
model switching, prompt retry, or failed-turn recovery policy.

## Feedback forwarding

Authenticated clients preview optional diagnostics with `GET /api/feedback/diagnostics`
and send `POST /api/feedback/submit`. The closed request, preview, success and
error shapes are defined in `packages/contracts/src/routes/settings.ts` and
`contracts/fixtures/web-feedback.json`. Clients reuse the same UUID `requestId`
and unchanged form values after an unknown outcome. The server retries transport
failures once and preserves the redacted server snapshot across retries and restarts.
Changing a form under an existing request ID returns `invalid`.

The server owns the install UUID, version stamps and diagnostics. It shares the
existing publisher key and Relay transport; unregistered installs send unsigned.
Relay 429 returns `rate_limited` and `retryAfterSeconds`, disabled intake returns
`feedback_unavailable`, and unconfirmed transport or server failures return
`relay_unreachable`. Relay response details never reach the client. Local input
and Relay validation failures return `invalid`.

Diagnostics contain runtime versions, platform/architecture, registration state,
configured provider IDs and at most ten recent server errors, each capped at
300 characters. The shared redactor and path, URL, environment-assignment and
content-field removal all run before caching or truncating an error. Absolute
POSIX, Windows and quoted paths are removed regardless of their root. The complete UTF-8 text
is capped at 16 KiB. Feedback never reads transcripts or prompts. The private
`feedback` document namespace stores one bounded ledger with the install UUID,
redacted server snapshots and input hashes, never the submitted title or body.
The full JSON envelope is checked before admission writes. A principal may admit
20 fresh request IDs per hour; the ledger holds at most 1,024 receipts. Both limits
return `rate_limited` with a retry interval and allow existing IDs to reconcile.
Unknown outcomes retain the exact snapshot for up to 30 days. Confirmed sends
compact to a report-ID receipt; definitive refusals discard diagnostics and retain
a quota marker for one hour. Expired entries are removed on the next admission.
Concurrent calls for one request ID serialize through send and compaction. Submission
logs contain only the request UUID and outcome.

### Feedback attachments

`GET /api/feedback/options` publishes what clients may attach. Attachments are
enabled only when this server is a registered Relay publisher, because Relay
accepts files only on signed reports; `acceptedTypes`, sizes, `maxVideoCount`
(zero without video) and the video length limit mirror `contracts/fixtures/feedback-attachment-limits.json`
(`FEEDBACK_ATTACHMENT_LIMITS`, kept equal by a contract test). Clients compress
and strip metadata before upload; the server never re-encodes.

`POST /api/feedback/attachments` stages one multipart `file` with its declared
`contentType`. The bytes must match the type's signature (the shared magic table
in `sessions/shares.ts`, with Relay's `ftyp` brands) and its size limit. Files live
under `<state dir>/feedback-attachments`, indexed by the `feedback/attachments`
document: a member may stage 15 files and 100 MB, the server 256 files and 1 GB,
and an unreferenced file expires after one hour.

`attachmentIds` on submit must name at most five of the member's own unexpired
files, with at most one video; anything else is `invalid` before forwarding.
Claiming checks and binds every file to the request atomically, so one file
belongs to at most one report; a claim is returned when admission refuses the
report. Admission stores the manifest (type, bytes, SHA-256) in the receipt, the
fingerprint covers the file hashes, and the files live as long as the receipt:
they are deleted once the report is sent, and a refused report keeps them for its
one-hour quota marker so a retry of the same request can still send them. The server sends the manifest with the report, then PUTs each accepted
file with its token. An unknown PUT outcome resubmits the identical report once
(Relay keeps the report and reissues tokens only for files not stored) and retries;
a second unknown outcome is `relay_unreachable`, and the client's retry with the
same request ID resumes. The result lists every attachment as `sent` or `refused`
with `tier`, `quota` or `disabled` from Relay, `invalid` for a rejected upload,
or `expired` when the upload window closed.
