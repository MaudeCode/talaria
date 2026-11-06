import XCTest
@testable import TalariaKit

/// TAL-1321: a chat's connection operation renders the server's exact view from `contracts/fixtures/connectors.json` and
/// answers it through `/api/connectors/operations/{op_id}`. The App never infers settlement or replays a lost answer.
@MainActor
extension ChatViewModelSendTests {
    private static let operationPath = "/api/connectors/operations/op-native"

    /// One recorded view from the shared fixture as JSON text, with `edit` applied to it.
    private static func viewJSON(_ key: String = "native", edit: (inout [String: Any]) -> Void = { _ in }) throws -> String {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("connectors")) as? [String: Any])
        let recorded = key == "native" ? (fixture["native_connection"] as? [String: Any])?["view"] : fixture[key]
        var view = try XCTUnwrap(recorded as? [String: Any])
        edit(&view)
        return String(decoding: try JSONSerialization.data(withJSONObject: view), as: UTF8.self)
    }

    /// `view` after the owner settled it.
    private static func settledJSON() throws -> String {
        try viewJSON { view in
            view["settled"] = true
            view["outcome"] = "not_connected"
            view["can_continue"] = false
            view["can_wake"] = false
            view["targets"] = (view["targets"] as? [[String: Any]])?.map { target in
                target.merging(["connect_url": NSNull(), "actions": [], "env_fields": []]) { $1 }
            }
        }
    }

    /// `view` with the row `name` in `state` and offering nothing.
    private static func viewJSON(row name: String, state: String) throws -> String {
        try viewJSON { view in
            view["targets"] = (view["targets"] as? [[String: Any]])?.map { target in
                guard target["name"] as? String == name else { return target }
                return target.merging(["state": state, "connect_url": NSNull(), "actions": [], "env_fields": []]) { $1 }
            }
        }
    }

    private static func frame(_ json: String) -> SSEEvent {
        SSEEventDecoder.decode(eventType: "connect_card", data: json)
    }

    private static func decodedFrame(_ json: String) -> ConnectorOperationView? {
        if case .connectionOperation(let view) = frame(json) { view } else { nil }
    }

    private static func refusal(_ status: Int, code: String, message: String, for request: URLRequest) -> (HTTPURLResponse, Data) {
        apiTestJSONResponse(#"{"error":"\#(message)","code":"\#(code)"}"#, statusCode: status, for: request)
    }

    /// An owner chat holding the fixture's operation; `connection` is the attachment's field as JSON, nil to omit it.
    private func connectionViewModel(
        _ log: OwnerRequestLog,
        streamClient: SpySSEStreamingClient? = nil,
        connection: @escaping () -> String? = { nil },
        pollingIntervals: ChatPollingIntervals = .connectionHeld,
        respond: @escaping (String, URLRequest) -> (HTTPURLResponse, Data)? = { _, _ in nil }
    ) throws -> ChatViewModel {
        let normal = try Self.ownerAttachmentJSON("normal")
        let session: () -> String = {
            let attachment = connection().map { String(normal.dropLast()) + #","connection":\#($0)}"# } ?? normal
            return Self.ownerSessionObject(attachment: attachment)
        }
        return try makeViewModel(streamClient: streamClient ?? SpySSEStreamingClient(), pollingIntervals: pollingIntervals) { request in
            let path = request.url?.path ?? ""
            if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                log.bodies[path, default: []].append(body)
            }
            if let answer = respond(path, request) { return answer }
            switch path {
            case "/api/session":
                log.sessionReads += 1
                return apiTestJSONResponse(#"{"session":\#(session())}"#, for: request)
            default:
                return apiTestJSONResponse("{}", for: request)
            }
        }
    }

    private func loadedOperation(
        _ log: OwnerRequestLog,
        streamClient: SpySSEStreamingClient? = nil,
        pollingIntervals: ChatPollingIntervals = .connectionHeld,
        respond: @escaping (String, URLRequest) -> (HTTPURLResponse, Data)? = { _, _ in nil }
    ) async throws -> ChatViewModel {
        let view = try Self.viewJSON()
        let viewModel = try connectionViewModel(log, streamClient: streamClient, connection: { view }, pollingIntervals: pollingIntervals, respond: respond)
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native")
        return viewModel
    }

    private func actions(_ viewModel: ChatViewModel, _ name: String) -> [ConnectorOperationView.Action]? {
        viewModel.connectionOperation?.targets.first { $0.name == name }?.actions
    }

    private func state(_ viewModel: ChatViewModel, _ name: String) -> String? {
        viewModel.connectionOperation?.targets.first { $0.name == name }?.state
    }

    func testTheSharedFixtureDecodesTheServersExactOperation() throws {
        let native = try APIClient.responseDecoder().decode(ConnectorOperationView.self, from: Data(Self.viewJSON().utf8))
        XCTAssertEqual(native.owner?.authorityEpoch, 1)
        XCTAssertTrue(native.canWake)
        XCTAssertTrue(native.canContinue)
        XCTAssertEqual(native.targets.map(\.state), ["initiated", "pending", "failed", "connected", "skipped"])
        XCTAssertEqual(native.targets.map(\.actions), [[.skip], [.approve, .skip], [.retry, .skip], [], []])
        XCTAssertEqual(native.targets[0].connectUrl?.absoluteString, "https://vendor.example.test/authorize/conn-native?state=opaque-state")
        XCTAssertEqual(native.targets[1].envFields.map(\.name), ["LINEAR_API_KEY"])
        XCTAssertEqual(native.targets[1].envFields.first?.secret, true)
        XCTAssertEqual(native.targets[2].detail, "The link expired")

        // A direct operation names no owner and offers no wake.
        let direct = try APIClient.responseDecoder().decode(ConnectorOperationView.self, from: Data(Self.viewJSON("connect_card").utf8))
        XCTAssertNil(direct.owner)
        XCTAssertFalse(direct.canWake)
    }

    func testAnOwnersLaunchShowsWhenSentAndTheRowDecodesWithoutIt() throws {
        let view = try APIClient.responseDecoder().decode(ConnectorOperationView.self, from: Data(Self.viewJSON().utf8))
        XCTAssertNil(view.targets[0].launch)
        XCTAssertEqual(view.targets[1].launch?.kind, "stdio")
        XCTAssertEqual(view.targets[1].launch?.target, "npx -y mcp-linear --api-key=*** 'two  spaces' sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "The consent line is the server's, unchanged")
        XCTAssertEqual(view.targets[1].launch?.env, ["LINEAR_API_KEY"])
        XCTAssertEqual(view.targets[1].launch?.cwd, "/workspace/linear")

        // An older server omits the field, and the row is the same without it.
        let older = try Self.viewJSON { view in
            view["targets"] = (view["targets"] as? [[String: Any]])?.map { $0.filter { $0.key != "launch" } }
        }
        XCTAssertNil(try APIClient.responseDecoder().decode(ConnectorOperationView.self, from: Data(older.utf8)).targets[1].launch)
    }

    func testAttachRestoresOneOperationAndEachUpdateReplacesIt() async throws {
        let log = OwnerRequestLog()
        let view = try Self.viewJSON()
        let viewModel = try connectionViewModel(log, connection: { view })
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native", "Attach restores the owner's operation")

        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.connectionOperation?.targets.count, 5, "A reconnect restores the same one operation")
        XCTAssertEqual(state(viewModel, "gmail"), "initiated")

        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(Self.viewJSON(row: "gmail", state: "connected"))))
        XCTAssertEqual(state(viewModel, "gmail"), "connected", "A live update replaces the shown view")

        let replacement = try Self.viewJSON { $0["op_id"] = "op-next"; $0["targets"] = [] }
        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(replacement)))
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-next", "A new operation replaces the old one")
        XCTAssertEqual(viewModel.connectionOperation?.targets.count, 0)
    }

    func testAConnectCardFrameReachesTheChatFromItsStream() async throws {
        let log = OwnerRequestLog()
        let stream = SpySSEStreamingClient()
        let normal = try Self.ownerAttachmentJSON("normal")
        let view = try Self.viewJSON()
        let viewModel = try ownerViewModel(log, streamClient: stream, session: { Self.ownerSessionObject(attachment: normal, activeStreamID: "owner-stream") })
        await viewModel.loadMessages()
        await viewModel.reconnectStreamIfNeeded()
        stream.emit(Self.frame(view))
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native")
        XCTAssertTrue(viewModel.streamCoordinatorHasPendingPrompt, "A waiting card holds off the stall recovery, as a prompt does")
    }

    func testEveryAnswerNamesTheExactActionTargetOperationAndOwner() async throws {
        let log = OwnerRequestLog()
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            path == Self.operationPath ? apiTestJSONResponse(view, for: request) : nil
        }

        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native")
        await viewModel.respondToConnectionOperation(.row(.retry, target: "notion"), opID: "op-native")
        await viewModel.respondToConnectionOperation(.row(.approve, target: "linear"), env: ["LINEAR_API_KEY": "synthetic-secret"], opID: "op-native")
        await viewModel.respondToConnectionOperation(.continueWithoutTheRest, opID: "op-native")

        let bodies = try XCTUnwrap(log.bodies[Self.operationPath])
        let owner: [String: Any] = ["session_id": "local-24fa9f4bfead2fe04a0da5932e866e42cbba68160044a1cbbb9285cfcccc3cea", "authority_epoch": 1]
        func expected(_ fields: [String: Any]) -> NSDictionary { fields.merging(owner) { $1 } as NSDictionary }
        XCTAssertEqual(bodies.map { $0 as NSDictionary }, [
            expected(["action": "skip", "target": "gmail"]),
            expected(["action": "retry", "target": "notion"]),
            // The server's field name goes back as it came, never re-cased by the snake-case encoder.
            expected(["action": "approve", "target": "linear", "env": ["LINEAR_API_KEY": "synthetic-secret"]]),
            expected(["action": "continue"])
        ])
    }

    func testADirectOperationSendsNoOwnerAndOffersNoWake() async throws {
        let log = OwnerRequestLog()
        let direct = try Self.viewJSON("connect_card")
        let viewModel = try connectionViewModel(log, respond: { path, request in
            path.hasPrefix("/api/connectors/operations/") ? apiTestJSONResponse(direct, for: request) : nil
        })
        await viewModel.loadMessages()
        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(direct)))

        await viewModel.wakeConnectionOperation()
        XCTAssertNil(log.bodies["/api/connectors/operations/op-chat"], "No owner to wake on a direct operation")

        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-chat")
        XCTAssertEqual(log.bodies["/api/connectors/operations/op-chat"]?.map { $0 as NSDictionary }, [["action": "skip", "target": "gmail"] as NSDictionary])
    }

    func testWakeAsksTheOwnerOnceAndShowsWhatItFound() async throws {
        let log = OwnerRequestLog()
        let found = try Self.viewJSON(row: "gmail", state: "connected")
        let viewModel = try await loadedOperation(log) { path, request in
            path == Self.operationPath ? apiTestJSONResponse(found, for: request) : nil
        }
        await viewModel.wakeConnectionOperation()
        let bodies = try XCTUnwrap(log.bodies[Self.operationPath])
        XCTAssertEqual(bodies.compactMap { $0["action"] as? String }, ["wake"])
        XCTAssertNil(bodies.first?["target"])
        XCTAssertEqual(state(viewModel, "gmail"), "connected")
    }

    func testSkipShowsAtOnceThenRollsBackOnARefusal() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            if request.httpMethod == "POST" {
                _ = release.wait(timeout: .now() + 15)
                return Self.refusal(409, code: "operation_refused", message: "That move is not open on this connection.", for: request)
            }
            return apiTestJSONResponse(view, for: request)
        }

        let answer = Task { await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native") }
        try await waitUntil { self.state(viewModel, "gmail") == "skipped" }
        XCTAssertNil(viewModel.connectionOperation?.targets.first?.connectUrl, "The skipped row drops its link at once")
        XCTAssertEqual(actions(viewModel, "gmail"), [], "The skipped row offers nothing")
        XCTAssertEqual(viewModel.connectionOperation?.canContinue, false, "Continue waits for the row's answer")
        release.signal()
        await answer.value

        XCTAssertEqual(state(viewModel, "gmail"), "initiated", "The refusal restores the last confirmed value")
        XCTAssertEqual(actions(viewModel, "gmail"), [.skip])
        XCTAssertEqual(viewModel.connectionErrorMessage, "That move is not open on this connection.")
    }

    func testApproveKeepsItsBusyStateOnItsOwnRowAndLeavesTheOthersAnswerable() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        let connected = try Self.viewJSON(row: "linear", state: "connected")
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            _ = release.wait(timeout: .now() + 15)
            return apiTestJSONResponse(connected, for: request)
        }

        let answer = Task { await viewModel.respondToConnectionOperation(.row(.approve, target: "linear"), env: ["LINEAR_API_KEY": "synthetic-secret"], opID: "op-native") }
        try await waitUntil { viewModel.connectionRunningTargets == ["linear"] }
        XCTAssertEqual(state(viewModel, "linear"), "pending", "An install's result comes from the server, never assumed")
        XCTAssertEqual(actions(viewModel, "gmail"), [.skip])
        release.signal()
        await answer.value

        XCTAssertEqual(viewModel.connectionRunningTargets, [])
        XCTAssertEqual(state(viewModel, "linear"), "connected")
    }

    /// The App re-checks the server's offer when it sends, so a stale tap asks nothing, and Continue never races a row.
    func testOnlyAMoveTheServerOffersNowIsSent() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            _ = release.wait(timeout: .now() + 15)
            return apiTestJSONResponse(view, for: request)
        }

        await viewModel.respondToConnectionOperation(.row(.approve, target: "gmail"), opID: "op-native")
        await viewModel.respondToConnectionOperation(.row(.skip, target: "slack"), opID: "op-native")
        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-other")
        XCTAssertNil(log.bodies[Self.operationPath], "None of those moves is on offer")

        let row = Task { await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native") }
        try await waitUntil { self.state(viewModel, "gmail") == "skipped" }
        await viewModel.respondToConnectionOperation(.continueWithoutTheRest, opID: "op-native")
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native", "Continue is closed while a row's answer is out")
        release.signal()
        await row.value
        XCTAssertEqual(log.bodies[Self.operationPath]?.compactMap { $0["action"] as? String }, ["skip"])
    }

    func testContinueRemovesTheCardAtOnceAndARefusalBringsItBack() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            if request.httpMethod == "POST" {
                _ = release.wait(timeout: .now() + 15)
                return Self.refusal(409, code: "operation_refused", message: "That move is not open on this connection.", for: request)
            }
            return apiTestJSONResponse(view, for: request)
        }

        let answer = Task { await viewModel.respondToConnectionOperation(.continueWithoutTheRest, opID: "op-native") }
        try await waitUntil { viewModel.connectionOperation == nil }
        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native")
        release.signal()
        await answer.value

        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native")
        XCTAssertEqual(viewModel.connectionOperation?.canContinue, true)
        XCTAssertEqual(viewModel.connectionErrorMessage, "That move is not open on this connection.")
        XCTAssertEqual(log.bodies[Self.operationPath]?.count, 1, "A row's move never joins a Continue on its way")
    }

    func testASettledContinueLeavesTheCardClosedWithoutAResult() async throws {
        let log = OwnerRequestLog()
        let settled = try Self.settledJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            path == Self.operationPath ? apiTestJSONResponse(settled, for: request) : nil
        }
        await viewModel.respondToConnectionOperation(.continueWithoutTheRest, opID: "op-native")
        XCTAssertNil(viewModel.connectionOperation, "The user already moved on")

        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(settled)))
        XCTAssertNil(viewModel.connectionOperation, "A later frame of it stays closed")
    }

    /// An unknown outcome reads the same operation: it never sends the answer again, and nothing can be answered until it knows.
    func testALostAnswerIsDecidedByAReadAndNeverReplayed() async throws {
        let log = OwnerRequestLog()
        final class Reads: @unchecked Sendable { var allowed = false; var count = 0 }
        let reads = Reads()
        let view = try Self.viewJSON(row: "gmail", state: "skipped")
        let viewModel = try await loadedOperation(log, pollingIntervals: .connectionFast) { path, request in
            guard path == Self.operationPath else { return nil }
            if request.httpMethod == "POST" {
                return apiTestJSONResponse(#"{"error":"Could not read this connection from its owner.","code":"connectors_failed","outcome_unknown":true}"#, statusCode: 503, for: request)
            }
            reads.count += 1
            guard reads.allowed else { return Self.refusal(503, code: "connectors_failed", message: "Unavailable", for: request) }
            return apiTestJSONResponse(view, for: request)
        }

        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native")
        XCTAssertGreaterThanOrEqual(reads.count, 1, "A lost answer reads the operation at once")
        XCTAssertEqual(state(viewModel, "gmail"), "skipped", "Still unknown: the choice stays shown")
        XCTAssertEqual(actions(viewModel, "notion"), [], "Nothing else is sent before the server says what landed")
        XCTAssertEqual(viewModel.connectionOperation?.canContinue, false)
        await viewModel.respondToConnectionOperation(.continueWithoutTheRest, opID: "op-native")
        await viewModel.respondToConnectionOperation(.row(.retry, target: "notion"), opID: "op-native")

        reads.allowed = true
        try await waitUntil { self.actions(viewModel, "notion")?.isEmpty == false }
        XCTAssertEqual(state(viewModel, "gmail"), "skipped")
        XCTAssertEqual(actions(viewModel, "notion"), [.retry, .skip], "The read reopens the rest")
        XCTAssertNil(viewModel.connectionErrorMessage, "The answer landed")
        XCTAssertEqual(log.bodies[Self.operationPath]?.count, 1, "The answer was sent once")
    }

    func testALostAnswerThatDidNotLandRollsBackWithItsError() async throws {
        let log = OwnerRequestLog()
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            if request.httpMethod == "POST" {
                return Self.refusal(502, code: "connectors_failed", message: "Connector request failed. Try again explicitly.", for: request)
            }
            return apiTestJSONResponse(view, for: request)
        }

        await viewModel.respondToConnectionOperation(.row(.approve, target: "linear"), env: ["LINEAR_API_KEY": "synthetic-secret"], opID: "op-native")

        XCTAssertEqual(actions(viewModel, "linear"), [.approve, .skip], "The server still offers it, so the user decides")
        XCTAssertEqual(viewModel.connectionRunningTargets, [])
        XCTAssertEqual(viewModel.connectionErrorMessage, "Connector request failed. Try again explicitly.")
        XCTAssertEqual(log.bodies[Self.operationPath]?.count, 1, "The credentials went once")
    }

    func testAnExpiredOperationClosesTheCardAndSaysSo() async throws {
        let log = OwnerRequestLog()
        let viewModel = try await loadedOperation(log) { path, request in
            path == Self.operationPath ? Self.refusal(404, code: "operation_not_found", message: "No connection operation with that id.", for: request) : nil
        }
        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native")
        XCTAssertNil(viewModel.connectionOperation)
        XCTAssertEqual(viewModel.sendErrorMessage, PendingPromptExpiredError(prompt: .connection).errorDescription)
    }

    func testAForeignOperationsRefusalKeepsTheCardAndARefusedReadClosesIt() async throws {
        let log = OwnerRequestLog()
        final class Reads: @unchecked Sendable { var refused = false }
        let reads = Reads()
        let view = try Self.viewJSON()
        let message = "This connection cannot be changed from here."
        let viewModel = try await loadedOperation(log, pollingIntervals: .connectionFast) { path, request in
            guard path == Self.operationPath else { return nil }
            if request.httpMethod == "POST" || reads.refused {
                return Self.refusal(403, code: "connectors_forbidden", message: message, for: request)
            }
            return apiTestJSONResponse(view, for: request)
        }

        await viewModel.respondToConnectionOperation(.row(.skip, target: "gmail"), opID: "op-native")
        XCTAssertEqual(viewModel.connectionErrorMessage, message)
        XCTAssertEqual(state(viewModel, "gmail"), "initiated")

        reads.refused = true
        try await waitUntil { viewModel.connectionOperation == nil }
        XCTAssertEqual(viewModel.sendErrorMessage, "The server refused the request: \(message)")
    }

    func testALateAnswerFromAReplacedOperationChangesNothing() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        let old = try Self.viewJSON(row: "gmail", state: "connected")
        let viewModel = try await loadedOperation(log) { path, request in
            guard path == Self.operationPath else { return nil }
            _ = release.wait(timeout: .now() + 15)
            return apiTestJSONResponse(old, for: request)
        }

        let answer = Task { await viewModel.respondToConnectionOperation(.row(.approve, target: "linear"), opID: "op-native") }
        try await waitUntil { viewModel.connectionRunningTargets == ["linear"] }
        let next = try Self.viewJSON { $0["op_id"] = "op-next" }
        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(next)))
        XCTAssertEqual(viewModel.connectionRunningTargets, [], "A new operation starts with nothing on its way")
        release.signal()
        await answer.value

        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-next")
        XCTAssertEqual(state(viewModel, "gmail"), "initiated")
    }

    func testAProfileSwitchLeavesTheOperationBehind() async throws {
        let log = OwnerRequestLog()
        let viewModel = try await loadedOperation(log) { path, request in
            path == "/api/profile/switch" ? apiTestJSONResponse(#"{"active":"work"}"#, for: request) : nil
        }
        let work = try APIClient.responseDecoder().decode(ProfileSummary.self, from: Data(#"{"name":"work"}"#.utf8))
        _ = await viewModel.switchProfile(work, startNewSession: false)
        XCTAssertNil(viewModel.connectionOperation)
    }

    func testAnOperationStaysWithTheSessionThatOpenedIt() throws {
        let delegate = ConnectionSessionDelegate()
        let coordinator = ChatPendingActionCoordinator(
            client: APIClient(baseURL: URL(string: "https://example.test")!),
            approvalStreamClient: SpySSEStreamingClient(),
            clarifyStreamClient: SpySSEStreamingClient(),
            pollingIntervals: .connectionHeld
        )
        coordinator.delegate = delegate
        coordinator.applyConnectionOperation(try XCTUnwrap(Self.decodedFrame(Self.viewJSON())), sessionID: "session-abc")
        XCTAssertEqual(coordinator.connectionOperation?.opId, "op-native")

        delegate.pendingActionSessionID = "session-other"
        XCTAssertNil(coordinator.connectionOperation, "Another chat never shows it")

        delegate.pendingActionSessionID = "session-abc"
        XCTAssertEqual(coordinator.connectionOperation?.opId, "op-native")
    }

    func testADetailReadFromBeforeAFrameCannotCloseIt() async throws {
        let log = OwnerRequestLog()
        let release = DispatchSemaphore(value: 0)
        final class Held: @unchecked Sendable { var isHeld = false }
        let held = Held()
        let normal = try Self.ownerAttachmentJSON("normal")
        let stale = Self.ownerSessionObject(attachment: String(normal.dropLast()) + #","connection":null}"#)
        let viewModel = try connectionViewModel(log, respond: { path, request in
            guard path == "/api/session", held.isHeld else { return nil }
            _ = release.wait(timeout: .now() + 15)
            return apiTestJSONResponse(#"{"session":\#(stale)}"#, for: request)
        })
        await viewModel.loadMessages()
        held.isHeld = true
        let load = Task { await viewModel.loadMessages() }
        try await Task.sleep(for: .milliseconds(50))
        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(Self.viewJSON())))
        release.signal()
        await load.value
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native")
    }

    func testAnOwnerSnapshotDecidesTheCardOnlyWhenItStatesTheConnection() async throws {
        let log = OwnerRequestLog()
        final class Held: @unchecked Sendable { var connection: String? }
        let held = Held()
        held.connection = try Self.viewJSON()
        let viewModel = try connectionViewModel(log, connection: { held.connection })
        await viewModel.loadMessages()
        XCTAssertNotNil(viewModel.connectionOperation)

        held.connection = nil
        await viewModel.loadMessages()
        XCTAssertNotNil(viewModel.connectionOperation, "An older server or a missing snapshot says nothing about the operation")

        held.connection = "null"
        await viewModel.loadMessages()
        XCTAssertNil(viewModel.connectionOperation, "The server says the owner holds none")
    }

    func testASettledOperationShowsItsResultUntilClosed() async throws {
        let log = OwnerRequestLog()
        let settled = try Self.settledJSON()
        final class Held: @unchecked Sendable { var connection: String? }
        let held = Held()
        held.connection = try Self.viewJSON()
        let viewModel = try connectionViewModel(log, connection: { held.connection })
        await viewModel.loadMessages()

        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(settled)))
        XCTAssertEqual(viewModel.connectionOperation?.outcome, .notConnected)
        XCTAssertEqual(viewModel.connectionOperation?.settled, true)
        XCTAssertFalse(viewModel.streamCoordinatorHasPendingPrompt, "Nothing waits on a settled operation")

        held.connection = "null"
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.connectionOperation?.outcome, .notConnected, "The owner closes what it settled; the result stays to read")

        viewModel.dismissConnectionOperation(opID: "op-native")
        XCTAssertNil(viewModel.connectionOperation)
        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(settled)))
        XCTAssertNil(viewModel.connectionOperation, "A replayed frame stays closed")
    }

    func testAnOpenOperationIsReadUntilItSettlesAndAReadStartsNothing() async throws {
        let log = OwnerRequestLog()
        final class Reads: @unchecked Sendable { var count = 0 }
        let reads = Reads()
        let settled = try Self.settledJSON()
        let view = try Self.viewJSON()
        let viewModel = try await loadedOperation(log, pollingIntervals: .connectionFast) { path, request in
            guard path == Self.operationPath else { return nil }
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "authority_epoch" }?.value, "1")
            reads.count += 1
            return apiTestJSONResponse(reads.count < 3 ? view : settled, for: request)
        }

        try await waitUntil { viewModel.connectionOperation?.settled == true }
        let finalCount = reads.count
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(reads.count, finalCount, "A settled operation is not read again")
        XCTAssertNil(log.bodies[Self.operationPath], "A read never answers the operation")
    }

    func testARunEndingClosesADirectCardButNotAnOwners() async throws {
        let log = OwnerRequestLog()
        let direct = try Self.viewJSON("connect_card")
        let native = try Self.viewJSON()
        let viewModel = try connectionViewModel(log)
        await viewModel.loadMessages()

        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(direct)))
        viewModel.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
        XCTAssertNil(viewModel.connectionOperation, "The Agent no longer waits on a direct card once its turn ended")

        viewModel.streamCoordinatorApplyConnectionOperation(try XCTUnwrap(Self.decodedFrame(native)))
        viewModel.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
        XCTAssertEqual(viewModel.connectionOperation?.opId, "op-native", "An owner's operation outlives one watch")
    }

    func testEveryTurnDeclaresConnectCardSupport() async throws {
        let log = OwnerRequestLog()
        let normal = try Self.ownerAttachmentJSON("normal")
        let viewModel = try ownerViewModel(log, session: { Self.ownerSessionObject(attachment: normal) }) { path, request in
            guard path == "/api/chat/start" else { return nil }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"owner-stream"}"#, for: request)
        }
        await viewModel.loadMessages()
        _ = await viewModel.sendMessage("Connect Gmail")
        XCTAssertEqual(log.bodies["/api/chat/start"]?.last?["connect_card"] as? Bool, true)
    }

    func testTheOfflineCopyOfAnAttachmentNeverHoldsTheOperation() throws {
        let normal = try Self.ownerAttachmentJSON("normal")
        let attachment = String(normal.dropLast()) + #","connection":\#(try Self.viewJSON())}"#
        let decoded = try APIClient.responseDecoder().decode(OwnerAttachment.self, from: Data(attachment.utf8))
        XCTAssertEqual(decoded.connection?.opId, "op-native")

        let cached = try JSONEncoder().encode(decoded)
        XCTAssertFalse(String(decoding: cached, as: UTF8.self).contains("vendor.example.test"), "An authorization link never reaches the cache")
        let restored = try JSONDecoder().decode(OwnerAttachment.self, from: cached)
        XCTAssertNil(restored.connection)
        XCTAssertFalse(restored.statesConnection, "An offline copy says nothing about the operation")
    }
}

private extension ChatPollingIntervals {
    /// Holds the operation's read loop, so each test decides when a read happens.
    static var connectionHeld: ChatPollingIntervals {
        var intervals = ChatPollingIntervals.standard
        intervals.sleep = { _ in try await Task.sleep(for: .seconds(3600)) }
        return intervals
    }

    static var connectionFast: ChatPollingIntervals {
        var intervals = ChatPollingIntervals.standard
        intervals.sleep = { _ in try await Task.sleep(for: .milliseconds(5)) }
        return intervals
    }
}

@MainActor
private final class ConnectionSessionDelegate: ChatPendingActionCoordinatorDelegate {
    var pendingActionSessionID: String? = "session-abc"
    var pendingActionHasActiveStream = true
    var pendingActionHasRunningClarificationTool = false
    var pendingActionIsStreamConnectionSuspended = false
    func pendingActionCoordinatorWillSubmitAction() {}
    func pendingActionCoordinatorDidFailAction(_ error: Error) {}
}
