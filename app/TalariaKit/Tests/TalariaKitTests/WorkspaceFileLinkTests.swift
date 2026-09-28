import XCTest
@testable import TalariaKit

/// Chat link destinations that name a workspace file, resolved to the
/// workspace-relative path and one-based line the source viewer opens (TAL-169).
final class WorkspaceFileLinkTests: XCTestCase {
    private let root = "/Users/hermes/projects/app"

    private func parse(_ destination: String, root: String? = nil) -> WorkspaceFileLink? {
        WorkspaceFileLink.parse(destination, workspaceRoot: root ?? self.root)
    }

    // MARK: - Accepted syntaxes

    func testFileURLWithLineAndColumnSuffixKeepsOnlyTheLine() {
        let link = parse("file:///Users/hermes/projects/app/Sources/ChatView.swift:12:3")
        XCTAssertEqual(link, WorkspaceFileLink(path: "Sources/ChatView.swift", line: 12))
        XCTAssertEqual(link?.name, "ChatView.swift")
    }

    func testFileURLAcceptsTheLocalhostAuthorityInAnyCase() {
        XCTAssertEqual(
            parse("file://LOCALHOST/Users/hermes/projects/app/Sources/Main.swift:5"),
            WorkspaceFileLink(path: "Sources/Main.swift", line: 5)
        )
        XCTAssertEqual(
            parse("file://localhost/Users/hermes/projects/app/Sources/Main.swift"),
            WorkspaceFileLink(path: "Sources/Main.swift", line: nil)
        )
    }

    func testFileURLWithGitHubStyleFragment() {
        XCTAssertEqual(
            parse("file:///Users/hermes/projects/app/README.md#L8C2"),
            WorkspaceFileLink(path: "README.md", line: 8)
        )
        XCTAssertEqual(
            parse("file:///Users/hermes/projects/app/README.md#l8"),
            WorkspaceFileLink(path: "README.md", line: 8)
        )
    }

    func testAbsolutePathUnderWorkspace() {
        XCTAssertEqual(
            parse("/Users/hermes/projects/app/Sources/Main.swift:40"),
            WorkspaceFileLink(path: "Sources/Main.swift", line: 40)
        )
        XCTAssertEqual(
            parse("/Users/hermes/projects/app/Sources/Main.swift"),
            WorkspaceFileLink(path: "Sources/Main.swift", line: nil)
        )
    }

    func testDotRelativePathsResolveFromTheWorkspaceRoot() {
        XCTAssertEqual(parse("./Package.swift"), WorkspaceFileLink(path: "Package.swift", line: nil))
        XCTAssertEqual(
            parse("./Sources/../Tests/AppTests.swift:2"),
            WorkspaceFileLink(path: "Tests/AppTests.swift", line: 2)
        )
        XCTAssertEqual(
            parse("../app/docs/guide.md"),
            WorkspaceFileLink(path: "docs/guide.md", line: nil)
        )
    }

    func testTildeExpandsToTheHomeTheWorkspaceSitsIn() {
        XCTAssertEqual(parse("~/projects/app/docs/guide.md"), WorkspaceFileLink(path: "docs/guide.md", line: nil))
        XCTAssertEqual(
            parse("~/app/main.py", root: "/home/hermes/app"),
            WorkspaceFileLink(path: "main.py", line: nil)
        )
    }

    func testPercentEncodedUnicodeAndQueryDestinations() {
        XCTAssertEqual(
            parse("./docs/release%20notes.md?x=1#L3"),
            WorkspaceFileLink(path: "docs/release notes.md", line: 3)
        )
        XCTAssertEqual(
            parse("file:///Users/hermes/projects/app/docs/%C3%BCbersicht.md:4"),
            WorkspaceFileLink(path: "docs/übersicht.md", line: 4)
        )
        XCTAssertEqual(
            parse("./src/日本語/メモ.txt:7"),
            WorkspaceFileLink(path: "src/日本語/メモ.txt", line: 7)
        )
    }

    func testFilesystemRootWorkspaceAcceptsAbsolutePaths() {
        XCTAssertEqual(parse("/etc/hosts:3", root: "/"), WorkspaceFileLink(path: "etc/hosts", line: 3))
        XCTAssertEqual(parse("./etc/hosts", root: "/"), WorkspaceFileLink(path: "etc/hosts", line: nil))
        XCTAssertNil(parse("/", root: "/"))
        XCTAssertNil(parse("~/hosts", root: "/"))
    }

    func testWorkspaceRootToleratesTrailingSlashAndWhitespace() {
        XCTAssertEqual(
            parse("./a.swift", root: " /Users/hermes/projects/app/ "),
            WorkspaceFileLink(path: "a.swift", line: nil)
        )
    }

    func testZeroLineIsDropped() {
        XCTAssertEqual(parse("./a.swift:0"), WorkspaceFileLink(path: "a.swift", line: nil))
        XCTAssertEqual(parse("./a.swift#L0"), WorkspaceFileLink(path: "a.swift", line: nil))
    }

    /// The transcript renderer builds a `URL` from the link destination and the
    /// chat handler reads back `absoluteString`, which percent-encodes and keeps
    /// positions and fragments; the parser must accept what comes out of that trip.
    func testSurvivesTheURLRoundTripTheTranscriptRendererApplies() throws {
        let cases: [(destination: String, expected: WorkspaceFileLink)] = [
            ("./docs/release%20notes.md:3", WorkspaceFileLink(path: "docs/release notes.md", line: 3)),
            ("~/projects/app/docs/guide.md#L4C2", WorkspaceFileLink(path: "docs/guide.md", line: 4)),
            ("/Users/hermes/projects/app/Sources/Main.swift:40:7", WorkspaceFileLink(path: "Sources/Main.swift", line: 40)),
            ("file:///Users/hermes/projects/app/a%20b.txt#L9", WorkspaceFileLink(path: "a b.txt", line: 9))
        ]
        for (destination, expected) in cases {
            let url = try XCTUnwrap(URL(string: destination), destination)
            XCTAssertEqual(WorkspaceFileLink.parse(url, workspaceRoot: root), expected, destination)
        }
    }

    // MARK: - Rejections

    func testRejectsLexicalTraversalOutOfTheWorkspace() {
        XCTAssertNil(parse("../secrets.env"))
        XCTAssertNil(parse("./src/../../other/file.swift"))
        XCTAssertNil(parse("file:///Users/hermes/projects/app/../app2/file.swift"))
        XCTAssertNil(parse("/Users/hermes/projects/app-other/file.swift"))
        XCTAssertNil(parse("~/other/file.swift"))
        XCTAssertNil(parse("/../../etc/passwd"))
    }

    func testRejectsTheWorkspaceItselfAndTheFilesystemRoot() {
        XCTAssertNil(parse("/Users/hermes/projects/app"))
        XCTAssertNil(parse("./"))
        XCTAssertNil(parse("/"))
        XCTAssertNil(parse("file:///"))
    }

    func testRejectsWebMailAndBareRelativeLinks() {
        XCTAssertNil(parse("https://example.invalid/Users/hermes/projects/app/a.swift"))
        XCTAssertNil(parse("http://example.invalid/a.swift:12"))
        XCTAssertNil(parse("mailto:hermes@example.invalid"))
        XCTAssertNil(parse("//example.com/docs", root: "/"))
        XCTAssertNil(parse("//Users/hermes/projects/app/a.swift"))
        XCTAssertNil(parse("//example.com/docs:12"))
        XCTAssertNil(parse("Sources/Main.swift:12"))
        XCTAssertNil(parse("README.md"))
        XCTAssertNil(parse(""))
    }

    func testRejectsMalformedFileURLs() {
        XCTAssertNil(parse("file:Sources/Main.swift"))
        XCTAssertNil(parse("file://host/Users/hermes/projects/app/a.swift"))
        XCTAssertNil(parse("file:"))
    }

    /// A position that does not parse is left on the path for the server to
    /// answer; it never turns into a guessed line.
    func testMalformedPositionsDegradeToThePathAlone() {
        XCTAssertEqual(parse("./a.swift:12:"), WorkspaceFileLink(path: "a.swift:12:", line: nil))
        XCTAssertEqual(parse("./a.swift:abc"), WorkspaceFileLink(path: "a.swift:abc", line: nil))
        XCTAssertEqual(parse("./a.swift#L"), WorkspaceFileLink(path: "a.swift", line: nil))
        XCTAssertEqual(parse("./a.swift#section"), WorkspaceFileLink(path: "a.swift", line: nil))
    }

    func testRejectsTildeWhenTheWorkspaceIsNotUnderAHome() {
        XCTAssertNil(parse("~/app/a.swift", root: "/srv/app"))
    }

    func testRejectsWithoutAWorkspaceRoot() {
        XCTAssertNil(parse("./a.swift", root: ""))
        XCTAssertNil(WorkspaceFileLink.parse("./a.swift", workspaceRoot: nil))
        XCTAssertNil(parse("./a.swift", root: "relative/root"))
    }
}

/// The lexical preflight cannot see symlinks, so the server's containment
/// answer for a link-derived path has to surface as the viewer's error state.
final class WorkspaceFileLinkPreviewTests: APIClientTestCase {
    @MainActor
    func testServerRejectedSymlinkEscapeBecomesTheViewerError() async throws {
        let link = try XCTUnwrap(WorkspaceFileLink.parse("./shared/escape.txt:3", workspaceRoot: "/tmp/workspace"))
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/file")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            XCTAssertEqual(components?.queryItems?.first(where: { $0.name == "path" })?.value, "shared/escape.txt")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 404,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"Path traversal blocked: shared/escape.txt"}"#.utf8))
        }
        let viewModel = try FilePreviewViewModel(
            session: makeFilePreviewSession(),
            server: XCTUnwrap(URL(string: "https://example.test")),
            path: link.path,
            apiClient: client
        )

        await viewModel.load()

        XCTAssertNil(viewModel.preview)
        XCTAssertNotNil(viewModel.errorMessage)
        guard case let .http(statusCode, _)? = viewModel.lastError as? APIError else {
            return XCTFail("Expected the server's rejection to be kept: \(String(describing: viewModel.lastError))")
        }
        XCTAssertEqual(statusCode, 404)
    }

    @MainActor
    func testDeniedReadKeepsTheServerRefusal() async throws {
        let client = makeClient { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 403,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"forbidden"}"#.utf8))
        }
        let viewModel = try FilePreviewViewModel(
            session: makeFilePreviewSession(),
            server: XCTUnwrap(URL(string: "https://example.test")),
            path: "private/notes.txt",
            apiClient: client
        )

        await viewModel.load()

        XCTAssertNil(viewModel.preview)
        XCTAssertEqual(viewModel.errorMessage, viewModel.lastError?.localizedDescription)
        XCTAssertTrue(viewModel.errorMessage?.contains("forbidden") == true)
    }
}
