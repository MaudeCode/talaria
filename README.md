# Talaria

Talaria combines a native Apple client, Talaria Web, and the APNs/Live Activity
relay. Components share source history and contracts, with independent builds
and releases.

- [Apple app](app/README.md): SwiftUI, Xcode, widgets, share extension, and XCTest.
- `web/`: Talaria Web, the Hermes-compatible Python server and React frontend.
- `relay/`: the Convex relay.
- `contracts/`: shared interface versions and synthetic fixtures.

Start app validation with `app/scripts/test-ios`. Open
`app/Talaria.xcodeproj` in Xcode. Component commands run from their own directory.
See [app development](app/DEVELOPMENT.md) and [contribution policy](CONTRIBUTING.md).

The source migration is in progress under TAL-202. Release integration and the
production cutover are separate required steps, TAL-203 and TAL-204.
