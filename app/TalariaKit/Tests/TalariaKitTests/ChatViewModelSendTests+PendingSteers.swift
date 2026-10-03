import XCTest
@testable import TalariaKit

/// TAL-426: the App shows the server's pending steers, from any device, with the actions the server allows.
@MainActor
extension ChatViewModelSendTests {
    private final class RequestLog: @unchecked Sendable {
        var bodies: [String: [[String: Any]]] = [:]
        var withdraw: [String] = []
        var sendNow: [String] = []
        var cancel = #"{"ok":true,"cancelled":true}"#
        /// The session load's `pending_steers` JSON.
        var pendingSteers = "[]"
    }

    private func runningViewModel(
        _ log: RequestLog,
        streamClient: SpySSEStreamingClient,
        userDefaults: UserDefaults? = nil,
        protocolClasses: [AnyClass] = [MockURLProtocol.self]
    ) throws -> ChatViewModel {
        try makeViewModel(streamClient: streamClient, userDefaults: userDefaults ?? makeEphemeralUserDefaults(), protocolClasses: protocolClasses) { request in
            let path = request.url?.path ?? ""
            if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                log.bodies[path, default: []].append(body)
            }
            switch path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/chat/steer":
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-123"}"#, for: request)
            case "/api/chat/stream/status":
                return apiTestJSONResponse(#"{"active":true,"stream_id":"stream-123","replay_available":true}"#, for: request)
            case "/api/chat/cancel":
                return apiTestJSONResponse(log.cancel, for: request)
            case "/api/session":
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","active_stream_id":"stream-123","is_streaming":true,"messages":[{"role":"user","content":"Initial request","message_id":"user-1"}],"pending_steers":\#(log.pendingSteers)}}"#, for: request)
            case "/api/chat/steer/withdraw":
                return apiTestJSONResponse(log.withdraw.isEmpty ? #"{"withdrawn":false}"# : log.withdraw.removeFirst(), for: request)
            case "/api/chat/steer/send-now":
                return apiTestJSONResponse(log.sendNow.isEmpty ? #"{"redirected":false}"# : log.sendNow.removeFirst(), for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
    }

    private func steer(_ id: String, _ text: String, state: PendingSteer.State = .pending, sendNow: Bool = true) -> PendingSteer {
        PendingSteer(steerId: id, text: text, submittedAt: 5, state: state, actions: PendingSteer.Actions(edit: state == .pending, cancel: state == .pending, sendNow: state == .pending && sendNow))
    }

    func testAPendingSteerFromAnotherDeviceShowsWithTheServersActionsUntilClosed() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try runningViewModel(RequestLog(), streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.token("Working. "))

        streamClient.emit(.steerPending(steer("steer-web", "Sent from Web", sendNow: false)))
        XCTAssertEqual(viewModel.messages.last?.content, "Sent from Web")
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .waiting)
        XCTAssertEqual(viewModel.pendingSteerActions["steer-web"], PendingSteer.Actions(edit: true, cancel: true, sendNow: false))
        // A Send now from elsewhere: still pending, nothing to act on here.
        streamClient.emit(.steerPending(steer("steer-web", "Sent from Web", state: .sendingNow)))
        XCTAssertEqual(viewModel.messages.filter { $0.messageId == "steer-web" }.count, 1)
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .sending)
        XCTAssertEqual(viewModel.pendingSteerActions["steer-web"], PendingSteer.Actions.none)

        streamClient.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: "steer-web", reason: .cancel, text: "Sent from Web")))
        XCTAssertFalse(viewModel.messages.contains { $0.messageId == "steer-web" })
        XCTAssertNil(viewModel.pendingSteerActions["steer-web"])
        // A replayed frame never brings it back.
        streamClient.emit(.steerPending(steer("steer-web", "Sent from Web")))
        XCTAssertFalse(viewModel.messages.contains { $0.messageId == "steer-web" })
    }

    func testThisDevicesSteerKeepsItsIdAndShowsOnceWhenTheServerReportsIt() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try runningViewModel(RequestLog(), streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        _ = await viewModel.submitStreamingMessage("Check b too", behavior: .steer)
        let id = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerPending(steer(id, "Check b too")))
        XCTAssertEqual(viewModel.messages.filter(\.isLocalSteeringHint).map(\.messageId), [id])
        XCTAssertEqual(viewModel.messages.last?.steeringHintState, .waiting)
        XCTAssertEqual(viewModel.pendingSteerActions[id]?.any, true)
    }

    func testEditPutsTheTextBackCancelAsksTheServerAndARefusalSaysWhy() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        let viewModel = try runningViewModel(log, streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.steerPending(steer("steer-a", "Check a")))
        streamClient.emit(.steerPending(steer("steer-b", "Check b")))

        log.withdraw = [#"{"withdrawn":true,"text":"Check a"}"#]
        await viewModel.withdrawPendingSteer(id: "steer-a", reason: .edit)
        XCTAssertEqual(log.bodies["/api/chat/steer/withdraw"]?.last as? [String: String], ["session_id": "session-abc", "steer_id": "steer-a", "reason": "edit"])
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["Check a"])
        XCTAssertTrue(viewModel.returnedComposerTexts.isEmpty)
        XCTAssertFalse(viewModel.messages.contains { $0.messageId == "steer-a" })

        // The Agent already took it: it stays, and the notice says why.
        await viewModel.withdrawPendingSteer(id: "steer-b", reason: .cancel)
        XCTAssertEqual(log.bodies["/api/chat/steer/withdraw"]?.last?["reason"] as? String, "cancel")
        XCTAssertTrue(viewModel.messages.contains { $0.messageId == "steer-b" })
        XCTAssertEqual(viewModel.pinnedLocalNotices.last, "This steering message can no longer be changed.")

        log.withdraw = [#"{"withdrawn":true}"#]
        await viewModel.withdrawPendingSteer(id: "steer-b", reason: .cancel)
        XCTAssertFalse(viewModel.messages.contains { $0.messageId == "steer-b" })
        XCTAssertTrue(viewModel.takeReturnedComposerTexts().isEmpty)
    }

    func testSendNowAsksTheServerAndSaysWhenItStaysPending() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        let viewModel = try runningViewModel(log, streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.steerPending(steer("steer-a", "Check a")))

        log.sendNow = [#"{"redirected":true}"#]
        await viewModel.sendPendingSteerNow(id: "steer-a")
        XCTAssertEqual(log.bodies["/api/chat/steer/send-now"]?.last as? [String: String], ["session_id": "session-abc", "steer_id": "steer-a"])
        XCTAssertTrue(viewModel.pinnedLocalNotices.isEmpty)

        await viewModel.sendPendingSteerNow(id: "steer-a")
        XCTAssertEqual(viewModel.pinnedLocalNotices.last, "Nothing is running to take it now; it stays pending.")
        XCTAssertTrue(viewModel.messages.contains { $0.messageId == "steer-a" })
    }

    func testAStopGivesThisDevicesSteerTextBackAndOnlyThat() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try runningViewModel(RequestLog(), streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        _ = await viewModel.submitStreamingMessage("Mine", behavior: .steer)
        let mine = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerPending(steer("steer-web", "Theirs")))

        streamClient.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: "steer-web", reason: .stopped, text: "Theirs")))
        streamClient.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: mine, reason: .stopped, text: "Mine")))
        streamClient.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: mine, reason: .stopped, text: "Mine")))
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["Mine"])
        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
    }

    func testTheAppsOwnStopGivesItsSteerBackFromTheStopsAnswer() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        let viewModel = try runningViewModel(log, streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        _ = await viewModel.submitStreamingMessage("Mine", behavior: .steer)
        let mine = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerPending(steer("steer-web", "Theirs")))

        // The stream stops reading once the Stop answers, before its `steer_withdrawn` frames arrive.
        log.cancel = #"{"ok":true,"cancelled":true,"stream_id":"stream-123","withdrawn_steers":[{"steer_id":"\#(mine)","reason":"stopped","text":"Mine"},{"steer_id":"steer-web","reason":"stopped","text":"Theirs"}]}"#
        let stopped = await viewModel.cancelActiveStream()
        XCTAssertTrue(stopped)
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["Mine"])
        XCTAssertFalse(viewModel.messages.contains(where: \.isLocalSteeringHint))
    }

    func testASteerTheAgentTookOffersNoActions() async throws {
        let streamClient = SpySSEStreamingClient()
        let viewModel = try runningViewModel(RequestLog(), streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.steerPending(steer("steer-a", "Check a")))
        streamClient.emit(.steerPending(steer("steer-b", "Check b")))

        // Taken by its text alone, then reported pending again by a late frame.
        streamClient.emit(.steerConsumed(SteeringStreamEvent(text: "Check b")))
        streamClient.emit(.steerPending(steer("steer-b", "Check b")))
        XCTAssertNil(viewModel.pendingSteerActions["steer-b"])
        // The turn ends: what is still waiting was taken.
        streamClient.emit(.done(DoneStreamEvent()))
        XCTAssertEqual(viewModel.messages.first { $0.messageId == "steer-a" }?.steeringHintState, .consumed)
        XCTAssertNil(viewModel.pendingSteerActions["steer-a"])
    }

    func testEditKeepsTheShownTextWhenTheAnswerHasNone() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        let viewModel = try runningViewModel(log, streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.steerPending(steer("steer-a", "Check a")))

        log.withdraw = [#"{"withdrawn":true}"#]
        await viewModel.withdrawPendingSteer(id: "steer-a", reason: .edit)
        XCTAssertEqual(viewModel.takeReturnedComposerTexts(), ["Check a"])
    }

    func testAReloadWhileThisDevicesSteerIsSendingKeepsItsRow() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        HeldURLProtocol.path = "/api/chat/steer"
        let viewModel = try runningViewModel(log, streamClient: streamClient, protocolClasses: [HeldURLProtocol.self, MockURLProtocol.self])
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)

        let send = Task { await viewModel.submitStreamingMessage("Mine", behavior: .steer) }
        try await waitUntil { viewModel.messages.contains(where: \.isLocalSteeringHint) }
        let mine = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        // The server cannot list a steer whose POST has not reached it.
        await viewModel.loadMessages()
        XCTAssertTrue(viewModel.messages.contains { $0.messageId == mine })
        try await waitUntil { HeldURLProtocol.held != nil }
        HeldURLProtocol.release(#"{"accepted":true,"stream_id":"stream-123"}"#)
        _ = await send.value
        XCTAssertEqual(viewModel.messages.first { $0.messageId == mine }?.steeringHintState, .waiting)
    }

    func testALoadFetchedBeforeASteerArrivesNeverRemovesIt() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        HeldURLProtocol.path = "/api/session"
        let viewModel = try runningViewModel(log, streamClient: streamClient, protocolClasses: [HeldURLProtocol.self, MockURLProtocol.self])
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)

        // The load's answer predates both steers: this device's (POST answered) and one from Web.
        let load = Task { await viewModel.loadMessages() }
        try await waitUntil { HeldURLProtocol.held != nil }
        _ = await viewModel.submitStreamingMessage("Mine", behavior: .steer)
        let mine = try XCTUnwrap(viewModel.messages.last(where: \.isLocalSteeringHint)?.messageId)
        streamClient.emit(.steerPending(steer("steer-web", "Theirs")))
        HeldURLProtocol.release(#"{"session":{"session_id":"session-abc","active_stream_id":"stream-123","is_streaming":true,"messages":[{"role":"user","content":"Initial request","message_id":"user-1"}],"pending_steers":[]}}"#)
        await load.value

        XCTAssertEqual(viewModel.messages.filter(\.isLocalSteeringHint).compactMap(\.messageId), [mine, "steer-web"])
        XCTAssertEqual(viewModel.pendingSteerActions["steer-web"]?.any, true)
    }

    func testARelaunchShowsEachPendingSteerOnceAndStillKnowsThisDevicesOwn() async throws {
        let defaults = try makeEphemeralUserDefaults()
        let firstStream = SpySSEStreamingClient()
        let log = RequestLog()
        let first = try runningViewModel(log, streamClient: firstStream, userDefaults: defaults)
        let started = await first.sendMessage("Initial request")
        XCTAssertTrue(started)
        _ = await first.submitStreamingMessage("Mine", behavior: .steer)
        let mine = try XCTUnwrap(first.messages.last(where: \.isLocalSteeringHint)?.messageId)

        // A fresh process: only the server's list and the stored ids carry over.
        log.pendingSteers = #"[{"steer_id":"\#(mine)","text":"Mine","submitted_at":3,"state":"pending","actions":{"edit":true,"cancel":true,"send_now":true}},{"steer_id":"steer-web","text":"Theirs","submitted_at":4,"state":"pending","actions":{"edit":true,"cancel":true,"send_now":true}}]"#
        let stream = SpySSEStreamingClient()
        let relaunched = try runningViewModel(log, streamClient: stream, userDefaults: defaults)
        await relaunched.loadMessages()
        await relaunched.loadMessages()
        XCTAssertEqual(relaunched.messages.filter(\.isLocalSteeringHint).map(\.content), ["Mine", "Theirs"])

        await relaunched.reconnectStreamIfNeeded()
        stream.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: "steer-web", reason: .stopped, text: "Theirs")))
        stream.emit(.steerWithdrawn(SteerWithdrawnEvent(steerId: mine, reason: .stopped, text: "Mine")))
        XCTAssertEqual(relaunched.takeReturnedComposerTexts(), ["Mine"])
    }

    func testAResumeNeverBringsBackASteerWithdrawnWhileAway() async throws {
        let streamClient = SpySSEStreamingClient()
        let log = RequestLog()
        let viewModel = try runningViewModel(log, streamClient: streamClient)
        let started = await viewModel.sendMessage("Initial request")
        XCTAssertTrue(started)
        streamClient.emit(.steerPending(steer("steer-web", "Theirs")))
        viewModel.suspendStreamForBackground()

        // Cancelled on Web meanwhile: the server lists no pending steer, and the saved snapshot must not add it back.
        log.pendingSteers = "[]"
        await viewModel.reconnectStreamIfNeeded()
        XCTAssertFalse(viewModel.messages.contains { $0.messageId == "steer-web" })
    }
}

/// Holds one request to `path` open until released, while other requests answer.
private final class HeldURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var path = ""
    nonisolated(unsafe) static var held: HeldURLProtocol?

    override class func canInit(with request: URLRequest) -> Bool { request.url?.path == path && held == nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.held = self }
    override func stopLoading() {}

    static func release(_ body: String) {
        guard let held, let url = held.request.url else { return }
        Self.held = nil
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        held.client?.urlProtocol(held, didReceive: response, cacheStoragePolicy: .notAllowed)
        held.client?.urlProtocol(held, didLoad: Data(body.utf8))
        held.client?.urlProtocolDidFinishLoading(held)
    }
}
