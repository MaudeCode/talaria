# Talaria

> [!WARNING]
> **Talaria is under heavy development and is not accepting outside contributions.**
> Interfaces, storage formats, and release flows change without notice. Report
> security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
> This notice changes when that does.

Talaria combines a native Apple client, Talaria Web, and the APNs/Live Activity
relay. Components share source history and contracts, with independent builds
and releases.

- [Apple app](app/README.md): SwiftUI, Xcode, widgets, share extension, and XCTest.
- [Talaria Web](web/README.md): Talaria Web, the TypeScript server, React frontend, and Python sidecar for Hermes Agent.
- [Relay](relay/README.md): the Convex relay.
- `contracts/`: shared interface versions and synthetic fixtures.

Run `scripts/check app`, `scripts/check web`, `scripts/check relay`, or
`scripts/check docker` for component validation. `scripts/check all` runs the
complete local path. Node 24, Python 3.13 (sidecar tests and release tooling), pnpm, Xcode, and Docker are required
for their owning checks. Browser and server tests use synthetic isolated state.

Start app validation directly with `app/scripts/test-ios`. Open
`app/Talaria.xcodeproj` in Xcode. Component commands run from their own directory.
See [app development](app/DEVELOPMENT.md) and [contribution policy](CONTRIBUTING.md).
