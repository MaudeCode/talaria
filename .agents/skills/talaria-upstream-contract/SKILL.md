---
name: talaria-upstream-contract
description: Verify Talaria against the adopted hermes-webui contract. Use when changing API requests, JSON decoding, SSE or streaming, session transport, or server-version compatibility.
---

# Talaria upstream contract

Treat the pinned upstream source as the authority for behavior Talaria supports.
Use official documentation only as secondary context.

## Establish the contract

1. Read `UPSTREAM_TESTED_SHA`.
2. Read only the relevant sections of `CONTRACT_TESTS.md`.
3. Inspect `hermes-webui` at the exact pinned commit. Prefer `git show` against an
   existing `.codex-tmp/hermes-webui` clone so its checkout stays unchanged.
4. Verify the route, HTTP method, query or body keys, response shape, and SSE event
   sequence touched by the task.

Cloning, fetching, checking out, or modifying the upstream clone requires the
user's permission under the repository workflow boundaries.

## Running-server evidence

Use a running server to reproduce behavior only for that server's known version.
Keep read-only checks read-only. Run state-changing checks only with explicit
permission and only against disposable sessions or data.

The running server explains its own behavior. It does not silently replace the
pinned support contract. Stop and report a version mismatch instead of shaping
the client around an unidentified server version.

## Client behavior

- Define endpoints and request fields from verified upstream source. Do not infer
  them from names or nearby routes.
- Decode missing and version-varying fields tolerantly. Ignore unknown keys and
  validate required values before use.
- Keep request building, streaming, decoding, persistence, and rendering aligned
  when the same contract state crosses those boundaries.
- Add or update the smallest focused request, decode, or stream test that proves
  the adopted shape, then use `$talaria-ios-testing` for XCTest validation.

Update `UPSTREAM_TESTED_SHA` only when the user selected a pin advance and the
advance policy in `CONTRACT_TESTS.md` has passed. An upstream difference by itself
is not permission to move the pin.
