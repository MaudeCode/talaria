import Foundation
import UserNotifications

/// The install-wide offer shown after a new run starts from this phone's composer.
public enum NotificationOffer: Identifiable, Sendable {
    public static let hasOfferedKey = "notificationOffer.hasOffered"

    public enum Submission: Equatable, Sendable {
        case composer
        case slashCommand
        case streaming(StreamingSendBehavior)

        public var canOffer: Bool { self == .composer }
    }

    case local
    case relay

    public var id: Self { self }

    static func decision(
        after submission: Submission, hasOffered: Bool, authorizationStatus: UNAuthorizationStatus,
        responseCompletionEnabled: Bool, relayAlertsEnabled: Bool, relayConnected: Bool
    ) -> Self? {
        guard submission.canOffer, !hasOffered, authorizationStatus != .denied,
              !responseCompletionEnabled, !(relayConnected && relayAlertsEnabled) else { return nil }
        return relayConnected ? .relay : .local
    }

    /// Main-actor isolation keeps the read and write together across all visible chats.
    @MainActor public static func claim(
        after submission: Submission, authorizationStatus: UNAuthorizationStatus,
        relayConnected: Bool, defaults: UserDefaults = .standard
    ) -> Self? {
        let offer = decision(
            after: submission,
            hasOffered: defaults.bool(forKey: hasOfferedKey),
            authorizationStatus: authorizationStatus,
            responseCompletionEnabled: defaults.bool(forKey: ResponseCompletionNotifications.isEnabledKey),
            relayAlertsEnabled: defaults.bool(forKey: TalariaRelayNotifications.isEnabledKey)
                || TalariaRelayNotifications.updateAvailableAlertsEnabled(in: defaults),
            relayConnected: relayConnected
        )
        guard let offer else { return nil }
        defaults.set(true, forKey: hasOfferedKey)
        return offer
    }

    @discardableResult
    @MainActor public func enable(
        defaults: UserDefaults = .standard,
        requestAuthorization: @MainActor () async -> Bool = { await ResponseCompletionNotificationService.requestAuthorization() },
        whileCurrent: @MainActor () -> Bool = { true }
    ) async -> Bool {
        guard whileCurrent() else { return false }
        defaults.set(true, forKey: ResponseCompletionNotifications.hasRequestedPermissionKey)
        guard await requestAuthorization(), whileCurrent() else { return false }
        defaults.set(true, forKey: ResponseCompletionNotifications.isEnabledKey)
        defaults.set(true, forKey: self == .relay ? TalariaRelayNotifications.isEnabledKey : ApprovalNotifications.isEnabledKey)
        return true
    }
}
