import XCTest
@testable import TalariaKit

/// The Duo tent pose's run monitor (TAL-1460): when the Chats list shows run cards, what each card says, and its Stop.
@MainActor
final class SessionRunMonitorTests: APIClientTestCase {
    private let running = SessionSummary(sessionId: "running", activeStreamId: "stream-running", isStreaming: true, pendingStartedAt: 1_000)
    private let idle = SessionSummary(sessionId: "idle", isStreaming: false)
    private let waiting = SessionSummary(sessionId: "waiting", isStreaming: true, attention: SessionAttention(kind: .approval, count: 1))

    func testTheMonitorShowsOnlyForCompactCompactPartlyOpenHingeAndAnActiveSession() {
        let hinges: [SessionRunMonitor.HingeStatus?] = [nil, .closed, .partiallyOpen, .fullyOpen]
        for horizontal in [true, false] {
            for vertical in [true, false] {
                for hinge in hinges {
                    for sessions in [[idle], [idle, running], [waiting], []] {
                        let expected = horizontal && vertical && hinge == .partiallyOpen && sessions != [idle] && !sessions.isEmpty
                        XCTAssertEqual(
                            SessionRunMonitor.isActive(
                                horizontalSizeClassIsCompact: horizontal,
                                verticalSizeClassIsCompact: vertical,
                                hinge: hinge,
                                sessions: sessions
                            ),
                            expected,
                            "horizontal compact \(horizontal), vertical compact \(vertical), hinge \(String(describing: hinge)), sessions \(sessions.map(\.id))"
                        )
                    }
                }
            }
        }
    }

    func testACardReadsTheRunOrWhatWaitsOnTheUser() throws {
        let now = Date(timeIntervalSince1970: 1_125)
        let working = try XCTUnwrap(SessionRunMonitor.runStatus(for: running))
        XCTAssertEqual(working.label(agentName: "Hermes"), "Working")
        XCTAssertEqual(working.elapsedTime(now: now, locale: Locale(identifier: "en_US")), "2m")
        XCTAssertFalse(working.isAwaitingUser)

        let approval = try XCTUnwrap(SessionRunMonitor.runStatus(for: waiting))
        XCTAssertEqual(approval.label(agentName: "Hermes"), "Needs approval")
        XCTAssertTrue(approval.isAwaitingUser)
        let question = SessionSummary(sessionId: "q", attention: SessionAttention(kind: .clarify))
        XCTAssertEqual(SessionRunMonitor.runStatus(for: question)?.label(agentName: "Hermes"), "Has a question")

        XCTAssertNil(SessionRunMonitor.runStatus(for: idle))
    }

    func testTheRowDecodesTheServersAttention() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func row(_ attention: String) throws -> SessionSummary {
            try decoder.decode(SessionSummary.self, from: Data(#"{"session_id": "s", "is_streaming": true, "attention": \#(attention)}"#.utf8))
        }
        XCTAssertEqual(try row(#"{"kind": "approval", "count": 2, "severity": "critical"}"#).attention, SessionAttention(kind: .approval, count: 2))
        XCTAssertEqual(try row(#"{"kind": "clarify", "count": 1}"#).attention?.kind, .clarify)
        XCTAssertEqual(try row(#"{"kind": "future_kind"}"#).attention?.kind, .other)
        XCTAssertNil(try row("null").attention)
        XCTAssertNil(try row(#""unexpected""#).attention)
    }

    func testStopShowsTheRunStoppedAtOnceAndKeepsItStoppedUntilTheServerAgrees() async throws {
        var listsStream = true
        var cancelURL: URL?
        let release = DispatchSemaphore(value: 0)
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            switch request.url?.path {
            case "/api/chat/cancel":
                cancelURL = request.url
                release.wait()
                return apiTestJSONResponse(#"{"ok": true, "cancelled": true}"#, for: request)
            default:
                return apiTestJSONResponse(#"{"sessions": [\#(Self.row(streaming: listsStream))]}"#, for: request)
            }
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        let stop = Task { await viewModel.stopRun(session) }
        try await waitFor { cancelURL != nil }
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false, "The row must show the run stopped before the server answers")
        XCTAssertNil(SessionRunMonitor.runStatus(for: try XCTUnwrap(viewModel.sessions.first)))
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(cancelURL), resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "stream-running")
        release.signal()
        await stop.value

        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false, "A reload that still lists the stopped run live keeps it stopped")
        XCTAssertNil(viewModel.actionErrorMessage)

        listsStream = false
        _ = await viewModel.load()
        XCTAssertTrue(viewModel.stoppedStreamIDs.isEmpty, "The stop is confirmed once the server lists the run idle")
        listsStream = true
        _ = await viewModel.load()
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, true, "A later run on the same stream is the server's again")
    }

    func testARefusedStopRollsBackWithTheServersError() async throws {
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            request.url?.path == "/api/chat/cancel"
                ? apiTestJSONResponse(#"{"ok": false, "error": "Run already finished elsewhere"}"#, for: request)
                : apiTestJSONResponse(#"{"sessions": [\#(Self.row(streaming: true))]}"#, for: request)
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        await viewModel.stopRun(session)

        XCTAssertEqual(viewModel.sessions.first?.isStreaming, true)
        XCTAssertTrue(viewModel.stoppedStreamIDs.isEmpty)
        XCTAssertEqual(viewModel.actionErrorMessage, "Run already finished elsewhere")
    }

    func testAStopWithAnUnknownOutcomeStaysStoppedOnlyIfTheServerStoppedTheRun() async throws {
        var listsStream = true
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            if request.url?.path == "/api/chat/cancel" { throw URLError(.networkConnectionLost) }
            return apiTestJSONResponse(#"{"sessions": [\#(Self.row(streaming: listsStream))]}"#, for: request)
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        await viewModel.stopRun(session)
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, true, "A run the server still lists as live rolls back")
        XCTAssertNotNil(viewModel.actionErrorMessage)

        listsStream = false
        await viewModel.stopRun(session)
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false, "A run the server stopped stays stopped")
        XCTAssertTrue(viewModel.stoppedStreamIDs.isEmpty)
    }

    private static func row(streaming: Bool) -> String {
        streaming
            ? #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": true, "active_stream_id": "stream-running"}"#
            : #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": false}"#
    }

    private func waitFor(_ condition: () -> Bool, timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
