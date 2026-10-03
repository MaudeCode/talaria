import Foundation
import UserNotifications

public enum ApprovalNotifications {
    public static let isEnabledKey = "approvalNotifications.isEnabled"
}

struct ApprovalNotificationRequest: Equatable {
    let sessionID: String
    let publisherID: String?

    var userInfo: [String: String] {
        var info = [SessionNotificationRefresh.sessionIDKey: sessionID]
        if let publisherID { info["publisherId"] = publisherID }
        return info
    }

    var content: UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Approval required")
        content.body = String(localized: "An agent run is waiting for your approval.")
        content.sound = .default
        content.userInfo = userInfo
        return content
    }
}

protocol ApprovalNotificationScheduling {
    func authorizationStatus() async -> UNAuthorizationStatus
    func schedule(_ request: ApprovalNotificationRequest) async
}

extension UserNotificationResponseCompletionScheduler: ApprovalNotificationScheduling {
    func schedule(_ request: ApprovalNotificationRequest) async {
        let notification = UNNotificationRequest(
            identifier: "approval-\(UUID().uuidString)", content: request.content, trigger: nil
        )
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().add(notification) { _ in continuation.resume() }
        }
    }
}

/// Device-local delivery memory survives stream reconnection and recreation of the chat view.
/// Consume a head even when alerts are gated off, so foreground prompts never alert on backgrounding.
@MainActor
final class ApprovalNotificationService {
    static let shared = ApprovalNotificationService()

    private struct Identity: Hashable {
        let server: URL
        let sessionID: String
        let approvalID: String
    }

    private var observed = Set<Identity>()
    private let scheduler: any ApprovalNotificationScheduling
    private let preferenceEnabled: @MainActor () -> Bool
    private let sceneIsActive: @MainActor () -> Bool
    private let relayOwnsAlerts: @MainActor (URL) -> Bool

    init(
        scheduler: any ApprovalNotificationScheduling = UserNotificationResponseCompletionScheduler(),
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
        guard let approvalID = prompt.pending.approvalId, !approvalID.isEmpty,
              !prompt.sessionID.isEmpty,
              observed.insert(Identity(server: server, sessionID: prompt.sessionID, approvalID: approvalID)).inserted
        else { return nil }
        guard preferenceEnabled(), !sceneIsActive(), !relayOwnsAlerts(server) else { return nil }

        return Task { @MainActor in
            let status = await scheduler.authorizationStatus()
            // Recheck device state after the permission read yields, before scheduling a banner.
            guard ResponseCompletionNotificationPolicy.shouldSchedule(
                preferenceEnabled: preferenceEnabled() && !relayOwnsAlerts(server),
                authorizationStatus: status, completedNormally: true, sceneIsActive: sceneIsActive()
            ) else { return }
            await scheduler.schedule(ApprovalNotificationRequest(
                sessionID: prompt.sessionID, publisherID: TalariaRelayClient.originURL(server)?.absoluteString
            ))
        }
    }
}
