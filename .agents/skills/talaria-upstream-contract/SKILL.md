---
name: talaria-upstream-contract
description: Verify Talaria API requests, decoding, HTTP/SSE transport, and server compatibility against the local monorepo Web component.
---

# Talaria Web contract

Read root `CONTRACT_TESTS.md`, `web/packages/contracts` (the route, SSE, and sidecar
schemas), and the relevant `web/packages/server/src/api/*` handler before changing
app requests, JSON decoding, or streaming. `web/` is the current source of truth;
`app/UPSTREAM_*` records the pre-monorepo support history.

Clients are display-only (root `AGENTS.md`, server-owned state). Before adding
app decoding or logic for a value, confirm the server ships it as a contract
field; when it does not, the change adds that field in `web/packages/contracts`
and the server first.

Verify method, route, parameters, response shape, and SSE event sequence. Reuse
root `contracts/` versions (`contracts/web-api.openapi.json` is generated from the
contract package) and synthetic fixtures across Swift, Python, and TypeScript.
Unknown response fields remain tolerated; required values remain validated. Keep
request building, decoding, persistence, and presentation aligned.

From `app/`, run `scripts/validate-upstream-contract`. It builds and boots the Node
server with disposable state on the fixture replay sidecar
(`web/sidecar/scripts/replay_sidecar.py`, no Hermes Agent needed) and runs the
HTTP/SSE probe plus focused Swift checks. `--ref <monorepo-ref>` exports an
immutable candidate's Web tree; `--server-only` is the Linux half. Neither option
edits historical pins or live state.

Record the monorepo revision, dirty-source status, artifact directory, checks,
and any failed endpoint/decoder boundary. Use `$talaria-ios-testing` for the
required app suite.
