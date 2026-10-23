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
        let working = try XCTUnwrap(SessionRunMonitor.runStatus(for: running, isStopping: false))
        XCTAssertEqual(working.label(agentName: "Hermes"), "Working")
        XCTAssertEqual(working.elapsedTime(now: now, locale: Locale(identifier: "en_US")), "2m")
        XCTAssertFalse(working.isAwaitingUser)

        let stopping = try XCTUnwrap(SessionRunMonitor.runStatus(for: running, isStopping: true))
        XCTAssertEqual(stopping.label(agentName: "Hermes"), "Stopping response")

        let approval = try XCTUnwrap(SessionRunMonitor.runStatus(for: waiting, isStopping: false))
        XCTAssertEqual(approval.label(agentName: "Hermes"), "Needs approval")
        XCTAssertTrue(approval.isAwaitingUser)
        let question = SessionSummary(sessionId: "q", attention: SessionAttention(kind: .clarify))
        XCTAssertEqual(SessionRunMonitor.runStatus(for: question, isStopping: false)?.label(agentName: "Hermes"), "Has a question")

        XCTAssertNil(SessionRunMonitor.runStatus(for: idle, isStopping: false))
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

    func testStopShowsStoppingAtOnceAndConvergesOnTheServersRows() async throws {
        var cancelled = false
        var cancelURL: URL?
        let release = DispatchSemaphore(value: 0)
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            switch request.url?.path {
            case "/api/chat/cancel":
                cancelURL = request.url
                release.wait()
                cancelled = true
                return apiTestJSONResponse(#"{"ok": true, "cancelled": true}"#, for: request)
            default:
                let row = cancelled
                    ? #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": false}"#
                    : #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": true, "active_stream_id": "stream-running"}"#
                return apiTestJSONResponse(#"{"sessions": [\#(row)]}"#, for: request)
            }
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        let stop = Task { await viewModel.stopRun(session) }
        try await waitFor { cancelURL != nil }
        XCTAssertTrue(viewModel.isStopping(session), "The card must read Stopping before the server answers")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(cancelURL), resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "stream-running")
        release.signal()
        await stop.value

        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false)
        XCTAssertTrue(viewModel.stoppingStreamIDs.isEmpty)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    func testARefusedStopRollsBackWithTheServersError() async throws {
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            request.url?.path == "/api/chat/cancel"
                ? apiTestJSONResponse(#"{"ok": false, "error": "Run already finished elsewhere"}"#, for: request)
                : apiTestJSONResponse(#"{"sessions": [{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": true, "active_stream_id": "stream-running"}]}"#, for: request)
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        await viewModel.stopRun(session)

        XCTAssertFalse(viewModel.isStopping(session))
        XCTAssertEqual(viewModel.actionErrorMessage, "Run already finished elsewhere")
    }

    func testAStopWithAnUnknownOutcomeKeepsStoppingOnlyIfTheServerStoppedTheRun() async throws {
        var listsStream = true
        let viewModel = SessionListViewModel(server: URL(string: "https://example.test")!, client: makeClient { request in
            if request.url?.path == "/api/chat/cancel" { throw URLError(.networkConnectionLost) }
            let row = listsStream
                ? #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": true, "active_stream_id": "stream-running"}"#
                : #"{"session_id": "running", "title": "Run", "message_count": 2, "is_streaming": false}"#
            return apiTestJSONResponse(#"{"sessions": [\#(row)]}"#, for: request)
        })
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)

        await viewModel.stopRun(session)
        XCTAssertFalse(viewModel.isStopping(session), "A run the server still lists as live rolls back")
        XCTAssertNotNil(viewModel.actionErrorMessage)

        listsStream = false
        await viewModel.stopRun(session)
        XCTAssertEqual(viewModel.sessions.first?.isStreaming, false, "A run the server stopped stays stopped")
        XCTAssertTrue(viewModel.stoppingStreamIDs.isEmpty)
    }

    private func waitFor(_ condition: () -> Bool, timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
