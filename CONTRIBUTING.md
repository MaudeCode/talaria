# Contributing to Talaria

Thanks for your interest in contributing! This document covers local setup,
running tests, code signing for contributors, and the PR workflow. Please also
read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local setup

- **Xcode 26 or newer** (the project builds with the iOS 18 SDK or later; the
  deployment target is iOS 18).
- Clone the repo and open `Talaria.xcodeproj`. Dependencies resolve
  automatically via Swift Package Manager — the dependency list is locked in
  `PROJECT_SPEC.md`; do not add new ones without maintainer approval.
- Build and run the **`Talaria`** scheme on an iPhone simulator
  (`iPhone 17` is the reference device; any recent iPhone simulator works).
- To actually use the app you need your own
  [hermes-webui](https://github.com/MaudeCode/hermes-webui) server — the app is
  a client only. See the [README](README.md#you-need-your-own-server) for
  reachable-server options (Cloudflare Tunnel, reverse proxy, Tailscale, or
  `http://localhost:8787` for simulator-only testing).

## Running tests

The full XCTest suite is the repo's green bar — it must pass before any PR:

```zsh
xcodebuild test -project Talaria.xcodeproj -scheme Talaria -destination 'platform=iOS Simulator,name=iPhone 17'
```

If that simulator name isn't installed, pick a nearby iPhone from
`xcrun simctl list devices available`. The same suite runs in CI on every pull
request with code signing disabled, so forks get green CI without any secrets.

## Code signing for contributors

The project's committed signing identity (`DEVELOPMENT_TEAM`, bundle IDs)
belongs to the maintainer. **Never edit `project.pbxproj` to sign with your own
team** — override locally instead:

1. Create `Config/Local.xcconfig` (it is gitignored, so it never lands in a PR):

   ```xcconfig
   DEVELOPMENT_TEAM = YOUR_TEAM_ID
   // Optional — only needed if provisioning complains about the bundle ID.
   // The app-group entitlement must stay in sync with the bundle ID.
   // APP_BUNDLE_IDENTIFIER = com.yourname.talaria
   // APP_GROUP_IDENTIFIER = group.com.yourname.talaria
   ```

2. Build normally. `Config/Shared.xcconfig` is wired into the project and ends
   with `#include? "Local.xcconfig"`, so your local values override the
   committed defaults for every target — no project-file changes needed.

For simulator-only development you usually don't need any of this: simulator
builds don't require a paid team. Note that unit tests and CI run with
`CODE_SIGNING_ALLOWED=NO`; installing such a build on a simulator for *manual*
testing breaks Keychain entitlements — use a normally-signed build for that
(see `AGENTS.md`).

## What PRs we welcome (and what we don't)

Bug fixes, test coverage, and focused improvements are always welcome. For
anything larger than a small fix, **open an issue first and wait for a
maintainer nod before writing code** — it protects your time as much as the
review queue. Drive-by rewrites, reformat-the-world diffs, and unannounced
architecture overhauls will be closed without detailed review.

Keep each PR to **one logical change** with a reviewable diff. If a change is
independently useful, it deserves its own PR.

## App bug or server bug?

Talaria is a thin client over the canonical
[`MaudeCode/hermes-webui`](https://github.com/MaudeCode/hermes-webui) fork, so a
fair share of apparent app bugs are server bugs. Reproduce the problem in that
fork's web UI against the same server:

- **Breaks in the web UI too** → report the fork behavior with its exact commit.
  Reference the public parent only when the same bug is verified there.
- **Only breaks in the app** → file it here with the bug-report form.

## PR workflow

1. **Start from tracked work.** Maintainer work uses a Kaneo `TAL-<number>` key.
   External reports may start in GitHub, but a maintainer links the canonical
   Kaneo task before implementation.
2. **Branch** from `main` as `<type>/TAL-<number>-<short-slug>`.
3. **Make the change**, keeping these repo hard rules (full list in
   [`AGENTS.md`](AGENTS.md)):
   - **Tolerant decoding:** every `Codable` model uses optionals for fields the
     server might add or rename — never crash on unknown fields.
   - **Never invent API endpoints or JSON shapes** — verify against the pinned
     upstream `hermes-webui` source or your own running server.
   - **No new third-party dependencies** without approval.
4. **Run the full test suite** (command above) and make sure it passes.
5. **Open a PR** against `main` using the PR template. Reference the `TAL` key
   and describe what changed and how you tested it. CI must be
   green; automated review bots may comment, and the maintainer reviews and
   merges.
6. **Disclose AI usage** in one line of the PR description: the tool/model
   used (e.g. "built with Claude Code"), or "human-authored". This repo is
   itself built with coding agents, so it's normal context for review — not a
   gate.

`main` is the protected release branch. Releases and TestFlight
uploads (`.github/workflows/*-testflight.yml`) are maintainer-only operations —
contributors never need App Store Connect access.

## Questions

Ask in [GitHub Discussions](https://github.com/MaudeCode/talaria/discussions)
if something here is unclear or wrong — docs fixes are welcome contributions
too.
