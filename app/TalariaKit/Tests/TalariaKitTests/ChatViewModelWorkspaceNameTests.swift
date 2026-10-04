import XCTest
@testable import TalariaKit

/// The toolbar and composer name the workspace from the server's `workspace_name` (TAL-303).
final class ChatViewModelWorkspaceNameTests: APIClientTestCase {
    @MainActor
    func testTheServerNameLabelsTheWorkspaceAndFollowsAChange() async throws {
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(
                    #"{"session": {"session_id": "session-abc", "workspace": "/tmp/workspace", "workspace_name": "Talaria", "messages": []}}"#,
                    for: request
                )
            case "/api/session/update":
                return apiTestJSONResponse(
                    #"{"session": {"session_id": "session-abc", "workspace": "/src/scratch", "workspace_name": "Scratch"}}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        // The opening row came from a server without the field: no label, never the folder name.
        XCTAssertEqual(viewModel.selectedWorkspacePath, "/tmp/workspace")
        XCTAssertNil(viewModel.selectedWorkspaceName)

        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.selectedWorkspaceName, "Talaria")

        let changed = await viewModel.selectWorkspacePath("/src/scratch")
        XCTAssertTrue(changed)
        XCTAssertEqual(viewModel.selectedWorkspaceName, "Scratch")
    }
}
