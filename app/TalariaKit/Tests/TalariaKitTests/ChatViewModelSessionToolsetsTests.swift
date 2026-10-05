import XCTest
@testable import TalariaKit

/// The strip's toolsets control shows and sets the session's server-side toolset override (TAL-631).
final class ChatViewModelSessionToolsetsTests: APIClientTestCase {
    @MainActor
    func testToolsetsShowTheServerValueAndSavesRoundTripIncludingProfileDefaults() async throws {
        var savedBodies: [[String: Any]] = []
        var serverSaves = [#"["web","terminal"]"#, "null"]
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
                // The server normalizes the names (trims, drops blanks, empty means defaults).
                return apiTestJSONResponse(#"{"ok": true, "enabled_toolsets": \#(serverSaves.removeFirst())}"#, for: request)
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
        XCTAssertEqual(savedBodies.last?["toolsets"] as? [String], [" web", " terminal ", "", " "], "The input goes as typed")
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["web", "terminal"]), "The control shows what the server saved")

        let savedDefaults = await viewModel.saveSessionToolsets(nil)
        XCTAssertTrue(savedDefaults)
        XCTAssertTrue(savedBodies.last?["toolsets"] is NSNull, "Profile defaults go as an explicit null")
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: nil))
        XCTAssertEqual(viewModel.sessionToolsets?.title, "Profile defaults")

        failsNextSave = true
        let failed = await viewModel.saveSessionToolsets(["browser"])
        XCTAssertFalse(failed)
        XCTAssertEqual(savedBodies.count, 3)
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: nil), "A failed save keeps the old value")
        XCTAssertNotNil(viewModel.composerConfigurationErrorMessage)
        XCTAssertFalse(viewModel.isUpdatingComposerConfiguration)
    }

    @MainActor
    func testASaveWhileAnotherIsInFlightIsRefused() async throws {
        let firstSaveArrived = expectation(description: "first save reached the server")
        let releaseFirstSave = DispatchSemaphore(value: 0)
        var saves = 0
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "messages": [], "enabled_toolsets": null}}"#, for: request)
            case "/api/session/toolsets":
                saves += 1
                firstSaveArrived.fulfill()
                releaseFirstSave.wait()
                return apiTestJSONResponse(#"{"ok": true, "enabled_toolsets": ["web"]}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await viewModel.loadMessages()

        let first = Task { await viewModel.saveSessionToolsets(["web"]) }
        await fulfillment(of: [firstSaveArrived], timeout: 5)
        XCTAssertTrue(viewModel.isUpdatingComposerConfiguration, "The strip stays disabled while the save runs")
        let overlapping = await viewModel.saveSessionToolsets(["terminal"])
        XCTAssertFalse(overlapping, "A second save waits for the first to answer")
        releaseFirstSave.signal()
        let firstSaved = await first.value
        XCTAssertTrue(firstSaved)
        XCTAssertEqual(saves, 1)
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["web"]))
    }

    func testToolsetsTitleJoinsNamesAndNamesProfileDefaults() {
        XCTAssertEqual(SessionToolsets(names: ["web", "terminal"]).title, "web, terminal")
        XCTAssertEqual(SessionToolsets(names: []).title, "Profile defaults")
        XCTAssertEqual(SessionToolsets(names: nil).title, "Profile defaults")
    }
}
