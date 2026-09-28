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
    }
}
