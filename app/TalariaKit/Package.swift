// swift-tools-version: 6.2
// The App's logic that needs no app host: models, networking, persistence, sync, and the view models and presentation
// logic behind every screen. The App and its extensions link TalariaKit; its tests run with `swift test` on macOS,
// without a simulator (TAL-399).
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
            // The package's own sources build warning-free; dependencies keep their warnings (TAL-1685).
            swiftSettings: [.treatAllWarnings(as: .error)]
        ),
        .testTarget(
            name: "TalariaKitTests",
            dependencies: [
                "TalariaKit",
                // The streaming-fade tests render through MarkdownUI, as the App's transcript does.
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ],
            // Stub URL handlers are closures formed in main-actor tests that run on URLSession's thread, and many block
            // it on a semaphore, so Swift 6's runtime isolation trap can't apply to them. Static checking still does,
            // and the production module keeps the trap. The hosted TalariaTests target sets the same flag.
            swiftSettings: [.unsafeFlags(["-Xfrontend", "-disable-actor-data-race-checks", "-Xfrontend", "-disable-dynamic-actor-isolation"])]
        ),
    ],
    swiftLanguageModes: [.v6]
)
