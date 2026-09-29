import XCTest

/// End-to-end coverage for sharing into Talaria (TAL-81). Everything here runs through the
/// real system share sheet and the installed extension process: the app-group handoff, the
/// containing-app launch, the composer import, the cleanup after consumption, and the copy
/// shown when input is refused.
///
/// The host is Talaria's own DEBUG `--ui-test-share-host` bar, so a run owns every byte it
/// shares and depends on no pre-existing photo, document, or account. Each host launch also
/// empties the shared inbox, so nothing carries over between tests.
class ShareExtensionUITestCase: TalariaUITestCase {
    static let fixtureText = "TalariaShareFixtureText"
    static let fixtureURL = "https://share.fixture.invalid/talaria"

    // MARK: - Harness

    /// Mirrors `ShareExtensionUITestPayload`, which lives in the app target.
    enum Payload: String {
        case text
        case url
        case attachments
        case unsupported
        case oversizedFile
        case oversizedTotal
    }

    func launchShareHost() {
        launch(arguments: ["--ui-test-fixture", "--ui-test-share-host", "--ui-test-share-reset"])
        XCTAssertTrue(
            app.buttons["share-host-text"].awaitExistence(timeout: 30),
            "Missing the share host fixture"
        )
    }

    /// Right after launch a tap can land before the bar takes input, and nothing on screen shows
    /// the mode, so wait until the switch is tappable first.
    func selectOpenMode(_ identifier: String) {
        let button = app.buttons[identifier]
        XCTAssertTrue(button.awaitExistence(timeout: 15), "Missing the \(identifier) switch")
        XCTAssertTrue(waitUntilHittable(button, timeout: 30), "The \(identifier) switch never became tappable")
        button.tap()
    }

    func share(_ payload: Payload) {
        let button = app.buttons["share-host-\(payload.rawValue)"]
        XCTAssertTrue(button.awaitExistence(timeout: 15), "Missing the \(payload.rawValue) share button")
        // A previous round's sheet can still be dismissing over the bar, and a tap
        // synthesized then lands on nothing.
        XCTAssertTrue(
            waitUntilHittable(button, timeout: 30),
            "The \(payload.rawValue) share button never became tappable"
        )
        button.tap()
    }

    func shareToTalaria(_ payload: Payload) {
        share(payload)
        let sheet = app.otherElements["ActivityListView"]
        XCTAssertTrue(sheet.awaitExistence(timeout: 20), "The system share sheet did not open")
        let talaria = talariaActivity(in: sheet)
        XCTAssertTrue(talaria.awaitExistence(timeout: 20), "Talaria is not offered for \(payload.rawValue)")
        XCTAssertTrue(
            waitUntilHittable(talaria, timeout: 20),
            "The Talaria share activity never became tappable"
        )
        talaria.tap()
    }

    func talariaActivity(in sheet: XCUIElement) -> XCUIElement {
        sheet.cells.matching(NSPredicate(format: "label == %@", "Talaria")).firstMatch
    }

    func assertExtensionStatus(_ text: String, timeout: TimeInterval = 30) {
        XCTAssertTrue(
            element(labelContaining: text).awaitExistence(timeout: timeout),
            "The share extension never showed: \(text)"
        )
    }

    func inboxSummary() -> String {
        app.staticTexts["share-host-inbox"].label
    }

    func waitForInbox(_ summary: String, timeout: TimeInterval = 20) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)

        repeat {
            if inboxSummary() == summary { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline

        return false
    }

    func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)

        repeat {
            if element.isHittable { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline

        return false
    }

    func waitForComposerDraft(containing text: String, timeout: TimeInterval = 30) -> String? {
        let composer = app.textViews.firstMatch
        let deadline = Date().addingTimeInterval(timeout)

        repeat {
            if composer.exists, let value = composer.value as? String, value.contains(text) {
                return value
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline

        return nil
    }
}

/// Shares that reach the composer, on the shipping open path and the private-selector workaround.
final class ShareExtensionUITests: ShareExtensionUITestCase {
    /// The whole happy path: sheet, extension, app group, containing-app launch, composer.
    /// Consuming the draft has to clear it, so a later launch cannot replay it.
    func testSharedTextReachesTheComposerAndIsConsumed() throws {
        launchShareHost()

        shareToTalaria(.text)
        XCTAssertNotNil(
            waitForComposerDraft(containing: Self.fixtureText),
            "Shared text never reached the composer"
        )

        // Consumption is asynchronous, so watch the inbox rather than assume it finished:
        // a still-reserved record would make every assertion below pass for the wrong
        // reason, since reserved items are not re-offered for 15 minutes.
        XCTAssertTrue(
            waitForInbox("inbox pending=0 reserved=0"),
            "The imported item was never cleaned up: \(inboxSummary())"
        )

        // Relaunch with the host but without a reset, so nothing clears the inbox for us:
        // whatever the app finds is what consumption actually left behind.
        app.terminate()
        launch(arguments: ["--ui-test-fixture", "--ui-test-share-host"])

        XCTAssertTrue(
            app.navigationBars["Chats"].awaitExistence(timeout: 30),
            "The relaunch did not land on the session list"
        )
        XCTAssertFalse(
            app.staticTexts["Another shared item is waiting"].exists,
            "A consumed import was still queued after the app imported it"
        )
        XCTAssertNil(
            waitForComposerDraft(containing: Self.fixtureText, timeout: 3),
            "A consumed import was replayed into a new composer"
        )
        XCTAssertEqual(inboxSummary(), "inbox pending=0 reserved=0", "The share inbox was not left empty")
    }

    /// One share carrying text, a URL, an image, a PDF, and a generic file, delivered through
    /// the private-selector workaround behind `NSExtensionContext.open`: the draft and every
    /// attachment have to survive the handoff. The workaround is the App Review risk in
    /// `ShareViewController`, so this pins whether it still reaches the containing app on the OS
    /// the suite runs against; the shipping open path runs in the text test above. A URL-only
    /// share's extraction is `ShareInputReaderTests` (TAL-402).
    func testWorkaroundOpenPathDeliversTextURLAndAttachments() throws {
        launchShareHost()
        selectOpenMode("share-host-open-mode-workaround")

        shareToTalaria(.attachments)
        let draft = waitForComposerDraft(containing: Self.fixtureText)
        XCTAssertNotNil(
            draft,
            """
            The containing-app workaround no longer opens Talaria on \
            \(ProcessInfo.processInfo.operatingSystemVersionString), or the mixed share never \
            reached the composer.
            """
        )
        XCTAssertTrue(draft?.contains(Self.fixtureURL) == true, "The shared URL was dropped: \(draft ?? "")")

        for filename in ["fixture-image.png", "fixture-document.pdf", "fixture-file.dat"] {
            XCTAssertTrue(
                element(labelContaining: filename).awaitExistence(timeout: 30),
                "The composer is missing the shared attachment \(filename)"
            )
        }
    }
}

/// Shares the extension refuses or cannot hand over, in one launch and its manual reopen: a file
/// over the size limit, the manual-open fallback, and content the activation rule rejects. The
/// aggregate limit's copy and reading are `ShareInputReaderTests` (TAL-402).
final class ShareExtensionRefusalUITests: ShareExtensionUITestCase {
    func testRefusedAndUnopenedSharesExplainThemselves() throws {
        launchShareHost()
        selectOpenMode("share-host-open-mode-manual")

        // One file over the per-item limit explains itself and reaches no composer.
        shareToTalaria(.oversizedFile)
        assertExtensionStatus("Talaria accepts text, URLs, images, PDFs, and files up to 20 MB.")
        XCTAssertNil(
            waitForComposerDraft(containing: "fixture-", timeout: 3),
            "Refused content still opened a composer"
        )

        // When no launch path works the extension says so, and the draft has to survive for
        // the next time the user opens Talaria themselves.
        shareToTalaria(.text)
        assertExtensionStatus("Shared content saved. Open Talaria manually.")
        XCTAssertNil(
            waitForComposerDraft(containing: Self.fixtureText, timeout: 5),
            "The fallback path opened the app anyway"
        )
        // Unconsumed means untouched: the draft has to still be sitting in the inbox.
        XCTAssertTrue(
            waitForInbox("inbox pending=1 reserved=0"),
            "The extension did not leave the unopened draft in the inbox: \(inboxSummary())"
        )

        // Opening Talaria by hand is a cold launch, which is where the saved draft has to
        // reappear. The host bar comes back without a reset.
        app.terminate()
        launch(arguments: ["--ui-test-fixture", "--ui-test-share-host"])
        XCTAssertNotNil(
            waitForComposerDraft(containing: Self.fixtureText),
            "The manually opened app lost the draft the extension had saved"
        )

        // More web URLs than the activation rule accepts: the system must not offer Talaria at
        // all, rather than handing the extension something it would silently drop.
        share(.unsupported)
        let sheet = app.otherElements["ActivityListView"]
        XCTAssertTrue(sheet.awaitExistence(timeout: 20), "The system share sheet did not open")
        XCTAssertFalse(
            talariaActivity(in: sheet).awaitExistence(timeout: 5),
            "Talaria was offered content its activation rule does not accept"
        )
    }
}
