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
  clarify prompts, the merged sidebar stream, and heartbeats.
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
