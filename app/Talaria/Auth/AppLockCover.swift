import SwiftUI
import TalariaKit
import UIKit

/// The app lock's windows, one per window scene. Each sits above alerts, so it also covers sheets and menus, which an
/// overlay on `ContentView` would sit under. UIKit's scene notifications drive them rather than SwiftUI's `scenePhase`,
/// so a cover is up in the same call that reports its scene's phase: before the first frame of a cold launch and
/// before the app switcher's snapshot.
@MainActor
final class AppLockCoverPresenter {
    static let shared = AppLockCoverPresenter(model: .shared)
    static let windowIdentifier = "app-lock-cover"

    private let model: AppLockModel
    /// By the scene's persistent identifier, so every window gets its own cover (TAL-2387).
    private var covers: [String: UIWindow] = [:]
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
        observers.append(NotificationCenter.default.addObserver(
            forName: UIScene.didDisconnectNotification, object: nil, queue: nil
        ) { [weak self] notification in
            let scene = notification.object as? UIWindowScene
            MainActor.assumeIsolated { self?.disconnect(scene) }
        })
        followModel()
    }

    private func handle(scene: UIWindowScene?, phase: ScenePhase?) {
        guard let scene, scene.session.role == .windowApplication else { return }
        let id = scene.session.persistentIdentifier
        if covers[id] == nil { covers[id] = makeWindow(on: scene, id: id) }
        if let phase { model.sceneDidChange(phase, scene: id) }
        syncWindows()
    }

    private func disconnect(_ scene: UIWindowScene?) {
        guard let scene, scene.session.role == .windowApplication else { return }
        let id = scene.session.persistentIdentifier
        covers.removeValue(forKey: id)?.isHidden = true
        model.sceneDidDisconnect(id)
        syncWindows()
    }

    /// Follows the changes no scene notification reports: an unlock or the Settings switch.
    private func followModel() {
        withObservationTracking {
            _ = model.isEnabled
            _ = model.isLocked
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.syncWindows()
                self?.followModel()
            }
        }
    }

    private func makeWindow(on scene: UIWindowScene, id: String) -> UIWindow {
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.accessibilityIdentifier = Self.windowIdentifier
        // VoiceOver reads only the cover while it is up.
        window.accessibilityViewIsModal = true
        window.rootViewController = UIHostingController(rootView: coverView(scene: id))
        return window
    }

    private func coverView(scene: String) -> AppLockCoverView {
        AppLockCoverView(model: model, scene: scene, icon: .current)
    }

    private func syncWindows() {
        for (id, window) in covers { sync(window, scene: id) }
    }

    private func sync(_ window: UIWindow, scene: String) {
        if model.showsCover(in: scene) {
            if window.isHidden {
                // The icon can change in Settings, which SwiftUI doesn't observe.
                (window.rootViewController as? UIHostingController<AppLockCoverView>)?.rootView = coverView(scene: scene)
                window.isHidden = false
                UIAccessibility.post(notification: .screenChanged, argument: nil)
            }
            if model.isLocked, window.windowScene?.keyWindow !== window {
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
    let scene: String
    let icon: AppIconChoice
    @AppStorage(AppTheme.storageKey) private var appThemeRawValue = AppTheme.system.rawValue

    var body: some View {
        VStack(spacing: 28) {
            AppIconChoicePreview(icon: icon, size: 96)

            // Hidden rather than removed, so the icon stays in place when the button comes and goes.
            SettingsButton(String(localized: "Unlock")) { model.unlock() }
                .frame(maxWidth: 240)
                .opacity(model.showsUnlockButton(in: scene) ? 1 : 0)
                .disabled(!model.showsUnlockButton(in: scene))
                .accessibilityHidden(!model.showsUnlockButton(in: scene))
                .accessibilityIdentifier("app-lock-unlock")
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground).ignoresSafeArea())
        .preferredColorScheme(AppTheme.storedValue(appThemeRawValue).colorScheme)
    }
}
