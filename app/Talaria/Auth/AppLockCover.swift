import SwiftUI
import TalariaKit
import UIKit

/// The app lock's window. It sits above alerts, so it also covers sheets and menus, which an overlay on `ContentView`
/// would sit under. UIKit's scene notifications drive it rather than SwiftUI's `scenePhase`, so it is up in the same
/// call that reports the phase: before the first frame of a cold launch and before the app switcher's snapshot.
@MainActor
final class AppLockCoverPresenter {
    static let shared = AppLockCoverPresenter(model: .shared)
    static let windowIdentifier = "app-lock-cover"

    private let model: AppLockModel
    private var window: UIWindow?
    private var host: UIHostingController<AppLockCoverView>?
    private var observers: [NSObjectProtocol] = []

    init(model: AppLockModel) {
        self.model = model
        let phases: [(Notification.Name, ScenePhase?)] = [
            (UIScene.willConnectNotification, nil),
            (UIScene.willDeactivateNotification, .inactive),
            (UIScene.didEnterBackgroundNotification, .background),
            (UIScene.willEnterForegroundNotification, .inactive),
            (UIScene.didActivateNotification, .active)
        ]
        observers = phases.map { name, phase in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] notification in
                let scene = notification.object as? UIWindowScene
                MainActor.assumeIsolated { self?.handle(scene: scene, phase: phase) }
            }
        }
        followModel()
    }

    private func handle(scene: UIWindowScene?, phase: ScenePhase?) {
        guard let scene, scene.session.role == .windowApplication else { return }
        if window == nil { makeWindow(on: scene) }
        if let phase { model.sceneDidChange(phase) }
        syncWindow()
    }

    /// Follows the changes no scene notification reports: an unlock or the Settings switch.
    private func followModel() {
        withObservationTracking {
            _ = model.showsCover
            _ = model.isLocked
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.syncWindow()
                self?.followModel()
            }
        }
    }

    private func makeWindow(on scene: UIWindowScene) {
        let host = UIHostingController(rootView: AppLockCoverView(model: model, icon: .current))
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.accessibilityIdentifier = Self.windowIdentifier
        // VoiceOver reads only the cover while it is up.
        window.accessibilityViewIsModal = true
        window.rootViewController = host
        self.host = host
        self.window = window
    }

    private func syncWindow() {
        guard let window else { return }
        if model.showsCover {
            if window.isHidden {
                // The icon can change in Settings, which SwiftUI doesn't observe.
                host?.rootView = AppLockCoverView(model: model, icon: .current)
                window.isHidden = false
                UIAccessibility.post(notification: .screenChanged, argument: nil)
            }
            if model.isLocked, !window.isKeyWindow {
                // The keyboard floats above every window, and keys must not reach the app behind the lock.
                let resign = #selector(UIResponder.resignFirstResponder)
                UIApplication.shared.sendAction(resign, to: nil, from: nil, for: nil)
                window.makeKey()
            }
        } else if !window.isHidden {
            window.isHidden = true
            window.windowScene?.windows.first { $0 !== window && $0.windowLevel == .normal && !$0.isHidden }?.makeKey()
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
    }
}

struct AppLockCoverView: View {
    let model: AppLockModel
    let icon: AppIconChoice
    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue

    var body: some View {
        VStack(spacing: 28) {
            AppIconChoicePreview(icon: icon, size: 96)

            // Hidden rather than removed, so the icon stays in place when the button comes and goes.
            SettingsButton(String(localized: "Unlock")) { model.unlock() }
                .frame(maxWidth: 240)
                .opacity(model.showsUnlockButton ? 1 : 0)
                .disabled(!model.showsUnlockButton)
                .accessibilityHidden(!model.showsUnlockButton)
                .accessibilityIdentifier("app-lock-unlock")
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground).ignoresSafeArea())
        .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
    }
}
