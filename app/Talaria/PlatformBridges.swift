import TalariaKit
import UIKit

/// Connects TalariaKit's platform hooks to the App's UIKit, ActivityKit and App Intents implementations. TalariaKit
/// builds and tests on macOS, so it never calls those frameworks itself. `TalariaApp.init` runs this before anything
/// else, so every hook is in place before the first view model, session or activity exists.
enum PlatformBridges {
    @MainActor
    static func install() {
        #if DEBUG
        UITestURLSessionHook.configure = UITestFixtureURLProtocol.configure
        #endif
        HapticEmitter.perform = UIKitHaptics.perform
        HapticButtonHaptics.perform = UIKitHaptics.perform
        PlatformHooks.refreshProfileShortcuts = { ProfileEntityProvider.refreshAppShortcuts(changed: $0) }
        PlatformHooks.liveActivityManager = { AgentLiveActivityManager.shared }
        PlatformHooks.isApplicationActive = { UIApplication.shared.applicationState == .active }
        PlatformHooks.authenticateInBrowser = { url, scheme in
            try await OIDCWebAuthenticationPresenter.shared.authenticate(url: url, callbackScheme: scheme)
        }
        _ = AppLockCoverPresenter.shared
        _ = WindowActivity.shared
    }
}

/// TAL-2388: tells the event router which window was active last, and brings a window forward when it asks.
@MainActor
private final class WindowActivity {
    static let shared = WindowActivity(router: .shared)
    private var observers: [NSObjectProtocol] = []

    init(router: AppIntentRouter) {
        router.bringForward = { window in
            guard let session = UIApplication.shared.openSessions.first(where: { $0.persistentIdentifier == window })
            else { return }
            UIApplication.shared.activateSceneSession(for: UISceneSessionActivationRequest(session: session))
        }
        let center = NotificationCenter.default
        // A window becoming key is the user moving to it, though both windows stay active side by side.
        observers = [
            center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: nil) { notification in
                let scene = notification.object as? UIWindowScene
                MainActor.assumeIsolated { scene?.windowSceneID.map(router.windowDidBecomeActive) }
            },
            center.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: nil) { notification in
                let window = notification.object as? UIWindow
                MainActor.assumeIsolated { window?.windowScene?.windowSceneID.map(router.windowDidBecomeActive) }
            },
            center.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: nil) { notification in
                let scene = notification.object as? UIWindowScene
                MainActor.assumeIsolated { scene?.windowSceneID.map(router.windowDidClose) }
            }
        ]
    }
}

extension UIWindowScene {
    /// The identity a Talaria window goes by in the event router and the visible-chat registry (TAL-2388).
    var windowSceneID: String? {
        session.role == .windowApplication ? session.persistentIdentifier : nil
    }
}
