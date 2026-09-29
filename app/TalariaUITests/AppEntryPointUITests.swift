import XCTest

/// Installed-app entry points (TAL-77): URL delivery through the system, App Intent routing,
/// hardware-keyboard commands, and alternate app icons. Every journey runs against the
/// deterministic fixture server, so no owner server, real account, or Siri recognition is
/// involved — Siri phrase matching is deliberately out of scope for CI.
class AppEntryPointUITestCase: TalariaUITestCase {
    /// Debug and Release register `talaria`; only the branch TestFlight build appends a
    /// suffix, and the test action never uses that configuration.
    private static let scheme = "talaria"

    func fixtureURL(_ hostAndQuery: String) -> URL {
        URL(string: "\(Self.scheme)://\(hostAndQuery)")!
    }

    /// Delivers a URL the way the system does, so the app's real `onOpenURL` boundary runs.
    /// The fixture app must already be running: a cold `open` would relaunch it without the
    /// fixture launch arguments and land on onboarding instead.
    func openThroughSystem(_ url: URL) {
        XCUIDevice.shared.system.open(url)
    }

    func launchFixtureOnSessionList(additionalArguments: [String] = []) {
        launchFixture(additionalArguments: additionalArguments)
        XCTAssertTrue(
            app.navigationBars["Chats"].awaitExistence(timeout: 20),
            "Missing deterministic app fixture"
        )
    }

    /// Matches on label *or* value: composer text arrives as an element value, row text as a
    /// label.
    func element(carrying text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", text, text))
            .firstMatch
    }

    /// Icon changes and microphone access both raise a system alert over the app, and
    /// dismissing it keeps the journey deterministic. A named button also identifies *which*
    /// alert counts: an alert without that button is left alone and reported as not dismissed,
    /// so a caller asserting on the return value cannot be satisfied by an unrelated alert.
    @discardableResult
    func dismissSystemAlert(preferring buttonLabel: String? = nil, timeout: TimeInterval = 5) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.exists {
                guard let buttonLabel else {
                    alert.buttons.firstMatch.tap()
                    return true
                }
                let button = alert.buttons[buttonLabel]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        return false
    }
}

/// The new-chat family of deep links, each of which must land on its own composer.
final class NewChatDeepLinkUITests: AppEntryPointUITestCase {
    func testNewChatAndProfileURLsOpenTheirOwnComposer() throws {
        launchFixtureOnSessionList()

        openThroughSystem(fixtureURL("new-chat"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 25),
            "talaria://new-chat did not open the New Chat composer"
        )

        returnToSessionList()

        // The fixture echoes the requested profile into the new session's title, so the
        // assertion proves the profile rode the link through to session creation.
        openThroughSystem(fixtureURL("new-chat-profile?profile=fixture-profile"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat (fixture-profile)"].awaitExistence(timeout: 25),
            "talaria://new-chat-profile did not pin the new chat to the requested profile"
        )
    }

    /// The voice variant opens the same composer *and* starts dictation. The prompt is the
    /// evidence that dictation was attempted — a plain new chat never asks — so the test owns
    /// the microphone permission by resetting it first. Recognition itself stays out of CI:
    /// access is declined, and the composer degrades to a clear error.
    func testVoiceChatURLOpensTheComposerAndStartsDictation() throws {
        app.resetAuthorizationStatus(for: .microphone)
        launchFixtureOnSessionList()

        openThroughSystem(fixtureURL("new-chat-voice"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 25),
            "talaria://new-chat-voice did not open the New Chat composer"
        )
        XCTAssertTrue(
            dismissSystemAlert(preferring: "Don’t Allow", timeout: 20),
            "The voice variant never asked for microphone access, so dictation did not start"
        )
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].exists,
            "Declining dictation must leave the composer open"
        )
    }
}

/// Session and share delivery, plus the URLs that must leave navigation alone.
final class SessionAndShareDeepLinkUITests: AppEntryPointUITestCase {
    func testSessionURLOpensTheDeepLinkedSession() throws {
        launchFixtureOnSessionList()

        openThroughSystem(fixtureURL("session?id=ui-fixture-session"))
        XCTAssertTrue(
            app.navigationBars["UI Fixture Session"].awaitExistence(timeout: 25),
            "talaria://session did not open the deep-linked session"
        )
    }

    /// The share extension writes its draft while Talaria is in the background and then opens
    /// `talaria://share`; the fixture seeds it the same way, so reopening has real work to do.
    /// Foregrounding imports too, so this asserts the user-visible contract rather than which
    /// of the two paths served it.
    func testAShareDraftArrivingWhileBackgroundedReachesTheComposerOnce() throws {
        launchFixtureOnSessionList(additionalArguments: ["--ui-test-pending-share"])
        XCTAssertFalse(
            app.navigationBars["New Fixture Chat"].exists,
            "Nothing has been shared yet"
        )

        XCUIDevice.shared.press(.home)
        openThroughSystem(fixtureURL("share"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 25),
            "Reopening through talaria://share did not import the shared draft"
        )
        XCTAssertTrue(
            element(carrying: "FixtureSharedDraft").awaitExistence(timeout: 15),
            "The shared text was routed away and never reached the composer"
        )

        // Marking the draft makes a repeat import visible: a second one would open a composer
        // carrying the seeded text alone, so a surviving marker means this composer was left
        // alone rather than replaced.
        let input = app.textViews.firstMatch
        XCTAssertTrue(input.awaitExistence(timeout: 10), "The shared draft did not open an editable composer")
        input.tap()
        input.typeText(" MarkedByTest")
        XCTAssertTrue(element(carrying: "MarkedByTest").awaitExistence(timeout: 5))

        // The inbox is empty now, so delivering the share URL again must import nothing.
        openThroughSystem(fixtureURL("share"))
        XCTAssertFalse(
            app.navigationBars["Chats"].awaitExistence(timeout: 3),
            "A share URL with nothing pending changed navigation"
        )
        XCTAssertTrue(
            element(carrying: "MarkedByTest").awaitExistence(timeout: 10),
            "A second share URL replaced the composer, so the record was imported twice"
        )
    }

    /// A URL for another app never reaches this app — the system routes by scheme — so the
    /// boundary that has to hold is a `talaria://` URL naming nothing this app declares.
    func testUnknownAndIncompleteURLsLeaveNavigationAlone() throws {
        launchFixtureOnSessionList()

        for url in ["not-a-destination", "session?id=", "new-chat-provider?provider=", "open"] {
            openThroughSystem(fixtureURL(url))
            XCTAssertFalse(
                app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 3),
                "talaria://\(url) opened a new chat"
            )
            XCTAssertFalse(
                app.navigationBars["UI Fixture Session"].exists,
                "talaria://\(url) opened a session"
            )
            XCTAssertTrue(
                app.navigationBars["Chats"].exists,
                "talaria://\(url) navigated away from the session list"
            )
        }
    }
}

/// App Intent delivery. XCUITest has no supported way to run an App Intent through
/// Shortcuts, Spotlight, or Siri deterministically, so the fixture runs the shipping intent
/// itself at launch; everything after `perform()` — the router and `ContentView`'s drain,
/// whether it lands on the initial pass or the `onChange` one — is the code path a real
/// Action-button press takes.
final class AppIntentEntryPointUITests: AppEntryPointUITestCase {
    func testNewChatIntentOpensTheComposerAtLaunch() throws {
        launchFixture(additionalArguments: ["--ui-test-intent-new-chat"])
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 25),
            "The New Chat App Intent did not open the composer"
        )
    }
}

/// Hardware-keyboard commands. `typeKey` is available on every simulator destination the
/// scheme runs on, so these checks never skip.
final class KeyboardCommandUITests: AppEntryPointUITestCase {
    func testNewChatCommandOpensANewChat() throws {
        launchFixtureOnSessionList()

        let newChat = app.navigationBars["New Fixture Chat"]
        XCTAssertTrue(
            pressCommand("n", until: newChat.exists),
            "Command-N did not open a new chat"
        )
    }

    func testSearchCommandFocusesSessionSearch() throws {
        launchFixtureOnSessionList()

        XCTAssertNotNil(waitForSessionSearchControl(timeout: 15), "Missing the session search control")
        let search = sessionSearchField
        XCTAssertFalse(search.exists && hasKeyboardFocus(search), "Session search starts unfocused")

        XCTAssertTrue(
            pressCommand("f", until: search.exists && hasKeyboardFocus(search)),
            "Command-F did not focus session search"
        )
    }

    /// A key command pressed right after launch can land before the scene has installed its
    /// key commands, and the keystroke is then simply dropped. Press again rather than read
    /// that race as a missing shortcut.
    private func pressCommand(
        _ key: String,
        until isSatisfied: @autoclosure () -> Bool,
        attempts: Int = 3,
        timeout: TimeInterval = 5
    ) -> Bool {
        for _ in 0..<attempts {
            app.typeKey(key, modifierFlags: .command)
            let deadline = Date().addingTimeInterval(timeout)
            repeat {
                if isSatisfied() { return true }
                Thread.sleep(forTimeInterval: 0.2)
            } while Date() < deadline
        }
        return false
    }

    private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        element.value(forKey: "hasKeyboardFocus") as? Bool == true
    }
}

/// Alternate app icons. The fixture restores the primary icon at launch, and this journey
/// leaves the simulator back on System, so a reused device starts every run the same way.
final class AppIconSwitchingUITests: AppEntryPointUITestCase {
    private static let alternates = [
        "Light", "Dark", "Disco",
        "Monochrome Light", "Monochrome Dark",
        "Gradient Light", "Gradient Dark"
    ]

    func testEveryAlternateIconAppliesAndReturnsToSystem() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "appearance", title: "Appearance")

        for icon in Self.alternates + ["System"] {
            XCTAssertTrue(
                applyIcon(icon),
                "The app icon never changed to \(icon); its alternate icon resource is missing or was rejected"
            )
        }
    }

    /// iOS rejects alternate-icon changes made in quick succession — the picker surfaces
    /// "Resource temporarily unavailable" — so a rejected change is paced and retried. Only a
    /// change that never lands means the icon resource itself is missing.
    private func applyIcon(_ icon: String, attempts: Int = 4) -> Bool {
        for attempt in 0..<attempts {
            if attempt > 0 {
                Thread.sleep(forTimeInterval: 2)
            }
            select(icon)
            if selectedChoice(icon).awaitExistence(timeout: 5) { return true }
        }
        return false
    }

    private var iconRow: XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "App Icon"))
            .firstMatch
    }

    /// The picker collapses after a successful change, so each selection re-expands it.
    private func expandIconPicker() {
        let row = iconRow
        for _ in 0..<8 where !row.exists {
            scrollSettingsRoot(up: true)
        }
        XCTAssertTrue(row.awaitExistence(timeout: 5), "Missing the App Icon picker")
        guard !choice("System").exists else { return }
        tapRow(row)
        XCTAssertTrue(
            choice("System").awaitExistence(timeout: 5),
            "The App Icon choices did not expand"
        )
    }

    private func select(_ icon: String) {
        expandIconPicker()
        let choice = choice(icon)
        for _ in 0..<8 where !choice.exists {
            scrollSettingsRoot(up: true)
        }
        XCTAssertTrue(choice.awaitExistence(timeout: 5), "Missing the \(icon) app icon choice")
        tapRow(choice)
        // Changing the icon raises the system's "you have changed the icon" alert.
        dismissSystemAlert()
        // A successful change collapses the picker. Waiting for that before re-reading it
        // keeps the next tap from landing on a row that is still animating away.
        _ = self.choice("System").awaitNonExistence(timeout: 5)
        expandIconPicker()
    }

    /// Scrolls the row fully into the viewport and taps where it has come to rest: a
    /// coordinate taken while the list is still gliding lands on a neighbouring icon.
    private func tapRow(_ row: XCUIElement) {
        let top = app.navigationBars.firstMatch.frame.maxY
        for _ in 0..<10 {
            let frame = settledFrame(of: row)
            guard frame.minY < top || frame.maxY > app.frame.maxY else { break }
            scrollSettingsRoot(up: frame.maxY > app.frame.maxY)
        }
        let frame = settledFrame(of: row)
        XCTAssertTrue(
            frame.minY >= top && frame.maxY <= app.frame.maxY,
            "Could not bring the row into view: \(frame)"
        )
        tapCenter(of: row)
    }

    private func settledFrame(of element: XCUIElement) -> CGRect {
        var last = element.frame
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.2)
            let next = element.frame
            if next == last { return next }
            last = next
        }
        return last
    }

    private func choice(_ icon: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "\(icon)."))
            .firstMatch
    }

    private func selectedChoice(_ icon: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND value == %@", "\(icon).", "Selected"))
            .firstMatch
    }
}

final class ReauthenticationUITests: AppEntryPointUITestCase {
    func testSessionLossSignsInOverExistingSessionList() {
        let row = triggerRecovery()
        let password = app.secureTextFields["ReauthenticatePassword"]
        XCTAssertTrue(password.awaitExistence(timeout: 15))
        XCTAssertFalse(app.textFields["Server URL"].exists)
        XCTAssertTrue(password.isEnabled)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "In-place reauthentication"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        password.tap()
        password.typeText("fixture-password")
        app.buttons["ReauthenticateSignIn"].tap()
        XCTAssertTrue(password.awaitNonExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Chats"].exists)
        XCTAssertTrue(row.awaitExistence(timeout: 10))
        XCTAssertTrue(row.isEnabled)
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["BackButton"].awaitExistence(timeout: 10))
    }

    func testTrustedHeaderRecoveryCanRetryWithoutSigningOut() {
        _ = triggerRecovery(additionalArguments: ["--ui-test-reauthentication-trusted"])
        let retry = app.buttons["ReauthenticateRetry"]
        XCTAssertTrue(retry.awaitExistence(timeout: 15))
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@", "This server signs in through an identity proxy"
        )).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Trusted-header recovery"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Connection Headers"].tap()
        let addHeader = app.buttons["Add header"]
        for _ in 0..<5 where !addHeader.exists || !addHeader.isHittable { app.swipeUp() }
        addHeader.tap()
        let name = app.textFields["Header name"]
        XCTAssertTrue(name.awaitExistence(timeout: 5))
        name.tap()
        name.typeText("X-Fixture-Authorization")
        let value = app.secureTextFields["Header value"]
        value.tap()
        value.typeText("fixture-token")
        for _ in 0..<5 where !retry.exists || !retry.isHittable { app.swipeDown() }
        retry.tap()
        XCTAssertTrue(retry.awaitNonExistence(timeout: 15))
        // This title is returned only by a new request carrying the repaired header.
        XCTAssertTrue(app.staticTexts["Header recovery confirmed"].awaitExistence(timeout: 10))
    }

    func testSSOIsPrimaryWithPasswordAvailableThroughTextLink() {
        _ = triggerRecovery(additionalArguments: ["--ui-test-reauthentication-both"])
        let sso = app.buttons["ReauthenticateSSO"]
        let methodSwitch = app.buttons["ReauthenticateSwitchMethod"]
        XCTAssertTrue(sso.awaitExistence(timeout: 15))
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists)
        XCTAssertEqual(methodSwitch.label, "Sign in with password")
        methodSwitch.tap()
        XCTAssertTrue(app.secureTextFields["ReauthenticatePassword"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.buttons["ReauthenticateSignIn"].exists)
        XCTAssertFalse(sso.exists)
        methodSwitch.tap()
        XCTAssertTrue(sso.awaitExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists)
    }

    private func triggerRecovery(additionalArguments: [String] = []) -> XCUIElement {
        launchFixtureOnSessionList(additionalArguments: ["--ui-test-reauthentication"] + additionalArguments)
        let row = app.buttons.containing(.staticText, identifier: "UI Fixture Session").firstMatch
        XCTAssertTrue(row.awaitExistence(timeout: 10))
        // Returning to the list triggers its normal refresh without leaving a
        // pull-to-refresh animation running behind the authentication sheet.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let back = app.buttons["BackButton"]
        let recovery = app.staticTexts["Your session expired. Sign in again."]
        // A foreground refresh can expire the session before navigation finishes,
        // for example when a native permission alert interrupts the row tap.
        XCTAssertTrue(poll(timeout: 10) { back.exists || recovery.exists })
        if !recovery.exists { back.tap() }
        return row
    }
}
