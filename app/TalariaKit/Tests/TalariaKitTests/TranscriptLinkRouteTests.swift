import XCTest
@testable import TalariaKit

/// Web links open in the in-app Safari sheet, workspace files in the source
/// viewer, and every other scheme goes to the system (TAL-442).
final class TranscriptLinkRouteTests: XCTestCase {
    private let root = "/Users/hermes/projects/app"

    private func route(_ destination: String) throws -> TranscriptLinkRoute {
        TranscriptLinkRoute.route(try XCTUnwrap(URL(string: destination)), workspaceRoot: root)
    }

    func testWebLinksOpenInTheInAppBrowser() throws {
        for destination in ["https://example.invalid/page?q=1#top", "http://example.invalid", "HTTPS://Example.invalid/Caps"] {
            let url = try XCTUnwrap(URL(string: destination))
            XCTAssertEqual(try route(destination), .inAppBrowser(url), destination)
        }
    }

    func testOtherSchemesKeepTheSystemBehaviour() throws {
        for destination in ["mailto:fixture@example.invalid", "tel:+15550100", "talaria://session/fixture", "ftp://example.invalid/file", "docs/readme", "https:///no-host"] {
            XCTAssertEqual(try route(destination), .system, destination)
        }
    }

    func testWorkspaceFileLinksOpenTheSourceViewer() throws {
        XCTAssertEqual(
            try route("file:///Users/hermes/projects/app/Sources/Main.swift:5"),
            .workspaceFile(WorkspaceFileLink(path: "Sources/Main.swift", line: 5))
        )
        XCTAssertEqual(
            try route("./README.md#L8"),
            .workspaceFile(WorkspaceFileLink(path: "README.md", line: 8))
        )
    }

    func testFileLinksOutsideTheWorkspaceKeepTheSystemBehaviour() throws {
        XCTAssertEqual(try route("file:///etc/hosts"), .system)
    }

    /// The chat installs one link action for good; a tap must still reach the handler from its latest pass (TAL-852).
    @MainActor
    func testTheInstalledLinkActionRunsTheLatestHandler() throws {
        let router = TranscriptLinkRouter()
        let installed = router.action
        var opened: [String] = []
        router.handler = { _ in opened.append("first"); return .handled }
        router.handler = { url in opened.append(url.absoluteString); return .handled }

        installed(try XCTUnwrap(URL(string: "https://example.invalid/latest")))

        XCTAssertEqual(opened, ["https://example.invalid/latest"])
    }
}
