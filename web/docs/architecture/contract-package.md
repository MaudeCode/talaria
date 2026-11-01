# Contract package (TAL-245)

`@maudecode/talaria-web-contracts` (`packages/contracts`) is the single source
of truth for:

- every HTTP route the TypeScript server implements: method, path, auth class,
  query parameters, request body, response body, error envelope (oRPC
  contract-first, Zod v4 schemas);
- every SSE stream: a discriminated union per stream and the `id:` cursor
  grammar;
- the sidecar RPC: methods, params, results, stream frames, and
  `SIDECAR_RPC_VERSION`;
- the OpenAPI 3.1 document generated from the route contract into
  `contracts/web-api.openapi.json` at the repository root.

## Consumers

| Consumer | Uses |
|---|---|
| `packages/server` | implements the route contract; handlers are type-checked against it; the sidecar client is typed by the RPC schemas |
| `packages/frontend` | the generated oRPC client with TanStack Query bindings; SSE consumers parse with the stream unions |
| `sidecar/` (Python) | JSON fixtures exported from the RPC schemas; the pytest suite asserts each method against them |
| iOS app | the Swift decoders, checked against live server responses by `app/scripts/validate-upstream-contract` and against `contracts/fixtures/` |
| MCP bin | the route contract client |

## Rules

- No `z.unknown()`, `z.looseObject`, or `.or(OkSchema)` unions in the final
  contract except where a field is genuinely opaque passthrough from the
  Agent. Every such field is listed in `docs/architecture/contract-passthrough.md`
  with the Agent module that produces it.
- Today's loose shapes are pinned to one shape: the 27 `.or(OkSchema)` endpoint
  unions, dual-key responses (`entries|items`, `log|entries`, `history|days`,
  `entries|extensions`), string-or-number ids, enum-or-string statuses. The
  server emits the pinned shape; the frontend consumes it; the PR body lists
  each pinning decision.
- REST paths, methods, query parameters, and auth classes are preserved so the
  iOS app keeps working without changes.
- The OpenAPI document is generated in CI and compared with
  `git diff --exit-code`; a stale document fails the build.
- The route contract carries the auth class of each route as metadata
  (`public`, `auth`, `operator`), and the server's auth middleware reads it from
  the contract rather than from a parallel path list.

## Layout

```
packages/contracts/
  package.json          @maudecode/talaria-web-contracts
  src/
    index.ts            public exports
    common.ts           error envelope, ids, timestamps, nullable helpers
    routes/             one file per domain (auth, sessions, chat, ...), each
                        exporting an oRPC contract router segment
    router.ts           the composed route contract
    sse/                one union per stream and the cursor grammar
    sidecar/            RPC method schemas, stream frames, SIDECAR_RPC_VERSION
    openapi.ts          OpenAPI 3.1 generator
  fixtures/             JSON fixtures shared with the sidecar pytest suite
  scripts/
    generate-openapi.mjs   writes ../../contracts/web-api.openapi.json
    export-fixtures.mjs    writes sidecar/tests/fixtures/*.json
```

### Session row read projection

Session list and search reads normalize unambiguous legacy scalar values to
`SessionRowSchema` types before filtering and counting. Missing titles render as
empty strings. Rows without a valid session identity are omitted and logged once
per source file for the lifetime of the store; loading a saved file never invents
an identity, and a saved identity must match its file name. Unusable optional
schema fields are omitted. These projections do
not rewrite the saved session files. The app retains tolerant decoding for older
servers, and Insights displays server analytics rather than totals computed from
session rows.

Canonical Agent ownership is independent of source and runtime activity. The
read-only state.db resolver reads local-policy receipts, admission lineages and
worker ledgers in the selected profile, including terminal records. It recovers
the original source from the receipt and keeps logical and physical reset or
compression ids display-only. Existing Talaria sidecar tags cannot override that
ownership. Session list/detail/status carry `read_only_reason` when canonical
ownership or unreadable storage prevents writing. Mutation and turn admission
use this same resolver; no Agent database writes or owner restarts are involved.

## Catalog availability

Models, live models, provider discovery and plural quotas expose the same optional
`availability` object. `authoritative` confirms membership for that response;
`status` distinguishes available, stale and unavailable data, and
`unavailable_reason` explains the display state. Individual quota sources still
carry their own usage status, so confirmed membership does not make a failed
balance refresh current. Model groups carry the same verdict for their catalog.
Older consumers may ignore these additive fields.

A failed Agent lookup never confirms an empty catalog or removed source. The
server keeps sanitized last-confirmed answers only while the profile's config,
credential and plugin fingerprint, including hashed provider/model environment inputs, matches. `generation` is an opaque fingerprint;
clients may retain missing cached rows only when it and the quota `scope_id`
match. Native widget snapshots also bind to the existing response cache's opaque
server identity and profile. Legacy snapshots without that binding are refreshed
before restoration. Confirmed empty responses replace cached membership.

These display fallbacks do not change sidecar recovery admission. Configured
model identity stays separate from live catalog authority, and unconfirmed live
model lists never replace the native picker catalog or authorize session repair.
`contracts/fixtures/catalog-recovery.json` pins the shared App/Web display fields.
