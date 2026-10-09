import XCTest
import UserNotifications
@testable import TalariaKit

final class ApprovalNotificationTests: XCTestCase {
    @MainActor
    func testEveryApprovalSourceReachesVisibleHeadNotificationBoundary() throws {
        let client = APIClient(baseURL: URL(string: "https://approval-alert.test")!)
        let delegate = ApprovalNotificationTestDelegate()
        let coordinator = ChatPendingActionCoordinator(
            client: client, approvalStreamClient: SSEClient(), clarifyStreamClient: SSEClient(),
            pollingIntervals: .standard
        )
        coordinator.delegate = delegate
        var observed: [String] = []
        coordinator.approvalHeadDidBecomeVisible = { observed.append($0.pending.approvalId ?? "") }
        let first = ApprovalPendingResponse.streamPayload(from: Data(#"{"pending":{"id":"first","command":"private command"},"pending_count":2}"#.utf8))
        // Chat stream, initial approval snapshot, push and polling all use this method.
        for _ in 0..<4 { coordinator.applyApprovalUpdate(first, sessionID: "session-abc") }
        coordinator.applyApprovalUpdate(ApprovalPendingResponse(pending: nil, pendingCount: 0), sessionID: "session-abc")
        let second = ApprovalPendingResponse.streamPayload(from: Data(#"{"pending":{"id":"second"},"pending_count":1}"#.utf8))
        coordinator.applyApprovalUpdate(second, sessionID: "session-abc")
        XCTAssertEqual(observed, ["first", "second"], "Each newly visible queue head must reach the alert boundary once.")
        XCTAssertEqual(coordinator.approvalPrompt?.pending.approvalId, "second")
    }

    @MainActor
    func testApprovalPollResponseAfterPollingStopsDoesNotShowPrompt() async throws {
        let approvalRequests = LockedCounter()
        let releaseResponse = DispatchSemaphore(value: 0)
        defer { releaseResponse.signal() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register { request in
            XCTAssertEqual(request.url?.path, "/api/approval/pending")
            _ = approvalRequests.increment()
            releaseResponse.wait()
            return apiTestJSONResponse(#"{"pending": {"approval_id": "approval-late"}, "pending_count": 1}"#, for: request)
        }]
        let session = URLSession(configuration: configuration)
        let approvalStream = SpySSEStreamingClient()
        let delegate = ApprovalNotificationTestDelegate()
        var coordinator: ChatPendingActionCoordinator? = ChatPendingActionCoordinator(
            client: APIClient(baseURL: URL(string: "https://approval-alert.test")!, session: session),
            approvalStreamClient: approvalStream, clarifyStreamClient: SpySSEStreamingClient(),
            pollingIntervals: .standard
        )
        weak var weakCoordinator = coordinator
        coordinator?.delegate = delegate
        var shown: [String] = []
        coordinator?.approvalHeadDidBecomeVisible = { shown.append($0.pending.approvalId ?? "") }
        coordinator?.startMonitoring()
        approvalStream.emit(.transportError("approval stream failed"))
        try await waitUntil { approvalRequests.count == 1 }

        // Stopping while the request is held makes URLSession throw, so let the response finish first. The
        // main actor stays blocked meanwhile, so the poll cannot apply it before polling stops.
        releaseResponse.signal()
        XCTAssertTrue(blockUntilRequestsFinish(session))
        coordinator?.stopMonitoring(clearPrompt: true)

        // The poll holds the coordinator until it returns, so deallocation means the response was handled.
        coordinator = nil
        let deadline = ContinuousClock.now + .seconds(10)
        while weakCoordinator != nil, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNil(weakCoordinator, "The cancelled poll must finish")
        XCTAssertEqual(shown, [], "A response that arrives after polling stops must not show a prompt")
        XCTAssertEqual(approvalRequests.count, 1)
    }

    /// Blocks the calling thread until `session` has no running request.
    private nonisolated func blockUntilRequestsFinish(_ session: URLSession) -> Bool {
        let finished = DispatchSemaphore(value: 0)
        Task.detached {
            while await !session.allTasks.isEmpty {
                try? await Task.sleep(for: .milliseconds(1))
            }
            finished.signal()
        }
        return finished.wait(timeout: .now() + 10) == .success
    }
    @MainActor
    func testDeduplicatesAcrossSourcesReconnectAndQueueReplacement() async {
        let scheduler = ApprovalNotificationSpy(status: .authorized)
        let service = ApprovalNotificationService(scheduler: scheduler, preferenceEnabled: { true },
            sceneIsActive: { false }, relayOwnsAlerts: { _ in false })
        let first = prompt("first")
        let task = service.observe(first, server: server)
        for _ in 0..<4 { XCTAssertNil(service.observe(first, server: server)) }
        await task?.value
        await service.observe(prompt("second"), server: server)?.value
        XCTAssertNil(service.observe(first, server: server))
        await service.observe(prompt("first", sessionID: "other-session"), server: server)?.value
        await service.observe(first, server: URL(string: "https://other-alert.test")!)?.value
        XCTAssertEqual(scheduler.requests.count, 4)
        XCTAssertEqual(scheduler.requests.map(\.sessionID), ["session-abc", "session-abc", "other-session", "session-abc"])
    }

    @MainActor
    func testScenePreferenceAuthorizationAndRelayGates() async {
        var statuses: [UNAuthorizationStatus] = [.authorized, .provisional, .denied, .notDetermined]
        #if os(iOS)
        statuses.append(.ephemeral)
        #endif
        for status in statuses {
            for enabled in [false, true] {
                for active in [false, true] {
                    for relay in [false, true] {
                        let scheduler = ApprovalNotificationSpy(status: status)
                        let service = ApprovalNotificationService(scheduler: scheduler, preferenceEnabled: { enabled },
                            sceneIsActive: { active }, relayOwnsAlerts: { _ in relay })
                        await service.observe(prompt("first"), server: server)?.value
                        let permitted = status != .denied && status != .notDetermined
                        XCTAssertEqual(scheduler.requests.count, enabled && !active && !relay && permitted ? 1 : 0)
                    }
                }
            }
        }
    }

    @MainActor
    func testForegroundHeadIsConsumedAndPermissionReadRechecksDeviceState() async {
        var active = true
        var enabled = true
        var relay = false
        let scheduler = ApprovalNotificationSpy(status: .authorized)
        let service = ApprovalNotificationService(scheduler: scheduler, preferenceEnabled: { enabled },
            sceneIsActive: { active }, relayOwnsAlerts: { _ in relay })
        XCTAssertNil(service.observe(prompt("foreground"), server: server))
        active = false
        XCTAssertNil(service.observe(prompt("foreground"), server: server))
        scheduler.onAuthorization = { active = true }
        await service.observe(prompt("became-active"), server: server)?.value
        active = false
        scheduler.onAuthorization = { enabled = false }
        await service.observe(prompt("disabled"), server: server)?.value
        enabled = true
        scheduler.onAuthorization = { relay = true }
        await service.observe(prompt("relay-connected"), server: server)?.value
        XCTAssertTrue(scheduler.requests.isEmpty)
    }

    @MainActor
    func testSanitizedContentAndPayloadReachExistingTapRoute() async throws {
        let scheduler = ApprovalNotificationSpy(status: .authorized)
        let service = ApprovalNotificationService(scheduler: scheduler, preferenceEnabled: { true },
            sceneIsActive: { false }, relayOwnsAlerts: { _ in false })
        await service.observe(prompt("stable-id"), server: server)?.value
        let request = try XCTUnwrap(scheduler.requests.first)
        XCTAssertEqual(request.userInfo, ["sessionId": "session-abc", "publisherId": "https://approval-alert.test"])
        let content = request.content
        XCTAssertEqual(content.title, "Approval required")
        XCTAssertEqual(content.body, "An agent run is waiting for your approval.")
        XCTAssertNotNil(content.sound)
        XCTAssertEqual(content.categoryIdentifier, "")
        XCTAssertEqual(content.userInfo as? [String: String], request.userInfo)
        XCTAssertTrue(SessionNotificationRefresh.namesASession(userInfo: content.userInfo))
        let url = try XCTUnwrap(TalariaDeepLink.sessionURL(
            sessionID: try XCTUnwrap(content.userInfo[SessionNotificationRefresh.sessionIDKey] as? String),
            publisherID: content.userInfo["publisherId"] as? String))
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "session-abc")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), "https://approval-alert.test")
        await service.observe(prompt(nil), server: server)?.value
        await service.observe(prompt(""), server: server)?.value
        XCTAssertEqual(scheduler.requests.count, 1, "Never derive an alert identity from command text.")
    }


    @MainActor
    func testRetainedPushTokenDoesNotSuppressLocalApprovalWhenRelayApprovalPreferenceIsOff() async throws {
        let suite = "approval-relay-preference-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let keychain = InMemoryKeychainStore()
        try TalariaRelayConfigurationStore.save(TalariaRelayCredentials(
            baseURL: URL(string: "https://relay-alert.test")!, deviceID: "test-device",
            userID: "test-user", appleUserID: "test-apple-user", sessionToken: "synthetic-token",
            expiresAt: .distantFuture
        ), keychain: keychain)
        try TalariaRelayConfigurationStore.recordPairedPublisher(server, keychain: keychain)
        defaults.set("synthetic-push-token", forKey: TalariaRelayNotifications.pushTokenKey)
        defaults.set(false, forKey: TalariaRelayNotifications.isEnabledKey)
        let scheduler = ApprovalNotificationSpy(status: .authorized)
        let service = ApprovalNotificationService(scheduler: scheduler, preferenceEnabled: { true },
            sceneIsActive: { false }, relayOwnsAlerts: {
                TalariaRelayConfigurationStore.ownsApprovalAlerts(for: $0, keychain: keychain, defaults: defaults)
            })
        await service.observe(prompt("relay-alerts-off"), server: server)?.value
        XCTAssertEqual(scheduler.requests.count, 1, "A retained token must not suppress a local alert when relay approval alerts are disabled.")
        defaults.set(true, forKey: TalariaRelayNotifications.isEnabledKey)
        await service.observe(prompt("relay-alerts-on"), server: server)?.value
        XCTAssertEqual(scheduler.requests.count, 1, "Enabled, operational relay approval alerts own delivery.")
        defaults.removeObject(forKey: TalariaRelayNotifications.pushTokenKey)
        await service.observe(prompt("no-push-token"), server: server)?.value
        XCTAssertEqual(scheduler.requests.count, 2)
    }

    func testClarificationWaitUsesInputInEveryLocalLiveActivityLabel() {
        let initial = AgentRunActivityStateReducer.initialState(sessionID: "input-session", sessionTitle: "Synthetic input", startedAt: Date())
        let waiting = AgentRunActivityStateReducer.waitingForClarification(state: initial)
        XCTAssertEqual(waiting.status, .waitingForClarification)
        XCTAssertEqual(waiting.status.title, "Input")
        XCTAssertEqual(waiting.status.compactTitle, "Input")
        XCTAssertEqual(waiting.currentActivity, "Input")
    }

    private var server: URL { URL(string: "https://approval-alert.test/private/path")! }
    private func prompt(_ id: String?, sessionID: String = "session-abc") -> ApprovalPromptState {
        ApprovalPromptState(sessionID: sessionID,
            pending: PendingApproval(approvalId: id, command: "private command /private/path", description: "private transcript"),
            pendingCount: 2)
    }
}

@MainActor
private final class ApprovalNotificationTestDelegate: ChatPendingActionCoordinatorDelegate {
    var pendingActionSessionID: String? = "session-abc"
    var pendingActionHasActiveStream = true
    var pendingActionHasRunningClarificationTool = false
    var pendingActionIsStreamConnectionSuspended = false
    func pendingActionCoordinatorWillSubmitAction() {}
    func pendingActionCoordinatorDidFailAction(_ error: Error) {}
}

private final class ApprovalNotificationSpy: ApprovalNotificationScheduling {
    let status: UNAuthorizationStatus
    var onAuthorization: () -> Void = {}
    var requests: [ApprovalNotificationRequest] = []
    init(status: UNAuthorizationStatus) { self.status = status }
    func authorizationStatus() async -> UNAuthorizationStatus {
        onAuthorization()
        return status
    }
    func schedule(_ request: ApprovalNotificationRequest) async { requests.append(request) }
}
