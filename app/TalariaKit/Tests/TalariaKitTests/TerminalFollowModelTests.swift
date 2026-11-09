import Foundation
@testable import TalariaKit
import XCTest

/// TAL-1997: the read-only terminal view a `terminal_open` card opens, from the shared contract fixture.
@MainActor
final class TerminalFollowModelTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Read: Decodable { let afterEventId: Int; let result: JSONValue }
        let ref: JSONValue
        let reads: [Read]
    }

    private static func fixture() throws -> Fixture {
        try DecisionReview.decoder.decode(Fixture.self, from: sharedContractFixture("terminal-view"))
    }

    private static func json(_ value: JSONValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }

    /// A model whose reads the handler answers, recording each read's `after_event_id`.
    private func model(stream: SSEStreamingClient, reads: LockedTestValue<[Int]>, answer: @escaping @Sendable (Int, DeferredMockURLProtocol) -> Void) throws -> TerminalFollowModel {
        let host = "terminal-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest({ request in
            let url = try! XCTUnwrap(request.request.url)
            XCTAssertEqual(url.path, "/api/terminal/read")
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(query.first { $0.name == "session_id" }?.value, "synthetic-session")
            XCTAssertEqual(query.first { $0.name == "terminal_id" }?.value, "term_0a1b2c3d4e5f6071")
            let after = Int(query.first { $0.name == "after_event_id" }?.value ?? "") ?? -1
            reads.value.append(after)
            answer(after, request)
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config))
        let reference = TerminalRef(terminalId: "term_0a1b2c3d4e5f6071", title: "Run the tests", command: "npm test")
        return TerminalFollowModel(sessionID: "synthetic-session", reference: reference, client: client, stream: stream)
    }

    func testATerminalOpenResultCarriesTheTerminalItsCardOpens() throws {
        let view = try JSONDecoder().decode(ToolResultView.self, from: Data("{\"terminal\":\(try Self.json(Self.fixture().ref))}".utf8))
        XCTAssertEqual(view.terminal, TerminalRef(terminalId: "term_0a1b2c3d4e5f6071", title: "Run the tests", command: "npm test"))
    }

    func testTheViewReadsFromTheStartThenFromItsCursorOnEachOutputEventUntilTheShellExits() async throws {
        let fixture = try Self.fixture()
        let bodies = try Dictionary(uniqueKeysWithValues: fixture.reads.map { ($0.afterEventId, try Self.json($0.result)) })
        let stream = ScriptedSSEStreamingClient(connectionScripts: [[.init(.ignored, lastEventID: "3"), .init(.heartbeat), .init(.ignored, lastEventID: "4")]])
        let reads = LockedTestValue<[Int]>([])
        let model = try model(stream: stream, reads: reads) { after, request in request.complete(withJSON: bodies[after] ?? "{}") }

        await model.start()
        XCTAssertEqual(model.lines, ["npm test", "> vitest run", " 40%"])
        XCTAssertTrue(model.running)
        XCTAssertEqual(stream.startedURLs.map(\.path), ["/api/terminal/output"])
        XCTAssertEqual(stream.startedURLs.first?.query, "session_id=synthetic-session")

        stream.playArmedConnectionScript()
        try await waitUntil { await MainActor.run { !model.running } }
        // The server restated ` 40%` as it now reads, so it is replaced rather than kept beside its rewrite.
        XCTAssertEqual(model.lines, ["npm test", "> vitest run", "100% done", "PASS"])
        XCTAssertEqual(model.exitCode, 0)
        XCTAssertEqual(reads.value, [0, 2, 3])
        XCTAssertGreaterThan(stream.stopCount, 0, "Following stops once the shell exited")
    }

    func testATerminalTheServerNoLongerHasStopsFollowing() async throws {
        let stream = ScriptedSSEStreamingClient()
        let reads = LockedTestValue<[Int]>([])
        let model = try model(stream: stream, reads: reads) { _, request in
            request.complete(withJSON: #"{"error":"terminal_not_found","message":"This terminal is no longer available."}"#, statusCode: 404)
        }

        await model.start()
        XCTAssertTrue(model.gone)
        XCTAssertNil(model.lastError)
        XCTAssertTrue(stream.startedURLs.isEmpty)
    }
}
