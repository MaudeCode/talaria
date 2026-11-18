import XCTest
@testable import TalariaKit

final class APIClientSessionExportTests: APIClientTestCase {
    // MARK: - Download

    func testExportSessionReturnsBytesAndHeaderDerivedFilename() async throws {
        let html = Data("<html><body>hi</body></html>".utf8)
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/session/export")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            // The response is a file download, so the export request must not
            // claim it only accepts JSON.
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Disposition": "attachment; filename=\"hermes-abc-123.html\""
                ]
            )!
            return (response, html)
        }

        let file = try await client.exportSession(id: "abc-123", format: .html, fallbackTitle: "Planning")

        XCTAssertEqual(file.data, html)
        XCTAssertEqual(file.filename, "hermes-abc-123.html")
    }

    func testExportSessionFallsBackToTitleWhenHeaderMissing() async throws {
        let json = Data("{}".utf8)
        let client = makeClient { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json; charset=utf-8"]
            )!
            return (response, json)
        }

        let file = try await client.exportSession(id: "abc-123", format: .json, fallbackTitle: "Planning notes")

        XCTAssertEqual(file.data, json)
        XCTAssertEqual(file.filename, "Planning notes.json")
    }

    // MARK: - Filename derivation

    func testFilenameParsesUnquotedToken() {
        let filename = SessionExportFile.filename(
            contentDisposition: "attachment; filename=export.json",
            fallbackTitle: nil,
            sessionID: "s1",
            format: .json
        )
        XCTAssertEqual(filename, "export.json")
    }

    func testFilenameStripsPathComponentsFromHeader() {
        let filename = SessionExportFile.filename(
            contentDisposition: "attachment; filename=\"../../etc/passwd\"",
            fallbackTitle: nil,
            sessionID: "s1",
            format: .html
        )
        // Only the last path component survives; traversal segments are gone.
        XCTAssertEqual(filename, "passwd")
    }

    func testFilenameSanitizesTitleFallback() {
        let filename = SessionExportFile.filename(
            contentDisposition: nil,
            fallbackTitle: "  Fix: build/CI \n pipeline  ",
            sessionID: "s1",
            format: .html
        )
        XCTAssertEqual(filename, "Fix build CI pipeline.html")
    }

    func testFilenameUsesSessionIDWhenTitleUnusable() {
        let filename = SessionExportFile.filename(
            contentDisposition: "inline",
            fallbackTitle: "   ",
            sessionID: "abc-123",
            format: .json
        )
        XCTAssertEqual(filename, "hermes-abc-123.json")
    }

    func testFilenameTruncatesVeryLongTitles() {
        let longTitle = String(repeating: "a", count: 200)
        let filename = SessionExportFile.filename(
            contentDisposition: nil,
            fallbackTitle: longTitle,
            sessionID: "s1",
            format: .json
        )
        XCTAssertEqual(filename, String(repeating: "a", count: 80) + ".json")
    }
}
