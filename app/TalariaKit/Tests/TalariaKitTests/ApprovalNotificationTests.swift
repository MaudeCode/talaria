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
