// swift-tools-version: 6.0
// App logic that needs no app host: models, networking, persistence and chat streaming. The App and its extensions
// link TalariaKit; its tests run with `swift test` on macOS, without a simulator (TAL-399).
import PackageDescription

let package = Package(
    name: "TalariaKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "TalariaKit", targets: ["TalariaKit"])
    ],
    dependencies: [
        // The App's approved packages; Package.resolved pins the same revisions as the Xcode project.
        .package(url: "https://github.com/LaunchDarkly/swift-eventsource.git", from: "3.3.0"),
        .package(url: "https://github.com/kishikawakatsumi/KeychainAccess.git", from: "4.2.2"),
    ],
    targets: [
        .target(
            name: "TalariaKit",
            dependencies: [
                .product(name: "LDSwiftEventSource", package: "swift-eventsource"),
                .product(name: "KeychainAccess", package: "KeychainAccess"),
            ],
            swiftSettings: [.enableExperimentalFeature("StrictConcurrency=targeted")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
