import Foundation
import UserNotifications

/// How a run ended, for the local reply notification. Only the server's outcome
/// reaches here (a terminal stream event or the run journal's `terminal_state`);
/// a user Stop (cancelled) has no case, so it never notifies.
public enum ResponseCompletionOutcome: Equatable {
    case completed
    case failed

    public init?(status: AgentRunActivityStatus) {
        switch status {
        case .complete: self = .completed
        case .failed: self = .failed
        default: return nil
        }
    }
}

enum ResponseCompletionNotificationPolicy {
    /// Fire a reply notification when the user almost certainly isn't watching:
    /// notifications are enabled + permitted and the scene is not active when the
    /// run ends. Deliberately does NOT depend
    /// on any "was streaming" / "was backgrounded during the stream" memory — those
    /// in-memory flags were wiped on suspend→cold-relaunch, which is exactly when the
    /// stuck-mid-response reports happened (#248). Every in-session completion path
    /// funnels through one chokepoint, so scene-not-active is the only gate needed.
    static func shouldSchedule(
        preferenceEnabled: Bool,
        authorizationStatus: UNAuthorizationStatus,
        sceneIsActive: Bool
    ) -> Bool {
        preferenceEnabled
            && authorizationStatus.allowsResponseCompletionNotifications
            && !sceneIsActive
    }
}

public struct ResponseCompletionNotificationRequest: Equatable {
    let sessionID: String?
    /// The chat's display title, as the Chats list shows it.
    let chatTitle: String?
    let outcome: ResponseCompletionOutcome

    var title: String {
        let chatTitle = chatTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return chatTitle.isEmpty ? String(localized: "Hermes") : chatTitle
    }

    var body: String {
        switch outcome {
        case .completed: String(localized: "Response complete")
        case .failed: String(localized: "Response failed")
        }
    }

    var userInfo: [String: String] {
        guard let sessionID, !sessionID.isEmpty else { return [:] }
        return [SessionNotificationRefresh.sessionIDKey: sessionID]
    }
}

public struct ResponseCompletionNotificationCompletionContext: Equatable {
    public let sceneIsActive: Bool
}

public struct ResponseCompletionNotificationTracker {

    public init() {
    }

    private var lastHandledCompletionTrigger = 0

    public func shouldEndBackgroundTaskOnStreamInactive(completionTrigger: Int) -> Bool {
        completionTrigger <= lastHandledCompletionTrigger
    }

    /// Returns the completion context exactly once per completion trigger, so a run
    /// that completes is handled a single time even if the trigger is observed
    /// repeatedly. The scene state at completion is the only gate the policy needs.
    public mutating func completionContext(
        completionTrigger: Int,
        sceneIsActive: Bool
    ) -> ResponseCompletionNotificationCompletionContext? {
        guard completionTrigger > lastHandledCompletionTrigger else {
            return nil
        }

        lastHandledCompletionTrigger = completionTrigger
        return ResponseCompletionNotificationCompletionContext(sceneIsActive: sceneIsActive)
    }
}

public protocol ResponseCompletionNotificationScheduling {
    func authorizationStatus() async -> UNAuthorizationStatus
    func requestAuthorization() async -> Bool
    func schedule(_ request: ResponseCompletionNotificationRequest) async
}

public struct UserNotificationResponseCompletionScheduler: ResponseCompletionNotificationScheduling {
    public init() {}

    public func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    public func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                continuation.resume(returning: granted)
            }
        }
    }

    public func schedule(_ request: ResponseCompletionNotificationRequest) async {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.sound = .default
        content.userInfo = request.userInfo

        let identifierSessionPart: String
        if let sessionID = request.sessionID, !sessionID.isEmpty {
            identifierSessionPart = sessionID
        } else {
            identifierSessionPart = UUID().uuidString
        }
        let notificationRequest = UNNotificationRequest(
            identifier: "response-complete-\(identifierSessionPart)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )

        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().add(notificationRequest) { _ in
                continuation.resume()
            }
        }
    }
}

public enum ResponseCompletionNotificationService {
    public static func authorizationStatus(
        scheduler: any ResponseCompletionNotificationScheduling = UserNotificationResponseCompletionScheduler()
    ) async -> UNAuthorizationStatus {
        await scheduler.authorizationStatus()
    }

    public static func requestAuthorization(
        scheduler: any ResponseCompletionNotificationScheduling = UserNotificationResponseCompletionScheduler()
    ) async -> Bool {
        await scheduler.requestAuthorization()
    }

    @discardableResult
    public static func scheduleResponseCompletedIfAllowed(
        sessionID: String?,
        chatTitle: String?,
        outcome: ResponseCompletionOutcome,
        preferenceEnabled: Bool,
        sceneIsActive: Bool,
        scheduler: any ResponseCompletionNotificationScheduling = UserNotificationResponseCompletionScheduler()
    ) async -> Bool {
        let status = await authorizationStatus(scheduler: scheduler)
        guard ResponseCompletionNotificationPolicy.shouldSchedule(
            preferenceEnabled: preferenceEnabled,
            authorizationStatus: status,
            sceneIsActive: sceneIsActive
        ) else {
            return false
        }

        await scheduler.schedule(ResponseCompletionNotificationRequest(
            sessionID: sessionID,
            chatTitle: chatTitle,
            outcome: outcome
        ))
        return true
    }
}

private extension UNAuthorizationStatus {
    var allowsResponseCompletionNotifications: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined, .denied:
            return false
        @unknown default:
            return false
        }
    }
}


extension Notification.Name {
    /// Posted when a Talaria notification naming a session arrives while the app
    /// is in the foreground. The Chats list refreshes on it, so a run that just
    /// finished elsewhere appears as soon as the phone is told about it rather
    /// than waiting out the polling interval.
    public static let talariaSessionNotificationArrived = Notification.Name(
        "dev.kil.talaria.sessionNotificationArrived"
    )
}

public enum SessionNotificationRefresh {
    /// The `userInfo` key relay pushes and local notifications share for the session.
    public static let sessionIDKey = "sessionId"

    /// Only a notification that names a session says anything about the list.
    /// Relay and response-completion notifications both carry `sessionId`.
    public static func namesASession(userInfo: [AnyHashable: Any]) -> Bool {
        guard let sessionID = userInfo[sessionIDKey] as? String else { return false }
        return !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
