import XCTest
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    /// TAL-299: the ring shows the server's percent and nothing derived from raw token counters.
    func testLoadedSessionRingShowsOnlyTheServerPercent() async throws {
        let context = try makeContext()
        var body = #"{"session":{"session_id":"session-abc","title":"Planning","messages":[],"input_tokens":900000,"context_length":200000}}"#
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse(body, for: request)
        }
        func label() -> String { ContextWindowIndicatorPresentation(snapshot: viewModel.contextWindowSnapshot).percentageLabel }

        // A cumulative input total over a known window is not the ring's value: no percentage, never 450%.
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(label(), "–")

        body = #"{"session":{"session_id":"session-abc","title":"Planning","messages":[],"input_tokens":900000,"context_length":128000,"last_prompt_tokens":64000,"context_used_tokens":64000,"context_window_tokens":128000,"context_usage_percent":50}}"#
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(label(), "50")
    }
}
