import Foundation
import UserNotifications

/// One preference gates the local approval and question alerts.
public enum ApprovalNotifications {
    public static let isEnabledKey = "approvalNotifications.isEnabled"
}

struct PendingActionNotificationRequest: Equatable {
    enum Kind: Hashable {
        case approval
        case question
    }

    let kind: Kind
    let sessionID: String
    let publisherID: String?

    var userInfo: [String: String] {
        var info = [SessionNotificationRefresh.sessionIDKey: sessionID]
        if let publisherID { info[SessionNotificationRefresh.publisherIDKey] = publisherID }
        return info
    }

    var content: UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        switch kind {
        case .approval:
            content.title = String(localized: "Approval required")
            content.body = String(localized: "An agent run is waiting for your approval.")
        case .question:
            content.title = String(localized: "Question waiting")
            content.body = String(localized: "An agent run is waiting for your answer.")
        }
        content.sound = .default
        content.userInfo = userInfo
        return content
    }
}

protocol PendingActionNotificationScheduling: Sendable {
    func authorizationStatus() async -> UNAuthorizationStatus
    func schedule(_ request: PendingActionNotificationRequest) async
}

extension UserNotificationResponseCompletionScheduler: PendingActionNotificationScheduling {
    func schedule(_ request: PendingActionNotificationRequest) async {
        let notification = UNNotificationRequest(
            identifier: "approval-\(UUID().uuidString)", content: request.content, trigger: nil
        )
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().add(notification) { _ in continuation.resume() }
        }
    }
}

/// Alerts once per approval or question queue head that becomes visible while Talaria is in the background.
/// Device-local delivery memory survives stream reconnection and recreation of the chat view.
/// Consume a head even when alerts are gated off, so foreground prompts never alert on backgrounding.
@MainActor
final class PendingActionNotificationService {
    static let shared = PendingActionNotificationService()

    private struct Identity: Hashable {
        let server: URL
        let sessionID: String
        let kind: PendingActionNotificationRequest.Kind
        let id: String
    }

    private var observed = Set<Identity>()
    private let scheduler: any PendingActionNotificationScheduling
    private let preferenceEnabled: @MainActor () -> Bool
    private let sceneIsActive: @MainActor () -> Bool
    private let relayOwnsAlerts: @MainActor (URL) -> Bool

    init(
        scheduler: any PendingActionNotificationScheduling = UserNotificationResponseCompletionScheduler(),
        preferenceEnabled: @escaping @MainActor () -> Bool = { UserDefaults.standard.bool(forKey: ApprovalNotifications.isEnabledKey) },
        sceneIsActive: @escaping @MainActor () -> Bool = { PlatformHooks.isApplicationActive() },
        relayOwnsAlerts: @escaping @MainActor (URL) -> Bool = { TalariaRelayConfigurationStore.ownsApprovalAlerts(for: $0) }
    ) {
        self.scheduler = scheduler
        self.preferenceEnabled = preferenceEnabled
        self.sceneIsActive = sceneIsActive
        self.relayOwnsAlerts = relayOwnsAlerts
    }

    @discardableResult
    func observe(_ prompt: ApprovalPromptState, server: URL) -> Task<Void, Never>? {
        observe(.approval, id: prompt.pending.approvalId, sessionID: prompt.sessionID, server: server)
    }

    @discardableResult
    func observe(_ prompt: ClarificationPromptState, server: URL) -> Task<Void, Never>? {
        observe(.question, id: prompt.requestID, sessionID: prompt.sessionID, server: server)
    }

    private func observe(
        _ kind: PendingActionNotificationRequest.Kind, id: String?, sessionID: String, server: URL
    ) -> Task<Void, Never>? {
        guard let id, !id.isEmpty, !sessionID.isEmpty,
              observed.insert(Identity(server: server, sessionID: sessionID, kind: kind, id: id)).inserted
        else { return nil }
        guard preferenceEnabled(), !sceneIsActive(), !relayOwnsAlerts(server) else { return nil }

        return Task { @MainActor in
            let status = await scheduler.authorizationStatus()
            // Recheck device state after the permission read yields, before scheduling a banner.
            guard ResponseCompletionNotificationPolicy.shouldSchedule(
                preferenceEnabled: preferenceEnabled() && !relayOwnsAlerts(server),
                authorizationStatus: status, sceneIsActive: sceneIsActive()
            ) else { return }
            await scheduler.schedule(PendingActionNotificationRequest(
                kind: kind, sessionID: sessionID, publisherID: TalariaRelayClient.originURL(server)?.absoluteString
            ))
        }
    }
}
