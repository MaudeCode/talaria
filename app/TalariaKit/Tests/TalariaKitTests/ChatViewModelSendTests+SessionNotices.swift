import XCTest
@testable import TalariaKit

/// TAL-831: the chat shows the Agent's notices the server keeps for the session, until the server clears them.
@MainActor
extension ChatViewModelSendTests {
    func testTheServersNoticesShowUntilTheServerClearsThem() async throws {
        let streamClient = SpySSEStreamingClient()
        let warning = SessionNotice(key: "startup-warning.1", level: .warn, text: "Memory provider 'honcho' could not be loaded; memory is off.")
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path ?? "" {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/session":
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","messages":[],"notices":[{"key":"startup-warning.1","level":"warn","text":"Memory provider 'honcho' could not be loaded; memory is off.","expires_at":null}]}}"#, for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
        await viewModel.loadMessages(modelContext: try makeContext())
        XCTAssertEqual(viewModel.sessionNotices, [warning])

        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        let band = SessionNotice(key: "credits.usage_band", level: .info, text: "You've used 90% of your credits.")
        streamClient.emit(.notices(SessionNoticesEvent(sessionId: "session-abc", notices: [warning, band])))
        XCTAssertEqual(viewModel.sessionNotices, [warning, band])
        // Another chat's list never shows here.
        streamClient.emit(.notices(SessionNoticesEvent(sessionId: "session-other", notices: [])))
        XCTAssertEqual(viewModel.sessionNotices, [warning, band])

        streamClient.emit(.notices(SessionNoticesEvent(sessionId: "session-abc", notices: [band])))
        XCTAssertEqual(viewModel.sessionNotices, [band])
        streamClient.emit(.notices(SessionNoticesEvent(sessionId: "session-abc", notices: [])))
        XCTAssertTrue(viewModel.sessionNotices.isEmpty)
    }
}
