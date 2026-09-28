// swift-tools-version: 6.0
// The App's logic that needs no app host: models, networking, persistence, sync, and the view models and presentation
// logic behind every screen. The App and its extensions link TalariaKit; its tests run with `swift test` on macOS,
// without a simulator (TAL-399).
import PackageDescription

// The App target's language settings: Swift 5 mode, targeted concurrency checking, regex literals.
let settings: [SwiftSetting] = [
    .enableExperimentalFeature("StrictConcurrency=targeted"),
    .enableUpcomingFeature("BareSlashRegexLiterals"),
]

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
        .package(url: "https://github.com/JohnSundell/Splash.git", from: "0.16.0"),
        .package(url: "https://github.com/raspu/Highlightr.git", from: "2.3.0"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", from: "2.4.1"),
    ],
    targets: [
        .target(
            name: "TalariaKit",
            dependencies: [
                .product(name: "LDSwiftEventSource", package: "swift-eventsource"),
                .product(name: "KeychainAccess", package: "KeychainAccess"),
                .product(name: "Splash", package: "Splash"),
                .product(name: "Highlightr", package: "Highlightr"),
            ],
            swiftSettings: settings
        ),
        .testTarget(
            name: "TalariaKitTests",
            dependencies: [
                "TalariaKit",
                // The streaming-fade tests render through MarkdownUI, as the App's transcript does.
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ],
            swiftSettings: settings
        ),
    ],
    swiftLanguageModes: [.v5]
)
