import notify
import XCTest
import UIKit

class ChatUITestCase: TalariaUITestCase {
    fileprivate var fixtureTrace: String?

    override func tearDownWithError() throws {
        if let fixtureTrace {
            let trace = XCTAttachment(string: fixtureTrace)
            trace.name = "Scripted chat event trace"
            trace.lifetime = .deleteOnSuccess
            add(trace)

            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Chat streaming failure"
            screenshot.lifetime = .deleteOnSuccess
            add(screenshot)
        }
        try super.tearDownWithError()
    }
}

/// Automatic background wakeups render as one completion line per result with the reply under them, a silent reply
/// shows nothing, and a typed marker stays a user message (TAL-371, TAL-460).
final class BackgroundUpdateTranscriptUITests: ChatUITestCase {
    func testWakeupsRenderAsCompletionLinesWithTheirReplies() throws {
        launchFixture(additionalArguments: ["--ui-test-background-updates"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30), "The background-update session never opened")

        let updates = app.buttons.matching(identifier: "background-update-lines")
        XCTAssertTrue(updates.firstMatch.awaitExistence(timeout: 15), "The wakeup did not render as completion lines")
        let batch = updates.element(boundBy: 0)
        XCTAssertEqual(batch.label, "Agent “Audit the fixture” completed, Background command make test failed (exit 1)")
        let reply = app.staticTexts["The audit finished and the test run failed."]
        XCTAssertTrue(reply.awaitExistence(timeout: 10), "The reply to the background update is missing")
        XCTAssertLessThan(batch.frame.maxY, reply.frame.minY, "The reply is not under its completion lines")
        XCTAssertEqual(updates.element(boundBy: 1).label, "Background command ./backup.sh finished")
        XCTAssertFalse(app.staticTexts["[SILENT]"].exists, "A silent background reply is shown")
        XCTAssertTrue(app.staticTexts["[ASYNC DELEGATION BATCH COMPLETE — typed] I typed this"].exists, "The typed marker is no longer the user's message")
        batch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Delegated result body.")).firstMatch.awaitExistence(timeout: 10), "The expanded update does not show the full notification")
    }
}

/// Load Older keeps the reader where they were, and a disclosure toggled right as the older rows land pins its own
/// row instead of leaving the offset to the prepend, which let SwiftUI carry the reader away (TAL-149).
final class LoadOlderPositionUITests: ChatUITestCase {
    func testADisclosureToggledAsOlderRowsLandKeepsItsRowStill() throws {
        launchFixture(additionalArguments: ["--ui-test-older-messages"])
        _ = try openFixtureSession()

        // The newest page holds turns 26-50; a status-bar tap scrolls up to its first row and the Load Older button.
        // A swipe would overscroll the top into pull to refresh, which loads the older page itself.
        let loadOlder = app.buttons["Load older messages"]
        let firstLoaded = app.staticTexts["Paged prompt 26"]
        // Transcript controls report `isHittable == false`; being below the navigation bar is what counts.
        let isInView = { [app] in loadOlder.exists && loadOlder.frame.minY > app.navigationBars.firstMatch.frame.maxY }
        repeatStep(3, until: { poll(timeout: 3, until: isInView) }) { tap(at: CGPoint(x: 200, y: 8)) }
        XCTAssertTrue(isInView(), "Load Older never came into view")
        let promptBefore = settledFrame(of: firstLoaded)
        let worked = app.buttons.matching(identifier: "Worked").allElementsBoundByIndex
            .first { $0.frame.minY > promptBefore.maxY }
        let workedBefore = try XCTUnwrap(worked, "Turn 26 has no Worked disclosure").frame
        attachScreenshot(named: "Before Load Older")

        // The fixture answers at once; tapping by coordinate, with no element query in between, lands the toggle
        // inside the prepend's one-second stabilization window.
        tapCenter(of: loadOlder)
        tap(at: CGPoint(x: workedBefore.midX, y: workedBefore.midY))

        XCTAssertTrue(app.staticTexts["Paged prompt 1"].awaitExistence(timeout: 10), "The older page never landed")
        XCTAssertTrue(element(labelContaining: "Paging").awaitExistence(timeout: 5), "The disclosure did not expand")
        let promptAfter = settledFrame(of: firstLoaded)
        attachScreenshot(named: "After Load Older and the disclosure")
        XCTAssertEqual(promptAfter.minY, promptBefore.minY, accuracy: 1, "The transcript moved under the reader")
        XCTAssertEqual(app.buttons.matching(identifier: "Worked").allElementsBoundByIndex
            .first { $0.frame.minY > promptAfter.maxY }?.frame.minY ?? .nan, workedBefore.minY, accuracy: 1,
            "The tapped disclosure moved")
    }
}

/// The compaction reference card renders after the row the server names (TAL-560).
final class CompressionReferenceUITests: ChatUITestCase {
    func testTheReferenceCardFollowsTheServersNamedRow() throws {
        launchFixture(additionalArguments: ["--ui-test-compression-reference"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30), "The compacted session never opened")

        let card = element(labelContaining: "Reference only · Earlier turns were summarised.")
        XCTAssertTrue(card.awaitExistence(timeout: 15), "The reference card is missing")
        let anchor = app.staticTexts["Here is the plan."]
        let next = app.staticTexts["Start step one."]
        XCTAssertTrue(anchor.awaitExistence(timeout: 10) && next.exists, "The transcript rows are missing")
        XCTAssertLessThan(anchor.frame.maxY, card.frame.minY, "The card is not after the named row")
        XCTAssertLessThan(card.frame.maxY, next.frame.minY, "The card is not before the following row")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "compression-reference"
        shot.lifetime = .keepAlways
        add(shot)
    }
}

/// The session's background work is the server's record: the card above the composer shows what it pins with the full
/// result on request and a shared Dismiss, and a delegation row shows its subagents' progress in place (TAL-372).
final class BackgroundWorkUITests: ChatUITestCase {
    func testTheCardShowsTheServersRecordsAndADelegationRowItsProgress() throws {
        launchFixture(additionalArguments: ["--ui-test-background-updates"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30), "The background-work session never opened")

        XCTAssertTrue(app.staticTexts["Background work"].awaitExistence(timeout: 15), "The background card is missing")
        XCTAssertTrue(element(labelContaining: "Fix CI").awaitExistence(timeout: 5), "The running delegation is missing")
        XCTAssertTrue(element(labelContaining: "Summarize the repo").exists, "The finished /background task is missing")
        tapCenter(of: app.buttons["Worked"].firstMatch)
        XCTAssertTrue(element(labelContaining: "2 of 3 done · 1 failed").awaitExistence(timeout: 10), "The delegation row does not show its subagents' progress")
        let card = XCTAttachment(screenshot: app.screenshot())
        card.name = "background-work"
        card.lifetime = .keepAlways
        add(card)

        tapCenter(of: app.buttons["Show result"])
        XCTAssertTrue(app.staticTexts["The repo has three packages."].awaitExistence(timeout: 10), "The full result did not load")
        let result = XCTAttachment(screenshot: app.screenshot())
        result.name = "background-result"
        result.lifetime = .keepAlways
        add(result)
        tapCenter(of: app.buttons["Done"])
        XCTAssertTrue(app.staticTexts["The repo has three packages."].awaitNonExistence(timeout: 10), "The result sheet did not close")

        tapCenter(of: app.buttons["Dismiss"])
        XCTAssertTrue(element(labelContaining: "Summarize the repo").awaitNonExistence(timeout: 10), "Dismiss left the finished task in the card")
        XCTAssertTrue(element(labelContaining: "Fix CI").exists, "Dismiss removed running work")
    }
}

/// A reply whose media the server rewrote for display renders as one Markdown document: images load
/// where the text puts them, the Markdown around them stays intact, and audio follows as a tile (TAL-186).
final class TranscriptMediaUITests: ChatUITestCase {
    func testServerMediaRendersInsideTheMarkdownAroundIt() throws {
        launchFixture(additionalArguments: ["--ui-test-transcript-media"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30), "The media session never opened")

        // The thumbnail is named by its Markdown alt text.
        let linked = app.buttons["Linked chart"].firstMatch
        let shown = linked.awaitExistence(timeout: 15)
        // Thumbnails show a spinner until their bytes load; capture them loaded, from the top of the reply.
        _ = app.activityIndicators.firstMatch.awaitNonExistence(timeout: 10)
        let listImage = app.buttons["chart.png"].firstMatch.exists
        let boldImage = app.buttons["Chart"].firstMatch.exists
        let audioTile = element(labelContaining: "narration.mp3").exists
        let literalBold = element(labelContaining: "**").exists
        let literalToken = element(labelContaining: "MEDIA:").exists
        app.swipeDown()
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "transcript-media"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(shown, "The linked image did not render as a thumbnail")
        XCTAssertTrue(listImage, "The list item's image did not render")
        XCTAssertTrue(boldImage, "The image inside bold text did not render under its alt text")
        XCTAssertTrue(audioTile, "The audio file did not render as a tile")
        XCTAssertFalse(literalBold, "Bold text around an image rendered literally")
        XCTAssertFalse(literalToken, "A media token rendered as text")

        assertPresentsFileExporter(from: app.buttons["Export audio narration.mp3"].firstMatch, name: "audio-exporter")
    }
}

/// A transcript of very long bodies opens collapsed to the server's excerpts, each expands and
/// collapses in place, and the composer stays usable (TAL-456).
final class LongBodyTranscriptUITests: ChatUITestCase {
    func testLongBodiesOpenCollapsedAndExpandInPlace() throws {
        launchFixture(additionalArguments: ["--ui-test-long-bodies"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30), "The long-body session never opened")

        XCTAssertTrue(app.buttons["Show more"].firstMatch.awaitExistence(timeout: 15), "A long body did not open collapsed")
        // The transcript opens at its end, so the newest toggle is the one on screen.
        let showMore = try XCTUnwrap(app.buttons.matching(identifier: "Show more").allElementsBoundByIndex.last)
        // Held past the transcript's 0.4 s long press, as a tap on a loaded simulator can be:
        // the toggle still toggles instead of opening the message menu (TAL-485).
        showMore.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        let showLess = app.buttons["Show less"].firstMatch
        XCTAssertTrue(showLess.awaitExistence(timeout: 10), "The collapsed body did not expand")
        // The toggle follows the whole body now, so bring it on screen before tapping it.
        let window = app.windows.firstMatch.frame
        for _ in 0..<40 where !window.contains(CGPoint(x: showLess.frame.midX, y: showLess.frame.midY)) {
            if showLess.frame.midY > window.maxY { app.swipeUp() } else { app.swipeDown() }
        }
        showLess.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(showLess.awaitNonExistence(timeout: 10), "The expanded body did not collapse again")
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }
}

/// A long pasted prompt opens folded to its first lines, and Show more / Show less toggle it in place (TAL-452).
final class LongPromptFoldUITests: ChatUITestCase {
    func testLongPromptOpensFoldedAndToggles() throws {
        launchFixture(additionalArguments: ["--ui-test-long-prompt"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        let composer = try XCTUnwrap(waitForComposer(timeout: 30), "The long-prompt session never opened")

        let prompt = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Fixture prompt line 1\n")).firstMatch
        XCTAssertTrue(prompt.awaitExistence(timeout: 15), "The long prompt did not render")
        let showMore = app.buttons["Show more"]
        XCTAssertTrue(showMore.awaitExistence(timeout: 10), "The long prompt did not open folded")
        XCTAssertEqual(app.buttons.matching(identifier: "Show more").count, 1, "Only the long prompt folds")
        let folded = prompt.settledFrame.height
        let foldedShot = XCTAttachment(screenshot: app.screenshot())
        foldedShot.name = "long-prompt-folded"
        foldedShot.lifetime = .keepAlways
        add(foldedShot)

        // Held past the transcript's long press, as the TAL-456 toggle test does (TAL-485).
        showMore.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        let showLess = app.buttons["Show less"]
        XCTAssertTrue(showLess.awaitExistence(timeout: 10), "The folded prompt did not expand")
        // 24 lines against a fold of 8.
        XCTAssertGreaterThan(prompt.settledFrame.height, folded * 2, "The expanded prompt is not shown whole")
        let expandedShot = XCTAttachment(screenshot: app.screenshot())
        expandedShot.name = "long-prompt-expanded"
        expandedShot.lifetime = .keepAlways
        add(expandedShot)

        // The whole prompt pushes the toggle under the floating composer; scroll it above.
        for _ in 0..<10 where showLess.frame.maxY > composer.frame.minY - 24 { app.swipeUp() }
        showLess.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        XCTAssertTrue(showMore.awaitExistence(timeout: 10), "The expanded prompt did not fold again")
        XCTAssertEqual(prompt.settledFrame.height, folded, accuracy: 2, "The prompt did not return to its fold")
    }
}

/// Opening a chat from the list, then what the opened chat offers: its idle composer, which
/// expands for typing, and long-press isolation between a message's links and its own actions
/// (TAL-49).
final class ChatNavigationUITests: ChatUITestCase {
    func testApprovalBypassChipTurnsBypassOffForTheSession() throws {
        // The composer renders before the chat reads its bypass state, so the status waits for the fixture to answer
        // that read (`approvalBypassAnsweredName` in the app): a loaded hosted runner answered it 10 s after the
        // composer (TAL-664). An earlier test on this simulator may have left the state answered.
        var bypassAnswered: Int32 = 0
        notify_register_check("dev.kil.talaria.ui-test.approval-bypass-answered", &bypassAnswered)
        defer { notify_cancel(bypassAnswered) }
        notify_set_state(bypassAnswered, 0)
        launchFixture(additionalArguments: ["--ui-test-approval-bypass"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15))
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 30))
        XCTAssertTrue(
            poll(timeout: 30) {
                var state: UInt64 = 0
                notify_get_state(bypassAnswered, &state)
                return state == 1
            },
            "The chat never read its approval bypass state."
        )
        let status = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Approval bypass active")).firstMatch
        XCTAssertTrue(status.awaitExistence(timeout: 5), "The fixture must first show active bypass.")
        let chip = app.buttons["Approval bypass active"]
        XCTAssertTrue(chip.awaitExistence(timeout: 5), "The bypass status must be an actionable button.")
        _ = chip.settledFrame
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Approval bypass can be turned off from its chip"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let frame = chip.settledFrame
        XCTAssertTrue(app.frame.contains(frame), "The chip must be inside the visible screen.")
        XCTAssertGreaterThanOrEqual(frame.height, 44)
        tapCenter(of: chip)
        let confirmation = app.alerts["Turn off approval bypass"]
        XCTAssertTrue(confirmation.awaitExistence(timeout: 5), "Tapping the chip must ask before changing bypass.")
        let promptScreenshot = XCTAttachment(screenshot: app.screenshot())
        promptScreenshot.name = "Confirm before turning approval bypass off"
        promptScreenshot.lifetime = .keepAlways
        add(promptScreenshot)
        XCTAssertTrue(chip.exists, "Bypass stays active until confirmation.")
        confirmation.buttons["Cancel"].tap()
        XCTAssertTrue(confirmation.awaitNonExistence(timeout: 5))
        XCTAssertTrue(chip.exists, "Cancel must leave bypass active.")
        tapCenter(of: chip)
        XCTAssertTrue(confirmation.awaitExistence(timeout: 5))
        confirmation.buttons["Turn off approval bypass"].tap()
        XCTAssertTrue(chip.awaitNonExistence(timeout: 5), "A server-confirmed disabled bypass must remove the chip.")
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }

    func testChatSessionOpensFromListWithItsComposerAndMessageActions() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")

        // The list scrolls; `tapFixtureSession` brings the row back into view.
        let initialY = session.frame.minY
        let sessionList = app.collectionViews.firstMatch
        XCTAssertTrue(sessionList.exists)
        sessionList.swipeUp(velocity: .slow)
        if session.exists {
            XCTAssertGreaterThan(abs(session.frame.minY - initialY), 20)
        }

        tapFixtureSession(session)
        let idleComposer = try XCTUnwrap(waitForComposer(timeout: 15))
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-bottom-accessory"].exists)

        assertLongPressShowsMessageActionsOnTextAndOnlyLinkActionsOnALink()

        idleComposer.tap()
        let expandedTextView = app.textViews.firstMatch
        XCTAssertTrue(expandedTextView.awaitExistence(timeout: 10))
        expandedTextView.typeText("Composer transition check")
        XCTAssertFalse(app.buttons["Reply"].exists)
    }
}

/// TAL-455: a chat started while the list is filtered to a project joins that project, so it stays in the filtered list.
final class SessionListProjectNewChatUITests: ChatUITestCase {
    func testNewChatUnderAProjectFilterStaysInTheFilteredList() throws {
        launchFixture(additionalArguments: ["--ui-test-projects"])
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")

        let allProjects = app.buttons["Project filter: All Projects"]
        XCTAssertTrue(allProjects.awaitExistence(timeout: 15), "Missing the project filter")
        allProjects.tap()
        let project = app.buttons["Fixture Project"]
        XCTAssertTrue(project.awaitExistence(timeout: 5), "Missing the fixture project")
        project.tap()
        XCTAssertTrue(app.buttons["Project filter: Fixture Project"].awaitExistence(timeout: 5))
        XCTAssertTrue(fixtureSessionButton.awaitNonExistence(timeout: 5), "The filter should hide chats outside the project")

        // The closed sidebar keeps its own New Chat row in the tree, so take the list's.
        let sidebarNewChat = app.descendants(matching: .any)["app-sidebar"].buttons["New Chat"]
        let newChats = app.buttons.matching(NSPredicate(format: "label == %@", "New Chat"))
        func listNewChat() -> XCUIElement? {
            let sidebarFrame = sidebarNewChat.exists ? sidebarNewChat.frame : .null
            return newChats.allElementsBoundByIndex.first { $0.exists && $0.frame != sidebarFrame }
        }
        XCTAssertTrue(poll(timeout: 5) { listNewChat() != nil }, "Missing the New Chat button")
        tap(at: try XCTUnwrap(listNewChat()).settledFrame.center)
        XCTAssertTrue(app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 15))
        tapCenter(of: app.buttons["BackButton"])

        let created = app.buttons.containing(.staticText, identifier: "New Fixture Chat").firstMatch
        XCTAssertTrue(created.awaitExistence(timeout: 10), "The new chat left the project's filtered list")

        let list = app.collectionViews.firstMatch
        list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            .press(forDuration: 0.1, thenDragTo: list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        XCTAssertTrue(app.buttons["Project filter: Fixture Project"].awaitExistence(timeout: 10))
        XCTAssertTrue(created.awaitExistence(timeout: 10), "The new chat left the filtered list after a refresh")
        XCTAssertFalse(fixtureSessionButton.exists, "The refresh should keep the project filter")
    }
}

/// TAL-461: New Chat sits on the bottom row beside Search instead of floating above it.
final class SessionListBottomBarUITests: ChatUITestCase {
    func testNewChatSharesTheSearchRowHidesWhileSearchingAndOpensTheComposer() throws {
        guard #available(iOS 26.0, *) else {
            throw XCTSkip("Search minimizes into the bottom bar from iOS 26; earlier versions keep the floating button")
        }
        // Regular width keeps New Chat in its own bottom bar without Search (TAL-482).
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "The Search row is the compact-width layout")
        launchFixture()
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        let search = try XCTUnwrap(waitForSessionSearchControl(timeout: 15), "Missing the session search control")
        // The closed sidebar keeps its New Chat row on screen behind the list, and the
        // full-screen toolbar container leaves every button not hittable, so exclude it by frame.
        let newChat = app.buttons.matching(NSPredicate(format: "label == %@", "New Chat"))
        let sidebarNewChat = app.descendants(matching: .any)["app-sidebar"].buttons["New Chat"]
        func visibleNewChat() -> XCUIElement? {
            let sidebarFrame = sidebarNewChat.exists ? sidebarNewChat.frame : .null
            return newChat.allElementsBoundByIndex.first { $0.exists && $0.frame != sidebarFrame }
        }
        XCTAssertTrue(poll(timeout: 5) { visibleNewChat() != nil }, "Missing the New Chat button")
        let newChatFrame = try XCTUnwrap(visibleNewChat()).settledFrame
        let searchFrame = search.settledFrame
        XCTAssertEqual(newChatFrame.midY, searchFrame.midY, accuracy: 2, "New Chat \(newChatFrame) is off the Search row \(searchFrame)")
        XCTAssertGreaterThan(newChatFrame.minX, searchFrame.maxX, "New Chat should trail Search")

        search.tap()
        XCTAssertTrue(sessionSearchField.awaitExistence(timeout: 5))
        XCTAssertTrue(poll(timeout: 5) { visibleNewChat() == nil }, "New Chat should hide while searching")
        let closeSearch = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "close")).firstMatch
        XCTAssertTrue(closeSearch.awaitExistence(timeout: 3))
        closeSearch.tap()
        XCTAssertTrue(poll(timeout: 5) { visibleNewChat() != nil }, "New Chat should return when search closes")

        tap(at: try XCTUnwrap(visibleNewChat()).settledFrame.center)
        XCTAssertTrue(app.navigationBars["New Fixture Chat"].awaitExistence(timeout: 15))
        XCTAssertNotNil(waitForComposer(timeout: 15), "New Chat did not open the composer")
    }

    func testOpeningAndClosingSearchKeepsTheListInPlace() throws {
        guard #available(iOS 26.0, *) else {
            throw XCTSkip("Search minimizes into the bottom bar from iOS 26")
        }
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "The Search row is the compact-width layout")
        launchFixture()
        let row = fixtureSessionButton
        XCTAssertTrue(row.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        let search = try XCTUnwrap(waitForSessionSearchControl(timeout: 15), "Missing the session search control")
        let resting = row.settledFrame

        search.tap()
        XCTAssertTrue(sessionSearchField.awaitExistence(timeout: 5))
        XCTAssertEqual(row.settledFrame.minY, resting.minY, accuracy: 1, "Opening search moved the list")
        XCTAssertTrue(app.staticTexts["Sessions"].exists, "Opening an empty search removed the Sessions header")

        let closeSearch = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "close")).firstMatch
        XCTAssertTrue(closeSearch.awaitExistence(timeout: 3))
        closeSearch.tap()
        XCTAssertTrue(sessionSearchField.awaitNonExistence(timeout: 5))
        XCTAssertEqual(row.settledFrame.minY, resting.minY, accuracy: 1, "Closing search moved the list")
    }
}

/// TAL-496: update notifications are a system sheet, so they swipe down to dismiss and center
/// at form width in regular width instead of spanning the screen.
final class UpdateNotificationsSheetUITests: ChatUITestCase {
    func testTheNotificationsSheetSwipesDownToDismiss() throws {
        launchFixture(additionalArguments: ["--ui-test-update-notifications"])
        let sheetBar = app.navigationBars["Notifications"]
        XCTAssertTrue(sheetBar.awaitExistence(timeout: 20), "The notifications sheet did not open")
        attachScreenshot(named: "Notifications sheet")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertLessThan(sheetBar.settledFrame.width, app.windows.firstMatch.frame.width, "The sheet spans the full window width")
        }

        // A swipe inside the short navigation bar is too short to dismiss; drag the sheet to the bottom edge.
        sheetBar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(
            forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)),
            withVelocity: .fast,
            thenHoldForDuration: 0
        )
        XCTAssertTrue(sheetBar.awaitNonExistence(timeout: 5), "Swiping down did not dismiss the notifications sheet")
        XCTAssertTrue(app.buttons["Notifications"].awaitExistence(timeout: 5), "The bell is missing after dismissing")
    }
}

/// TAL-443: archiving a chat offers Undo, which brings the chat back from the server.
final class SessionArchiveUndoUITests: ChatUITestCase {
    func testUndoRestoresAnArchivedChat() throws {
        // A hosted runner can spend longer than the five-second offer snapshotting the list (TAL-650).
        launchFixture(additionalArguments: ["--ui-test-hold-archive-undo"])
        let row = fixtureSessionButton
        XCTAssertTrue(row.awaitExistence(timeout: 15), "Missing deterministic session fixture")

        row.swipeLeft()
        let archive = app.buttons["Archive"]
        XCTAssertTrue(archive.awaitExistence(timeout: 5), "The swipe did not reveal Archive")
        archive.tap()
        let toast = app.staticTexts["Chat archived"]
        XCTAssertTrue(toast.awaitExistence(timeout: 5), "Archiving did not offer Undo")
        XCTAssertTrue(row.awaitNonExistence(timeout: 3), "The archived chat stayed in the list")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "archive-undo-toast"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.buttons["Undo"].tap()
        XCTAssertTrue(row.awaitExistence(timeout: 10), "Undo did not restore the chat")
        XCTAssertTrue(toast.awaitNonExistence(timeout: 5), "The toast stayed after Undo")
    }
}

/// TAL-627: Select Chats picks rows, then one confirmed Bulk Action ends the mode.
final class SelectChatsUITests: ChatUITestCase {
    func testSelectingChatsAndDeletingThemEndsSelectChats() throws {
        launchFixture()
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")

        let select = app.buttons["Select Chats"]
        XCTAssertTrue(select.awaitExistence(timeout: 5))
        select.tap()
        for title in ["Fixture Session 01", "Fixture Session 02"] {
            let row = app.buttons.containing(.staticText, identifier: title).firstMatch
            XCTAssertTrue(row.awaitExistence(timeout: 5), title)
            row.tap()
        }
        XCTAssertTrue(app.staticTexts["2 selected"].awaitExistence(timeout: 5))
        attachScreenshot(named: "select-chats")

        app.buttons["Delete"].tap()
        let confirmation = app.alerts["Delete 2 Chats?"]
        XCTAssertTrue(confirmation.awaitExistence(timeout: 5))
        attachScreenshot(named: "select-chats-delete-confirmation")
        confirmation.buttons["Delete"].tap()

        XCTAssertTrue(app.staticTexts["2 selected"].awaitNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Select Chats"].awaitExistence(timeout: 5), "Select Chats did not end once every chat was deleted")
    }
}

/// TAL-437: a relaunch shows the chats the app saw last time before `/api/sessions` answers.
final class ColdLaunchCacheUITests: ChatUITestCase {
    func testRelaunchShowsTheLastChatsBeforeTheServerAnswers() throws {
        launchFixture(additionalArguments: ["--ui-test-persistent-cache", "--ui-test-reset-persistent-cache"])
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        app.terminate()

        launchFixture(additionalArguments: ["--ui-test-persistent-cache", "--ui-test-hold-session-list"])

        XCTAssertTrue(
            fixtureSessionButton.awaitExistence(timeout: 15),
            "The relaunch did not show the last chats before /api/sessions answered"
        )
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Cached chats on relaunch"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(releaseHeldLoads { fixtureSessionButton.exists })
    }
}

/// Reopening a chat paints its cached transcript at once and shows "Syncing messages" above
/// the composer until the server answers (TAL-436).
final class ChatSyncStatusUITests: ChatUITestCase {
    /// TAL-434: a reply sent from another client while the app was in the background shows up in
    /// the open chat as soon as the app returns, without a pull or reopening the chat.
    func testOpenChatCatchesUpAfterTheAppReturnsFromTheBackground() throws {
        launchFixture(additionalArguments: ["--ui-test-change-while-backgrounded"])
        _ = try openFixtureSession()
        let reply = element(labelContaining: "FixtureReplyFromElsewhere")
        XCTAssertFalse(reply.exists)

        sendToBackground()
        app.activate()

        XCTAssertTrue(reply.awaitExistence(timeout: 15), "The open chat never caught up with the reply sent while it was away")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Caught up after foreground"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testReopenedChatShowsSyncingUntilTheServerAnswers() throws {
        launchFixture(additionalArguments: ["--ui-test-hold-transcript-reloads"])
        _ = try openFixtureSession()
        let back = app.navigationBars.buttons["BackButton"].firstMatch
        XCTAssertTrue(back.awaitExistence(timeout: 5))
        back.tap()
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 10))
        tapFixtureSession(session)

        let syncing = element(label: "Syncing messages with the server")
        XCTAssertTrue(syncing.awaitExistence(timeout: 10), "The reopened chat never showed Syncing messages")
        XCTAssertFalse(element(label: "Hermes is checking the response stream").exists, "Checking stream competed with Syncing messages")
        XCTAssertFalse(element(label: "Hermes is reconnecting the response stream").exists, "Reconnecting stream competed with Syncing messages")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Syncing messages"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        XCTAssertTrue(releaseHeldLoads { !syncing.exists }, "Syncing messages stayed after the server answered")
    }
}

final class ChatPrimaryStreamUITests: ChatUITestCase {
    func testBatchClarificationShowsChoicesAndDeliversTypedAndMultiSelectAnswers() throws {
        launchChatFixture(argument: "--ui-test-chat-batch-clarification", trace: "batch prompt -> typed answer -> next -> selected answers -> agent result")
        _ = try openFixtureSession()
        XCTAssertTrue(app.staticTexts["What sounds best for a quiet evening?"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.buttons["A movie"].exists)
        XCTAssertTrue(app.buttons["A book"].exists)
        XCTAssertTrue(app.staticTexts["Question 1 of 2"].exists)
        XCTAssertTrue(app.keyboards.firstMatch.awaitNonExistence(timeout: 3))
        let resize = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Resize question area")).firstMatch
        XCTAssertTrue(resize.exists)
        let originalTop = resize.frame.minY
        let grip = resize.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        grip.press(forDuration: 0.1, thenDragTo: grip.withOffset(CGVector(dx: 0, dy: -70)))
        XCTAssertLessThan(resize.frame.minY, originalTop - 30)
        let input = app.textViews.firstMatch
        input.tap()
        input.typeText("A movie")
        XCTAssertTrue(app.keyboards.firstMatch.awaitExistence(timeout: 3))
        XCTAssertLessThanOrEqual(app.buttons["Next"].frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        app.buttons["Next"].tap()
        XCTAssertTrue(app.staticTexts["Which drinks?"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Question 2 of 2"].exists)
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "")
        tapCenter(of: app.buttons["Tea"])
        tapCenter(of: app.buttons["Water"])
        tapCenter(of: app.buttons["Previous question"])
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "A movie")
        tapCenter(of: app.buttons["Next question"])
        XCTAssertTrue(app.buttons["Submit clarification"].isEnabled)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Batch questions inside the composer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Submit clarification"].tap()
        XCTAssertTrue(app.staticTexts["Agent received: A movie | Tea, Water"].awaitExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
    }

    func testClarificationRestoresOrdinaryDraftAfterAnswerAndNavigation() throws {
        launchChatFixture(argument: "--ui-test-chat-clarification", trace: "saved draft -> clarification -> answer -> restore -> navigate")
        _ = try openFixtureSession()
        XCTAssertTrue(app.staticTexts["Clarification Required"].awaitExistence(timeout: 5))
        let input = app.textViews.firstMatch
        XCTAssertEqual(input.value as? String, "")
        input.tap()
        input.typeText("Temporary fixture answer")
        app.buttons["Submit clarification"].tap()
        XCTAssertTrue(app.staticTexts["Clarification Required"].awaitNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Agent received: Temporary fixture answer"].awaitExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
        tapCenter(of: app.buttons["BackButton"])
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 5))
        tapCenter(of: fixtureSessionButton)
        XCTAssertTrue(app.textViews.firstMatch.awaitExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
    }

    func testChatStreamPreservesChronologyAndSettlesWithoutDuplication() throws {
        launchChatFixture(
            argument: "--ui-test-chat-full",
            trace: "start -> token -> reasoning -> token -> tool -> approval -> tool_complete -> token -> clarify -> composer answer -> title -> metering -> done -> stream_end -> reload"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        let optimisticMessage = app.staticTexts["Run the deterministic fixture"]
        XCTAssertTrue(optimisticMessage.awaitExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Approval required"].awaitExistence(timeout: 5))

        let opening = app.staticTexts["Fixture opening."]
        XCTAssertTrue(opening.exists)
        let liveThinking = element(labelContaining: "Thinking, Inspecting fixture")
        let liveProgress = app.staticTexts["Fixture progress."]
        let liveTool = element(labelContaining: "Calling a tool, Running")
        XCTAssertTrue(liveThinking.exists)
        XCTAssertTrue(liveProgress.exists)
        XCTAssertTrue(liveTool.exists)
        XCTAssertLessThan(opening.frame.minY, liveThinking.frame.minY)
        XCTAssertLessThan(liveThinking.frame.minY, liveProgress.frame.minY)
        XCTAssertLessThan(liveProgress.frame.minY, liveTool.frame.minY)

        app.buttons["Allow once"].tap()
        XCTAssertTrue(app.staticTexts["Clarification Required"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Which deterministic path should continue?"].exists)

        let finished = app.staticTexts["Fixture finished."]
        XCTAssertTrue(finished.exists)

        // The clarification uses only the composer, and slash text there is an answer, not a
        // command. Tapping an offered choice is the batch test's and `ClarificationTests`'.
        XCTAssertTrue(app.buttons["Use the deterministic path"].exists)
        XCTAssertEqual(app.textViews.count, 1)
        XCTAssertFalse(app.textFields["Type a response"].exists)
        XCTAssertFalse(app.buttons["Stop response"].exists)
        XCTAssertFalse(app.buttons["Composer options"].exists)
        let send = app.buttons["Submit clarification"]
        XCTAssertFalse(send.isEnabled)
        let input = app.textViews.firstMatch
        input.tap()
        input.typeText("/interrupt is my answer")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Clarification in the chat composer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(app.navigationBars["Deterministic Stream Complete"].awaitExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Clarification Required"].exists)
        XCTAssertFalse(app.staticTexts["/interrupt is my answer"].exists)
        XCTAssertTrue(app.buttons["Stop response"].awaitNonExistence(timeout: 5))

        let back = app.buttons["BackButton"]
        XCTAssertTrue(back.exists)
        tapCenter(of: back)
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 5))
        tapCenter(of: fixtureSessionButton)
        XCTAssertTrue(app.navigationBars["Deterministic Stream Complete"].awaitExistence(timeout: 5))
        let worked = app.buttons["Worked"]
        XCTAssertTrue(worked.awaitExistence(timeout: 5))
        tapCenter(of: worked)

        let reloadedOpening = app.staticTexts["Fixture opening."]
        let reloadedThinking = element(labelContaining: "Thinking, Inspecting fixture")
        let reloadedProgress = app.staticTexts["Fixture progress."]
        let reloadedTool = element(labelContaining: "Called a tool, Completed")
        let reloadedFinished = app.staticTexts["Fixture finished."]
        XCTAssertTrue(reloadedOpening.awaitExistence(timeout: 5))
        XCTAssertTrue(reloadedThinking.exists)
        XCTAssertTrue(reloadedProgress.exists)
        XCTAssertTrue(reloadedTool.exists)
        XCTAssertTrue(reloadedFinished.exists)
        XCTAssertLessThan(reloadedOpening.frame.minY, reloadedThinking.frame.minY)
        XCTAssertLessThan(reloadedThinking.frame.minY, reloadedProgress.frame.minY)
        XCTAssertLessThan(reloadedProgress.frame.minY, reloadedTool.frame.minY)
        XCTAssertLessThan(reloadedTool.frame.minY, reloadedFinished.frame.minY)
        XCTAssertEqual(countElements(label: "Run the deterministic fixture"), 1)
        XCTAssertEqual(countElements(label: "Fixture opening."), 1)
        XCTAssertEqual(countElements(label: "Fixture progress."), 1)
        XCTAssertEqual(countElements(label: "Fixture finished."), 1)

        // TAL-331: the settled tool row the server clipped opens its whole result on request.
        tapCenter(of: reloadedTool)
        let showFullOutput = app.buttons["Show full output"]
        XCTAssertTrue(showFullOutput.awaitExistence(timeout: 5))
        attachScreenshot(named: "Clipped tool result")
        showFullOutput.tap()
        XCTAssertTrue(app.staticTexts["fixture result, in full"].awaitExistence(timeout: 5))
        XCTAssertFalse(showFullOutput.exists)
        attachScreenshot(named: "Full tool result")

        // TAL-448: a file edit shows the server's counts and expands to its diff, then collapses again.
        let editRow = element(labelContaining: "Edited src/app.ts, Completed, 2 added, 1 removed")
        XCTAssertTrue(editRow.awaitExistence(timeout: 5))
        let addedLine = app.staticTexts["+run(2)"]
        XCTAssertFalse(addedLine.exists)
        tapCenter(of: editRow)
        XCTAssertTrue(addedLine.awaitExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["-run(1)"].exists)
        XCTAssertTrue(app.staticTexts["Diff truncated"].exists)
        attachScreenshot(named: "Edit diff expanded")
        tapCenter(of: editRow)
        XCTAssertTrue(addedLine.awaitNonExistence(timeout: 5))
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }
}

/// Steering and stopping a running turn through the composer. A terminal error, a transport
/// reconnect and reopening a running chat are ChatViewModel and session-list tests in
/// TalariaKit (TAL-402).
final class ChatRecoveryUITests: ChatUITestCase {
    /// A run waiting on the test heartbeats like the server's stream, so the stall watchdog never shows
    /// Checking stream (after 12 s) or reconnects and replays the run (at 18 s) while a test works (TAL-666).
    func testWaitingRunKeepsItsStreamAlive() throws {
        launchFixture(additionalArguments: ["--ui-test-chat-controls"])
        try sendFixtureMessage("Run the deterministic fixture")
        let waiting = app.staticTexts["Waiting for control input."]
        XCTAssertTrue(waiting.awaitExistence(timeout: 5))

        let checking = element(label: "Hermes is checking the response stream")
        XCTAssertFalse(poll(timeout: 22) { checking.exists }, "A waiting run's stream looked stalled")
        XCTAssertTrue(waiting.exists, "The run was replayed by a reconnect")
    }

    func testChatStreamSupportsSteeringAndCancellation() throws {
        launchChatFixture(
            argument: "--ui-test-chat-controls",
            trace: "start -> token -> steer request -> steer_consumed -> cancel request -> cancel"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        XCTAssertTrue(app.staticTexts["Waiting for control input."].awaitExistence(timeout: 5))
        let input = readyComposerInput(try XCTUnwrap(waitForComposer(timeout: 5)))
        input.typeText("Keep the fixture concise")
        tapCenter(of: app.buttons["Send"])

        XCTAssertTrue(app.staticTexts["Keep the fixture concise"].awaitExistence(timeout: 5))
        XCTAssertTrue(element(labelContaining: "Steering hint").awaitExistence(timeout: 5))
        XCTAssertTrue(element(label: "Steering hint").awaitExistence(timeout: 5))
        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.awaitExistence(timeout: 5))
        stop.tap()

        XCTAssertTrue(stop.awaitNonExistence(timeout: 5))
        // The stopped turn settles into the server's scene: its outcome and the steer it took stay visible.
        XCTAssertTrue(app.staticTexts["Stopped"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Keep the fixture concise"].exists)
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }
}

/// TAL-80: a running chat through the app's real lifecycle, against a fixture server whose run
/// outlives the app. The test drives the run: `drop` cuts the live stream, `finish` ends the run on
/// the server whether or not the app is attached. Every journey ends with one prompt and one reply,
/// so a resend or a replayed segment fails it. A real tunnel's long-lived behavior stays TAL-32's
/// live smoke.
class StreamLifecycleUITestCase: ChatUITestCase {
    let lifecycle = "--ui-test-chat-lifecycle"
    let prompt = "Run the lifecycle fixture"
    let opening = "Lifecycle opening."
    let reply = "Lifecycle opening. Lifecycle finished."

    func startRun() throws {
        try sendFixtureMessage(prompt)
        XCTAssertTrue(element(labelContaining: opening).awaitExistence(timeout: 15), "The run never streamed its opening")
        XCTAssertTrue(app.buttons["Stop response"].exists)
    }

    func signal(_ name: String) {
        notify_post("dev.kil.talaria.ui-test.lifecycle-\(name)")
    }

    /// One prompt and one whole reply, and the run is over.
    func assertSettledOnce() {
        XCTAssertTrue(app.staticTexts[reply].awaitExistence(timeout: 30), "The run never settled to its whole reply")
        XCTAssertTrue(app.buttons["Stop response"].awaitNonExistence(timeout: 10), "The settled run still offers Stop")
        XCTAssertEqual(countElements(label: prompt), 1, "The prompt was sent again")
        XCTAssertEqual(countElements(containing: opening), 1, "Part of the reply repeated")
        attachScreenshot(named: "Settled once")
    }
}

final class StreamLifecycleUITests: StreamLifecycleUITestCase {
    /// Killed while away mid-run, the relaunched app paints the run it cached before the server
    /// answers, then rejoins the same run by status and replay instead of sending again.
    func testRelaunchAfterTheAppIsKilledPaintsTheCachedRunThenRejoinsIt() throws {
        let cache = "--ui-test-persistent-cache"
        launchFixture(additionalArguments: [lifecycle, cache, "--ui-test-reset-persistent-cache"])
        try startRun()
        sendToBackground()
        app.terminate()

        launchFixture(additionalArguments: [lifecycle, cache, "--ui-test-hold-first-transcript-load"])
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertTrue(app.staticTexts[prompt].awaitExistence(timeout: 15), "The relaunch did not paint the cached prompt")
        XCTAssertTrue(element(label: "Syncing messages with the server").exists, "The cached run was not shown before the server answered")
        attachScreenshot(named: "Cached run before the server answers")

        XCTAssertTrue(
            releaseHeldLoads(timeout: 30) { element(labelContaining: opening).exists && !element(label: "Syncing messages with the server").exists },
            "The relaunched chat did not rejoin the run and replay its reply so far"
        )
        XCTAssertTrue(app.buttons["Stop response"].exists, "The relaunched chat lost the running response")
        signal("finish")
        assertSettledOnce()
    }

    /// A refused connection, a timeout and a 503 while the run continues: the chat reconnects,
    /// never asks to sign in, and finishes the same run on the rejoined stream.
    func testUnreachableServerReconnectsWithoutSigningOutAndFinishesTheRun() throws {
        launchFixture(additionalArguments: [lifecycle, "--ui-test-lifecycle-unreachable"])
        try startRun()
        signal("drop")

        let reconnecting = element(label: "Hermes is reconnecting the response stream")
        XCTAssertTrue(reconnecting.awaitExistence(timeout: 15), "A dropped stream did not show it was reconnecting")
        attachScreenshot(named: "Reconnecting while unreachable")
        XCTAssertTrue(reconnecting.awaitNonExistence(timeout: 40), "The chat never reconnected once the server was reachable")
        XCTAssertFalse(app.secureTextFields["ReauthenticatePassword"].exists, "An unreachable server asked the user to sign in")
        XCTAssertTrue(app.buttons["Stop response"].exists, "The reconnected chat lost the running response")

        signal("finish")
        assertSettledOnce()
    }

    /// The run finishes while the server is unreachable: once it answers, its status says the
    /// run is over and the chat settles to the server's transcript.
    func testRunThatFinishedWhileUnreachableSettlesToTheServerTranscript() throws {
        launchFixture(additionalArguments: [lifecycle, "--ui-test-lifecycle-unreachable"])
        try startRun()
        signal("drop")
        XCTAssertTrue(
            element(label: "Hermes is reconnecting the response stream").awaitExistence(timeout: 15),
            "A dropped stream did not show it was reconnecting"
        )
        signal("finish")

        assertSettledOnce()
    }

    /// The sign-in session expires while the stream is down: unlike an unreachable server, the
    /// chat asks to sign in, and once signed in rejoins and finishes the same run.
    func testExpiredSessionWhileReconnectingAsksToSignInThenRejoinsTheRun() throws {
        launchFixture(additionalArguments: [lifecycle, "--ui-test-lifecycle-session-expiry"])
        try startRun()
        signal("drop")

        let password = app.secureTextFields["ReauthenticatePassword"]
        XCTAssertTrue(password.awaitExistence(timeout: 20), "A 401 while reconnecting did not ask the user to sign in")
        attachScreenshot(named: "Sign in while reconnecting")
        _ = password.settledFrame
        // A tap while the sheet still settles can leave the field without focus.
        repeatStep(3, until: { app.keyboards.firstMatch.exists }) {
            password.tap()
            _ = app.keyboards.firstMatch.awaitExistence(timeout: 5)
        }
        password.typeText("fixture-password")
        app.buttons["ReauthenticateSignIn"].tap()
        XCTAssertTrue(password.awaitNonExistence(timeout: 15), "Signing in did not close the sign-in sheet")

        XCTAssertTrue(
            element(label: "Hermes is reconnecting the response stream").awaitNonExistence(timeout: 20),
            "The chat did not reconnect after signing in"
        )
        XCTAssertTrue(app.buttons["Stop response"].awaitExistence(timeout: 10), "The chat lost the running response after signing in")
        signal("finish")
        assertSettledOnce()
    }
}

/// Needs the simulator's notification service, which a parallel-testing clone does not answer:
/// `scripts/test-ios` runs this class on the leased simulator itself, as CI runs every class.
final class ResponseCompletionAlertUITests: StreamLifecycleUITestCase {
    /// Away mid-run and back, the chat keeps the same run. When the run then finishes while the
    /// app is away but still has runtime, the reply alerts, and tapping the alert opens the chat.
    func testBackgroundedRunKeepsStreamingAndItsCompletionAlertOpensTheChat() throws {
        launchFixture(additionalArguments: [lifecycle])
        turnOnResponseCompleteAlerts()
        try startRun()

        sendToBackground()
        app.activate()
        XCTAssertTrue(app.buttons["Stop response"].awaitExistence(timeout: 10), "The run stopped when the app came back")
        XCTAssertEqual(countElements(label: prompt), 1, "Returning to the app resent the prompt")
        XCTAssertEqual(countElements(containing: opening), 1, "Returning to the app repeated the reply")

        sendToBackground()
        signal("finish")
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Response complete")).firstMatch
        XCTAssertTrue(alert.awaitExistence(timeout: 20), "The run finished in the background without an alert")
        // The banner belongs to SpringBoard, so only a screen capture shows it.
        let banner = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        banner.name = "Completion alert"
        banner.lifetime = .keepAlways
        add(banner)
        alert.tap()

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "Tapping the alert did not open the app")
        XCTAssertTrue(app.navigationBars[fixtureSessionTitle].awaitExistence(timeout: 10), "Tapping the alert did not open its chat")
        assertSettledOnce()
    }

    /// The user's own path: the switch in Settings, and the system's permission prompt when the
    /// simulator has not answered it yet.
    private func turnOnResponseCompleteAlerts() {
        openSettings()
        tapSettingsCategory(id: "notificationsAndHaptics", title: "Notifications & Haptics")
        let alerts = app.switches["Response Complete Alerts"]
        XCTAssertTrue(alerts.awaitExistence(timeout: 10), "Missing the Response Complete Alerts switch")
        // The row's footnote appears once iOS reports the permission; a tap before then waits on the
        // same request. A simulator whose notification service never answers fails here, not later.
        let permissionKnown = app.staticTexts.matching(NSPredicate(
            format: "label IN %@", ["iOS permission not requested.", "iOS notifications allowed."]
        )).firstMatch
        XCTAssertTrue(permissionKnown.awaitExistence(timeout: 60), "The simulator's notification service never reported the permission")
        _ = alerts.settledFrame
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        let isOn = { alerts.value as? String == "1" }
        // The row's own switch takes the touch; a tap while the screen settles can be dropped.
        repeatStep(3, until: { isOn() || allow.exists }) {
            let knob = alerts.switches.firstMatch
            tapCenter(of: knob.exists ? knob : alerts)
            _ = poll(timeout: 10) { isOn() || allow.exists }
        }
        if allow.exists { allow.tap() }
        XCTAssertTrue(poll(timeout: 10) { alerts.value as? String == "1" }, "Response Complete Alerts did not turn on")
        app.navigationBars.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: Self.navigationTimeout))
        openSidebarDestination("Chats")
        XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout), "Settings did not return to the session list")
    }
}

/// A steer sent from another device shows as a pending bubble with the server's actions; Send now says when it must
/// wait, and Edit puts its text back in the composer (TAL-426).
final class PendingSteerUITests: ChatUITestCase {
    func testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel() throws {
        launchChatFixture(argument: "--ui-test-chat-pending-steers", trace: "start -> token -> steer_pending -> withdraw -> steer_withdrawn")
        try sendFixtureMessage("Back up the cluster")

        XCTAssertTrue(app.staticTexts["Check the backup logs too"].awaitExistence(timeout: 10), "The pending steer from Web is missing")
        XCTAssertTrue(app.staticTexts["Skip the cache"].awaitExistence(timeout: 5), "The second pending steer is missing")
        XCTAssertTrue(element(labelContaining: "Waiting for agent").awaitExistence(timeout: 5))
        let sendNow = app.buttons["Send now"]
        XCTAssertTrue(sendNow.awaitExistence(timeout: 5))
        // Only the actions the server allows: the second steer offers no Send now.
        XCTAssertEqual(app.buttons.matching(identifier: "Send now").count, 1)
        XCTAssertEqual(app.buttons.matching(identifier: "Edit steering message").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "Cancel steering message").count, 2)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "pending-steer"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        tapCenter(of: sendNow)
        XCTAssertTrue(element(labelContaining: "it stays pending").awaitExistence(timeout: 5), "Send now gave no notice when nothing could take it")

        // Edit appends the steer after the draft, a blank line between.
        let input = app.textViews.firstMatch
        if !input.awaitExistence(timeout: 2) {
            try XCTUnwrap(waitForComposer(timeout: 5)).tap()
            XCTAssertTrue(input.awaitExistence(timeout: 5))
        }
        XCTAssertTrue(app.keyboards.firstMatch.awaitExistence(timeout: 5), "The composer has no keyboard to type the draft")
        input.typeText("Draft")
        // With the keyboard up the composer's control strip stays (TAL-629), so the first steer's
        // actions can sit under the navigation bar; scroll them back into view before tapping Edit.
        let edit = app.buttons.matching(identifier: "Edit steering message").firstMatch
        let navigationBarBottom = app.navigationBars.firstMatch.frame.maxY
        if edit.frame.minY < navigationBarBottom + 8 {
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: app.frame.midX, dy: navigationBarBottom + 120))
            start.press(
                forDuration: 0.05,
                thenDragTo: start.withOffset(CGVector(dx: 0, dy: navigationBarBottom + 60 - edit.frame.minY)),
                withVelocity: .slow,
                thenHoldForDuration: 0.2
            )
        }
        XCTAssertGreaterThan(edit.frame.minY, navigationBarBottom, "The steer's Edit action stayed under the navigation bar")
        tapCenter(of: edit)
        XCTAssertTrue(app.staticTexts["Check the backup logs too"].awaitNonExistence(timeout: 10), "The edited steer is still pending")
        XCTAssertEqual(input.value as? String, "Draft\n\nCheck the backup logs too")
    }
}

/// The composer collapses as the transcript scrolls and expands again, starting from a fresh,
/// unfocused composer with no draft. Its first expansion runs in `ChatNavigationUITests`.
final class ChatComposerUITests: ChatUITestCase {
    func testComposerCollapsesAndExpandsWithoutBottomNavigation() throws {
        launchFixture()
        _ = try openFixtureSession()

        // The composer's control strip scrolls too and inherits the screen's identifier; the transcript comes first.
        let transcript = app.scrollViews["chat-detail:\(fixtureSessionTitle)"].firstMatch
        XCTAssertTrue(transcript.awaitExistence(timeout: 3))
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)
        transcript.swipeUp(velocity: .slow)

        let collapsedComposer = app.buttons["Message"]
        XCTAssertTrue(collapsedComposer.awaitExistence(timeout: 5))
        // The control strip stays under the one-line composer (TAL-629).
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(collapsedComposer.exists)

        let composerOptions = app.buttons["Composer options"]
        XCTAssertTrue(composerOptions.exists)
        composerOptions.tap()
        XCTAssertTrue(app.buttons["Attach File"].awaitExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Photos"].exists)
        XCTAssertTrue(app.buttons["Camera"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()

        let collapsedComposerScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        collapsedComposerScreenshot.name = "Collapsed composer"
        collapsedComposerScreenshot.lifetime = .keepAlways
        add(collapsedComposerScreenshot)

        collapsedComposer.tap()
        let keyboard = app.keyboards.firstMatch
        let reexpandedTextView = app.textViews.firstMatch
        XCTAssertTrue(reexpandedTextView.awaitExistence(timeout: 10))
        reexpandedTextView.typeText("Draft")

        // With the keyboard up the strip's controls stay one tap away (TAL-629).
        XCTAssertTrue(keyboard.exists)
        let model = app.buttons["Select model"]
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertLessThan(model.frame.maxY, keyboard.frame.minY, "The model control is under the keyboard")
        tapCenter(of: model)
        XCTAssertTrue(app.buttons["All Models..."].awaitExistence(timeout: 3), "The model menu did not open")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        XCTAssertTrue(app.buttons["All Models..."].awaitNonExistence(timeout: 3))

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            .press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            )
        XCTAssertTrue(keyboard.awaitNonExistence(timeout: 3))

        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
    }
}

/// TAL-633: a photo picked from the composer's Photos menu attaches. The picker used to hang off the
/// `+` button, which the composer replaces when the picker expands it, so the pick was lost.
/// `scripts/seed-simulator-photo` puts a photo in the library before the run.
final class ComposerPhotoPickerUITests: ChatUITestCase {
    func testPhotoPickedFromPhotosAttachesToTheComposer() throws {
        launchFixture()
        _ = try openFixtureSession()

        let options = app.buttons["Composer options"]
        XCTAssertTrue(options.awaitExistence(timeout: 5))
        options.tap()
        let photos = app.buttons["Photos"]
        XCTAssertTrue(photos.awaitExistence(timeout: 5))
        photos.tap()

        // The picker loads out of process; its cells are labelled "Photo, <date>".
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH[c] %@", "Photo")).firstMatch
        XCTAssertTrue(photo.awaitExistence(timeout: 20), "The Photos picker showed no photo")
        photo.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.awaitExistence(timeout: 5), "The Photos picker offered no Done")
        done.tap()

        let remove = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove attachment")).firstMatch
        XCTAssertTrue(remove.awaitExistence(timeout: 15), "The picked photo never attached to the composer")
    }
}

/// TAL-634: pending attachments sit in a strip hanging from the composer card's top edge; removing
/// the last one takes the strip away. The chat's draft restores two staged photos, so the strip
/// does not wait on the out-of-process Photos picker (TAL-649); `ComposerPhotoPickerUITests`
/// covers picking.
final class ComposerAttachmentStripUITests: ChatUITestCase {
    func testAttachmentsShowInTheTopStripAndLeaveWithTheirRemoveButton() throws {
        launchFixture(additionalArguments: ["--ui-test-draft-attachments"])
        _ = try openFixtureSession()
        let removeButtons = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove attachment"))
        XCTAssertTrue(
            poll(timeout: 15) { removeButtons.count == 2 },
            "Expected 2 restored attachment chips, found \(removeButtons.count)"
        )

        let strip = app.otherElements["composer-attachment-strip"]
        XCTAssertTrue(strip.exists, "The attachments are not in the top strip")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open attachment")).count, 2)
        let composerTop = try XCTUnwrap(waitForComposer(timeout: 5)).frame.minY
        XCTAssertLessThan(strip.frame.minY, composerTop, "The strip does not sit above the composer card")

        tapCenter(of: removeButtons.element(boundBy: 0))
        XCTAssertTrue(poll(timeout: 5) { removeButtons.count == 1 }, "Remove did not take the attachment away")
        tapCenter(of: removeButtons.element(boundBy: 0))
        XCTAssertTrue(strip.awaitNonExistence(timeout: 5), "The strip stayed after its last attachment was removed")
    }
}

/// TAL-636: a new chat opens on the real composer while its session is starting; the controls
/// join it once the server answers, and the composer (with what was typed) never changes.
final class NewChatComposerUITests: ChatUITestCase {
    func testNewChatTypesIntoTheRealComposerWhileItsSessionStarts() throws {
        launchFixture(additionalArguments: ["--ui-test-hold-session-creation"])
        let newChat = app.buttons["New Chat"].firstMatch
        XCTAssertTrue(newChat.awaitExistence(timeout: 15))
        newChat.tap()

        // The chat screen's identifier reaches the strip, so it is found by its words.
        let starting = app.staticTexts["Starting chat…"]
        XCTAssertTrue(starting.awaitExistence(timeout: 10), "The strip does not show the session starting")
        let input = readyComposerInput(try XCTUnwrap(waitForComposer(timeout: 5), "The new chat has no real composer"))
        XCTAssertTrue(app.keyboards.firstMatch.awaitExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        input.typeText("Typed before the session")
        XCTAssertFalse(app.buttons["Send"].isEnabled, "Send must wait for the session")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "New chat starting"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        XCTAssertTrue(releaseHeldLoads { app.buttons["Select model"].exists }, "The controls never joined the strip")
        XCTAssertTrue(starting.awaitNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Typed before the session", "The draft did not survive the session starting")
        // Focus itself, not the keyboard: a fresh simulator's swipe-typing tip can cover the keyboard.
        XCTAssertEqual(input.value(forKey: "hasKeyboardFocus") as? Bool, true, "The composer lost focus when the session started")
        XCTAssertTrue(app.buttons["Send"].isEnabled)
    }

    func testNewChatReportsAFailedStartInItsComposerAndRetries() throws {
        launchFixture(additionalArguments: ["--ui-test-fail-first-session-creation"])
        let newChat = app.buttons["New Chat"].firstMatch
        XCTAssertTrue(newChat.awaitExistence(timeout: 15))
        newChat.tap()

        let retry = app.buttons["Retry"]
        XCTAssertTrue(retry.awaitExistence(timeout: 10), "The composer does not offer Retry after a failed start")
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        tapCenter(of: retry)
        XCTAssertTrue(app.buttons["Select model"].awaitExistence(timeout: 10), "Retry did not start the chat")
        XCTAssertFalse(retry.exists)
    }
}

/// TAL-444: a wide window keeps the transcript and the composer in one centred reading column of
/// at most 800 pt, while the transcript itself still scrolls edge to edge. On an iPad in landscape
/// the cap engages; a window already narrower than the column passes the same bounds untouched.
final class ChatReadableWidthUITests: ChatUITestCase {
    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        try super.tearDownWithError()
    }

    func testTranscriptAndComposerShareACentredReadableColumnInLandscape() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        launchFixture()
        // The row leads the list, in the iPad sidebar too, where `tapFixtureSession`'s
        // phone-list viewport does not apply.
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        session.tap()
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")

        // The composer's control strip scrolls too and inherits the screen's identifier; the transcript comes first.
        let transcript = app.scrollViews["chat-detail:\(fixtureSessionTitle)"].firstMatch
        XCTAssertTrue(transcript.awaitExistence(timeout: 3))
        let reply = element(labelContaining: "FixturePlainLead")
        let request = element(labelContaining: "Fixture link request")
        XCTAssertTrue(reply.awaitExistence(timeout: 15), "Missing the fixture's long assistant reply")
        XCTAssertTrue(request.awaitExistence(timeout: 5), "Missing the fixture's user message")

        // The chat's own pane: the whole window on iPhone, the area beside the sidebar on iPad.
        let pane = settledFrame(of: app.otherElements["chat-detail:\(fixtureSessionTitle)"].firstMatch)
        let scrollFrame = settledFrame(of: transcript)
        let replyFrame = settledFrame(of: reply)
        let requestFrame = settledFrame(of: request)
        // The composer card's leading and trailing controls bound it.
        let composerFrame = settledFrame(of: app.buttons["Composer options"])
            .union(settledFrame(of: app.buttons["Send"]))

        // The scroll view, and with it the scroll indicator, still reaches the window edge.
        XCTAssertEqual(scrollFrame.maxX, app.windows.firstMatch.frame.maxX, accuracy: 1)
        // The assistant reply starts the column and the user message ends it.
        let column = CGRect(x: replyFrame.minX, y: 0, width: requestFrame.maxX - replyFrame.minX, height: 1)
        for (name, frame) in [("Transcript column", column), ("Composer", composerFrame)] {
            XCTAssertLessThanOrEqual(frame.width, AdaptiveReadableWidth.chat, "\(name) \(frame) in \(pane)")
            XCTAssertEqual(frame.midX, pane.midX, accuracy: 4, "\(name) \(frame) is not centred in \(pane)")
        }

        // The jump to the latest message still returns to the end of the transcript.
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)
        let jump = app.buttons["Scroll to latest message"]
        XCTAssertTrue(jump.awaitExistence(timeout: 5), "Scrolling up did not offer the jump to the latest message")
        tapCenter(of: jump)
        XCTAssertTrue(jump.awaitNonExistence(timeout: 5), "The jump did not return to the latest message")

        // The expanded composer stays above the keyboard.
        app.buttons["Message"].tap()
        let textView = app.textViews.firstMatch
        XCTAssertTrue(textView.awaitExistence(timeout: 10))
        let keyboard = app.keyboards.firstMatch
        if keyboard.awaitExistence(timeout: 5) {
            XCTAssertLessThanOrEqual(settledFrame(of: textView).maxY, settledFrame(of: keyboard).minY)
        }
    }

    /// Mirrors `AdaptiveReadableContentWidth.chat`; the UI test bundle does not link TalariaKit.
    private enum AdaptiveReadableWidth {
        static let chat: CGFloat = 800
    }
}

/// A web link in a reply opens the in-app Safari sheet over the chat; its dismiss button returns to
/// the same transcript position with the composer draft intact (TAL-442).
final class TranscriptWebLinkUITests: ChatUITestCase {
    func testWebLinkOpensInAppSafariAndCloseKeepsTheChat() throws {
        launchFixture()
        _ = try openFixtureSession()

        let input = app.textViews.firstMatch
        if !input.awaitExistence(timeout: 2) {
            app.buttons["Message"].tap()
        }
        XCTAssertTrue(input.awaitExistence(timeout: 10), "The composer did not expand")
        input.typeText("Fixture draft")
        // With the keyboard up, a transcript tap only dismisses it.
        let keyboard = app.keyboards.firstMatch
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        XCTAssertTrue(keyboard.awaitNonExistence(timeout: 5), "The keyboard did not close")

        let link = app.links["FixtureLinkTarget"]
        XCTAssertTrue(link.awaitExistence(timeout: 15), "Missing the fixture's web link")
        let linkFrame = settledFrame(of: link)
        tapCenter(of: link)

        // Safari's own browser view and its dismiss button, which reads Close on iOS 26.
        let browser = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH 'BrowserView'")).firstMatch
        XCTAssertTrue(browser.awaitExistence(timeout: 15), "The web link did not open the in-app Safari sheet")
        XCTAssertEqual(app.state, .runningForeground, "The web link left Talaria")
        let close = app.buttons["Close"]
        XCTAssertTrue(close.awaitExistence(timeout: 5), "The Safari sheet has no dismiss button")
        close.tap()

        XCTAssertTrue(browser.awaitNonExistence(timeout: 10), "Close did not dismiss the Safari sheet")
        XCTAssertEqual(settledFrame(of: link), linkFrame, "Dismissing Safari moved the transcript")
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Fixture draft", "Dismissing Safari lost the draft")
    }
}

class SettingsUITestCase: TalariaUITestCase {}

/// The category root, where moved controls live, every category's route, and the server-backed
/// Chats and Providers screens with the grouped controls around them, in one launch. Their failed
/// loads run in `ReadFailureUITests`.
final class SettingsStructureUITests: SettingsUITestCase {
    func testApprovalAlertPreferenceSharesNotificationSettings() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "notificationsAndHaptics", title: "Notifications & Haptics")
        XCTAssertTrue(app.switches["Response Complete Alerts"].exists)
        XCTAssertTrue(app.switches["Approval Alerts"].exists)
        XCTAssertTrue(app.switches["Provider Quota Alerts"].exists)
        for level in ["Warning Alerts", "Critical Alerts", "Time Sensitive"] {
            let toggle = app.switches[level]
            repeatStep(6, until: { toggle.exists }) { app.swipeUp() }
            XCTAssertTrue(toggle.exists, "Missing \(level)")
            XCTAssertFalse(toggle.isEnabled, "\(level) waits for Provider Quota Alerts")
        }
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Approval Alerts in notification settings"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testAboutAcknowledgementsShowBundledLicenseNotices() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "about", title: "About")

        tapSettingsRow(label: "Acknowledgements")
        XCTAssertTrue(app.navigationBars["Acknowledgements"].awaitExistence(timeout: Self.navigationTimeout))
        tapSettingsRow(label: "SwiftMath, 1.7.3")
        XCTAssertTrue(app.navigationBars["SwiftMath"].awaitExistence(timeout: Self.navigationTimeout))
        let notice = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "Copyright (c) 2023 Computer Inspirations"))
            .firstMatch
        XCTAssertTrue(notice.awaitExistence(timeout: 3), "Missing SwiftMath's bundled license notice")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "SwiftMath acknowledgement"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testSettingsRootCategoriesRoutesAndServerContent() throws {
        launchFixture()
        openSettings()

        XCTAssertTrue(app.buttons["settings-user-profile"].exists)
        let appleAccount = app.buttons["settings-apple-account"]
        XCTAssertTrue(appleAccount.exists)
        for categoryID in ["appearance", "notificationsAndHaptics", "chats"] {
            XCTAssertTrue(app.buttons["settings-category-\(categoryID)"].exists)
        }
        // The single Sign in with Apple lives on the account screen, not the root.
        XCTAssertFalse(app.buttons["settings-sign-in-with-apple"].exists)
        tapCenter(of: appleAccount)
        XCTAssertTrue(app.navigationBars["Apple Account"].awaitExistence(timeout: 3))
        XCTAssertTrue(app.buttons["settings-sign-in-with-apple"].awaitExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["Haptic Feedback"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Default Model"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Clear Offline Cache"].exists)
        let rootScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        rootScreenshot.name = "Settings category root"
        rootScreenshot.lifetime = .keepAlways
        add(rootScreenshot)

        tapCenter(of: app.buttons["settings-user-profile"])
        XCTAssertTrue(app.navigationBars["User Profile"].awaitExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["Display Name"].exists)
        app.navigationBars["User Profile"].buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: 3))

        for category in [
            ("notificationsAndHaptics", "Notifications & Haptics", "Provider Quota Alerts"),
            ("notificationsAndHaptics", "Notifications & Haptics", "Approval & Input Alerts"),
            ("chats", "Chats", "Thinking & Tools"),
            ("liveActivitiesAndWidgets", "Live Activities & Widgets", "Live Activity Excerpts"),
        ] {
            tapSettingsCategory(id: category.0, title: category.1)
            let setting = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", category.2))
                .firstMatch
            repeatStep(12, until: { setting.exists }) {
                app.swipeUp()
            }
            XCTAssertTrue(setting.exists, "Missing \(category.2) under \(category.1)")
            app.navigationBars[category.1].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: 3))
        }

        for category in [
            ("appearance", "Appearance"),
            ("siriAndShortcuts", "Siri & Shortcuts"),
            ("servers", "Servers"),
            ("dataAndStorage", "Data & Storage"),
            ("about", "About"),
            ("developer", "Developer"),
        ] {
            tapSettingsCategory(id: category.0, title: category.1)
            app.navigationBars[category.1].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: Self.navigationTimeout))
        }

        assertChatsAndProvidersShowTheirControlsAndServerContent()
    }

    /// A server's typed name saves once the editor closes, so the Servers list shows it (TAL-123).
    func testServerIdentityEditSavesWhenTheEditorCloses() throws {
        launchFixture()
        renameFixtureServer(to: "Work Box")
        attachScreenshot(named: "Server name typed in the editor")

        app.navigationBars["Work Box"].buttons["Servers"].tap()
        XCTAssertTrue(app.navigationBars["Servers"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(serverRow(named: "Work Box").awaitExistence(timeout: 5))
        attachScreenshot(named: "Servers list after closing the editor")
    }

    /// A failed identity save stays visible with Retry, and the Servers list keeps the saved
    /// name instead of the unsaved one (TAL-123).
    func testFailedServerIdentitySaveShowsRetry() throws {
        launchFixture(additionalArguments: ["--ui-test-identity-save-fails"])
        renameFixtureServer(to: "Work Box")

        let retry = app.buttons["Retry"]
        XCTAssertTrue(retry.awaitExistence(timeout: 5))
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists, "Showing the failed save ended typing")
        XCTAssertLessThanOrEqual(retry.frame.maxY, keyboard.frame.minY, "The keyboard covers the failed-save notice")
        attachScreenshot(named: "Failed server identity save with Retry")
        app.navigationBars["Work Box"].buttons["Servers"].tap()
        XCTAssertTrue(app.navigationBars["Servers"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.buttons["Retry"].awaitExistence(timeout: 5))
        XCTAssertTrue(serverRow(named: "ui-test.talaria.invalid").exists)
        XCTAssertFalse(serverRow(named: "Work Box").exists)
        attachScreenshot(named: "Servers list keeps the saved name")
    }

    /// Opens the fixture server's detail screen and replaces its Display Name with `name`.
    private func renameFixtureServer(to name: String) {
        openSettings()
        tapSettingsCategory(id: "servers", title: "Servers")
        let row = serverRow(named: "ui-test.talaria.invalid")
        XCTAssertTrue(row.awaitExistence(timeout: Self.navigationTimeout))
        row.tap()
        // A Settings text field is labeled by its placeholder, the server's host here.
        let field = app.textFields["ui-test.talaria.invalid"]
        XCTAssertTrue(field.awaitExistence(timeout: Self.navigationTimeout))
        // The value is trailing-aligned, so a tap at the trailing edge puts the caret after it.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        let current = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + name)
        XCTAssertTrue(app.navigationBars[name].awaitExistence(timeout: 5))
    }

    private func serverRow(named name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name), ")).firstMatch
    }

    /// Settings follows the applied update's server notification through the restart and shows
    /// the server's own explanation when it fails (TAL-558).
    func testServerUpdateFollowsTheServerPhaseAndShowsItsFailureDetail() throws {
        launchFixture(additionalArguments: ["--ui-test-server-update"])
        openSettings()
        tapSettingsCategory(id: "servers", title: "Servers")
        let update = app.buttons["Update"]
        repeatStep(8, until: { update.exists && update.isHittable }) { app.swipeUp() }
        _ = update.settledFrame
        update.tap()
        let confirm = app.alerts["Update server?"].buttons["Update"]
        XCTAssertTrue(confirm.awaitExistence(timeout: 5))
        confirm.tap()

        let restarting = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Updating & restarting"))
            .firstMatch
        XCTAssertTrue(restarting.awaitExistence(timeout: 5))
        let restartingShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        restartingShot.name = "Server update restarting"
        restartingShot.lifetime = .keepAlways
        add(restartingShot)

        let failure = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "unresolved merge conflicts"))
            .firstMatch
        XCTAssertTrue(failure.awaitExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Retry update"].exists)
        let failedShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        failedShot.name = "Server update failed with server detail"
        failedShot.lifetime = .keepAlways
        add(failedShot)
    }

    /// Starts at the Settings root.
    private func assertChatsAndProvidersShowTheirControlsAndServerContent() {
        tapSettingsCategory(id: "chats", title: "Chats")
        let composerHeading = app.staticTexts["Composer"]
        repeatStep(8, until: { composerHeading.exists }) {
            app.swipeUp()
        }
        XCTAssertTrue(composerHeading.exists)
        for label in [
            "Send While Responding",
            "Send With",
            "Dictation Provider",
            "Workspace",
            "Profile",
            "Git Branch",
            "Context Usage",
        ] {
            let setting = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", label))
                .firstMatch
            repeatStep(8, until: { setting.exists }) {
                app.swipeUp()
            }
            XCTAssertTrue(setting.exists, "Missing composer setting: \(label)")
        }
        // TAL-468: at the default text size the menu value never wraps onto a second line.
        let sendWhileRespondingValue = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Send While Responding"))
            .staticTexts["Steer active response"]
        let oneLineLabel = app.switches["Workspace"].staticTexts["Workspace"].firstMatch
        XCTAssertTrue(sendWhileRespondingValue.exists)
        XCTAssertTrue(oneLineLabel.exists)
        XCTAssertLessThan(
            sendWhileRespondingValue.frame.height,
            oneLineLabel.frame.height * 1.5,
            "Send While Responding's value wrapped onto a second line"
        )
        // Choosing a longer value keeps the row's layout instead of moving the value under its title.
        let dictationPicker = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Dictation Provider"))
            .firstMatch
        XCTAssertTrue(dictationPicker.staticTexts["Server first"].exists)
        let dictationFrame = dictationPicker.settledFrame
        tapCenter(of: dictationPicker)
        let onDeviceFirst = app.buttons["On-device first"]
        XCTAssertTrue(onDeviceFirst.awaitExistence(timeout: Self.navigationTimeout))
        onDeviceFirst.tap()
        XCTAssertTrue(dictationPicker.staticTexts["On-device first"].awaitExistence(timeout: Self.navigationTimeout))
        let changedFrame = dictationPicker.settledFrame
        XCTAssertEqual(changedFrame.minY, dictationFrame.minY, accuracy: 1, "Dictation Provider changed layout with its value")

        app.navigationBars["Chats"].buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: Self.navigationTimeout))
        openProviders()
        XCTAssertTrue(
            element(labelContaining: "Fixture Provider").awaitExistence(timeout: 10),
            "The providers list did not show the fixture provider"
        )
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.navigationBars["Providers"].awaitExistence(timeout: Self.navigationTimeout))

        let percentage = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Quota Percentage"))
            .firstMatch
        repeatStep(12, until: { percentage.exists }) {
            app.swipeUp()
        }
        XCTAssertTrue(percentage.exists)
        XCTAssertTrue(app.staticTexts["Used"].exists)

        let quotaRefresh = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Quota Refresh"))
            .firstMatch
        repeatStep(6, until: { quotaRefresh.exists }) {
            app.swipeUp()
        }
        XCTAssertTrue(quotaRefresh.exists)
        XCTAssertTrue(app.staticTexts["Every 5 minutes"].exists)
        add(XCTAttachment(screenshot: XCUIScreen.main.screenshot()))

        // Last, because XCTest's next action after Archived Chats waits a minute for the app to
        // go idle, locally and on hosted runners.
        app.navigationBars["Providers"].buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: Self.navigationTimeout))
        openArchivedChats()
        XCTAssertTrue(
            element(labelContaining: "Fixture Archived Session").awaitExistence(timeout: 10),
            "The archived list did not show the fixture archived session"
        )
    }
}

final class RelaySettingsUITests: SettingsUITestCase {
    func testSyncErrorStatusOffersCopy() throws {
        // The relay sign-in signs sync in with the same Apple account; the
        // fixture's iCloud store is unavailable, so turning sync on fails.
        launchFixture(additionalArguments: ["--ui-test-relay-connected"])
        openSettings()
        tapCenter(of: app.buttons["settings-apple-account"])
        XCTAssertTrue(app.navigationBars["Apple Account"].awaitExistence(timeout: 3))

        let toggle = app.switches["settings-icloud-sync-toggle"]
        XCTAssertTrue(toggle.awaitExistence(timeout: 3))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()

        let status = app.buttons["settings-icloud-sync-status"]
        XCTAssertTrue(status.awaitExistence(timeout: 5), "The sync error is not a tappable control")
        XCTAssertTrue(status.label.contains("iCloud sync is off in the UI-test fixture."))
        tapCenter(of: status)
        XCTAssertTrue(app.buttons["Copy"].awaitExistence(timeout: 3), "Tapping the sync error offered no Copy action")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Sync error Copy menu"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testConnectedRelaySettingsUsePassiveStatusAndManagedDisconnect() throws {
        launchFixture(additionalArguments: ["--ui-test-relay-connected"])
        openSettings()

        let appleAccount = app.buttons["settings-apple-account"]
        XCTAssertTrue(appleAccount.awaitExistence(timeout: 3))
        tapCenter(of: appleAccount)
        XCTAssertTrue(app.navigationBars["Apple Account"].awaitExistence(timeout: 3))
        XCTAssertFalse(app.buttons["settings-sign-in-with-apple"].exists)

        let manageRelay = app.buttons["settings-manage-relay"]
        XCTAssertTrue(manageRelay.awaitExistence(timeout: 3))
        XCTAssertTrue(manageRelay.label.contains("Connected to"))
        tapCenter(of: manageRelay)

        XCTAssertTrue(app.navigationBars["Talaria Relay"].awaitExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://ui-test.talaria.invalid"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://removed.ui-test.invalid"].exists)
        XCTAssertFalse(app.buttons["Connect"].exists)
        let unenroll = app.buttons["Enrollment options for removed.ui-test.invalid"]
        XCTAssertTrue(unenroll.awaitExistence(timeout: 3))
        tapCenter(of: unenroll)
        XCTAssertTrue(app.buttons["This iPhone"].awaitExistence(timeout: 3))
        XCTAssertTrue(app.buttons["All Devices"].exists)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["settings-disconnect-relay"].exists)
    }

}

/// Every workspace destination hangs off an open chat, so these launches add the
/// deterministic file/Git fixture and drive the session's own toolbar.
class WorkspaceUITestCase: TalariaUITestCase {
    override var fixtureLaunchArguments: [String] {
        super.fixtureLaunchArguments + ["--ui-test-workspace"]
    }
}

/// `--ui-test-workspace-slow-reads` holds every listing and Git status read until the test
/// releases it, so each loading state is observable before its content arrives.
final class WorkspaceLoadingUITests: WorkspaceUITestCase {
    func testChangesSheetAndFileBrowserLoadThenNavigate() throws {
        launchFixture(additionalArguments: ["--ui-test-workspace-slow-reads"])
        openFixtureSessionChat()

        openGitActions()
        let changes = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "+"))
            .firstMatch
        XCTAssertTrue(
            releaseHeldLoads(timeout: 25) { changes.exists },
            "The Git status never reached the actions menu"
        )
        changes.tap()
        XCTAssertTrue(
            app.staticTexts["Loading…"].awaitExistence(timeout: 10),
            "Missing the Git changes loading state"
        )
        XCTAssertTrue(
            releaseHeldLoads(timeout: 25) { app.staticTexts["2 files changed"].exists },
            "The changes sheet did not show the fixture status"
        )
        XCTAssertTrue(gitFileCard(named: "fixture-notes.txt").exists)
        XCTAssertTrue(gitFileCard(named: "nested-note.txt").exists)
        app.buttons["Done"].tap()

        openFiles()
        XCTAssertTrue(
            app.staticTexts["Loading files..."].awaitExistence(timeout: 10),
            "Missing the file browser loading state"
        )
        XCTAssertTrue(releaseHeldLoads { fileRow(folder: "fixture-dir").exists }, "The root listing never loaded")
        XCTAssertTrue(fileRow(file: "fixture-notes.txt").exists)
        XCTAssertFalse(app.buttons["Up"].isEnabled, "The root has no parent to walk up to")
        XCTAssertFalse(app.buttons["Root"].isEnabled)

        openDirectory("fixture-dir")
        XCTAssertTrue(
            releaseHeldLoads { fileRow(file: "nested-note.txt").exists },
            "Opening a directory did not list its entries"
        )
        XCTAssertTrue(app.buttons["Up"].isEnabled)

        tapCenter(of: app.buttons["Open Root"])
        XCTAssertTrue(
            releaseHeldLoads { fileRow(file: "fixture-notes.txt").exists },
            "The Root breadcrumb did not return to the root"
        )

        openDirectory("fixture-dir")
        XCTAssertTrue(releaseHeldLoads { fileRow(file: "nested-note.txt").exists })
        tapCenter(of: app.buttons["Up"])
        XCTAssertTrue(
            releaseHeldLoads { fileRow(file: "fixture-notes.txt").exists },
            "Up did not return to the root"
        )
    }
}

/// Memory and Files headers keep whole words at accessibility text sizes (TAL-466): each Memory
/// title stays on one line with its modified caption below it, and Root and Up keep their names.
final class HeaderTextSizeUITests: WorkspaceUITestCase {
    static let memoryTitles = ["My Notes", "User Profile", "Agent Soul"]

    func testMemoryAndFilesHeadersKeepWholeWordsAtAccessibilityTextSize() throws {
        let defaultHeaders = launchAndMeasureMemoryHeaders(textSize: "UICTContentSizeCategoryL")
        app.terminate()
        let accessibilityHeaders = launchAndMeasureMemoryHeaders(textSize: "UICTContentSizeCategoryAccessibilityXL")
        // AX3 scales one header line about 2.4× (20 → 48 pt), so a second line lands past 4×.
        for name in Self.memoryTitles {
            let defaultHeader = try XCTUnwrap(defaultHeaders[name])
            let accessibilityHeader = try XCTUnwrap(accessibilityHeaders[name])
            XCTAssertTrue(
                defaultHeader.title.minY..<defaultHeader.title.maxY ~= defaultHeader.caption.midY,
                "\(name)'s caption left its title row at the default size"
            )
            XCTAssertGreaterThanOrEqual(
                accessibilityHeader.caption.minY, accessibilityHeader.title.maxY - 1,
                "\(name)'s caption must sit below its title at AX3"
            )
            XCTAssertLessThan(accessibilityHeader.title.height, defaultHeader.title.height * 3, "\(name) wrapped at AX3")
        }

        openSidebarDestination("Chats")
        XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout))
        openFixtureSessionChat()
        openFiles()
        let root = app.buttons["Root"]
        let up = app.buttons["Up"]
        XCTAssertTrue(root.awaitExistence(timeout: 10), "Missing the Root control at AX3")
        XCTAssertEqual(root.label, "Root")
        XCTAssertEqual(up.label, "Up")
        // Icon-only glyphs differ by a few points; a wrapped title was 2.6× Up's height.
        XCTAssertLessThan(root.frame.height, up.frame.height * 1.5, "Root wrapped at AX3")
    }

    /// Opens Memory at `textSize` and returns each section title's frame with its modified
    /// caption's: the first caption that ends below the title's top, beside it or under it.
    private func launchAndMeasureMemoryHeaders(textSize: String) -> [String: (title: CGRect, caption: CGRect)] {
        launchFixture(additionalArguments: ["--ui-test-panels", "-UIPreferredContentSizeCategoryName", textSize])
        XCTAssertTrue(app.buttons["Open navigation"].awaitExistence(timeout: 15), "Missing deterministic app fixture")
        openSidebarDestination("Memory")
        let firstTitle = element(label: Self.memoryTitles[0])
        XCTAssertTrue(releaseHeldLoads { firstTitle.exists }, "Memory did not render its sections [\(textSize)]")
        _ = firstTitle.settledFrame

        let captions = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Modified"))
        func caption(of title: CGRect) -> CGRect? {
            captions.allElementsBoundByIndex.map(\.frame)
                .filter { $0.maxY > title.minY }
                .min { $0.minY < $1.minY }
        }
        var headers: [String: (title: CGRect, caption: CGRect)] = [:]
        for name in Self.memoryTitles {
            let header = element(label: name)
            // The list builds rows near the viewport, so scroll until the caption under the title exists too.
            repeatStep(6, until: { header.exists && header.frame.maxY < app.frame.maxY && caption(of: header.frame) != nil }) {
                app.swipeUp()
            }
            let title = header.settledFrame
            let captionFrame = caption(of: title)
            XCTAssertNotNil(captionFrame, "\(name) showed no modified caption [\(textSize)]")
            headers[name] = (title, captionFrame ?? .null)
        }
        return headers
    }
}

/// TAL-484: workspace, profile and Git branch chips show their full title or only their icon, and
/// VoiceOver reads the full title either way. `ComposerChipLayoutTests` pins the collapse; run this
/// on a narrow destination such as the iPhone Duo outer display to see the icon-only form.
final class ComposerChipUITests: WorkspaceUITestCase {
    func testComposerChipsNameTheirFullTitleForVoiceOver() throws {
        try assertComposerChipsNameTheirFullTitle(textSize: "UICTContentSizeCategoryL")
    }

    /// Accessibility sizes keep the stacked accessibility layout and collapse the same way.
    func testComposerChipsStayInsideTheWindowAtAccessibilityTextSize() throws {
        try assertComposerChipsNameTheirFullTitle(textSize: "UICTContentSizeCategoryAccessibilityXL")
    }

    private func assertComposerChipsNameTheirFullTitle(textSize: String) throws {
        launchFixture(additionalArguments: ["-UIPreferredContentSizeCategoryName", textSize])
        openFixtureSessionChat()

        let branch = app.buttons["Current Git branch"]
        XCTAssertTrue(branch.awaitExistence(timeout: 15), "Missing the Git branch chip")
        XCTAssertEqual(branch.value as? String, "fixture-main", "VoiceOver must read the full branch name")
        for label in ["Choose workspace path", "Choose profile"] {
            let chip = app.buttons[label]
            XCTAssertTrue(chip.exists, "Missing the \(label) chip")
            let title = try XCTUnwrap(chip.value as? String, "\(label) gave VoiceOver no title")
            XCTAssertFalse(title.isEmpty, "\(label) gave VoiceOver an empty title")
            XCTAssertFalse(title.contains("…"), "\(label) gave VoiceOver a truncated title")
        }
        // The strip scrolls when its controls overflow (TAL-629): one scrolled off the end must come into view.
        let strip = app.otherElements["composer-control-strip"]
        for chip in [branch, app.buttons["Choose workspace path"], app.buttons["Choose profile"]] {
            // Slow drags across the strip's visible middle (the scrolled row's own centre can be off
            // screen) until the control is in view; a fast swipe's momentum overshoots it.
            var drags = 0
            while !app.frame.contains(chip.frame), strip.exists, drags < 4 {
                let origin = app.coordinate(withNormalizedOffset: .zero)
                let travel: CGFloat = chip.frame.minX < app.frame.minX ? 100 : -100
                origin.withOffset(CGVector(dx: app.frame.midX - travel / 2, dy: chip.frame.midY))
                    .press(
                        forDuration: 0.05,
                        thenDragTo: origin.withOffset(CGVector(dx: app.frame.midX + travel / 2, dy: chip.frame.midY)),
                        withVelocity: .slow,
                        thenHoldForDuration: 0.2
                    )
                drags += 1
            }
            XCTAssertTrue(app.frame.contains(chip.frame), "\(chip.label) cannot be scrolled into the window")
            XCTAssertGreaterThanOrEqual(chip.frame.height, 43, "\(chip.label) has a hit area under 44 pt")
        }

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Composer chips [\(textSize)]"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}

/// Previews, a chat file link, a file that fails to read and the push guard share one workspace
/// launch; the fixture grants its Git write capability partway through (TAL-402).
final class WorkspaceFilePreviewUITests: WorkspaceUITestCase {
    func testPreviewsFileLinkAndPushConfirmationKeepTheirOwnActions() throws {
        launchFixture()
        openFixtureSessionChat()

        // A chat link that names a workspace file opens the source viewer at its line (TAL-169).
        let link = app.links["FixtureFileLink"]
        XCTAssertTrue(link.awaitExistence(timeout: 15), "Missing the fixture's workspace file link")
        tapCenter(of: link)
        XCTAssertTrue(
            app.navigationBars["fixture-notes.txt"].awaitExistence(timeout: 15),
            "The file link did not open the source viewer"
        )
        let secondLine = app.staticTexts["Second deterministic line."]
        XCTAssertTrue(secondLine.awaitExistence(timeout: 20), "The viewer did not render the linked file")
        XCTAssertTrue(app.staticTexts["Line 2"].awaitExistence(timeout: 5), "The viewer should number its rows")
        XCTAssertTrue(app.buttons["Enable code line wrapping"].awaitExistence(timeout: 5), "Source files offer a wrap toggle")
        XCTAssertTrue(app.buttons["Export file"].exists, "The linked file keeps the preview's export action")
        app.buttons["Done"].tap()
        XCTAssertTrue(waitForComposer(timeout: 10) != nil, "Dismissing the viewer should return to the chat")

        // Push asks first, and without the fixture write capability it fails visibly.
        openGitActions()
        tapGitMenuPush()
        let confirmation = app.alerts["Push Local Commits?"]
        XCTAssertTrue(confirmation.awaitExistence(timeout: 10), "Push must ask before contacting the remote")
        confirmation.buttons["Cancel"].tap()
        XCTAssertFalse(
            app.staticTexts["Push complete"].awaitExistence(timeout: 3),
            "Cancelling the confirmation must not push"
        )
        XCTAssertFalse(app.alerts["Git Action Failed"].exists)

        openGitActions()
        tapGitMenuPush()
        XCTAssertTrue(app.alerts["Push Local Commits?"].awaitExistence(timeout: 10))
        app.alerts["Push Local Commits?"].buttons["Push"].tap()
        let failure = app.alerts["Git Action Failed"]
        XCTAssertTrue(
            failure.awaitExistence(timeout: 20),
            "Without the fixture write capability a push must fail visibly"
        )
        XCTAssertTrue(failure.staticTexts["Fixture git writes are disabled."].exists)
        failure.buttons["OK"].tap()

        // Granted the capability, the same push completes.
        notify_post("dev.kil.talaria.ui-test.grant-git-writes")
        openGitActions()
        tapGitMenuPush()
        XCTAssertTrue(app.alerts["Push Local Commits?"].awaitExistence(timeout: 10))
        app.alerts["Push Local Commits?"].buttons["Push"].tap()
        XCTAssertTrue(
            app.staticTexts["Push complete"].awaitExistence(timeout: 25),
            "The granted fixture capability should complete the push"
        )

        openFiles()
        openPreview(file: "fixture-notes.txt")
        let body = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "FixtureTextPreviewBody"))
            .firstMatch
        XCTAssertTrue(body.awaitExistence(timeout: 20), "The text preview did not render its content")
        XCTAssertTrue(app.buttons["Export file"].awaitExistence(timeout: 5), "A text file should be exportable")
        assertPresentsFileExporter(from: app.buttons["Export file"], name: "file-exporter")
        XCTAssertFalse(app.buttons["Save image to Photos"].exists, "Only images save to Photos")
        app.buttons["BackButton"].tap()

        openPreview(file: "fixture-image.png")
        XCTAssertTrue(
            app.images["fixture-image.png"].awaitExistence(timeout: 20),
            "The image preview did not render its image"
        )
        XCTAssertTrue(app.buttons["Save image to Photos"].awaitExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Export file"].exists)
        app.buttons["BackButton"].tap()

        openPreview(file: "fixture-archive.zip")
        XCTAssertTrue(app.staticTexts["No Preview"].awaitExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Preview is not available for this file type."].exists)
        XCTAssertFalse(app.buttons["Save image to Photos"].exists, "An archive is not an image")
        app.buttons["BackButton"].tap()

        // The browser lists this file, but reading it fails.
        openPreview(file: "fixture-unreadable.txt")
        XCTAssertTrue(
            app.staticTexts["Could Not Load File"].awaitExistence(timeout: 20),
            "A failed preview must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists)
    }
}

/// In a wide chat Files toggles the browser in an inspector beside it (TAL-479): the transcript and
/// composer stay on screen and usable, and folders and files open inside it. At compact width
/// Files still pushes the browser in place of the chat.
final class FilesInspectorUITests: WorkspaceUITestCase {
    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        try super.tearDownWithError()
    }

    func testFilesOpensBesideTheChatAtRegularWidthAndPushesAtCompactWidth() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else {
            launchFixture()
            openFixtureSessionChat()
            openFiles()
            XCTAssertTrue(
                app.buttons["Message"].awaitNonExistence(timeout: 10),
                "At compact width the file browser replaces the chat"
            )
            return
        }
        // In landscape the iPad detail column is wide enough to show the inspector beside the chat.
        XCUIDevice.shared.orientation = .landscapeLeft
        launchFixture()
        // The row leads the iPad sidebar, where `tapFixtureSession`'s phone-list viewport does not apply.
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        session.tap()
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")

        openFiles()
        let folder = fileRow(folder: "fixture-dir")
        XCTAssertTrue(folder.awaitExistence(timeout: 20), "The root listing never loaded")
        let inspectorMinX = settledFrame(of: folder).minX
        let request = element(labelContaining: "Fixture link request")
        XCTAssertTrue(request.awaitExistence(timeout: 5), "Missing the fixture's user message")
        let composer = app.buttons["Message"]
        XCTAssertTrue(composer.exists, "The composer must stay beside the files")
        for (name, frame) in [("Transcript", settledFrame(of: request)), ("Composer", settledFrame(of: composer))] {
            XCTAssertGreaterThan(frame.width, 0, "\(name) left the screen")
            XCTAssertLessThanOrEqual(frame.maxX, inspectorMinX, "\(name) \(frame) is not beside the files")
        }
        tapCenter(of: composer)
        let input = app.textViews.firstMatch
        XCTAssertTrue(input.awaitExistence(timeout: 10), "The composer did not expand beside the files")
        input.typeText("Inspector draft")
        XCTAssertTrue(poll(timeout: 5) { input.value as? String == "Inspector draft" }, "The composer did not take the typed draft")
        XCTAssertTrue(app.navigationBars["Files"].exists, "Typing in the composer closed the files")

        openDirectory("fixture-dir")
        XCTAssertTrue(fileRow(file: "nested-note.txt").awaitExistence(timeout: 20), "The folder did not open in place")
        openPreview(file: "nested-note.txt")
        XCTAssertGreaterThanOrEqual(
            settledFrame(of: app.navigationBars["nested-note.txt"]).minX, inspectorMinX - 1,
            "Opening a file must stay inside the inspector"
        )
        XCTAssertLessThanOrEqual(settledFrame(of: input).maxX, inspectorMinX, "Opening a file must keep the chat beside it")
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.navigationBars["Files"].awaitExistence(timeout: 10), "Back did not return to the files")

        app.buttons["Files"].tap()
        XCTAssertTrue(app.navigationBars["Files"].awaitNonExistence(timeout: 10), "Files did not close the inspector")
        XCTAssertTrue(input.exists, "Closing the files must keep the chat")
    }
}

class QuotaWidgetUITestCase: TalariaUITestCase {}

final class QuotaInsightsUITests: QuotaWidgetUITestCase {
    func testInsightsShowsQuotaSurface() throws {
        launchFixture(additionalArguments: ["--provider-quotas"])

        XCTAssertTrue(app.staticTexts["Provider quotas"].awaitExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Refresh all provider quotas"].exists)
        XCTAssertTrue(app.buttons["Open provider quota settings"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["provider-quota-section"].exists)
        let quotaSource = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "provider-quota-source-"))
            .firstMatch
        XCTAssertTrue(quotaSource.awaitExistence(timeout: 10), "Expected at least one rendered quota source")
        XCTAssertTrue(app.staticTexts["Fixture Provider"].exists)
        XCTAssertFalse(app.staticTexts["device_code"].exists)
        XCTAssertTrue(app.images["Active provider"].exists)

        let quotaCell = app.cells.containing(.any, identifier: quotaSource.identifier).firstMatch
        let resetCaption = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Resets"))
            .firstMatch
        XCTAssertTrue(quotaCell.exists, "Expected the quota source to render inside a list cell")
        XCTAssertTrue(resetCaption.exists, "Expected the quota window's reset caption")
        XCTAssertGreaterThanOrEqual(
            quotaCell.frame.maxY - resetCaption.frame.maxY,
            10,
            "Expected bottom padding below the reset caption"
        )

        let warning = app.buttons["Provider quota warning"]

        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Insights provider quota surface"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        if warning.exists {
            warning.tap()
            XCTAssertTrue(
                app.descendants(matching: .any)["provider-quota-warning-details"]
                    .awaitExistence(timeout: 3),
                "Expected warning details after tapping the warning button"
            )
        }
    }

    func testProviderQuotaWidgetFixturePreparesPreview() throws {
        launchFixture(additionalArguments: ["--provider-quota-widget-fixture"])

        XCTAssertTrue(app.staticTexts["Widget fixture ready"].awaitExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts["Add or edit the Talaria Provider quotas widget to inspect its configured states."].exists
        )
    }
}

class SidebarUITestCase: TalariaUITestCase {}

final class SidebarPresentationUITests: SidebarUITestCase {
    func testSidebarPresentationClosingAndNewChat() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.awaitExistence(timeout: 15), "Missing deterministic app fixture")

        XCTAssertFalse(app.tabBars.firstMatch.exists)
        let navigationBar = app.navigationBars.firstMatch
        XCTAssertTrue(navigationBar.exists)
        let navigationTitle = navigationBar.staticTexts.firstMatch
        XCTAssertTrue(navigationTitle.exists)
        let initialTitleFrame = navigationTitle.frame
        let mainSurface = app.descendants(matching: .any)["app-main-surface"]
        XCTAssertTrue(mainSurface.exists)

        // Opened with its button: an edge swipe over a row is timing-sensitive on a loaded host
        // (a touch that rests at the edge for about half a second fails UIKit's edge pan and
        // swipes the row instead), and SidebarGestureUITests owns the edge swipe (TAL-653).
        let sidebar = openSidebar()
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertEqual(sidebar.elementType, .alert)
        for destination in ["Chats", "Tasks", "Kanban", "Skills", "Memory", "Insights", "Settings"] {
            XCTAssertTrue(
                sidebar.descendants(matching: .any)[destination].exists,
                "Missing sidebar destination: \(destination)"
            )
        }

        let screenshot = XCUIScreen.main.screenshot()
        let topEdgeDifference = abs(
            try brightness(in: screenshot, x: 0.98, y: 0.01)
                - brightness(in: screenshot, x: 0.02, y: 0.01)
        )
        let bottomEdgeDifference = abs(
            try brightness(in: screenshot, x: 0.98, y: 0.99)
                - brightness(in: screenshot, x: 0.02, y: 0.99)
        )
        XCTAssertGreaterThan(topEdgeDifference, 0.05)
        XCTAssertGreaterThan(bottomEdgeDifference, 0.05)

        let statusBar = app.statusBars.firstMatch
        if statusBar.exists {
            XCTAssertGreaterThanOrEqual(closeNavigation.frame.minY, statusBar.frame.maxY)
        }

        closeNavigation.tap()
        XCTAssertTrue(mainSurface.awaitExistence(timeout: 3))
        // Closing animates, so wait for the surface and the title to come to rest where they began.
        XCTAssertTrue(
            poll(timeout: 3) {
                abs(mainSurface.frame.minX - app.frame.minX) <= 1
                    && abs(navigationTitle.frame.minX - initialTitleFrame.minX) <= 1
            },
            "The main surface or its title did not return: \(mainSurface.frame), \(navigationTitle.frame)"
        )
        XCTAssertFalse(sidebar.isHittable)

        // A fully open sidebar closes with a slow diagonal swipe.
        openSidebar()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45))
            .press(
                forDuration: 0.2,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.57)),
                withVelocity: 100,
                thenHoldForDuration: 0.1
            )
        XCTAssertTrue(mainSurface.awaitExistence(timeout: 3))
        XCTAssertTrue(
            poll(timeout: 3) { abs(mainSurface.frame.minX - app.frame.minX) <= 1 },
            "The main surface did not return: \(mainSurface.frame)"
        )

        // New Chat opens the existing composer and closes the sidebar.
        XCTAssertTrue(poll(timeout: 3) { !sidebar.isHittable })
        openSidebar()
        let newChat = sidebar.buttons["New Chat"]
        XCTAssertTrue(newChat.awaitExistence(timeout: 3))
        _ = newChat.settledFrame
        newChat.tap()
        XCTAssertTrue(app.buttons["Composer options"].awaitExistence(timeout: 15))
        XCTAssertFalse(sidebar.isHittable)
    }
}

final class SidebarPerformanceUITests: SidebarUITestCase {
    @available(iOS 26.0, *)
    func testSidebarCloseHitchPerformance() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.awaitExistence(timeout: 15), "Missing deterministic app fixture")

        let mainSurface = app.descendants(matching: .any)["app-main-surface"]
        let closeNavigation = app.buttons["Close navigation"]
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        options.invocationOptions = [.manuallyStart, .manuallyStop]

        measure(
            metrics: [XCTHitchMetric(application: app), XCTCPUMetric(application: app)],
            options: options
        ) {
            openNavigation.tap()
            XCTAssertTrue(closeNavigation.awaitExistence(timeout: 3))

            startMeasuring()
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45))
                .press(
                    forDuration: 0.1,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)),
                    withVelocity: 500,
                    thenHoldForDuration: 0.1
                )
            Thread.sleep(forTimeInterval: 0.4)
            stopMeasuring()

            XCTAssertTrue(mainSurface.awaitExistence(timeout: 3))
            XCTAssertTrue(poll(timeout: 3) { abs(mainSurface.frame.minX - app.frame.minX) <= 1 })
        }
    }

}

/// One owner per leading-edge swipe: a screen that can go back goes back, and only a stack
/// root opens the sidebar (TAL-462).
final class SidebarGestureUITests: SidebarUITestCase {
    func testEdgeSwipeGoesBackInPushedScreensAndOpensSidebarAtRoots() throws {
        launchFixture()
        try assertEdgeSwipeOwnership(isRightToLeft: false)
    }

    func testEdgeSwipeOwnershipMirrorsInDarkRTL() throws {
        launchFixture(additionalArguments: [
            "-appTheme", "dark",
            "-AppleTextDirection", "YES",
            "-NSForceRightToLeftWritingDirection", "YES",
        ])
        try assertEdgeSwipeOwnership(isRightToLeft: true)
    }

    private var sidebar: XCUIElement { app.descendants(matching: .any)["app-sidebar"] }

    private func assertEdgeSwipeOwnership(isRightToLeft rtl: Bool) throws {
        let chats = app.navigationBars["Chats"]
        XCTAssertTrue(app.buttons["Open navigation"].awaitExistence(timeout: 15), "Missing deterministic app fixture")
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")

        // A stack root opens the sidebar; a drag toward the leading edge or a tap on the dimmed
        // surface closes it.
        swipe(rtl: rtl, from: 0.005, to: 0.75)
        assertSidebarOpens("at the Chats list")
        swipe(rtl: rtl, from: 0.9, to: 0.1)
        assertSidebarCloses("after a closing drag")
        swipe(rtl: rtl, from: 0.005, to: 0.75)
        assertSidebarOpens("at the Chats list again")
        tap(at: CGPoint(x: rtl ? app.frame.width * 0.05 : app.frame.width * 0.95, y: app.frame.height * 0.5))
        assertSidebarCloses("after a tap on the dimmed surface")

        // A pushed chat goes back on every edge swipe and never opens the sidebar.
        for attempt in 1...10 {
            tapFixtureSession(fixtureSessionButton)
            XCTAssertNotNil(waitForComposer(timeout: 15), "The chat did not open (attempt \(attempt))")
            if attempt == 1 {
                // A back swipe released early leaves the chat in place.
                swipe(rtl: rtl, from: 0.005, to: 0.2, velocity: 60, hold: 0.3)
                XCTAssertNotNil(waitForComposer(timeout: 5), "A cancelled back swipe left the chat")
                XCTAssertFalse(chats.exists, "A cancelled back swipe left the chat")
                assertSidebarStaysClosed("A cancelled back swipe opened the sidebar")
            }
            swipe(rtl: rtl, from: 0.005, to: 0.75)
            XCTAssertTrue(chats.awaitExistence(timeout: 5), "The edge swipe did not go back (attempt \(attempt))")
            assertSidebarStaysClosed("The edge swipe opened the sidebar over a chat (attempt \(attempt))")
            _ = fixtureSessionButton.settledFrame
        }

        if #available(iOS 26.0, *) {
            tapFixtureSession(fixtureSessionButton)
            XCTAssertNotNil(waitForComposer(timeout: 15), "The chat did not open")
            swipe(rtl: rtl, from: 0.35, to: 0.95)
            XCTAssertTrue(chats.awaitExistence(timeout: 5), "A mid-screen swipe did not go back")
            assertSidebarStaysClosed("A mid-screen swipe opened the sidebar")
            _ = fixtureSessionButton.settledFrame
        }

        // A utility root opens the sidebar; its pushed screen goes back instead.
        openSettings()
        swipe(rtl: rtl, from: 0.005, to: 0.75)
        assertSidebarOpens("at the Settings root")
        swipe(rtl: rtl, from: 0.9, to: 0.1)
        assertSidebarCloses("over the Settings root")
        tapCenter(of: app.buttons["settings-user-profile"])
        XCTAssertTrue(app.navigationBars["User Profile"].awaitExistence(timeout: Self.navigationTimeout))
        swipe(rtl: rtl, from: 0.005, to: 0.75)
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: 5), "The edge swipe did not return to Settings")
        XCTAssertFalse(app.navigationBars["User Profile"].exists, "The edge swipe did not return to Settings")
        assertSidebarStaysClosed("The edge swipe opened the sidebar over a Settings page")
    }

    /// A horizontal drag between leading-relative offsets (0 is the leading edge), mirrored
    /// under RTL.
    private func swipe(rtl: Bool, from: CGFloat, to: CGFloat, velocity: CGFloat = 1_500, hold: TimeInterval = 0) {
        func point(_ leading: CGFloat) -> XCUICoordinate {
            app.coordinate(withNormalizedOffset: CGVector(dx: rtl ? 1 - leading : leading, dy: 0.5))
        }
        point(from).press(
            forDuration: 0.05,
            thenDragTo: point(to),
            withVelocity: XCUIGestureVelocity(velocity),
            thenHoldForDuration: hold
        )
    }

    private func assertSidebarOpens(_ context: String) {
        XCTAssertTrue(poll(timeout: 3) { sidebar.isHittable }, "The edge swipe did not open the sidebar \(context)")
        _ = app.buttons["Close navigation"].settledFrame
    }

    /// Watches past the opening animation, so a sidebar that started to open is caught.
    private func assertSidebarStaysClosed(_ message: String) {
        XCTAssertFalse(poll(timeout: 1) { sidebar.isHittable }, message)
    }

    private func assertSidebarCloses(_ context: String) {
        XCTAssertTrue(poll(timeout: 3) { !sidebar.isHittable }, "The sidebar stayed open \(context)")
        _ = app.descendants(matching: .any)["app-main-surface"].settledFrame
    }
}

class AdaptiveLayoutUITestCase: TalariaUITestCase {
    struct Variant {
        var name: String
        let arguments: [String]
        /// The first orientation launches the variant; the core-screen audit rotates through the
        /// rest in the same launch.
        let orientations: [UIDeviceOrientation]
        var reduceMotion = false
        /// Audit types run on this variant's screens. Element descriptions and traits belong to
        /// the elements, not to the layout, so only the baseline variant audits them; every
        /// variant audits Dynamic Type and hit regions, which follow the layout (TAL-402).
        var auditTypes: [XCUIAccessibilityAuditType] = [.dynamicType, .hitRegion]
        var isRightToLeft: Bool { arguments.contains("-AppleTextDirection") }
        var orientation: UIDeviceOrientation { orientations[0] }
    }

    /// One launch per variant; each launch walks every representative screen. Settings
    /// are bundled so the matrix stays at two launches instead of screens × settings.
    /// Every variant pins its text size so a reused simulator cannot leak one in. Landscape
    /// is audited by rotating each variant rather than in a launch of its own; the
    /// accessibility-size variant carries Reduce Motion (TAL-402, TAL-416).
    static let variants = [
        Variant(
            name: "light",
            arguments: ["-appTheme", "light", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"],
            orientations: [.portrait, .landscapeLeft],
            auditTypes: [.dynamicType, .hitRegion, .sufficientElementDescription, .trait]
        ),
        Variant(
            name: "dark RTL AXXXL reduce-motion",
            arguments: [
                "-appTheme", "dark",
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                "-AppleTextDirection", "YES",
                "-NSForceRightToLeftWritingDirection", "YES",
            ],
            orientations: [.portrait, .landscapeLeft],
            reduceMotion: true
        ),
    ]

    override func setUpWithError() throws {
        try super.setUpWithError()
        // Audits are plain assertions, so one run reports every screen and variant.
        continueAfterFailure = true
    }

    /// Simulator Reduce Motion value before this test touched it; restored in teardown.
    private var savedReduceMotion: CFPropertyList?

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        if let savedReduceMotion {
            Self.writeReduceMotion(savedReduceMotion)
            self.savedReduceMotion = nil
        }
        try super.tearDownWithError()
    }

    /// The simulator's Reduce Motion switch has no launch-argument seam, so the runner
    /// writes the system accessibility preference the app reads at launch. Every variant
    /// writes its value explicitly so a reused simulator cannot leak state into the matrix.
    func applyReduceMotion(_ enabled: Bool) {
        if savedReduceMotion == nil {
            savedReduceMotion = CFPreferencesCopyValue(
                Self.reduceMotionKey, Self.accessibilityDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost
            ) ?? kCFBooleanFalse
        }
        Self.writeReduceMotion(enabled ? kCFBooleanTrue : kCFBooleanFalse)
    }

    private static let accessibilityDomain = "com.apple.Accessibility" as CFString
    private static let reduceMotionKey = "ReduceMotionEnabled" as CFString

    private static func writeReduceMotion(_ value: CFPropertyList?) {
        CFPreferencesSetValue(reduceMotionKey, value, accessibilityDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        CFPreferencesSynchronize(accessibilityDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }
}

/// One test per variant: a single test walking every launch ran past five minutes on a
/// GitHub-hosted runner, and a failure in one variant no longer hides the others (TAL-401). Each
/// variant is its own class so the UI suite's shards can balance them (TAL-402).
final class AdaptiveLayoutLightUITests: AdaptiveLayoutAppUITestCase {
    func testCoreScreensPassAccessibilityAuditsInLightPortraitAndLandscape() throws {
        try auditCoreScreens(Self.variants[0])
    }
}

final class AdaptiveLayoutDarkRTLUITests: AdaptiveLayoutAppUITestCase {
    func testCoreScreensPassAccessibilityAuditsInDarkRTLAccessibilityXXXLReduceMotionPortraitAndLandscape() throws {
        try auditCoreScreens(Self.variants[1])
    }
}

class AdaptiveLayoutAppUITestCase: AdaptiveLayoutUITestCase {
    func auditCoreScreens(_ variant: Variant) throws {
        XCTAssertEqual(Self.variants.count, 2, "Give every adaptive layout variant its own core-screen audit class")
        launchFixture(variant: variant)
        for (index, orientation) in variant.orientations.enumerated() {
            var pass = variant
            if variant.orientations.count > 1 {
                pass.name = "portrait \(variant.name)"
            }
            if index > 0 {
                // Rotated passes audit the layout-dependent types; the elements were audited upright.
                pass.name = "landscape \(variant.name)"
                pass.auditTypes = [.dynamicType, .hitRegion]
                // The next pass starts on the session list, rotated there.
                openSidebarDestination("Chats")
                XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout))
                XCUIDevice.shared.orientation = orientation
                _ = app.navigationBars["Chats"].settledFrame
            }
            try walkCoreScreens(pass)
        }
        app.terminate()
    }

    /// One walk of the core screens from the session list, in the current orientation.
    private func walkCoreScreens(_ variant: Variant) throws {
        try XCTContext.runActivity(named: variant.name) { _ in
            let openNavigation = app.buttons["Open navigation"]
            XCTAssertTrue(openNavigation.awaitExistence(timeout: 15), "Missing deterministic app fixture")
            XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: 15), "Missing deterministic session fixture")
            if variant.isRightToLeft {
                XCTAssertGreaterThan(
                    openNavigation.frame.midX, app.frame.midX,
                    "Leading toolbar item should mirror under RTL [\(variant.name)]"
                )
            }
            try audit("Chats dense list", variant: variant)

            tapFixtureSession(fixtureSessionButton)
            XCTAssertNotNil(waitForComposer(timeout: 15), "Composer missing [\(variant.name)]")
            try audit("Chat transcript and composer", variant: variant)
            // The composer must leave the navigation bar's Back button tappable (TAL-416).
            app.buttons["BackButton"].tap()
            XCTAssertTrue(
                app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout),
                "Back did not return to Chats [\(variant.name)]"
            )

            openSettings()
            // The account rows above the category directory (User Profile,
            // Apple Account) can fill the screen at accessibility sizes and in
            // landscape, and a List does not create rows below the fold, so
            // scroll until the directory renders.
            let firstCategory = app.buttons["settings-category-appearance"]
            if !firstCategory.awaitExistence(timeout: 3) {
                repeatStep(10, until: { firstCategory.exists }) {
                    scrollSettingsRoot(up: true)
                }
            }
            XCTAssertTrue(firstCategory.awaitExistence(timeout: 3), "Settings categories missing [\(variant.name)]")
            try audit("Settings root", variant: variant)

            tapSettingsCategory(id: "servers", title: "Servers")
            let addServer = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label BEGINSWITH %@", "Add Server"))
                .firstMatch
            XCTAssertTrue(addServer.awaitExistence(timeout: 3), "Add Server row missing [\(variant.name)]")
            repeatStep(6, until: { addServer.frame.maxY <= app.frame.maxY }) {
                app.swipeUp()
            }
            let serverRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", "ui-test.talaria.invalid"))
                .firstMatch
            XCTAssertTrue(serverRow.exists, "Fixture server row missing [\(variant.name)]")
            let coveredRowCenter = serverRow.frame.center
            tap(at: addServer.frame.center)
            let editor = app.navigationBars["Add Server"]
            XCTAssertTrue(editor.awaitExistence(timeout: 5), "Add Server editor missing [\(variant.name)]")
            try audit("Add Server editor", variant: variant)
            // Modal isolation: a tap where the server row sits must not reach it.
            tap(at: coveredRowCenter)
            XCTAssertTrue(editor.exists, "Editor dismissed by a tap behind it [\(variant.name)]")
            editor.buttons["Cancel"].tap()
            XCTAssertTrue(editor.awaitNonExistence(timeout: 5), "Editor did not dismiss [\(variant.name)]")
            XCTAssertTrue(
                app.navigationBars["Servers"].exists && addServer.awaitExistence(timeout: 3),
                "Dismissing the editor must return to its launching screen [\(variant.name)]"
            )

            app.navigationBars["Servers"].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: 3))
            // In landscape at accessibility sizes Kanban is reached by scrolling the sidebar (TAL-416).
            openSidebarDestination("Kanban")
            XCTAssertTrue(
                app.navigationBars["Kanban"].awaitExistence(timeout: 5),
                "The sidebar did not open Kanban [\(variant.name)]"
            )
            XCTAssertTrue(app.staticTexts["Loading Kanban"].awaitNonExistence(timeout: 15))
            XCTAssertTrue(
                app.descendants(matching: .any)["KanbanStatusSelector"].awaitExistence(timeout: 5),
                "Kanban Board did not load [\(variant.name)]"
            )
            try audit("Kanban board", variant: variant)
            assertBoardPickerAndToolbarReachable(variant)
        }
    }

    /// The fixture's current Board carries a long localized name, so every variant renders the case
    /// that used to drop the Board picker out of the navigation bar entirely. Runs on the Board the
    /// audit just loaded rather than a launch of its own (TAL-402).
    private func assertBoardPickerAndToolbarReachable(_ variant: Variant) {
        let bar = app.navigationBars["Kanban"]
        let picker = app.descendants(matching: .any)["KanbanBoardPicker"].firstMatch
        XCTAssertTrue(picker.awaitExistence(timeout: 5), "Board picker missing [\(variant.name)]")
        assertReachable(picker, named: "Board picker", in: bar, variant: variant)

        // The Kanban root keeps the sidebar button where a pushed screen keeps Back;
        // whichever leads the bar must stay clear of the picker.
        let leading = bar.buttons["BackButton"].exists ? bar.buttons["BackButton"] : bar.buttons["Open navigation"]
        assertReachable(leading, named: "Leading bar control", in: bar, variant: variant)
        XCTAssertFalse(leading.frame.intersects(picker.frame), "Board picker covers the leading control [\(variant.name)]")

        let overflow = app.descendants(matching: .any)["KanbanToolbarOverflow"].firstMatch
        var trailing = [("New Card", bar.buttons["New Card"]), ("Dispatcher", bar.buttons["Dispatcher"])]
        if overflow.exists {
            trailing.append(("More", overflow))
        } else {
            trailing += [("Select Cards", bar.buttons["Select Cards"]), ("Card Filters", bar.buttons["Card Filters"])]
        }
        for (label, control) in trailing {
            assertReachable(control, named: label, in: bar, variant: variant)
            XCTAssertFalse(control.frame.intersects(picker.frame), "Board picker covers \(label) [\(variant.name)]")
        }

        assertSelectionAndFiltersReachable(in: bar, overflow: overflow, variant: variant)
        assertBoardMenuSelectsAnotherBoard(picker: picker, variant: variant)
    }

    /// Navigation-bar controls report `isHittable == false` to XCUI even when visible, so
    /// reachability is measured from the frame. The bar caps its controls below the 44
    /// points the toolbar requests; the size check is a floor against a squeezed control.
    private func assertReachable(_ control: XCUIElement, named name: String, in bar: XCUIElement, variant: Variant) {
        XCTAssertTrue(control.exists, "\(name) missing [\(variant.name)]")
        XCTAssertGreaterThanOrEqual(min(control.frame.width, control.frame.height), 32, "\(name) squeezed [\(variant.name)]")
        XCTAssertGreaterThanOrEqual(control.frame.minX, bar.frame.minX, "\(name) clipped by the bar [\(variant.name)]")
        XCTAssertLessThanOrEqual(control.frame.maxX, bar.frame.maxX, "\(name) clipped by the bar [\(variant.name)]")
    }

    /// Select Cards and Card Filters keep their state whether they sit in the bar or the overflow.
    private func assertSelectionAndFiltersReachable(in bar: XCUIElement, overflow: XCUIElement, variant: Variant) {
        // Decide once: iOS 27 drops the More button from the tree while its menu is open.
        let usesOverflow = overflow.exists
        func secondaryAction(_ label: String) -> XCUIElement {
            guard usesOverflow else { return bar.buttons[label] }
            tap(at: overflow.frame.center)
            return app.buttons[label].firstMatch
        }

        let filters = secondaryAction("Card Filters")
        XCTAssertTrue(filters.awaitExistence(timeout: 3), "Card Filters unreachable [\(variant.name)]")
        let selectCards = usesOverflow ? app.buttons["Select Cards"].firstMatch : bar.buttons["Select Cards"]
        XCTAssertTrue(selectCards.exists, "Select Cards unreachable [\(variant.name)]")
        XCTAssertTrue(selectCards.isEnabled, "Select Cards disabled in the fixture Board [\(variant.name)]")
        tap(at: selectCards.frame.center)

        let cancel = secondaryAction("Cancel")
        XCTAssertTrue(
            cancel.awaitExistence(timeout: 3),
            "Selection mode did not survive the toolbar placement [\(variant.name)]"
        )
        tap(at: cancel.frame.center)
    }

    private func assertBoardMenuSelectsAnotherBoard(picker: XCUIElement, variant: Variant) {
        tap(at: picker.frame.center)
        let otherBoard = app.buttons["Fixture Board"].firstMatch
        XCTAssertTrue(otherBoard.awaitExistence(timeout: 3), "Board menu did not open [\(variant.name)]")
        otherBoard.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["KanbanBoardPicker"].firstMatch.awaitExistence(timeout: 5),
            "Board picker lost after selecting a Board [\(variant.name)]"
        )
    }
}

/// Onboarding in the portrait-light and dark RTL AXXXL variants, each rotating once to check focus
/// retention; the landscape onboarding audit is no longer run (TAL-402).
final class AdaptiveLayoutOnboardingUITests: AdaptiveLayoutUITestCase {
    /// Wide windows (iPad, the Duo inner display) keep onboarding text and buttons in a centered
    /// 520 pt column; iPhone widths are narrower than the column, so they still fill it (TAL-497).
    func testOnboardingContentKeepsReadableWidth() throws {
        launchFixture(variant: Self.variants[0], additionalArguments: ["--ui-test-onboarding"])
        let getStarted = app.buttons["Get Started"]
        XCTAssertTrue(getStarted.awaitExistence(timeout: 15), "Missing onboarding fixture")
        let headline = app.staticTexts["Control your Hermes agent from iPhone or iPad."]
        let column = app.frame.insetBy(dx: max(0, (app.frame.width - 520) / 2), dy: 0)
        for (name, element) in [("Get Started", getStarted), ("Headline", headline)] {
            let frame = element.settledFrame
            XCTAssertGreaterThanOrEqual(frame.minX, column.minX - 1, "\(name) leaves the readable column")
            XCTAssertLessThanOrEqual(frame.maxX, column.maxX + 1, "\(name) leaves the readable column")
        }
    }

    func testOnboardingScalesTitleAndRetainsFocusAcrossVariants() throws {
        var titleHeights: [String: CGFloat] = [:]
        for variant in Self.variants {
            try XCTContext.runActivity(named: variant.name) { _ in
                launchFixture(variant: variant, additionalArguments: ["--ui-test-onboarding"])
                let getStarted = app.buttons["Get Started"]
                XCTAssertTrue(getStarted.awaitExistence(timeout: 15), "Missing onboarding fixture [\(variant.name)]")
                try audit("Onboarding welcome", variant: variant)
                // The welcome page scrolls once its text outgrows the page, so every
                // line and badge must clear the bottom bar after scrolling.
                let subtitle = app.staticTexts["Connect to your self-hosted Web UI over Tailscale."]
                let lastBadge = element(label: "Tailscale ready")
                let pageIndicator = element(label: "Page 1 of 5")
                XCTAssertTrue(pageIndicator.exists && lastBadge.exists, "Welcome page parts missing [\(variant.name)]")
                repeatStep(6, until: { lastBadge.frame.maxY <= pageIndicator.frame.minY }) {
                    app.swipeUp()
                }
                XCTAssertLessThanOrEqual(subtitle.frame.maxY, pageIndicator.frame.minY, "Subtitle under bottom bar [\(variant.name)]")
                XCTAssertLessThanOrEqual(lastBadge.frame.maxY, pageIndicator.frame.minY, "Badges under bottom bar [\(variant.name)]")
                getStarted.tap()
                let setUp = app.buttons["Set Up"]
                XCTAssertTrue(setUp.awaitExistence(timeout: 5), "Features page missing [\(variant.name)]")
                setUp.tap()

                let step = app.staticTexts["STEP 1"]
                let title = app.staticTexts["Set up Hermes Web UI"]
                let description = app.staticTexts
                    .matching(NSPredicate(format: "label BEGINSWITH %@", "Send this prompt"))
                    .firstMatch
                XCTAssertTrue(title.awaitExistence(timeout: 5), "Step title missing [\(variant.name)]")
                _ = title.settledFrame
                XCTAssertTrue(step.exists && description.exists, "Step header parts missing [\(variant.name)]")
                XCTAssertGreaterThanOrEqual(title.frame.minX, app.frame.minX, "Title clipped [\(variant.name)]")
                XCTAssertLessThanOrEqual(title.frame.maxX, app.frame.maxX, "Title clipped [\(variant.name)]")
                XCTAssertLessThanOrEqual(step.frame.maxY, title.frame.minY + 1, "Title overlaps step label [\(variant.name)]")
                XCTAssertLessThanOrEqual(title.frame.maxY, description.frame.minY + 1, "Title overlaps description [\(variant.name)]")
                titleHeights[variant.name] = title.frame.height
                try audit("Onboarding step", variant: variant)

                app.buttons["Already have a server?"].tap()
                let continueAnyway = app.buttons["Continue Anyway"]
                XCTAssertTrue(continueAnyway.awaitExistence(timeout: 3), "Copy reminder missing [\(variant.name)]")
                // The shortcut starts an animated jump to the connect page, which the copy reminder
                // turns back to this step. Continuing while the pager is still moving can land on
                // the connect page instead of the next step, so wait for it to rest on this step.
                XCTAssertTrue(
                    element(label: "Page 3 of 5").awaitExistence(timeout: 5),
                    "The pager did not return to the setup step [\(variant.name)]"
                )
                _ = title.settledFrame
                continueAnyway.tap()
                let stepTwo = app.staticTexts["STEP 2"]
                XCTAssertTrue(stepTwo.awaitExistence(timeout: 5), "Tailscale step missing [\(variant.name)]")
                // A tap while the pager is still sliding the step in does not reach its button.
                _ = stepTwo.settledFrame
                app.buttons["Already have a server?"].tap()
                let serverField = app.textFields.firstMatch
                XCTAssertTrue(serverField.awaitExistence(timeout: 5), "Server URL field missing [\(variant.name)]")
                // The shortcut pages over two steps; audit and tap only once the pager reports the
                // connect page and the field has stopped moving, or both act on a page in motion.
                XCTAssertTrue(
                    element(label: "Page 5 of 5").awaitExistence(timeout: 10),
                    "The pager did not reach the connect page [\(variant.name)]"
                )
                _ = serverField.settledFrame
                try audit("Onboarding connect", variant: variant)
                // Focus retention: the audit walks the page, so focus the field only afterwards.
                // Focus and the keyboard arrive after the tap returns (a first keyboard on a
                // hosted runner took over 30 s), so wait for focus rather than read it once.
                serverField.tap()
                XCTAssertTrue(
                    poll(timeout: 45) { hasKeyboardFocus(serverField) },
                    "Server field did not take focus [\(variant.name)]"
                )
                XCUIDevice.shared.orientation = variant.orientation == .portrait ? .landscapeLeft : .portrait
                // iOS 27 usually resets the page-style TabView to the welcome page when the
                // device rotates with the keyboard up (TAL-201); not strict, because some
                // variants survive. Remove with that fix. Only the reset is expected: a
                // surviving field must still keep focus, and reading focus on a missing
                // field would interrupt the test before the remaining variants.
                let pagerReset = XCTExpectedFailure.Options()
                pagerReset.isEnabled = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27
                pagerReset.isStrict = false
                let fieldSurvived = serverField.awaitExistence(timeout: 5)
                XCTExpectFailure("TAL-201: iOS 27 pager resets on rotation", options: pagerReset) {
                    XCTAssertTrue(fieldSurvived, "Server URL field lost on rotation [\(variant.name)]")
                }
                if fieldSurvived {
                    // The rotated layout restores focus after the field reappears.
                    XCTAssertTrue(
                        poll(timeout: 10) { hasKeyboardFocus(serverField) },
                        "Rotation dropped field focus [\(variant.name)]"
                    )
                }
                app.terminate()
            }
        }

        let defaultHeight = try XCTUnwrap(titleHeights[Self.variants[0].name])
        let accessibilityHeight = try XCTUnwrap(titleHeights[Self.variants[1].name])
        XCTAssertGreaterThan(
            accessibilityHeight, defaultHeight * 1.4,
            "Onboarding step title must scale with Dynamic Type"
        )
    }
}

/// Returns as soon as `condition` holds, checking at once and then after 0.1, 0.2, 0.4 and 0.8 s,
/// then every second until `timeout`. XCTest's own waits (`waitForExistence`,
/// `XCTNSPredicateExpectation`) first check after a full second, so every wait cost at least a
/// second: about a quarter of the hosted UI suite (TAL-402). The back-off keeps a long wait from
/// snapshotting the app several times a second on a 3-core hosted runner. A check that ends past
/// `timeout` may have started before what it waits for happened, so the wait looks once more
/// before it gives up (TAL-665).
func poll(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var interval: TimeInterval = 0.1
    while !condition() {
        guard Date() < deadline else { return condition() }
        Thread.sleep(forTimeInterval: min(interval, max(deadline.timeIntervalSinceNow, 0)))
        interval = min(interval * 2, 1)
    }
    return true
}

/// The value `read` settles on: two samples taken at least `interval` apart that agree, so two
/// reads inside one animation frame cannot pass for a value at rest. `nil` if it is still changing
/// at `timeout`.
func awaitStable<Value: Equatable>(
    timeout: TimeInterval = 2,
    interval: TimeInterval = 0.15,
    _ read: () -> Value
) -> Value? {
    let deadline = Date().addingTimeInterval(timeout)
    var last = read()
    while Date() < deadline {
        Thread.sleep(forTimeInterval: interval)
        let next = read()
        if next == last { return next }
        last = next
    }
    return nil
}

/// Runs `step` until `done` holds, at most `attempts` times. A `for _ in 0..<n where !done` loop
/// evaluates `done` on every one of its `n` passes even once it holds, and each evaluation is a
/// query (TAL-402).
func repeatStep(_ attempts: Int, until done: () -> Bool, _ step: () -> Void) {
    for _ in 0..<attempts {
        if done() { return }
        step()
    }
}

extension XCUIElement {
    /// `waitForExistence(timeout:)` without its one-second polling; see `poll(timeout:until:)`.
    func awaitExistence(timeout: TimeInterval) -> Bool {
        poll(timeout: timeout) { exists }
    }

    /// `waitForNonExistence(timeout:)` without its one-second polling; see `poll(timeout:until:)`.
    func awaitNonExistence(timeout: TimeInterval) -> Bool {
        poll(timeout: timeout) { !exists }
    }

    /// Waits until the element reads `value` for VoiceOver.
    func awaitValue(_ value: String, timeout: TimeInterval) -> Bool {
        poll(timeout: timeout) { exists && self.value as? String == value }
    }

    /// Where the element comes to rest (`awaitStable`): a coordinate taken while a sheet, menu or
    /// sidebar is still sliding in lands on the wrong spot. The last frame read if it never settles.
    var settledFrame: CGRect {
        awaitStable { firstMatch.frame } ?? firstMatch.frame
    }
}

/// The waiting helpers' own contract, without launching the app.
final class UITestWaitingTests: XCTestCase {
    func testAwaitStableNeedsTwoAgreeingSamplesAnIntervalApart() {
        var samples = [1, 2, 3, 3]
        var readTimes: [Date] = []
        let settled = awaitStable(timeout: 2, interval: 0.1) { () -> Int in
            readTimes.append(Date())
            return samples.removeFirst()
        }
        XCTAssertEqual(settled, 3)
        XCTAssertEqual(readTimes.count, 4)
        for (earlier, later) in zip(readTimes, readTimes.dropFirst()) {
            XCTAssertGreaterThanOrEqual(later.timeIntervalSince(earlier), 0.1)
        }
    }

    func testAwaitStableGivesUpOnAValueThatKeepsChanging() {
        var counter = 0
        XCTAssertNil(awaitStable(timeout: 0.5, interval: 0.1) { () -> Int in
            counter += 1
            return counter
        })
    }

    func testPollChecksAtOnceAndStopsAtTheTimeout() {
        let start = Date()
        XCTAssertTrue(poll(timeout: 5) { true })
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.05)

        var checks = 0
        XCTAssertFalse(poll(timeout: 1) { checks += 1; return false })
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.5)
        XCTAssertGreaterThanOrEqual(checks, 4)
    }

    /// One check can outlast the whole wait on a loaded hosted runner: the file exporter appeared inside its 20 s
    /// while the snapshot that started before then returned after it (TAL-665). Such a check never ends a wait.
    func testPollLooksAgainWhenACheckEndsPastTheTimeout() {
        var checks = 0
        XCTAssertTrue(poll(timeout: 0.2) {
            checks += 1
            if checks == 1 {
                Thread.sleep(forTimeInterval: 0.4)
                return false
            }
            return true
        })
        XCTAssertEqual(checks, 2)
    }
}

class TalariaUITestCase: XCTestCase {
    /// Bound for the shared helpers' waits on a destination or control. A wait returns as soon
    /// as its element appears, so a passing run pays nothing for the margin; a 3-core
    /// GitHub-hosted runner took over four seconds for one sidebar query (TAL-401).
    static let navigationTimeout: TimeInterval = 20

    var app: XCUIApplication!

    fileprivate var fixtureLaunchArguments: [String] {
        ["--ui-test-fixture"]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    func launch(arguments: [String]) {
        app.launchArguments = arguments
        app.launch()
    }

    func launchFixture(additionalArguments: [String] = []) {
        launch(arguments: fixtureLaunchArguments + additionalArguments)
    }

    func attachScreenshot(named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    /// Taps `button`, expects the system file exporter, keeps a screenshot named `name`, and dismisses it.
    func assertPresentsFileExporter(from button: XCUIElement, name: String) {
        let save = app.buttons["DOCPicker.actionButton"].firstMatch
        XCTAssertTrue(button.awaitExistence(timeout: 10), "Missing export button for \(name)")
        button.tap()
        XCTAssertTrue(save.awaitExistence(timeout: Self.navigationTimeout), "The file exporter did not open for \(name)")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.navigationBars["FullDocumentManagerViewControllerNavigationBar"].swipeDown(velocity: .fast)
        XCTAssertTrue(save.awaitNonExistence(timeout: 10), "The file exporter did not dismiss for \(name)")
    }

    /// Backgrounds the app under test and returns once it has left the foreground, so work the
    /// app does on entering the background (the fixture seeds a share draft there) has run. On
    /// this simulator a home press alone can leave it in `runningForeground`; following the press
    /// with an explicit Springboard activation is what suspends it, and a press right after launch
    /// can be dropped, so the pair repeats until the app has left.
    func sendToBackground() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(
            poll(timeout: 20) {
                XCUIDevice.shared.press(.home)
                springboard.activate()
                return poll(timeout: 4) {
                    [.runningBackground, .runningBackgroundSuspended].contains(app.state)
                }
            },
            "The app never entered the background"
        )
    }

    /// Answers the loads the fixture holds (`UITestFixtureHold` in the app) until `condition` holds.
    /// A release answers only what is held when it lands, so it repeats while a request is still on
    /// its way.
    func releaseHeldLoads(timeout: TimeInterval = 20, until condition: () -> Bool) -> Bool {
        poll(timeout: timeout) {
            notify_post("dev.kil.talaria.ui-test.release-held-loads")
            return poll(timeout: 1, until: condition)
        }
    }
}

fileprivate extension ChatUITestCase {
    /// A long press on a message's prose opens its actions at the press point; one on a link
    /// offers only the link's own actions.
    func assertLongPressShowsMessageActionsOnTextAndOnlyLinkActionsOnALink() {
        let message = element(labelContaining: "FixturePlainLead")
        XCTAssertTrue(message.awaitExistence(timeout: 15), "Missing the fixture's long assistant message")
        let before = settledFrame(of: message)
        // High in a tall bubble: the pre-TAL-49 context menu lifted the whole
        // bubble and pushed its menu to the top of the screen from here.
        let press = CGPoint(x: before.midX, y: before.minY + 12)
        longPress(at: press)

        let fork = app.buttons["Fork From Here"]
        XCTAssertTrue(fork.awaitExistence(timeout: 5), "The message actions did not open")
        XCTAssertFalse(app.buttons["Open Link"].exists, "Prose must not offer link actions")

        // The menu opens from the press point, not from a lifted bubble: one of
        // its edges sits at the finger.
        let menu = app.buttons["Listen"].frame.union(fork.frame)
        XCTAssertLessThan(
            min(abs(menu.minY - press.y), abs(menu.maxY - press.y)), 60,
            "The menu opened away from the press point: \(menu) for a press at \(press)"
        )
        XCTAssertEqual(
            message.frame, before,
            "Opening the menu moved the message instead of leaving the transcript still"
        )
        dismissContextMenu(avoiding: menu)
        XCTAssertTrue(fork.awaitNonExistence(timeout: 5), "The message actions did not close")

        let link = app.links["FixtureLinkTarget"]
        XCTAssertTrue(link.awaitExistence(timeout: 15), "Missing the fixture's mixed text-and-link message")
        longPress(at: settledCenter(of: link))

        let openLink = app.buttons["Open Link"]
        XCTAssertTrue(openLink.awaitExistence(timeout: 5), "The link's own actions did not open")
        XCTAssertFalse(app.buttons["Fork From Here"].exists, "A link press must not offer message actions")
        XCTAssertFalse(app.buttons["Listen"].exists, "A link press must not offer message actions")
        dismissContextMenu(avoiding: openLink.frame)
        XCTAssertTrue(openLink.awaitNonExistence(timeout: 5), "The link actions did not close")
    }

    /// Taps the half of the screen the open menu does not cover; a tap outside a context menu
    /// only closes it.
    func dismissContextMenu(avoiding menu: CGRect) {
        let screen = app.frame
        tap(at: CGPoint(x: screen.midX, y: menu.midY > screen.midY ? screen.height * 0.3 : screen.height * 0.75))
    }

    func openFixtureSession() throws -> XCUIElement {
        if let composer = waitForComposer(timeout: 0) {
            return composer
        }

        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        let composer = waitForComposer(timeout: 15)
        XCTAssertNotNil(composer)
        return try XCTUnwrap(composer)
    }

    func launchChatFixture(argument: String, trace: String) {
        fixtureTrace = trace
        launchFixture(additionalArguments: [argument])
    }

    /// The composer's text view, ready for typing. An empty chat focuses its composer once its first load lands
    /// (`ChatView.applyInitialComposerFocusPolicyIfNeeded`), swapping the "Message" shell for the text view at any
    /// moment, so a shell found earlier may be gone by the time it is tapped (TAL-667). Each pass reads the shell
    /// again, by a snapshot that fails quietly once it is gone, and taps where it is.
    func readyComposerInput(_ composer: XCUIElement) -> XCUIElement {
        let input = app.textViews.firstMatch
        XCTAssertTrue(poll(timeout: 10) {
            if input.exists { return true }
            guard let frame = try? composer.snapshot().frame else { return input.exists }
            tap(at: CGPoint(x: frame.midX, y: frame.midY))
            return input.awaitExistence(timeout: 2)
        }, "The composer never took input")
        return input
    }

    func sendFixtureMessage(_ message: String) throws {
        let input = readyComposerInput(try openFixtureSession())
        // A chat can focus its composer as it opens. Typing, or querying the app, while the
        // keyboard is still sliding in can leave XCTest waiting a minute for the app to go idle
        // before every later step, so let it land first, as XCTest's one-second first check did.
        Thread.sleep(forTimeInterval: 1)
        input.typeText(message)
        let send = app.buttons["Send"]
        XCTAssertTrue(send.awaitExistence(timeout: Self.navigationTimeout))
        // A freshly booted simulator can raise its keyboard seconds after the text is typed, and
        // Send moves up with it; a tap at Send's old spot lands on the keyboard's return key (TAL-652).
        XCTAssertTrue(app.keyboards.firstMatch.awaitExistence(timeout: 10), "The composer has no keyboard")
        // A loaded runner can miss the tap, or read Send's frame while the keyboard still moves it.
        // The message still in the composer says nothing was sent, so tapping again cannot send twice;
        // a stray return key only adds a newline after it, which sending trims.
        tapCenter(of: send)
        repeatStep(2, until: { poll(timeout: 5) { (input.value as? String)?.contains(message) != true } }) {
            tapCenter(of: send)
        }
    }

    func countElements(label: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).count
    }

    func countElements(containing text: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).count
    }
}

extension TalariaUITestCase {
    /// Waits until the element stops moving, so a press lands where it was measured.
    func settledFrame(of element: XCUIElement) -> CGRect {
        awaitStable(timeout: 6, interval: 0.3) { element.frame } ?? element.frame
    }

    func settledCenter(of element: XCUIElement) -> CGPoint {
        let frame = settledFrame(of: element)
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    /// Presses by coordinate: transcript text and list rows report themselves as not hittable.
    func longPress(at point: CGPoint) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x, dy: point.y))
            .press(forDuration: 1.2)
    }

    /// Opens the sidebar with its button and returns it once it has slid to rest. The sidebar
    /// stays in the tree while closed, so hittability is the sign it opened.
    @discardableResult
    func openSidebar() -> XCUIElement {
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        // A tap while the screen behind is still settling (a menu closing, a rotation) can be
        // dropped, so open until the sidebar is up.
        repeatStep(3, until: { sidebar.exists && sidebar.isHittable }) {
            app.buttons["Open navigation"].tap()
            _ = poll(timeout: Self.navigationTimeout / 3) { sidebar.exists && sidebar.isHittable }
        }
        XCTAssertTrue(sidebar.exists && sidebar.isHittable, "The sidebar did not open")
        _ = app.buttons["Close navigation"].settledFrame
        return sidebar
    }

    func openSidebarDestination(_ destination: String) {
        let sidebar = openSidebar()
        // The sidebar's rows slide in; a row tapped on the way lands on the surface behind it.
        let row = sidebar.descendants(matching: .any)[destination].firstMatch
        _ = row.settledFrame
        row.tap()
    }

    /// The session list's search field once it is open.
    var sessionSearchField: XCUIElement {
        app.searchFields["Search sessions"]
    }

    /// The minimized session search at the bottom of the list. iOS 26 still exposes
    /// the collapsed field; iOS 27 replaces it with a toolbar button until it opens.
    /// Polls for either, so the choice does not depend on which appears first.
    func waitForSessionSearchControl(timeout: TimeInterval) -> XCUIElement? {
        let button = app.buttons["Search"]
        let deadline = Date().addingTimeInterval(timeout)

        repeat {
            if sessionSearchField.exists { return sessionSearchField }
            if button.exists { return button }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        return nil
    }
}

/// Shared by every `TalariaUITestCase` file: the Settings walk and the coordinate taps that
/// list rows need because they report `isHittable == false`.
extension TalariaUITestCase {
    func returnToSessionList() {
        let chats = app.navigationBars["Chats"]
        repeatStep(3, until: { chats.exists }) {
            let back = app.buttons["BackButton"]
            guard back.awaitExistence(timeout: 5) else { return }
            back.tap()
            _ = chats.awaitExistence(timeout: 5)
        }
        XCTAssertTrue(chats.exists, "Did not return to the session list")
    }

    func openSettings() {
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.awaitExistence(timeout: 15), "Missing deterministic app fixture")
        openNavigation.tap()

        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.awaitExistence(timeout: Self.navigationTimeout))
        let settings = sidebar.descendants(matching: .any)["Settings"].firstMatch
        _ = settings.settledFrame
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].awaitExistence(timeout: Self.navigationTimeout))
        // The sidebar stays in the tree once closed, so its closing is the loss of hittability.
        XCTAssertTrue(
            poll(timeout: Self.navigationTimeout) { !sidebar.isHittable },
            "The sidebar stayed open over Settings"
        )
    }

    /// Drags in the lower half of the screen: in landscape a horizontal card sits at the
    /// centre and swallows `swipeUp()`.
    func scrollSettingsRoot(up: Bool) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.85 : 0.4))
            .press(
                forDuration: 0.05,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.4 : 0.85))
            )
    }

    /// Settings and list rows report `isHittable == false` to XCUI even when visible; tap
    /// where they are drawn instead, once they have come to rest. A missing element has a zero
    /// frame, which would tap the screen corner; the assertions keep that from passing as a
    /// silent stray tap.
    func tapCenter(of element: XCUIElement) {
        XCTAssertTrue(element.awaitExistence(timeout: Self.navigationTimeout), "Missing tap target")
        let frame = element.settledFrame
        XCTAssertTrue(frame.width > 0 && frame.height > 0, "Tap target has no frame")
        tap(at: CGPoint(x: frame.midX, y: frame.midY))
    }

    /// Taps a point in screen coordinates. Offsetting from the app's origin needs no read of the
    /// app's own frame, which costs a query each time on a hosted runner.
    func tap(at point: CGPoint) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()
    }

    func element(labelContaining text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch
    }

    func element(label: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
    }

    func element(labelBeginningWith prefix: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
            .firstMatch
    }

    func tapSettingsRow(label: String) {
        // The category just tapped stays in the tree while its page pushes, and Providers' row shares its label.
        let row = app.buttons
            .matching(NSPredicate(format: "label == %@ AND NOT (identifier BEGINSWITH %@)", label, "settings-category-"))
            .firstMatch
        let bottom = app.frame.maxY
        repeatStep(12, until: { row.exists && row.frame.maxY <= bottom }) {
            app.swipeUp()
        }
        XCTAssertTrue(row.exists, "Missing settings row: \(label)")
        tapCenter(of: row)
    }

    /// Reads each frame once per scroll: every read is a query, and this runs for every
    /// category a test opens.
    func tapSettingsCategory(id: String, title: String) {
        let category = app.buttons["settings-category-\(id)"]
        repeatStep(10, until: { category.exists }) {
            scrollSettingsRoot(up: true)
        }
        XCTAssertTrue(category.awaitExistence(timeout: Self.navigationTimeout), "Missing Settings category: \(title)")
        let viewportTop = app.navigationBars["Settings"].frame.maxY
        let viewportBottom = app.frame.maxY
        // The Back tap that returned here already waited for the pop to finish, so one read gives
        // the resting frame; only a scroll below leaves the list gliding.
        var frame = category.firstMatch.frame
        // A row partly under the bar is still tappable. In landscape at accessibility sizes one
        // drag moves a screen's worth of rows, so scrolling back for the last few points pushed
        // the row out of the list (TAL-416).
        func visibleHeight(_ row: CGRect) -> CGFloat {
            min(row.maxY, viewportBottom) - max(row.minY, viewportTop)
        }
        repeatStep(10, until: { visibleHeight(frame) >= min(44, frame.height) }) {
            scrollSettingsRoot(up: frame.maxY > viewportBottom)
            frame = category.settledFrame
        }
        let visibleTop = max(frame.minY, viewportTop)
        let visibleBottom = min(frame.maxY, viewportBottom)
        XCTAssertGreaterThan(visibleBottom - visibleTop, 20)
        tap(at: CGPoint(x: frame.midX, y: (visibleTop + visibleBottom) / 2))
        XCTAssertTrue(app.navigationBars[title].awaitExistence(timeout: Self.navigationTimeout))
    }
}

extension TalariaUITestCase {
    var fixtureSessionTitle: String { "UI Fixture Session" }

    var fixtureSessionButton: XCUIElement {
        app.buttons.containing(.staticText, identifier: fixtureSessionTitle).firstMatch
    }

    func waitForComposer(timeout: TimeInterval) -> XCUIElement? {
        let idleComposer = app.buttons["Message"]
        let expandedComposer = app.textViews.firstMatch
        let deadline = Date().addingTimeInterval(timeout)

        repeat {
            if idleComposer.exists { return idleComposer }
            if expandedComposer.exists { return expandedComposer }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        return nil
    }

    /// Scrolls the row fully into the list's viewport and taps it. Each pass reads the row once
    /// (a snapshot answers existence and frame together), since every read is a query.
    func tapFixtureSession(_ session: XCUIElement) {
        let sessionList = app.collectionViews.firstMatch
        let viewportTop = app.navigationBars["Chats"].frame.maxY
        // iOS 27 swaps the minimized search between its field and its toolbar button at any moment, so its frame is
        // read by a snapshot of whichever is there rather than from an element found a moment earlier (TAL-667).
        var searchFrame: CGRect?
        XCTAssertTrue(poll(timeout: 5) {
            searchFrame = [sessionSearchField, app.buttons["Search"]].lazy.compactMap { try? $0.snapshot().frame }.first
            return searchFrame != nil
        }, "Missing the session search control")
        let viewportBottom = searchFrame?.minY ?? 0

        func rowFrame() -> CGRect? {
            let read = { (try? session.snapshot())?.frame }
            return awaitStable(read) ?? read()
        }
        // Fully in view, or, for a row taller than the viewport (landscape at accessibility
        // sizes), at least 44 points of it.
        func isReachable(_ row: CGRect) -> Bool {
            (row.minY >= viewportTop && row.maxY <= viewportBottom)
                || min(row.maxY, viewportBottom) - max(row.minY, viewportTop) >= 44
                && row.height > viewportBottom - viewportTop - 44
        }
        var frame = rowFrame()
        for _ in 0..<12 {
            if let row = frame, isReachable(row) {
                break
            }

            let scrollingUp = (frame?.maxY ?? 0) > viewportBottom
            let startY = scrollingUp ? 0.65 : 0.55
            let endY = scrollingUp ? 0.55 : 0.65
            sessionList.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
                .press(
                    forDuration: 0.05,
                    thenDragTo: sessionList.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: endY)
                    )
                )
            frame = rowFrame()
        }

        guard let row = frame else {
            XCTFail("The session row is missing")
            return
        }
        XCTAssertTrue(isReachable(row), "Could not bring the session row into view: \(row)")
        let visibleTop = max(row.minY, viewportTop)
        let visibleBottom = min(row.maxY, viewportBottom)
        tap(at: CGPoint(x: row.midX, y: (visibleTop + visibleBottom) / 2))
        // The transcript keeps scrolling into place for about a second after the chat opens, and
        // expanding the composer or typing during it leaves an animation XCTest then waits on for
        // a minute before every later step. XCTest's one-second first check used to cover it.
        Thread.sleep(forTimeInterval: 1)
    }
}

fileprivate extension SidebarUITestCase {
    func brightness(
        in screenshot: XCUIScreenshot,
        x normalizedX: CGFloat,
        y normalizedY: CGFloat
    ) throws -> CGFloat {
        let image = screenshot.image
        let pixelX = min(image.size.width - 1, image.size.width * normalizedX)
        let pixelY = min(image.size.height - 1, image.size.height * normalizedY)
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ), "Could not create screenshot pixel context")
        let cgImage = try XCTUnwrap(image.cgImage, "Could not read simulator screenshot pixels")

        context.translateBy(x: -pixelX, y: pixelY - image.size.height + 1)
        context.draw(cgImage, in: CGRect(origin: .zero, size: image.size))
        return CGFloat(pixel[0...2].max() ?? 0) / 255
    }

}

fileprivate extension AdaptiveLayoutUITestCase {
    func launchFixture(variant: Variant, additionalArguments: [String] = []) {
        XCUIDevice.shared.orientation = variant.orientation
        applyReduceMotion(variant.reduceMotion)
        launchFixture(additionalArguments: variant.arguments + additionalArguments)
        XCTAssertEqual(
            UIAccessibility.isReduceMotionEnabled, variant.reduceMotion,
            "Reduce Motion preference did not apply [\(variant.name)]"
        )
    }

    func audit(_ screen: String, variant: Variant) throws {
        try XCTContext.runActivity(named: "Audit \(screen) [\(variant.name)]") { activity in
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "\(screen) [\(variant.name)]"
            screenshot.lifetime = .deleteOnSuccess
            activity.add(screenshot)

            var issues: [String] = []
            var unlocated: [String] = []
            let handleIssue = { (issue: XCUIAccessibilityAuditIssue) -> Bool in
                // A finding with no element names nothing to fix; keep it visible, not fatal.
                guard issue.element != nil else {
                    unlocated.append("\(issue.compactDescription) — \(issue.detailedDescription)")
                    return true
                }
                // Generic containers (`Other`) carry no user-facing description; real controls
                // keep their own element types and stay audited.
                if issue.auditType == .sufficientElementDescription, issue.element?.elementType == .other {
                    return true
                }
                // Text rows (transcript messages) are text-height by nature; their actions are
                // reached through the rotor, not by tapping a 44pt target.
                if issue.auditType == .hitRegion, issue.element?.elementType == .staticText {
                    return true
                }
                // "Partially" flags text that scales less than the heuristic expects: caption
                // styles that stay flat below Large, or nav-bar titles with a pinned height.
                if issue.auditType == .dynamicType, issue.compactDescription.contains("partially") {
                    return true
                }
                let element = issue.element.map {
                    "\($0.elementType.rawValue) '\($0.label)' id='\($0.identifier)' \($0.frame)\n\($0.debugDescription)"
                } ?? "no element"
                issues.append("\(issue.compactDescription) — \(issue.detailedDescription) — \(element)")
                return true
            }
            // XCTest gives each audit call 15 seconds, and one call covering every type overran
            // it on a 3-core GitHub-hosted runner (TAL-401), so each type gets its own call.
            // The baseline variant runs every iOS audit type except three: contrast is unreliable
            // over blurred glass surfaces; the text-clipping audit predicts from `lineLimit`
            // instead of measuring the rendered variant; element detection scans pixels and names
            // no element to fix. The other variants run the layout-dependent types.
            for auditType in variant.auditTypes {
                // A call that runs out of time reports nothing, and one right after a slow
                // launch did so under CPU load, so a timed-out type runs again, up to 3 times.
                for attempt in 1...3 {
                    do {
                        try app.performAccessibilityAudit(for: auditType, handleIssue)
                        break
                    } catch let error as NSError
                        where error.domain == "com.apple.xcode.xctest.accessibilityAudit" && error.code == -56 && attempt < 3 {
                        activity.add(XCTAttachment(string: "Audit type \(auditType.rawValue) timed out on attempt \(attempt)"))
                    }
                }
            }
            if !unlocated.isEmpty {
                let note = XCTAttachment(string: unlocated.joined(separator: "\n"))
                note.name = "Unlocated audit findings: \(screen) [\(variant.name)]"
                activity.add(note)
            }
            XCTAssertTrue(
                issues.isEmpty,
                "Accessibility audit failed on \(screen) [\(variant.name)]:\n" + issues.joined(separator: "\n")
            )
        }
    }

    func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        element.value(forKey: "hasKeyboardFocus") as? Bool ?? false
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}

fileprivate extension TalariaUITestCase {
    func openProviders() {
        tapSettingsCategory(id: "providers", title: "Providers")
        tapSettingsRow(label: "Providers")
    }

    /// Walks back out of a nested Settings destination to the category root.
    func returnToSettingsRoot() {
        let root = app.navigationBars["Settings"]
        repeatStep(3, until: { root.exists }) {
            app.buttons["BackButton"].tap()
            _ = root.awaitExistence(timeout: 3)
        }
        XCTAssertTrue(root.exists, "Did not return to the Settings root")
    }

    func openArchivedChats() {
        tapSettingsCategory(id: "chats", title: "Chats")
        tapSettingsRow(label: "Archived Chats")
        XCTAssertTrue(app.navigationBars["Archived Chats"].awaitExistence(timeout: Self.navigationTimeout))
    }
}

fileprivate extension WorkspaceUITestCase {
    func openFixtureSessionChat() {
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")
    }

    func openFiles() {
        let files = app.buttons["Files"]
        XCTAssertTrue(files.awaitExistence(timeout: 15), "Missing the Files toolbar button")
        files.tap()
        XCTAssertTrue(app.navigationBars["Files"].awaitExistence(timeout: 10), "The file browser did not open")
    }

    func openGitActions() {
        let git = app.buttons["Git actions"]
        XCTAssertTrue(git.awaitExistence(timeout: 25), "Missing the Git actions toolbar button")
        git.tap()
    }

    func tapGitMenuPush() {
        let push = app.buttons["Push"]
        XCTAssertTrue(push.awaitExistence(timeout: Self.navigationTimeout), "Missing the Push action")
        // A tap while the menu is still growing in from its button lands but runs no action, so
        // wait for Push to be enabled and at rest first.
        XCTAssertTrue(poll(timeout: Self.navigationTimeout) { push.isEnabled }, "Push stayed disabled")
        _ = push.settledFrame
        push.tap()
    }

    func openDirectory(_ name: String) {
        let row = fileRow(folder: name)
        XCTAssertTrue(row.awaitExistence(timeout: 20), "Missing directory row: \(name)")
        tapCenter(of: row)
    }

    func openPreview(file name: String) {
        let row = fileRow(file: name)
        XCTAssertTrue(row.awaitExistence(timeout: 20), "Missing file row: \(name)")
        tapCenter(of: row)
        XCTAssertTrue(app.navigationBars[name].awaitExistence(timeout: 10), "The preview did not open: \(name)")
    }

    func fileRow(folder name: String) -> XCUIElement {
        element(labelBeginningWith: "Folder, \(name)")
    }

    func fileRow(file name: String) -> XCUIElement {
        element(labelBeginningWith: "File, \(name)")
    }

    func gitFileCard(named name: String) -> XCUIElement {
        element(labelBeginningWith: name)
    }
}

/// Card menus offer exactly the actions the server sent for each Card (TAL-557).
final class KanbanCardActionsUITests: TalariaUITestCase {
    func testCardMenuOffersOnlyTheServerActions() throws {
        launchFixture()
        openSidebarDestination("Kanban")
        let selector = app.descendants(matching: .any)["KanbanStatusSelector"]
        XCTAssertTrue(selector.awaitExistence(timeout: Self.navigationTimeout), "Kanban Board did not load")

        // Triage: Move and Archive only.
        assertCardMenu(offers: ["Move", "Archive"], omits: ["Block", "Unblock", "Complete"], screenshot: "Triage card actions")

        let ready = selector.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Ready")).firstMatch
        XCTAssertTrue(ready.awaitExistence(timeout: 5), "Ready status missing")
        ready.tap()
        assertCardMenu(offers: ["Move", "Block", "Complete", "Archive"], omits: ["Unblock"], screenshot: "Ready card actions")
    }

    private func assertCardMenu(offers: [String], omits: [String], screenshot: String) {
        let menu = app.buttons["Card Actions"].firstMatch
        XCTAssertTrue(menu.awaitExistence(timeout: 5), "Card Actions missing")
        menu.tap()
        for label in offers {
            XCTAssertTrue(app.buttons[label].firstMatch.awaitExistence(timeout: 3), "\(label) missing [\(screenshot)]")
        }
        for label in omits {
            XCTAssertFalse(app.buttons[label].exists, "\(label) offered [\(screenshot)]")
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = screenshot
        attachment.lifetime = .keepAlways
        add(attachment)
        // Close the menu by tapping clear of it.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(app.buttons[offers.last ?? "Archive"].awaitNonExistence(timeout: 3), "Card menu did not close [\(screenshot)]")
    }
}

/// Messages queued during a run show as a floating chip above the composer; it opens a sheet that shows
/// each one in full and sends it now, edits it or removes it (TAL-630).
final class QueuedMessagesChipUITests: ChatUITestCase {
    func testQueuedMessagesSheetShowsThemInFullAndRemovesAndEditsThem() throws {
        launchChatFixture(argument: "--ui-test-chat-controls", trace: "start -> token -> /queue -> Send menu queue -> remove -> edit")
        try sendFixtureMessage("Run the deterministic fixture")
        XCTAssertTrue(app.staticTexts["Waiting for control input."].awaitExistence(timeout: 5))

        // The first is queued with `/queue`; the chip replaces the old "Queued for next turn" notice.
        let input = app.textViews.firstMatch
        input.typeText("/queue First queued message")
        tapCenter(of: app.buttons["Send"])
        XCTAssertTrue(app.buttons["1 queued"].awaitExistence(timeout: 5), "/queue did not queue the message")
        XCTAssertFalse(element(labelContaining: "Queued for next turn").exists, "Queuing still shows a notice")

        // The second, a paragraph so the sheet shows a long message in full, is queued from Send's long-press menu.
        let long = "Second queued message: once this finishes, rerun the full suite on the hosted runner, "
            + "compare the timings against yesterday's run, and write up anything that got slower than ten percent."
        input.typeText(long)
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.awaitExistence(timeout: 5), "The composer has no keyboard")
        // A fresh simulator keyboard shows its swipe-typing tip once, over the keys; it takes touches meant for the menu.
        let swipeTypingTip = app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."]
        if swipeTypingTip.exists { app.buttons["Continue"].firstMatch.tap() }
        let keyboardTop = keyboard.frame.minY
        app.buttons["Send"].press(forDuration: 1)
        let queueOption = app.buttons["Queue"]
        XCTAssertTrue(queueOption.awaitExistence(timeout: 5), "Long-pressing Send did not open the send menu")
        Thread.sleep(forTimeInterval: 0.6) // a dismissal would be under way by now
        XCTAssertTrue(keyboard.exists && abs(keyboard.frame.minY - keyboardTop) < 2, "Opening the send menu dropped the keyboard")
        XCTAssertTrue(app.buttons["Steer"].exists)
        XCTAssertTrue(app.buttons["Stop and send"].exists)
        XCTAssertFalse(app.buttons["Side question"].exists, "A side question waits for the running reply")
        attachScreenshot(named: "send-menu")
        // A streaming reply redraws the composer while the menu is open; the tap must still choose (TAL-648).
        tapCenter(of: queueOption)

        let chip = app.buttons["2 queued"]
        XCTAssertTrue(chip.awaitExistence(timeout: 5), "The queue chip is missing")
        XCTAssertGreaterThanOrEqual(chip.frame.height, 43, "The queue chip's hit area is under 44 pt")
        attachScreenshot(named: "queued-chip")
        tapCenter(of: chip)
        XCTAssertTrue(app.staticTexts["First queued message"].awaitExistence(timeout: 5), "The sheet does not show the first message")
        let longText = app.staticTexts.matching(NSPredicate(format: "label == %@", long)).firstMatch
        XCTAssertTrue(longText.exists, "The sheet does not show the second message in full")
        XCTAssertEqual(app.buttons.matching(identifier: "Send now").count, 2)
        XCTAssertEqual(app.buttons.matching(identifier: "Remove").count, 2)
        attachScreenshot(named: "queued-sheet")

        // Remove drops the second message; the sheet stays for the first.
        app.buttons.matching(identifier: "Remove").element(boundBy: 1).tap()
        XCTAssertTrue(longText.awaitNonExistence(timeout: 5), "Remove left the message in the queue")
        XCTAssertTrue(app.staticTexts["First queued message"].exists)

        // Edit takes the last one back into the composer; the sheet and the chip leave with it.
        app.buttons["Edit"].tap()
        XCTAssertTrue(app.buttons["1 queued"].awaitNonExistence(timeout: 5), "The queue chip stayed after its last message was edited")
        let composerInput = app.textViews.firstMatch
        XCTAssertTrue(composerInput.awaitExistence(timeout: 5))
        XCTAssertEqual(composerInput.value as? String, "First queued message", "Edit did not put the message back in the composer")

        // The fixture starts no background task, so the menu send fails and the draft stays to retry.
        app.buttons["Send"].press(forDuration: 1)
        let backgroundOption = app.buttons["Run in background"]
        XCTAssertTrue(backgroundOption.awaitExistence(timeout: 5), "Long-pressing Send did not open the send menu")
        tapCenter(of: backgroundOption)
        XCTAssertTrue(element(labelContaining: "did not return a background task").awaitExistence(timeout: 5))
        XCTAssertEqual(composerInput.value as? String, "First queued message", "A failed menu send cleared the draft")
    }
}

/// A hardware keyboard sends on Return, adds a newline on ⌘Return or Shift+Return, and during a reply
/// Ctrl+Return sends the other way from the stored behavior: steer's other way is the queue (TAL-660).
final class ComposerHardwareKeyboardUITests: ChatUITestCase {
    /// The simulator presses Return for "\n"; `XCUIKeyboardKey.return` ("\r") reaches no key at all.
    private static let returnKey = "\n"

    func testReturnSendsCommandReturnAddsANewlineAndControlReturnQueuesDuringAReply() throws {
        launchChatFixture(argument: "--ui-test-chat-controls", trace: "start -> Cmd-Return -> Shift-Return -> Return -> token -> Ctrl-Return")
        let input = readyComposerInput(try openFixtureSession())
        Thread.sleep(forTimeInterval: 1) // let the keyboard land, as `sendFixtureMessage` does
        input.typeText("Run the deterministic fixture")
        input.typeKey(Self.returnKey, modifierFlags: .command)
        input.typeText("second line")
        input.typeKey(Self.returnKey, modifierFlags: .shift)
        input.typeText("third line")
        XCTAssertEqual(
            input.value as? String,
            "Run the deterministic fixture\nsecond line\nthird line",
            "Command-Return or Shift-Return did not add a newline"
        )
        attachScreenshot(named: "newlines-from-the-keyboard")

        input.typeKey(Self.returnKey, modifierFlags: [])
        XCTAssertTrue(app.staticTexts["Waiting for control input."].awaitExistence(timeout: 10), "Return did not send the draft")
        XCTAssertTrue(poll(timeout: 5) { (input.value as? String)?.contains("third line") != true }, "Return left the draft in the composer")

        input.typeText("Queued from the keyboard")
        input.typeKey(Self.returnKey, modifierFlags: .control)
        XCTAssertTrue(app.buttons["1 queued"].awaitExistence(timeout: 5), "Control-Return did not queue the draft while steering is the setting")
        XCTAssertTrue(poll(timeout: 5) { (input.value as? String)?.contains("Queued from the keyboard") != true }, "Control-Return left the draft in the composer")
        // A Control-Return key command would also open the text view's edit menu, which takes the next keystrokes.
        input.typeText("Next draft")
        XCTAssertEqual(input.value as? String, "Next draft", "Typing after Control-Return did not reach the composer")
        XCTAssertFalse(element(labelContaining: "Select All").exists, "Control-Return opened the edit menu")
        attachScreenshot(named: "control-return-queued")
    }

    /// With Send With set to ⌘ Return, Return is the newline and ⌘Return sends.
    func testCommandReturnModeSendsOnCommandReturnAndAddsANewlineOnReturn() throws {
        fixtureTrace = "start -> Return -> Cmd-Return -> token"
        launchFixture(additionalArguments: ["--ui-test-chat-controls", "-composerSendKey", "commandReturn"])
        let input = readyComposerInput(try openFixtureSession())
        Thread.sleep(forTimeInterval: 1)
        input.typeText("Run the deterministic fixture")
        input.typeKey(Self.returnKey, modifierFlags: [])
        input.typeText("second line")
        XCTAssertEqual(input.value as? String, "Run the deterministic fixture\nsecond line", "Return did not add a newline")

        input.typeKey(Self.returnKey, modifierFlags: .command)
        XCTAssertTrue(app.staticTexts["Waiting for control input."].awaitExistence(timeout: 10), "Command-Return did not send the draft")
        XCTAssertTrue(poll(timeout: 5) { (input.value as? String)?.contains("second line") != true }, "Command-Return left the draft in the composer")
    }
}

/// The strip's toolsets control shows the session's toolsets and sets them in a sheet (TAL-631).
final class ComposerToolsetsUITests: WorkspaceUITestCase {
    /// The chevron beside + hides the control strip and shows it again (TAL-630).
    func testChevronHidesAndShowsTheControlStrip() throws {
        launchFixture(additionalArguments: ["-composerVisibility.workspace", "NO", "-composerVisibility.gitBranch", "NO"])
        openFixtureSessionChat()

        let toolsets = app.buttons["Session toolsets"]
        XCTAssertTrue(toolsets.awaitExistence(timeout: 15), "The strip is not shown at launch")
        let hide = app.buttons["Hide composer controls"]
        XCTAssertTrue(hide.awaitExistence(timeout: 5), "Missing the strip chevron")
        XCTAssertGreaterThanOrEqual(hide.frame.height, 43, "The chevron's hit area is under 44 pt")
        tapCenter(of: hide)
        XCTAssertTrue(toolsets.awaitNonExistence(timeout: 5), "The chevron did not hide the strip")
        attachScreenshot(named: "strip-hidden")

        tapCenter(of: app.buttons["Show composer controls"])
        XCTAssertTrue(toolsets.awaitExistence(timeout: 5), "The chevron did not show the strip again")

        // With the keyboard up, the chevron leaves it up both ways.
        tapCenter(of: app.buttons["Message"])
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.awaitExistence(timeout: 5), "The composer has no keyboard")
        let swipeTypingTip = app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."]
        if swipeTypingTip.exists { app.buttons["Continue"].firstMatch.tap() }
        let keyboardTop = keyboard.settledFrame.minY
        for label in ["Hide composer controls", "Show composer controls"] {
            tapCenter(of: app.buttons[label])
            Thread.sleep(forTimeInterval: 0.6) // a dismissal would be under way by now
            XCTAssertTrue(keyboard.exists && abs(keyboard.frame.minY - keyboardTop) < 2, "\(label) dropped the keyboard")
        }
    }

    func testToolsetsControlSavesAListAndRestoresProfileDefaults() throws {
        // With workspace and branch hidden the control fits without scrolling the strip; a drag that
        // low on the screen can turn into the system's app-switch swipe.
        launchFixture(additionalArguments: ["-composerVisibility.workspace", "NO", "-composerVisibility.gitBranch", "NO"])
        openFixtureSessionChat()

        let control = app.buttons["Session toolsets"]
        XCTAssertTrue(control.awaitExistence(timeout: 15), "Missing the toolsets control")
        XCTAssertEqual(control.value as? String, "Profile defaults")
        tapCenter(of: control)

        let field = app.textFields["Session toolsets"]
        XCTAssertTrue(field.awaitExistence(timeout: 5), "The toolsets sheet did not open")
        field.tap()
        field.typeText("web, terminal")
        attachScreenshot(named: "toolsets-sheet")
        app.buttons["Save"].tap()
        XCTAssertTrue(field.awaitNonExistence(timeout: 5))
        XCTAssertTrue(control.awaitValue("web, terminal", timeout: 5), "The control does not show the saved toolsets")
        attachScreenshot(named: "toolsets-saved")

        tapCenter(of: control)
        XCTAssertTrue(field.awaitExistence(timeout: 5), "The toolsets sheet did not reopen")
        XCTAssertEqual(field.value as? String, "web, terminal")
        app.buttons["Use profile defaults"].tap()
        XCTAssertTrue(control.awaitValue("Profile defaults", timeout: 5), "Profile defaults did not restore")
    }
}
