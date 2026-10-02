import XCTest
@testable import TalariaKit

// TAL-437: a chat's composer shows the last profile, model, workspace and command choices
// before its configuration loads.
@MainActor
extension ChatViewModelSendTests {
    func testComposerShowsTheLastCatalogsBeforeTheyLoad() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let cache = ResponseCache(server: try XCTUnwrap(URL(string: "https://example.test")), root: root)
        let firstChat = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5", modelProvider: "openai", profile: "work"),
            responseCache: cache
        ) { request in
            switch request.url?.path {
            case "/api/profiles":
                return apiTestJSONResponse(#"{"active": "work", "profiles": [{"name": "work"}]}"#, for: request)
            case "/api/models":
                return apiTestJSONResponse(
                    #"{"groups": [{"name": "OpenAI", "provider_id": "openai", "models": [{"id": "gpt-5", "name": "GPT-5"}]}]}"#,
                    for: request
                )
            case "/api/reasoning":
                return apiTestJSONResponse(#"{"reasoning_effort": "medium"}"#, for: request)
            case "/api/workspaces":
                return apiTestJSONResponse(#"{"workspaces": [{"path": "/repo", "name": "Repo"}]}"#, for: request)
            case "/api/commands":
                return apiTestJSONResponse(#"{"commands": [{"name": "compress", "description": "Compress"}]}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await firstChat.loadComposerConfiguration()

        let nextChat = try makeViewModel(
            sessionSummary: makeSession(model: "gpt-5", modelProvider: "openai", profile: "work"),
            responseCache: cache
        ) { request in
            XCTFail("Seeding must not request \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        XCTAssertEqual(nextChat.profileOptions.compactMap(\.name), ["work"])
        XCTAssertEqual(nextChat.selectedProfileName, "work")
        XCTAssertEqual(nextChat.modelCatalogGroups.flatMap(\.models).compactMap(\.id), ["gpt-5"])
        XCTAssertEqual(nextChat.workspaceRoots.compactMap(\.name), ["Repo"])
        XCTAssertEqual(nextChat.agentCommands.compactMap(\.name), ["compress"])
    }
}
