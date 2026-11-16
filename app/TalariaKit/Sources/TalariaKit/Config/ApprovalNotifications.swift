import Foundation
import UserNotifications

/// One preference gates the local approval and question alerts.
public enum ApprovalNotifications {
    public static let isEnabledKey = "approvalNotifications.isEnabled"
}

/// TAL-1469: what a Relay push or local alert for a waiting request offers on its banner. Allow sits only beside the whole
/// text of what it approves (TAL-1463), the server's `action_text`, so an approval alert without it offers Deny alone;
/// Relay's never carries it. A question offers Reply. Each answer names the request the alert showed, and the App answers
/// nothing else.
public enum PendingActionNotificationCategory {
    /// Deny only: the alert names its approval but not what it runs. Relay sets it as `aps.category`.
    public static let approval = "talaria.approval"
    /// Allow and Deny: the alert's body is the whole text of what the approval runs.
    public static let approvalShowingAction = "talaria.approval.allow"
    /// Reply. Relay sets it as `aps.category`.
    public static let input = "talaria.input"
    /// TAL-1488: Undo, on the "Denied · Undo" banner posted while a Deny waits out its window with no Live Activity.
    public static let denied = "talaria.denied"

    public static let allowAction = "allow"
    public static let denyAction = "deny"
    public static let replyAction = "reply"
    public static let undoAction = "undo"

    /// The approval a Relay push names: its queue head, as on a Live Activity.
    public static let approvalHeadIDKey = "approvalHeadId"
    /// The approval a local alert names: its id.
    public static let approvalIDKey = "approvalId"
    /// The question a Relay push names: its queue head.
    public static let inputHeadIDKey = "inputHeadId"
    /// The question a local alert names: its id.
    public static let clarifyIDKey = "clarifyId"

    /// Registered at launch. Every answer acts on the user's server, so a locked device authenticates first.
    public static var all: Set<UNNotificationCategory> {
        let allow = UNNotificationAction(identifier: allowAction, title: String(localized: "Allow"), options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: denyAction, title: String(localized: "Deny"), options: [.authenticationRequired, .destructive]
        )
        let reply = UNTextInputNotificationAction(
            identifier: replyAction, title: String(localized: "Reply"), options: [.authenticationRequired],
            textInputButtonTitle: String(localized: "Send"), textInputPlaceholder: ""
        )
        return [
            UNNotificationCategory(identifier: approval, actions: [deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: approvalShowingAction, actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: input, actions: [reply], intentIdentifiers: []),
            // Undo sends nothing, so it needs no authentication inside its five seconds.
            UNNotificationCategory(
                identifier: denied, actions: [UNNotificationAction(identifier: undoAction, title: String(localized: "Undo"))],
                intentIdentifiers: []
            ),
        ]
    }
}

struct PendingActionNotificationRequest: Equatable {
    enum Kind: Hashable {
        case approval
        case question
    }

    let kind: Kind
    let sessionID: String
    let publisherID: String?
    /// The approval or question the alert's Deny or Reply answers; an alert without one offers no actions.
    var promptID: String? = nil
    /// The server's whole text of what the approval runs (`action_text`), shown beside Allow.
    var approvalAction: String? = nil

    var userInfo: [String: String] {
        var info = [SessionNotificationRefresh.sessionIDKey: sessionID]
        if let publisherID { info[SessionNotificationRefresh.publisherIDKey] = publisherID }
        if let promptID {
            info[kind == .approval ? PendingActionNotificationCategory.approvalIDKey : PendingActionNotificationCategory.clarifyIDKey] = promptID
        }
        return info
    }

    var content: UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        switch kind {
        case .approval:
            content.title = String(localized: "Approval required")
            content.body = approvalAction ?? String(localized: "An agent run is waiting for your approval.")
            if promptID != nil {
                content.categoryIdentifier = approvalAction == nil
                    ? PendingActionNotificationCategory.approval : PendingActionNotificationCategory.approvalShowingAction
            }
        case .question:
            content.title = String(localized: "Question waiting")
            content.body = String(localized: "An agent run is waiting for your answer.")
            if promptID != nil { content.categoryIdentifier = PendingActionNotificationCategory.input }
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
        observe(.approval, id: prompt.pending.approvalId, sessionID: prompt.sessionID, server: server,
                promptID: prompt.pending.approvalId, approvalAction: prompt.pending.actionText)
    }

    @discardableResult
    func observe(_ prompt: ClarificationPromptState, server: URL) -> Task<Void, Never>? {
        observe(.question, id: prompt.requestID, sessionID: prompt.sessionID, server: server, promptID: prompt.pending.clarifyId)
    }

    private func observe(
        _ kind: PendingActionNotificationRequest.Kind, id: String?, sessionID: String, server: URL,
        promptID: String?, approvalAction: String? = nil
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
                kind: kind, sessionID: sessionID, publisherID: TalariaRelayClient.originURL(server)?.absoluteString,
                promptID: promptID.flatMap { $0.isEmpty ? nil : $0 }, approvalAction: approvalAction
            ))
        }
    }
}
