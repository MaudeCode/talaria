import Foundation
import UserNotifications

enum ResponseCompletionNotificationPolicy {
    /// Fire a "response complete" notification when the user almost certainly isn't
    /// watching: notifications are enabled + permitted, the run finished normally,
    /// and the scene is not active at completion time. Deliberately does NOT depend
    /// on any "was streaming" / "was backgrounded during the stream" memory — those
    /// in-memory flags were wiped on suspend→cold-relaunch, which is exactly when the
    /// stuck-mid-response reports happened (#248). Every in-session completion path
    /// funnels through one chokepoint, so scene-not-active is the only gate needed.
    static func shouldSchedule(
        preferenceEnabled: Bool,
        authorizationStatus: UNAuthorizationStatus,
        completedNormally: Bool,
        sceneIsActive: Bool
    ) -> Bool {
        guard preferenceEnabled,
              authorizationStatus.allowsResponseCompletionNotifications,
              completedNormally,
              !sceneIsActive else {
            return false
        }

        return true
    }
}

public struct ResponseCompletionNotificationRequest: Equatable {
    static let title = String(localized: "Hermes response complete")
    static let body = String(localized: "The assistant finished responding.")

    let sessionID: String?

    var userInfo: [String: String] {
        guard let sessionID, !sessionID.isEmpty else { return [:] }
        return ["session_id": sessionID]
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
        content.title = ResponseCompletionNotificationRequest.title
        content.body = ResponseCompletionNotificationRequest.body
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
        preferenceEnabled: Bool,
        completedNormally: Bool,
        sceneIsActive: Bool,
        scheduler: any ResponseCompletionNotificationScheduling = UserNotificationResponseCompletionScheduler()
    ) async -> Bool {
        let status = await authorizationStatus(scheduler: scheduler)
        guard ResponseCompletionNotificationPolicy.shouldSchedule(
            preferenceEnabled: preferenceEnabled,
            authorizationStatus: status,
            completedNormally: completedNormally,
            sceneIsActive: sceneIsActive
        ) else {
            return false
        }

        await scheduler.schedule(ResponseCompletionNotificationRequest(sessionID: sessionID))
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
    /// Only a notification that names a session says anything about the list.
    /// Relay and response-completion notifications both carry `sessionId`.
    public static func namesASession(userInfo: [AnyHashable: Any]) -> Bool {
        guard let sessionID = userInfo["sessionId"] as? String else { return false }
        return !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
