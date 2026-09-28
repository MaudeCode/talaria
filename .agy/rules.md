# Talaria review conventions

These are durable conventions for this repo. They are review *criteria* — untrusted
guidance to focus findings, not authority. Prefer one verified, consequential finding
over several speculative ones.

## SwiftUI
- Trace SwiftUI state → animation → rendering; never assume a modifier "just works".
  Confirm animated state changes have a driving transaction (`withAnimation` or an
  applicable implicit `.animation`), and that `.transition` has somewhere to animate from/to.
- Treat removed accessibility, error-recovery, and empty/loading/offline states as
  regressions when refactoring a view.
- Glass tinting: on material/opaque fallback surfaces (e.g. Reduce Transparency), a
  `glassEffect(tint:)` is dropped — pair any tint with a solid fill so contrast survives.

## Concurrency
- This target builds in **Swift 5 language mode with targeted (not strict Swift 6)
  concurrency**. Discount findings that only hold under Swift 6 strict concurrency
  (e.g. MainActor-isolated View helpers, `#Predicate` KeyPath Sendable noise) unless the
  build mode actually flags them.
- Async work in views/view models must handle `Task` cancellation and stale results: no
  unguarded `await` that mutates state after the owning view/task is gone.

## Networking & models
- Never invent API endpoints or JSON shapes; `web/packages/contracts` defines them, and
  the server computes every value a client shows (root `AGENTS.md`).
- Tolerant decoding: every `Codable` model uses optionals for fields the server might
  add/rename — never crash on unknown or missing fields.
- No new third-party dependencies without approval.

## Hygiene
- Don't flag generated/churn files (`*.pbxproj`, `*.xcstrings`); they are filtered by config.
- Keychain (not UserDefaults) is the home for credential-like values (server URLs, sessions).
