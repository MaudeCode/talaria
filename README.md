# Talaria

Talaria combines a native Apple client, Talaria Web, and the APNs/Live Activity
relay. Components share source history and contracts, with independent builds
and releases.

- [Apple app](app/README.md): SwiftUI, Xcode, widgets, share extension, and XCTest.
- [Talaria Web](web/README.md): Talaria Web, the Hermes-compatible Python server and React frontend.
- [Relay](relay/README.md): the Convex relay.
- `contracts/`: shared interface versions and synthetic fixtures.

Run `scripts/check app`, `scripts/check web`, `scripts/check relay`, or
`scripts/check docker` for component validation. `scripts/check all` runs the
complete local path. Python 3.13, Node 22+, pnpm, Xcode, and Docker are required
for their owning checks. Browser and server tests use synthetic isolated state.

Start app validation directly with `app/scripts/test-ios`. Open
`app/Talaria.xcodeproj` in Xcode. Component commands run from their own directory.
See [app development](app/DEVELOPMENT.md) and [contribution policy](CONTRIBUTING.md).

See [source migration and rehearsal](docs/monorepo-migration.md) for history,
root ownership, tag preservation, and public upstream imports.

Source consolidation is tracked under TAL-202. Release integration and the
production cutover are separate required steps, TAL-203 and TAL-204.
