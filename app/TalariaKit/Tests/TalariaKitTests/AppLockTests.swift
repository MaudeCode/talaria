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
    /// Scene identifiers of two windows side by side.
    private let window = "window-a"
    private let otherWindow = "window-b"

    override func setUp() async throws {
        defaults = .ephemeral("AppLockTests")
    }

    private func coldLaunch(enabled: Bool = true) -> AppLockModel {
        defaults.set(enabled, forKey: AppLockModel.isEnabledKey)
        return AppLockModel(defaults: defaults, now: { self.instant }, authenticator: authenticator)
    }

    private func activate(_ model: AppLockModel, _ scene: String? = nil) async {
        model.sceneDidChange(.active, scene: scene ?? window)
        await model.authentication?.value
    }

    private func leave(_ model: AppLockModel, _ scene: String) {
        model.sceneDidChange(.inactive, scene: scene)
        model.sceneDidChange(.background, scene: scene)
    }

    /// A launch the user has unlocked, sitting in the foreground.
    private func unlockedModel() async -> AppLockModel {
        let model = coldLaunch()
        await activate(model)
        XCTAssertFalse(model.isLocked)
        return model
    }

    private func background(_ model: AppLockModel, for seconds: Int) async {
        model.sceneDidChange(.inactive, scene: window)
        model.sceneDidChange(.background, scene: window)
        instant = instant.advanced(by: .seconds(seconds))
        model.sceneDidChange(.inactive, scene: window)
        await activate(model)
    }

    func testColdLaunchLocksOnlyWhenEnabled() async {
        XCTAssertFalse(coldLaunch(enabled: false).isLocked)
        let disabled = coldLaunch(enabled: false)
        for phase in [ScenePhase.inactive, .background] {
            disabled.sceneDidChange(phase, scene: window)
            XCTAssertFalse(disabled.showsCover(in: window), "An off lock never covers a \(phase) window")
        }
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
        model.sceneDidChange(.inactive, scene: window)
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

    /// TAL-1470: an App Intent runs with the scene still in the background, so the minute away counts before it returns.
    func testBackgroundWorkSeesTheLockBeforeTheSceneReturns() async {
        let model = await unlockedModel()
        XCTAssertFalse(model.locksBackgroundWork())
        model.sceneDidChange(.background, scene: window)
        instant += .seconds(60)
        XCTAssertFalse(model.locksBackgroundWork(), "Within the grace period")
        instant += .seconds(1)
        XCTAssertTrue(model.locksBackgroundWork())
        XCTAssertTrue(coldLaunch().locksBackgroundWork(), "A launch for the intent alone starts locked")
        XCTAssertFalse(coldLaunch(enabled: false).locksBackgroundWork())
    }

    /// A deep link is delivered between entering the foreground and becoming active, so the lock must already hold.
    func testLockHoldsBeforeActivationSoAReturningDeepLinkQueues() async {
        let model = await unlockedModel()
        model.sceneDidChange(.background, scene: window)
        instant = instant.advanced(by: .seconds(61))
        model.sceneDidChange(.inactive, scene: window)
        XCTAssertTrue(model.isLocked)
        XCTAssertFalse(model.admitDeepLink(firstLink))
        XCTAssertEqual(authenticator.promptCount, 1, "The prompt waits for the scene to be active")
    }

    func testCancelDoesNotRePromptAndUnlockRetries() async {
        authenticator.results = [.cancelled]
        let model = coldLaunch()
        await activate(model)
        XCTAssertTrue(model.isLocked)
        XCTAssertTrue(model.showsUnlockButton(in: window))

        // The system prompt itself takes the scene through inactive, and leaving and coming back is the same lock.
        model.sceneDidChange(.inactive, scene: window)
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

    func testEnablingAppLockRequiresPurgingSpotlightAndBlocksNewDonations() async {
        let model = coldLaunch(enabled: false)
        let index = RecordingSessionSpotlightIndex()
        let indexer = SessionSpotlightIndexer(index: index, defaults: defaults)
        indexer.protect(with: model)
        let server = URL(string: "https://spotlight.test")!
        let first = SessionSummary(sessionId: "a", title: "Existing chat")
        let second = SessionSummary(sessionId: "b", title: "New chat")
        indexer.replace([first], for: server)
        await indexer.waitForPendingWrites()
        XCTAssertEqual(index.upserts.map(\.attributeSet.title), ["Existing chat"])

        index.failsDeleteAll = true
        let refused = await model.setEnabled(true)
        XCTAssertEqual(refused, .cancelled)
        XCTAssertFalse(model.isEnabled)

        index.failsDeleteAll = false
        let enabled = await model.setEnabled(true)
        XCTAssertEqual(enabled, .succeeded)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(index.deleteAllCalls, 2)
        indexer.replace([first, second], for: server)
        await indexer.waitForPendingWrites()
        XCTAssertEqual(index.upserts.map(\.attributeSet.title), ["Existing chat"])

        _ = await model.setEnabled(false)
        index.upserts.removeAll()
        indexer.replace([first, second], for: server)
        await indexer.waitForPendingWrites()
        XCTAssertEqual(Set(index.upserts.compactMap(\.attributeSet.title)), ["Existing chat", "New chat"])
    }

    func testLaunchingWithAppLockEnabledPurgesSpotlightBeforeAcceptingCacheRefreshes() async {
        let model = coldLaunch()
        let index = RecordingSessionSpotlightIndex()
        let indexer = SessionSpotlightIndexer(index: index, defaults: defaults)
        indexer.protect(with: model)
        indexer.replace([SessionSummary(sessionId: "a", title: "Private chat")], for: URL(string: "https://spotlight.test")!)
        await indexer.waitForPendingWrites()

        XCTAssertEqual(index.deleteAllCalls, 1)
        XCTAssertTrue(index.upserts.isEmpty)
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

    // MARK: - Two windows (TAL-2387)

    func testOneWindowAwayNeitherCoversTheOtherNorStartsTheTimer() async {
        let model = await unlockedModel()
        await activate(model, otherWindow)
        leave(model, otherWindow)
        XCTAssertFalse(model.showsCover(in: window), "The window still in use stays uncovered")
        XCTAssertTrue(model.showsCover(in: otherWindow), "The app switcher shows the away window covered")

        instant += .seconds(3600)
        model.sceneDidChange(.inactive, scene: otherWindow)
        await activate(model, otherWindow)
        XCTAssertFalse(model.isLocked, "The minute away starts only when the last window leaves")
        XCTAssertFalse(model.showsCover(in: otherWindow))
    }

    func testBothWindowsAwayPastTheGraceLockBoth() async {
        authenticator.results = [.succeeded, .cancelled]
        let model = await unlockedModel()
        await activate(model, otherWindow)
        leave(model, window)
        leave(model, otherWindow)
        instant += .seconds(61)
        model.sceneDidChange(.inactive, scene: window)
        XCTAssertTrue(model.isLocked)
        XCTAssertTrue(model.showsCover(in: window))
        XCTAssertTrue(model.showsCover(in: otherWindow))
    }

    func testOneUnlockClearsEveryWindow() async {
        authenticator.results = [.cancelled]
        let model = coldLaunch()
        await activate(model, window)
        await activate(model, otherWindow)
        XCTAssertEqual(authenticator.promptCount, 1, "One prompt for the app, not one per window")
        XCTAssertTrue(model.showsUnlockButton(in: window))
        XCTAssertTrue(model.showsUnlockButton(in: otherWindow))

        model.unlock()
        await model.authentication?.value
        XCTAssertFalse(model.showsCover(in: window))
        XCTAssertFalse(model.showsCover(in: otherWindow))
    }

    func testAClosedWindowNoLongerHoldsTheAppInTheForeground() async {
        let model = await unlockedModel()
        await activate(model, otherWindow)
        leave(model, window)
        instant += .seconds(30)
        model.sceneDidChange(.inactive, scene: otherWindow)
        model.sceneDidDisconnect(otherWindow)
        instant += .seconds(31)
        XCTAssertFalse(model.locksBackgroundWork(), "The minute away starts when the window in use closes")
        instant += .seconds(30)
        XCTAssertTrue(model.locksBackgroundWork())
    }

    /// The process can outlive its last window; reopening a minute later must find the app locked.
    func testClosingTheOnlyWindowStartsTheMinuteAway() async {
        let model = await unlockedModel()
        model.sceneDidChange(.inactive, scene: window)
        model.sceneDidDisconnect(window)
        instant += .seconds(61)
        XCTAssertTrue(model.locksBackgroundWork())
    }
}
