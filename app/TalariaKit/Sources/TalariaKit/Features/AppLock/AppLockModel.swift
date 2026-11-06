import Foundation
import LocalAuthentication
import Observation
import SwiftUI

/// How this device proves its owner, which names the Settings switch.
public enum AppLockMethod: Sendable {
    case faceID, touchID, passcode

    public var settingsTitle: String {
        switch self {
        case .faceID: String(localized: "Require Face ID")
        case .touchID: String(localized: "Require Touch ID")
        case .passcode: String(localized: "Require Passcode")
        }
    }

    public var systemImage: String {
        switch self {
        case .faceID: "faceid"
        case .touchID: "touchid"
        case .passcode: "lock"
        }
    }
}

public enum AppLockAuthentication: Sendable {
    case succeeded
    case cancelled
    /// The device has no passcode, so nothing can prove its owner.
    case unavailable
}

@MainActor
public protocol AppLockAuthenticating {
    var method: AppLockMethod { get }
    func authenticate(reason: String) async -> AppLockAuthentication
}

/// Biometry with the device passcode as its fallback.
public struct DeviceOwnerAuthenticator: AppLockAuthenticating {
    public init() {}

    public var method: AppLockMethod {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        default: return .passcode
        }
    }

    public func authenticate(reason: String) async -> AppLockAuthentication {
        do {
            return try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
                ? .succeeded : .cancelled
        } catch LAError.passcodeNotSet {
            return .unavailable
        } catch {
            return .cancelled
        }
    }
}

/// The app lock: off until turned on, it locks on a cold launch and after more than a minute in the background.
/// Device-local, so nothing here reaches the server or iCloud sync.
@MainActor
@Observable
public final class AppLockModel {
    public static let shared = AppLockModel()
    public static let isEnabledKey = "appLock.isEnabled"
    private static let backgroundGrace = Duration.seconds(60)

    public private(set) var isEnabled: Bool
    public private(set) var isLocked: Bool
    public private(set) var isAuthenticating = false
    /// Starts false: a launch is covered until its scene first activates.
    public private(set) var isSceneActive = false
    public private(set) var queuedDeepLinks: [URL] = []
    /// The choice being authenticated, which the Settings switch shows until iOS answers.
    private var requestedEnabled: Bool?
    private var didPromptForThisLock = false
    private var backgroundedAt: ContinuousClock.Instant?
    /// The prompt in flight, for tests to await.
    private(set) var authentication: Task<Void, Never>?

    private let defaults: UserDefaults
    private let now: @MainActor () -> ContinuousClock.Instant
    private let authenticator: any AppLockAuthenticating

    /// The clock is monotonic, so setting the device's date back cannot shorten the time away.
    public init(
        defaults: UserDefaults = .standard,
        now: @escaping @MainActor () -> ContinuousClock.Instant = { .now },
        authenticator: any AppLockAuthenticating = DeviceOwnerAuthenticator()
    ) {
        self.defaults = defaults
        self.now = now
        self.authenticator = authenticator
        isEnabled = defaults.bool(forKey: Self.isEnabledKey)
        isLocked = defaults.bool(forKey: Self.isEnabledKey)
    }

    public var method: AppLockMethod { authenticator.method }
    public var switchPosition: Bool { requestedEnabled ?? isEnabled }
    public var showsCover: Bool { isEnabled && (isLocked || !isSceneActive) }
    public var showsUnlockButton: Bool { isLocked && isSceneActive && !isAuthenticating }

    public func sceneDidChange(_ phase: ScenePhase) {
        isSceneActive = phase == .active
        switch phase {
        case .background:
            backgroundedAt = backgroundedAt ?? now()
        case .inactive:
            // Entering the foreground: a deep link arrives before the scene activates, so the lock holds by then.
            lockIfAwayTooLong()
        case .active:
            lockIfAwayTooLong()
            backgroundedAt = nil
            if isLocked, !didPromptForThisLock {
                didPromptForThisLock = true
                unlock()
            }
        @unknown default:
            break
        }
    }

    private func lockIfAwayTooLong() {
        guard isEnabled, !isLocked, let backgroundedAt, backgroundedAt.duration(to: now()) > Self.backgroundGrace else {
            return
        }
        isLocked = true
        didPromptForThisLock = false
    }

    public func unlock() {
        guard isLocked, !isAuthenticating else { return }
        isAuthenticating = true
        authentication = Task {
            let result = await authenticator.authenticate(reason: String(localized: "Unlock Talaria"))
            isAuthenticating = false
            switch result {
            case .succeeded: isLocked = false
            case .cancelled: break
            // Removing the passcode takes the passcode, so the owner did it. Staying locked would lock them out.
            case .unavailable: store(enabled: false)
            }
        }
    }

    /// Asks iOS, then stores the choice. Turning off with no passcode left succeeds: nothing could unlock it anyway.
    @discardableResult
    public func setEnabled(_ enabled: Bool) async -> AppLockAuthentication {
        guard enabled != isEnabled, !isAuthenticating else { return .cancelled }
        isAuthenticating = true
        requestedEnabled = enabled
        let result = await authenticator.authenticate(reason: String(localized: "Change the app lock"))
        isAuthenticating = false
        requestedEnabled = nil
        if result == .succeeded || (result == .unavailable && !enabled) {
            store(enabled: enabled)
        }
        return result
    }

    private func store(enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.isEnabledKey)
        if !enabled { isLocked = false }
    }

    /// True when `url` may route now. A locked app holds it for `takeQueuedDeepLinks` after unlock.
    public func admitDeepLink(_ url: URL) -> Bool {
        guard isLocked else { return true }
        queuedDeepLinks.append(url)
        return false
    }

    public func takeQueuedDeepLinks() -> [URL] {
        defer { queuedDeepLinks = [] }
        return queuedDeepLinks
    }
}
