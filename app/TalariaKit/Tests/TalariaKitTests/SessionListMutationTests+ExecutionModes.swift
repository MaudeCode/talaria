import XCTest
@testable import TalariaKit

/// TAL-1045: New Chat offers the diagnostic modes the server reports for the active profile, and a chosen one is
/// requested only by the creation it was chosen for.
@MainActor
extension SessionListMutationTests {
    final class ExecutionModeServer: @unchecked Sendable {
        var modes: (status: Int, json: String) = (200, "{}")
        var activeProfile = "default"
        var creation: (status: Int, json: String) = (200, "{}")
        var creationBodies: [[String: Any]] = []
    }

    func executionModesViewModel(_ server: ExecutionModeServer) throws -> SessionListViewModel {
        try makeViewModel { request in
            switch request.url?.path {
            case "/api/session/execution-modes":
                return apiTestJSONResponse(server.modes.json, statusCode: server.modes.status, for: request)
            case "/api/profiles":
                return apiTestJSONResponse(#"{"active":"\#(server.activeProfile)","profiles":[{"name":"default"},{"name":"work"}]}"#, for: request)
            case "/api/session/new":
                server.creationBodies.append(try apiTestJSONBody(from: request))
                return apiTestJSONResponse(server.creation.json, statusCode: server.creation.status, for: request)
            default:
                return apiTestJSONResponse(#"{"workspaces":[],"last":"/tmp/fixture"}"#, for: request)
            }
        }
    }

    func testNewChatOffersTheServersDiagnosticModesWithTheirAvailability() async throws {
        let server = ExecutionModeServer()
        server.modes = (200, try executionModesFixture("available"))
        let viewModel = try executionModesViewModel(server)
        await viewModel.loadActiveProfile()

        await viewModel.loadExecutionModes()
        XCTAssertEqual(viewModel.newChatExecutionModes.map(\.mode), [.ignoreConfig, .safe], "Normal is New Chat's tap, not a menu row")
        XCTAssertTrue(viewModel.newChatExecutionModes.allSatisfy(\.available))
        XCTAssertNil(viewModel.newChatExecutionModes.first?.reasonTitle)

        server.modes = (200, try executionModesFixture("unavailable"))
        await viewModel.loadExecutionModes()
        XCTAssertEqual(viewModel.newChatExecutionModes.map(\.available), [false, false], "An unavailable mode stays listed, disabled")
        XCTAssertEqual(viewModel.newChatExecutionModes.map(\.reasonTitle), ["Start the gateway first", "Start the gateway first"])
    }

    func testAnOlderServerOffersNoDiagnosticModes() async throws {
        let server = ExecutionModeServer()
        server.modes = (404, #"{"error":"Not found"}"#)
        let viewModel = try executionModesViewModel(server)

        await viewModel.loadExecutionModes()

        XCTAssertEqual(viewModel.newChatExecutionModes, [], "No route means no modes, so New Chat shows no menu")
    }

    func testModesReadForAnotherProfileAreNotOfferedAfterASwitch() async throws {
        let server = ExecutionModeServer()
        server.modes = (200, try executionModesFixture("available"))
        let viewModel = try executionModesViewModel(server)
        await viewModel.loadActiveProfile()
        await viewModel.loadExecutionModes()
        XCTAssertEqual(viewModel.newChatExecutionModes.count, 2)

        server.activeProfile = "work"
        await viewModel.loadActiveProfile()

        XCTAssertEqual(viewModel.activeProfileName, "work")
        XCTAssertEqual(viewModel.newChatExecutionModes, [], "The default profile's modes do not reach a work-profile chat")
        server.modes = (200, try executionModesFixture("unavailable"))
        await viewModel.loadExecutionModes()
        XCTAssertEqual(viewModel.newChatExecutionModes.map(\.available), [false, false], "The work profile's own answer replaces them")
    }

    func testADiagnosticCreationSendsItsModeAndCreationIdentityAndReturnsTheServersSession() async throws {
        let server = ExecutionModeServer()
        server.creation = (200, try executionModesFixture("created"))
        let viewModel = try executionModesViewModel(server)

        let result = await viewModel.createSessionResult(executionMode: .safe, requestID: "fixture-creation-1")

        guard case .started(let session, let detail) = result else { return XCTFail("Expected the created chat") }
        let body = try XCTUnwrap(server.creationBodies.last)
        XCTAssertEqual(body["execution_mode"] as? String, "safe")
        XCTAssertEqual(body["request_id"] as? String, "fixture-creation-1")
        XCTAssertEqual(session.sessionId, "local-fb4d9dabd7f0c5c106d3df779f54c429dd5d17c3fe2fdfe77245f6d22d8745bc")
        XCTAssertEqual(detail?.executionMode, .safe, "The effective mode is the server's, from its creation answer")
        XCTAssertEqual(detail?.ownerAttachment?.isAttached, true)
    }

    func testANormalCreationSendsNoModeOrCreationIdentity() async throws {
        let server = ExecutionModeServer()
        server.creation = (200, #"{"session":{"session_id":"normal-chat","title":"Untitled"}}"#)
        let viewModel = try executionModesViewModel(server)

        for mode in [nil, ExecutionMode.normal] {
            _ = await viewModel.createSessionResult(executionMode: mode, requestID: "unused")
            let body = try XCTUnwrap(server.creationBodies.last)
            XCTAssertNil(body["execution_mode"], "\(String(describing: mode))")
            XCTAssertNil(body["request_id"], "\(String(describing: mode))")
        }
    }

    func testARefusedDiagnosticCreationSaysWhyAndCanRetryTheSameCreation() async throws {
        let server = ExecutionModeServer()
        server.creation = (409, try executionModesFixture("refusal"))
        let viewModel = try executionModesViewModel(server)

        let refused = await viewModel.createSessionResult(executionMode: .safe, requestID: "fixture-creation-1")
        guard case .failed(let message, let canRetry, _) = refused else { return XCTFail("Expected the refusal") }
        XCTAssertEqual(message, "Safe Mode isn't available: Start the gateway first")
        XCTAssertTrue(canRetry)

        // An unconfirmed answer is retryable too: the creation identity returns the chat the owner already made.
        server.creation = (500, #"{"error":"Synthetic lost result"}"#)
        let lost = await viewModel.createSessionResult(executionMode: .safe, requestID: "fixture-creation-1")
        guard case .failed(_, let retriesLost, _) = lost else { return XCTFail("Expected the lost result") }
        XCTAssertTrue(retriesLost)
        XCTAssertEqual(server.creationBodies.compactMap { $0["request_id"] as? String }, ["fixture-creation-1", "fixture-creation-1"])
    }
}
