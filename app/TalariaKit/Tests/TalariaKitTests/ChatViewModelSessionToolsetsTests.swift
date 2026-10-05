import XCTest
@testable import TalariaKit

/// The strip's toolsets control shows and sets the session's server-side toolset override (TAL-631).
final class ChatViewModelSessionToolsetsTests: APIClientTestCase {
    @MainActor
    func testToolsetsShowTheServerValueAndSavesRoundTripIncludingProfileDefaults() async throws {
        var savedBodies: [[String: Any]] = []
        var failsNextSave = false
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(
                    #"{"session": {"session_id": "session-abc", "messages": [], "enabled_toolsets": ["web"]}}"#,
                    for: request
                )
            case "/api/session/toolsets":
                let body = try apiTestJSONBody(from: request)
                savedBodies.append(body)
                if failsNextSave {
                    return apiTestJSONResponse(#"{"error": "toolsets unavailable"}"#, statusCode: 500, for: request)
                }
                let saved = body["toolsets"] as? [String]
                let json = saved.map { #"[\#($0.map { "\"\($0)\"" }.joined(separator: ","))]"# } ?? "null"
                return apiTestJSONResponse(#"{"ok": true, "enabled_toolsets": \#(json)}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        XCTAssertNil(viewModel.sessionToolsets)
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["web"]))

        let savedList = await viewModel.saveSessionToolsets(SessionToolsets.names(fromInput: " web, terminal ,, "))
        XCTAssertTrue(savedList)
        XCTAssertEqual(savedBodies.last?["session_id"] as? String, "session-abc")
        XCTAssertEqual(savedBodies.last?["toolsets"] as? [String], ["web", "terminal"])
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["web", "terminal"]))

        let savedDefaults = await viewModel.saveSessionToolsets(SessionToolsets.names(fromInput: " , "))
        XCTAssertTrue(savedDefaults)
        XCTAssertTrue(savedBodies.last?["toolsets"] is NSNull, "Profile defaults go as an explicit null")
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: nil))
        XCTAssertEqual(viewModel.sessionToolsets?.title, "Profile defaults")

        failsNextSave = true
        let failed = await viewModel.saveSessionToolsets(["browser"])
        XCTAssertFalse(failed)
        XCTAssertEqual(savedBodies.count, 3)
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: nil), "A failed save keeps the old value")
        XCTAssertNotNil(viewModel.sendErrorMessage)
    }

    func testToolsetsTitleJoinsNamesAndNamesProfileDefaults() {
        XCTAssertEqual(SessionToolsets(names: ["web", "terminal"]).title, "web, terminal")
        XCTAssertEqual(SessionToolsets(names: []).title, "Profile defaults")
        XCTAssertEqual(SessionToolsets(names: nil).title, "Profile defaults")
    }
}
