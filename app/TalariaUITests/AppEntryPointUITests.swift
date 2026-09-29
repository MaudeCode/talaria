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

/// App Intent and deep-link delivery, in one launch: every destination has to land on its own
/// screen, and a URL naming nothing this app declares has to leave navigation alone.
final class NewChatDeepLinkUITests: AppEntryPointUITestCase {
    func testIntentAndDeepLinksOpenTheirOwnDestinations() throws {
        // The voice link's microphone prompt is the evidence that dictation started, so the
        // test owns the permission by resetting it before launch.
        app.resetAuthorizationStatus(for: .microphone)

        // XCUITest has no supported way to run an App Intent through Shortcuts, Spotlight, or
        // Siri deterministically, so the fixture runs the shipping intent itself at launch;
        // everything after `perform()` — the router and `ContentView`'s drain, whether it lands
        // on the initial pass or the `onChange` one — is the code path a real Action-button
        // press takes.
        launchFixture(additionalArguments: ["--ui-test-intent-new-chat"])
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 25),
            "The New Chat App Intent did not open the composer"
        )
        returnToSessionList()

        // A URL for another app never reaches this app — the system routes by scheme — so the
        // boundary that has to hold is a `talaria://` URL naming nothing this app declares.
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

        openThroughSystem(fixtureURL("session?id=ui-fixture-session"))
        XCTAssertTrue(
            app.navigationBars["UI Fixture Session"].awaitExistence(timeout: 25),
            "talaria://session did not open the deep-linked session"
        )
        returnToSessionList()

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
        returnToSessionList()

        // The voice variant opens the same composer *and* starts dictation; a plain new chat
        // never asks for the microphone. Recognition itself stays out of CI: access is
        // declined, and the composer degrades to a clear error.
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

/// Share delivery needs its own launch: the fixture seeds the draft whenever the app backgrounds.
/// The hardware-keyboard commands run in the same launch, after the share.
final class SessionAndShareDeepLinkUITests: AppEntryPointUITestCase {
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

        // The fixture seeds the draft once the app has entered the background; on a slow runner
        // that lands after a URL opened right behind the home press, which then finds nothing.
        sendToBackground()
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

        returnToSessionList()
        assertSearchAndNewChatCommands()
    }

    /// Hardware-keyboard commands. `typeKey` is available on every simulator destination the
    /// scheme runs on, so these checks never skip. Starts on the session list.
    private func assertSearchAndNewChatCommands() {
        XCTAssertNotNil(waitForSessionSearchControl(timeout: 15), "Missing the session search control")
        let search = sessionSearchField
        XCTAssertFalse(search.exists && hasKeyboardFocus(search), "Session search starts unfocused")
        XCTAssertTrue(
            pressCommand("f", until: search.exists && hasKeyboardFocus(search)),
            "Command-F did not focus session search"
        )

        let newChat = app.navigationBars["New Fixture Chat"]
        XCTAssertTrue(
            pressCommand("n", until: newChat.exists),
            "Command-N did not open a new chat"
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
            if poll(timeout: timeout, until: isSatisfied) { return true }
        }
        return false
    }

    private func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        element.value(forKey: "hasKeyboardFocus") as? Bool == true
    }
}

/// Appearance: the theme picker and the alternate app icon picker, which applies one alternate
/// through the system; `AppIconAlternateTests` (TalariaTests) checks that every alternate the
/// picker offers ships in the app (TAL-402). The fixture restores the primary icon and the theme at
/// every launch, so a reused device starts each run the same way.
final class AppIconSwitchingUITests: AppEntryPointUITestCase {
    func testThemeAndAppIconPickersShowTheirChoiceAndApplyAnAlternate() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "appearance", title: "Appearance")

        let theme = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Theme"))
            .firstMatch
        XCTAssertTrue(theme.awaitExistence(timeout: 3), "Missing the Theme picker")
        XCTAssertTrue(theme.staticTexts["System"].exists, "The Theme row should show the current theme")

        tapCenter(of: theme)
        let dark = app.buttons["Dark"]
        XCTAssertTrue(dark.awaitExistence(timeout: 3), "The Theme picker did not open")
        dark.tap()
        XCTAssertTrue(
            theme.staticTexts["Dark"].awaitExistence(timeout: 3),
            "Selecting a theme did not update the row"
        )

        // Restore the shared simulator's appearance; the fixture also resets it on launch.
        tapCenter(of: theme)
        let system = app.buttons["System"]
        XCTAssertTrue(system.awaitExistence(timeout: 3))
        system.tap()
        XCTAssertTrue(theme.staticTexts["System"].awaitExistence(timeout: 3))

        let row = iconRow
        repeatStep(8, until: { row.exists }) {
            app.swipeUp()
        }
        XCTAssertTrue(row.exists, "Missing the App Icon picker")
        XCTAssertTrue(row.label.contains("System"), "The App Icon row should name the current icon")
        expandIconPicker()
        XCTAssertTrue(choice("Disco").awaitExistence(timeout: 3), "The App Icon choices did not expand")
        XCTAssertTrue(selectedChoice("System").exists, "The current app icon is not marked as selected")

        // One alternate through the picker and the system; the fixture restores the primary icon
        // at every launch (TAL-402).
        XCTAssertTrue(
            applyIcon("Disco"),
            "The app icon never changed to Disco; its alternate icon resource is missing or was rejected"
        )
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
        repeatStep(8, until: { row.exists }) {
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
        repeatStep(8, until: { choice.exists }) {
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
        let bottom = app.frame.maxY
        var frame = row.settledFrame
        repeatStep(10, until: { frame.minY >= top && frame.maxY <= bottom }) {
            scrollSettingsRoot(up: frame.maxY > bottom)
            frame = row.settledFrame
        }
        XCTAssertTrue(
            frame.minY >= top && frame.maxY <= bottom,
            "Could not bring the row into view: \(frame)"
        )
        tap(at: CGPoint(x: frame.midX, y: frame.midY))
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
    func testTrustedHeaderRecoveryCanRetryWithoutSigningOut() {
        _ = triggerRecovery(additionalArguments: ["--ui-test-reauthentication-trusted"])
        let retry = app.buttons["ReauthenticateRetry"]
        XCTAssertTrue(retry.awaitExistence(timeout: 15))
        _ = retry.settledFrame
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@", "This server signs in through an identity proxy"
        )).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Trusted-header recovery"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let addHeader = app.buttons["Add header"]
        // A tap while the sheet is still sliding in can be dropped, so expand until the row shows.
        repeatStep(3, until: { addHeader.exists }) {
            app.buttons["Connection Headers"].tap()
            _ = addHeader.awaitExistence(timeout: 3)
        }
        repeatStep(5, until: { addHeader.exists && addHeader.isHittable }) { app.swipeUp() }
        // The sheet is still gliding after the swipe; tap once it rests.
        _ = addHeader.settledFrame
        addHeader.tap()
        let name = app.textFields["Header name"]
        XCTAssertTrue(name.awaitExistence(timeout: 5))
        name.tap()
        name.typeText("X-Fixture-Authorization")
        let value = app.secureTextFields["Header value"]
        value.tap()
        value.typeText("fixture-token")
        repeatStep(5, until: { retry.exists && retry.isHittable }) { app.swipeDown() }
        _ = retry.settledFrame
        retry.tap()
        XCTAssertTrue(retry.awaitNonExistence(timeout: 15))
        // This title is returned only by a new request carrying the repaired header.
        XCTAssertTrue(app.staticTexts["Header recovery confirmed"].awaitExistence(timeout: 10))
    }

    /// A server offering SSO and a password: SSO is primary, the text link switches between the
    /// two, and signing in with the password recovers the session over the existing session list.
    /// A password-only server shows the same password sheet without the link (TAL-402).
    func testSSOIsPrimaryAndPasswordSignInRecoversOverTheSessionList() {
        let row = triggerRecovery(additionalArguments: ["--ui-test-reauthentication-both"])
        let sso = app.buttons["ReauthenticateSSO"]
        let methodSwitch = app.buttons["ReauthenticateSwitchMethod"]
        XCTAssertTrue(sso.awaitExistence(timeout: 15))
        // The sign-in sheet slides up; a tap on its way can be dropped.
        _ = sso.settledFrame
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists)
        XCTAssertEqual(methodSwitch.label, "Sign in with password")
        methodSwitch.tap()
        let password = app.secureTextFields["ReauthenticatePassword"]
        XCTAssertTrue(password.awaitExistence(timeout: 5))
        XCTAssertTrue(app.buttons["ReauthenticateSignIn"].exists)
        XCTAssertFalse(sso.exists)
        methodSwitch.tap()
        XCTAssertTrue(sso.awaitExistence(timeout: 5))
        XCTAssertFalse(password.exists)
        methodSwitch.tap()

        XCTAssertTrue(password.awaitExistence(timeout: 5))
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
