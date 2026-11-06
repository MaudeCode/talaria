import SwiftUI
import XCTest
@testable import TalariaKit

@MainActor
private final class ScriptedAuthenticator: AppLockAuthenticating {
    var method = AppLockMethod.faceID
    var results: [AppLockAuthentication] = []
    /// Holds the next prompt open until `answer` runs, as iOS does while it asks.
    var holdsPrompt = false
    private var heldPrompt: CheckedContinuation<AppLockAuthentication, Never>?
    private(set) var promptCount = 0

    func authenticate(reason: String) async -> AppLockAuthentication {
        promptCount += 1
        if holdsPrompt {
            return await withCheckedContinuation { heldPrompt = $0 }
        }
        return results.isEmpty ? .succeeded : results.removeFirst()
    }

    func answer(_ result: AppLockAuthentication) {
        holdsPrompt = false
        heldPrompt?.resume(returning: result)
        heldPrompt = nil
    }
}

@MainActor
final class AppLockTests: XCTestCase {
    private var defaults: UserDefaults!
    private var instant = ContinuousClock.now
    private let authenticator = ScriptedAuthenticator()
    private let firstLink = URL(string: "talaria-test://first")!
    private let secondLink = URL(string: "talaria-test://second")!

    override func setUp() async throws {
        let name = "AppLockTests.\(UUID())"
        defaults = UserDefaults(suiteName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    }

    private func coldLaunch(enabled: Bool = true) -> AppLockModel {
        defaults.set(enabled, forKey: AppLockModel.isEnabledKey)
        return AppLockModel(defaults: defaults, now: { self.instant }, authenticator: authenticator)
    }

    private func activate(_ model: AppLockModel) async {
        model.sceneDidChange(.active)
        await model.authentication?.value
    }

    /// A launch the user has unlocked, sitting in the foreground.
    private func unlockedModel() async -> AppLockModel {
        let model = coldLaunch()
        await activate(model)
        XCTAssertFalse(model.isLocked)
        return model
    }

    private func background(_ model: AppLockModel, for seconds: Int) async {
        model.sceneDidChange(.inactive)
        model.sceneDidChange(.background)
        instant = instant.advanced(by: .seconds(seconds))
        model.sceneDidChange(.inactive)
        await activate(model)
    }

    func testColdLaunchLocksOnlyWhenEnabled() async {
        XCTAssertFalse(coldLaunch(enabled: false).isLocked)
        let disabled = coldLaunch(enabled: false)
        await activate(disabled)
        XCTAssertEqual(authenticator.promptCount, 0, "An off lock never prompts")

        XCTAssertTrue(coldLaunch(enabled: true).isLocked)
    }

    func testColdLaunchPromptsOnActivationAndSuccessUnlocks() async {
        let model = coldLaunch()
        XCTAssertEqual(authenticator.promptCount, 0, "iOS refuses a prompt before the scene is active")
        await activate(model)
        XCTAssertEqual(authenticator.promptCount, 1)
        XCTAssertFalse(model.isLocked)
    }

    func testInactiveThenActiveNeverLocks() async {
        let model = await unlockedModel()
        model.sceneDidChange(.inactive)
        instant = instant.advanced(by: .seconds(3600))
        await activate(model)
        XCTAssertFalse(model.isLocked)
        XCTAssertEqual(authenticator.promptCount, 1)
    }

    func testBackgroundLocksOnlyAfterMoreThan60Seconds() async {
        let model = await unlockedModel()
        await background(model, for: 60)
        XCTAssertFalse(model.isLocked)
        XCTAssertEqual(authenticator.promptCount, 1, "Returning within the grace period does not prompt")

        authenticator.results = [.cancelled]
        await background(model, for: 61)
        XCTAssertTrue(model.isLocked)
        XCTAssertEqual(authenticator.promptCount, 2)
    }

    /// A deep link is delivered between entering the foreground and becoming active, so the lock must already hold.
    func testLockHoldsBeforeActivationSoAReturningDeepLinkQueues() async {
        let model = await unlockedModel()
        model.sceneDidChange(.background)
        instant = instant.advanced(by: .seconds(61))
        model.sceneDidChange(.inactive)
        XCTAssertTrue(model.isLocked)
        XCTAssertFalse(model.admitDeepLink(firstLink))
        XCTAssertEqual(authenticator.promptCount, 1, "The prompt waits for the scene to be active")
    }

    func testCancelDoesNotRePromptAndUnlockRetries() async {
        authenticator.results = [.cancelled]
        let model = coldLaunch()
        await activate(model)
        XCTAssertTrue(model.isLocked)
        XCTAssertTrue(model.showsUnlockButton)

        // The system prompt itself takes the scene through inactive, and leaving and coming back is the same lock.
        model.sceneDidChange(.inactive)
        await activate(model)
        await background(model, for: 3600)
        XCTAssertEqual(authenticator.promptCount, 1, "One prompt per lock")

        model.unlock()
        await model.authentication?.value
        XCTAssertEqual(authenticator.promptCount, 2)
        XCTAssertFalse(model.isLocked)
    }

    func testDeepLinksQueuedWhileLockedRouteInOrderAfterUnlock() async {
        authenticator.results = [.cancelled]
        let model = coldLaunch()
        await activate(model)

        XCTAssertFalse(model.admitDeepLink(firstLink))
        XCTAssertFalse(model.admitDeepLink(secondLink))
        XCTAssertEqual(model.queuedDeepLinks, [firstLink, secondLink])

        model.unlock()
        await model.authentication?.value
        XCTAssertEqual(model.takeQueuedDeepLinks(), [firstLink, secondLink])
        XCTAssertEqual(model.takeQueuedDeepLinks(), [], "Each link routes once")
        XCTAssertTrue(model.admitDeepLink(firstLink), "Unlocked links route straight away")
    }

    func testTurningTheLockOnAndOffRequiresAuthentication() async {
        let model = coldLaunch(enabled: false)
        await activate(model)

        authenticator.results = [.cancelled]
        let cancelled = await model.setEnabled(true)
        XCTAssertEqual(cancelled, .cancelled)
        XCTAssertFalse(model.isEnabled)
        XCTAssertFalse(defaults.bool(forKey: AppLockModel.isEnabledKey))

        let enabled = await model.setEnabled(true)
        XCTAssertEqual(enabled, .succeeded)
        XCTAssertTrue(model.isEnabled)
        XCTAssertTrue(defaults.bool(forKey: AppLockModel.isEnabledKey))
        XCTAssertFalse(model.isLocked, "Turning the lock on does not lock the person who just authenticated")

        authenticator.results = [.cancelled]
        _ = await model.setEnabled(false)
        XCTAssertTrue(model.isEnabled)

        _ = await model.setEnabled(false)
        XCTAssertFalse(model.isEnabled)
        XCTAssertFalse(defaults.bool(forKey: AppLockModel.isEnabledKey))
        XCTAssertEqual(authenticator.promptCount, 4)
    }

    func testSwitchShowsTheChoiceWhileIOSAsks() async {
        let model = coldLaunch(enabled: false)
        await activate(model)
        authenticator.holdsPrompt = true
        let change = Task { await model.setEnabled(true) }
        while authenticator.promptCount == 0 { await Task.yield() }
        XCTAssertTrue(model.switchPosition)
        XCTAssertFalse(model.isEnabled, "The stored choice waits for the answer")

        authenticator.answer(.cancelled)
        _ = await change.value
        XCTAssertFalse(model.switchPosition, "A refusal rolls the switch back")
    }

    func testTheLockCannotTurnOnWithoutAPasscode() async {
        authenticator.results = [.unavailable]
        let model = coldLaunch(enabled: false)
        await activate(model)
        let result = await model.setEnabled(true)
        XCTAssertEqual(result, .unavailable)
        XCTAssertFalse(model.isEnabled)
    }

    /// Removing the passcode takes the passcode, so the owner did it; without this they could never reopen the app.
    func testRemovedPasscodeTurnsTheLockOffInsteadOfLockingOut() async {
        authenticator.results = [.unavailable]
        let model = coldLaunch()
        await activate(model)
        XCTAssertFalse(model.isLocked)
        XCTAssertFalse(model.isEnabled)
        XCTAssertFalse(defaults.bool(forKey: AppLockModel.isEnabledKey))
    }
}
