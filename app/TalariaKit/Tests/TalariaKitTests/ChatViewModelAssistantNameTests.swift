import XCTest
@testable import TalariaKit

/// The run status chip names the agent from the session's `assistant_name` (TAL-458).
final class ChatViewModelAssistantNameTests: APIClientTestCase {
    @MainActor
    func testLoadedSessionNamesTheAgentAndADetailWithoutTheFieldKeepsIt() async throws {
        var assistantName: String? = "Maude"
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            guard request.url?.path == "/api/session" else {
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
            let field = assistantName.map { #", "assistant_name": "\#($0)""# } ?? ""
            return apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "messages": []\#(field)}}"#, for: request)
        }

        // Before any detail arrives (or from a server that predates the field) the chip says Hermes.
        XCTAssertEqual(viewModel.assistantName, "Hermes")
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.assistantName, "Maude")

        assistantName = nil
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.assistantName, "Maude")
    }
}
