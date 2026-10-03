import XCTest
@testable import TalariaKit

/// TAL-426: the App shows the server's pending steers, from any device, with the actions the server allows.
@MainActor
extension ChatViewModelSendTests {
    private final class RequestLog: @unchecked Sendable {
        var bodies: [String: [[String: Any]]] = [:]
        var withdraw: [String] = []
        var sendNow: [String] = []
    }

    private func runningViewModel(
        _ log: RequestLog,
        streamClient: SpySSEStreamingClient
    ) throws -> ChatViewModel {
        try makeViewModel(streamClient: streamClient) { request in
            let path = request.url?.path ?? ""
            if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                log.bodies[path, default: []].append(body)
            }
            switch path {
            case "/api/chat/start":
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            case "/api/chat/steer":
                return apiTestJSONResponse(#"{"accepted":true,"stream_id":"stream-123"}"#, for: request)
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
        XCTAssertEqual(viewModel.pinnedLocalNotices.last, "The agent already took this steering message.")

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
}
