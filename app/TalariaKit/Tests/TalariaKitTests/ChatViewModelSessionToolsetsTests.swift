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
            XCTAssertEqual(body["q"] as? String, " files ")
            return apiTestJSONResponse(#"{"toolsets":[{"name":"todo","available":false,"selected":false,"unavailable_reason":"disabled"}],"selected_toolsets":["file"],"using_defaults":true}"#, for: request)
        }
        let response = try await client.fetchToolsetsCatalog(sessionID: "session-abc", toolsets: nil, query: " files ")
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
                    return apiTestJSONResponse(#"{"error": "toolsets unavailable"}"#, statusCode: 403, for: request)
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
    func testRapidToolsetWritesStayOptimisticAndReachTheServerInTapOrder() async throws {
        let firstSaveArrived = expectation(description: "first save reached the server")
        let releaseFirstSave = DispatchSemaphore(value: 0)
        var saves = 0
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(#"{"session": {"session_id": "session-abc", "messages": [], "enabled_toolsets": null}}"#, for: request)
            case "/api/session/toolsets":
                saves += 1
                if saves == 1 {
                    firstSaveArrived.fulfill()
                    releaseFirstSave.wait()
                    return apiTestJSONResponse(#"{"ok": true, "enabled_toolsets": ["web"]}"#, for: request)
                }
                return apiTestJSONResponse(#"{"ok": true, "enabled_toolsets": ["terminal"]}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await viewModel.loadMessages()

        let first = Task { await viewModel.saveSessionToolsets(["web"]) }
        await fulfillment(of: [firstSaveArrived], timeout: 5)
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["web"]), "The control updates before the server answers")
        let second = Task { await viewModel.saveSessionToolsets(["terminal"]) }
        try await waitUntil { await MainActor.run { viewModel.sessionToolsets?.names == ["terminal"] } }
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["terminal"]))
        XCTAssertEqual(saves, 1, "The writes are serialized without disabling the next choice")
        releaseFirstSave.signal()
        let firstSaved = await first.value
        XCTAssertTrue(firstSaved)
        let secondSaved = await second.value
        XCTAssertTrue(secondSaved)
        XCTAssertEqual(saves, 2)
        XCTAssertEqual(viewModel.sessionToolsets, SessionToolsets(names: ["terminal"]))
    }

    @MainActor
    func testUncertainToolsetWriteReadsTheSessionWithoutReplaying() async throws {
        for (readFails, recoveredSelection) in [(false, "terminal"), (true, "browser"), (true, "web")] {
            var writes = 0
            var reads = 0
            var starts = 0
            var offline = readFails
            let model = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
                switch request.url?.path {
                case "/api/session":
                    reads += 1
                    if offline && writes > 0 { throw URLError(.notConnectedToInternet) }
                    let confirmed = recoveredSelection
                    return apiTestJSONResponse(writes > 0
                        ? "{\"session\":{\"session_id\":\"session-abc\",\"messages\":[],\"enabled_toolsets\":[\"\(confirmed)\"]}}"
                        : #"{"session":{"session_id":"session-abc","messages":[],"enabled_toolsets":["web"]}}"#, for: request)
                case "/api/session/toolsets":
                    writes += 1
                    return apiTestJSONResponse(#"{"error":"response lost"}"#, statusCode: 500, for: request)
                case "/api/chat/start":
                    starts += 1
                    return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"reconciled-toolsets"}"#, for: request)
                default:
                    throw URLError(.badURL)
                }
            }
            defer {
                model.cleanupPollingTasks()
                model.suspendStreamForNavigation()
                ChatViewModel.resetActiveStreamSnapshotsForTesting()
            }
            await model.loadMessages()
            let saved = await model.saveSessionToolsets(["browser"])
            XCTAssertFalse(saved)
            XCTAssertEqual(writes, 1)
            XCTAssertEqual(reads, 2, "A 5xx has an unknown outcome and requires a read")
            XCTAssertEqual(model.sessionToolsets?.names, readFails ? ["browser"] : ["terminal"], "A successful read decides the result; a failed read retains the optimistic choice")
            XCTAssertNotNil(model.composerConfigurationErrorMessage)
            if readFails {
                let sentWithoutConfirmation = await model.sendMessage("Use only the chosen tools")
                XCTAssertFalse(sentWithoutConfirmation, "An unconfirmed toolset write must not start a turn")
                XCTAssertEqual(starts, 0, "The server may still have the broader toolset selection")
                offline = false
                let sentAfterReadback = await model.sendMessage("Use the confirmed tools")
                XCTAssertEqual(sentAfterReadback, recoveredSelection == "browser")
                XCTAssertEqual(starts, recoveredSelection == "browser" ? 1 : 0)
                if recoveredSelection != "browser" {
                    XCTAssertEqual(model.sessionToolsets?.names, [recoveredSelection], "Show the actual selection before allowing a retry")
                    let sentAfterRollback = await model.sendMessage("Use the displayed selection")
                    XCTAssertTrue(sentAfterRollback)
                    XCTAssertEqual(starts, 1)
                }
                XCTAssertEqual(writes, 1, "Recovery must read, never replay the uncertain write")
                XCTAssertGreaterThanOrEqual(reads, 4, "Each send must reconcile the unresolved selection first")
            }
        }
    }

    func testToolsetsTitleCountsNamesAndNamesProfileDefaults() {
        XCTAssertEqual(SessionToolsets(names: ["web", "terminal"]).title, "2 toolsets")
        XCTAssertEqual(SessionToolsets(names: ["web", "terminal"]).accessibilityValue, "web, terminal")
        XCTAssertEqual(SessionToolsets(names: ["web"]).title, "web")
        XCTAssertEqual(SessionToolsets(names: []).title, "Profile defaults")
        XCTAssertEqual(SessionToolsets(names: nil).title, "Profile defaults")
    }
}
