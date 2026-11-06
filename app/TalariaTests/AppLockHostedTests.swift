import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
private final class ScriptedAuthenticator: AppLockAuthenticating {
    let method = AppLockMethod.faceID
    var results: [AppLockAuthentication]

    init(_ results: [AppLockAuthentication]) {
        self.results = results
    }

    func authenticate(reason: String) async -> AppLockAuthentication {
        results.isEmpty ? .succeeded : results.removeFirst()
    }
}

/// The cover window the real scene notifications drive; `AppLockTests` owns when the lock itself holds.
@MainActor
final class AppLockHostedTests: XCTestCase {
    private var scene: UIWindowScene!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        _ = HostedAccessibility.enableAutomation
        scene = try HostedScene.current()
        let name = "AppLockHostedTests.\(UUID())"
        defaults = UserDefaults(suiteName: name)
        addTeardownBlock { [scene] in
            UserDefaults().removePersistentDomain(forName: name)
            // Every observer of the host's scene, the App's own presenter included, returns to the truth.
            await MainActor.run {
                NotificationCenter.default.post(name: UIScene.didActivateNotification, object: scene)
            }
        }
    }

    private func model(enabled: Bool = true, results: [AppLockAuthentication] = []) -> AppLockModel {
        defaults.set(enabled, forKey: AppLockModel.isEnabledKey)
        return AppLockModel(defaults: defaults, authenticator: ScriptedAuthenticator(results))
    }

    private func post(_ name: Notification.Name) {
        NotificationCenter.default.post(name: name, object: scene)
    }

    private var visibleCover: UIWindow? {
        scene.windows.first { $0.accessibilityIdentifier == AppLockCoverPresenter.windowIdentifier && !$0.isHidden }
    }

    private func unlockButton(in cover: UIWindow) -> NSObject? {
        HostedAccessibility.elements(in: cover).first { $0.accessibilityLabel == String(localized: "Unlock") }
    }

    func testCoverIsUpInTheSameCallWheneverTheSceneIsNotActive() async throws {
        let model = model()
        let presenter = AppLockCoverPresenter(model: model)

        post(UIScene.willConnectNotification)
        let launchCover = try XCTUnwrap(visibleCover, "A cold launch is covered before its first frame")
        XCTAssertGreaterThan(launchCover.windowLevel, .alert, "Sheets and alerts stay beneath the cover")

        post(UIScene.didActivateNotification)
        await model.authentication?.value
        let uncovered = await awaitCondition { self.visibleCover == nil }
        XCTAssertTrue(uncovered, "Unlocking and activating uncovers the app")

        for name in [UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification,
                     UIScene.willEnterForegroundNotification] {
            post(name)
            XCTAssertNotNil(visibleCover, "\(name.rawValue) must put the cover up before the system's snapshot")
        }

        post(UIScene.didActivateNotification)
        XCTAssertNil(visibleCover)
        withExtendedLifetime(presenter) {}
    }

    func testAnOffLockNeverCovers() {
        let presenter = AppLockCoverPresenter(model: model(enabled: false))
        post(UIScene.willConnectNotification)
        post(UIScene.willDeactivateNotification)
        XCTAssertNil(visibleCover)
        post(UIScene.didActivateNotification)
        withExtendedLifetime(presenter) {}
    }

    func testLockedCoverTakesTheKeyWindowAndOffersUnlockOnlyWhileActive() async throws {
        let model = model(results: [.cancelled])
        let presenter = AppLockCoverPresenter(model: model)
        post(UIScene.willConnectNotification)
        let cover = try XCTUnwrap(visibleCover)
        XCTAssertNil(unlockButton(in: cover), "The app switcher shows the icon alone")

        post(UIScene.didActivateNotification)
        await model.authentication?.value
        let offered = await awaitCondition { self.unlockButton(in: cover) != nil }
        XCTAssertTrue(offered, "A cancel leaves Unlock")
        XCTAssertTrue(cover.isKeyWindow, "Keys must not reach the app behind the lock")

        post(UIScene.willDeactivateNotification)
        let withdrawn = await awaitCondition { self.unlockButton(in: cover) == nil }
        XCTAssertTrue(withdrawn, "The switcher never shows Unlock")

        post(UIScene.didActivateNotification)
        model.unlock()
        await model.authentication?.value
        let uncovered = await awaitCondition { self.visibleCover == nil }
        XCTAssertTrue(uncovered)
        XCTAssertFalse(cover.isKeyWindow, "The app's own window gets the keyboard back")
        withExtendedLifetime(presenter) {}
    }

    func testContentViewQueuesAnIntentDeepLinkUntilUnlock() async throws {
        let router = AppIntentRouter.shared
        addTeardownBlock { await MainActor.run { router.pendingDeepLink = nil } }
        let model = model(results: [.cancelled])
        model.sceneDidChange(.active)
        await model.authentication?.value

        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(
            ContentView(authManager: fixture.environment.authManager, appLock: model).modelContainer(fixture.cache)
        )
        let link = try XCTUnwrap(TalariaDeepLink.openAppURL)
        router.requestDeepLink(link)
        let queued = await awaitCondition { model.queuedDeepLinks == [link] }
        XCTAssertTrue(queued, "The router drains into the lock's queue, not into navigation")
        XCTAssertNil(router.pendingDeepLink)

        model.unlock()
        await model.authentication?.value
        let routed = await awaitCondition { model.queuedDeepLinks.isEmpty }
        XCTAssertTrue(routed, "Unlocking routes what the lock held")
        withExtendedLifetime(window) {}
    }
}
