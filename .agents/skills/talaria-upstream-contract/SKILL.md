---
name: talaria-upstream-contract
description: Verify Talaria API requests, decoding, HTTP/SSE transport, and server compatibility against the local monorepo Web component.
---

# Talaria Web contract

Read root `CONTRACT_TESTS.md` and the relevant `web/api/` implementation before
changing app requests, JSON decoding, or streaming. `web/` is the current source
of truth; `app/UPSTREAM_*` records the pre-monorepo support history.

Verify method, route, parameters, response shape, and SSE event sequence. Reuse
root `contracts/` versions and synthetic fixtures across Swift, Python, and
TypeScript. Unknown response fields remain tolerated; required values remain
validated. Keep request building, decoding, persistence, and presentation aligned.

From `app/`, run `scripts/validate-upstream-contract`. It boots local Web source
with disposable state and runs the HTTP/SSE probe plus focused Swift checks.
`--ref <monorepo-ref>` exports an immutable candidate's Web tree; `--server-only`
is the Linux half. Neither option edits historical pins or live state.

Record the monorepo revision, dirty-source status, artifact directory, checks,
and any failed endpoint/decoder boundary. Use `$talaria-ios-testing` for the
required app suite. Public upstream imports use root
`scripts/import-web-upstream`; inspect their diff before adopting changed behavior.
