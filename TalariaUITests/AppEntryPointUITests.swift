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
            app.navigationBars["Chats"].waitForExistence(timeout: 20),
            "Missing deterministic app fixture"
        )
    }

    func returnToSessionList() {
        let chats = app.navigationBars["Chats"]
        for _ in 0..<3 where !chats.exists {
            let back = app.buttons["BackButton"]
            guard back.waitForExistence(timeout: 5) else { break }
            back.tap()
            _ = chats.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(chats.exists, "Did not return to the session list")
    }

    /// Icon changes and microphone access both raise a system alert over the app. Dismissing
    /// it keeps the journey deterministic; a preferred button keeps the simulator's own
    /// permission state fixed.
    @discardableResult
    func dismissSystemAlert(preferring buttonLabel: String? = nil, timeout: TimeInterval = 5) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.exists {
                if let buttonLabel, alert.buttons[buttonLabel].exists {
                    alert.buttons[buttonLabel].tap()
                } else {
                    alert.buttons.firstMatch.tap()
                }
                return true
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
            app.navigationBars["New Fixture Chat"].waitForExistence(timeout: 25),
            "talaria://new-chat did not open the New Chat composer"
        )

        returnToSessionList()

        // The fixture echoes the requested profile into the new session's title, so the
        // assertion proves the profile rode the link through to session creation.
        openThroughSystem(fixtureURL("new-chat-profile?profile=fixture-profile"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat (fixture-profile)"].waitForExistence(timeout: 25),
            "talaria://new-chat-profile did not pin the new chat to the requested profile"
        )
    }

    /// The voice variant opens the same composer and asks for dictation. Recognition itself
    /// stays out of CI: the microphone prompt is declined, which the composer degrades from.
    func testVoiceChatURLOpensTheComposerWithoutSiriRecognition() throws {
        launchFixtureOnSessionList()

        openThroughSystem(fixtureURL("new-chat-voice"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].waitForExistence(timeout: 25),
            "talaria://new-chat-voice did not open the New Chat composer"
        )
        dismissSystemAlert(preferring: "Don’t Allow")
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
            app.navigationBars["UI Fixture Session"].waitForExistence(timeout: 25),
            "talaria://session did not open the deep-linked session"
        )
    }

    /// The share extension writes its draft while Talaria is in the background and then opens
    /// `talaria://share`; the fixture seeds it the same way, so reopening has real work to do.
    /// Foregrounding imports too, so this asserts the user-visible contract rather than which
    /// of the two paths served it.
    func testAShareDraftArrivingWhileBackgroundedOpensTheComposer() throws {
        launchFixtureOnSessionList(additionalArguments: ["--ui-test-pending-share"])
        XCTAssertFalse(
            app.navigationBars["New Fixture Chat"].exists,
            "Nothing has been shared yet"
        )

        XCUIDevice.shared.press(.home)
        openThroughSystem(fixtureURL("share"))
        XCTAssertTrue(
            app.navigationBars["New Fixture Chat"].waitForExistence(timeout: 25),
            "Reopening through talaria://share did not import the shared draft"
        )

        // The inbox is empty now, so delivering the share URL again must not open a second
        // composer or bounce back to the list.
        openThroughSystem(fixtureURL("share"))
        XCTAssertFalse(
            app.navigationBars["Chats"].waitForExistence(timeout: 3),
            "A share URL with nothing pending changed navigation"
        )
        XCTAssertTrue(app.navigationBars["New Fixture Chat"].exists)
    }

    /// A URL for another app never reaches this app — the system routes by scheme — so the
    /// boundary that has to hold is a `talaria://` URL naming nothing this app declares.
    func testUnknownAndIncompleteURLsLeaveNavigationAlone() throws {
        launchFixtureOnSessionList()

        for url in ["not-a-destination", "session?id=", "new-chat-provider?provider=", "open"] {
            openThroughSystem(fixtureURL(url))
            XCTAssertFalse(
                app.navigationBars["New Fixture Chat"].waitForExistence(timeout: 3),
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
            app.navigationBars["New Fixture Chat"].waitForExistence(timeout: 25),
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

        let search = app.searchFields["Search sessions"]
        XCTAssertTrue(search.waitForExistence(timeout: 15), "Missing the session search field")
        XCTAssertFalse(hasKeyboardFocus(search), "Session search starts unfocused")

        XCTAssertTrue(
            pressCommand("f", until: hasKeyboardFocus(search)),
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
            if selectedChoice(icon).waitForExistence(timeout: 5) { return true }
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
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Missing the App Icon picker")
        guard !choice("System").exists else { return }
        tapRow(row)
        XCTAssertTrue(
            choice("System").waitForExistence(timeout: 5),
            "The App Icon choices did not expand"
        )
    }

    private func select(_ icon: String) {
        expandIconPicker()
        let choice = choice(icon)
        for _ in 0..<8 where !choice.exists {
            scrollSettingsRoot(up: true)
        }
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "Missing the \(icon) app icon choice")
        tapRow(choice)
        // Changing the icon raises the system's "you have changed the icon" alert.
        dismissSystemAlert()
        // A successful change collapses the picker. Waiting for that before re-reading it
        // keeps the next tap from landing on a row that is still animating away.
        _ = self.choice("System").waitForNonExistence(timeout: 5)
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
