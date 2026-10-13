import XCTest
@testable import TalariaKit

/// The strip's toolsets control shows and sets the session's server-side toolset override (TAL-631).
final class ChatViewModelSessionToolsetsTests: APIClientTestCase {
    func testCatalog404PreservesLegacyEditing() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"error":"not found"}"#, statusCode: 404, for: request)
        }
        do {
            let catalog = try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: ["file"])
            XCTAssertNil(catalog, "An unsupported catalog must select the legacy editor")
        } catch {
            XCTFail("An unsupported catalog must select the legacy editor, not fail: \(error)")
        }
    }

    func testCatalogAuthServerAndSessionFailuresNeverSelectLegacyEditing() async throws {
        for status in [401, 403, 404, 500, 503] {
            let client = makeClient { request in
                apiTestJSONResponse(#"{"error":"Session not found"}"#, statusCode: status, for: request)
            }
            do {
                _ = try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil)
                XCTFail("HTTP \(status) must stay an error")
            } catch { /* Expected: only a missing endpoint permits compatibility editing. */ }
        }
    }

    func testMalformedCatalogNeverSelectsLegacyEditing() async throws {
        let client = makeClient { request in apiTestJSONResponse("null", for: request) }
        do {
            _ = try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil)
            XCTFail("Malformed success responses must stay an error")
        } catch { /* Expected decoding failure, not unsupported endpoint. */ }
    }

    func testCatalogRequestPreservesProfileDefaults() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/toolsets")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try apiTestJSONBody(from: request)
            XCTAssertEqual(body["session_id"] as? String, "session-abc")
            XCTAssertTrue(body["toolsets"] is NSNull)
            return apiTestJSONResponse(#"{"toolsets":[{"name":"todo","available":false,"selected":false,"unavailable_reason":"disabled"}],"selected_toolsets":["file"],"using_defaults":true}"#, for: request)
        }
        let response = try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil)
        let catalog = try XCTUnwrap(response)
        XCTAssertEqual(catalog.toolsets.first?.available, false)
        XCTAssertEqual(catalog.selectedToolsets, ["file"])
    }

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
