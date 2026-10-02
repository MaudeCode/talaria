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

/// Opening a chat from the list, then what the opened chat offers: its idle composer, which
/// expands for typing, and long-press isolation between a message's links and its own actions
/// (TAL-49).
final class ChatNavigationUITests: ChatUITestCase {
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

/// Reopening a chat paints its cached transcript at once and shows "Syncing messages" above
/// the composer until the server answers (TAL-436).
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
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }
}

/// Steering and stopping a running turn through the composer. A terminal error, a transport
/// reconnect and reopening a running chat are ChatViewModel and session-list tests in
/// TalariaKit (TAL-402).
final class ChatRecoveryUITests: ChatUITestCase {
    func testChatStreamSupportsSteeringAndCancellation() throws {
        launchChatFixture(
            argument: "--ui-test-chat-controls",
            trace: "start -> token -> steer request -> steer_consumed -> cancel request -> cancel"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        XCTAssertTrue(app.staticTexts["Waiting for control input."].awaitExistence(timeout: 5))
        let composer = try XCTUnwrap(waitForComposer(timeout: 5))
        let input = app.textViews.firstMatch
        if !input.awaitExistence(timeout: 2) {
            composer.tap()
            XCTAssertTrue(input.awaitExistence(timeout: 5))
        }
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

/// The composer collapses as the transcript scrolls and expands again, starting from a fresh,
/// unfocused composer with no draft. Its first expansion runs in `ChatNavigationUITests`.
final class ChatComposerUITests: ChatUITestCase {
    func testComposerCollapsesAndExpandsWithoutBottomNavigation() throws {
        launchFixture()
        _ = try openFixtureSession()

        let transcript = app.scrollViews["chat-detail:\(fixtureSessionTitle)"]
        XCTAssertTrue(transcript.awaitExistence(timeout: 3))
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)
        transcript.swipeUp(velocity: .slow)

        XCTAssertTrue(app.buttons["Choose workspace path"].awaitNonExistence(timeout: 5))
        let collapsedComposer = app.buttons["Message"]
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

class SettingsUITestCase: TalariaUITestCase {}

/// The category root, where moved controls live, every category's route, and the server-backed
/// Chats and Providers screens with the grouped controls around them, in one launch. Their failed
/// loads run in `ReadFailureUITests`.
final class SettingsStructureUITests: SettingsUITestCase {
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
            ("notificationsAndHaptics", "Notifications & Haptics", "Quota Pace Alerts"),
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

        let warning = app.buttons["Provider quota warning"]
        XCTAssertFalse(app.staticTexts["This server supports active-provider quota only. Multi-account sources require the companion server update."].exists)

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

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
            .press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.45))
            )

        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.awaitExistence(timeout: 3))
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertTrue(closeNavigation.awaitExistence(timeout: 3))
        XCTAssertEqual(sidebar.elementType, .alert)
        XCTAssertFalse(app.buttons["Pin"].exists)
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
        openNavigation.tap()
        XCTAssertTrue(closeNavigation.awaitExistence(timeout: 3))
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
        // A tap while the close is still settling can be dropped. The sidebar and its rows stay
        // in the tree while it is closed, so hittability is the sign it opened.
        repeatStep(3, until: { sidebar.isHittable }) {
            openNavigation.tap()
            _ = poll(timeout: 3) { sidebar.isHittable }
        }
        XCTAssertTrue(sidebar.isHittable, "The sidebar did not open again")
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
    /// is audited by rotating the default-size variant rather than in a launch of its own; the
    /// accessibility-size variant carries Reduce Motion (TAL-402). Landscape at accessibility
    /// sizes is not audited: its composer covers the chat's navigation bar.
    static let variants = [
        Variant(
            name: "light",
            arguments: ["-appTheme", "light", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"],
            orientations: [.portrait, .landscapeLeft],
            auditTypes: [.dynamicType, .hitRegion, .sufficientElementDescription, .trait]
        ),
        Variant(
            name: "portrait dark RTL AXXXL reduce-motion",
            arguments: [
                "-appTheme", "dark",
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                "-AppleTextDirection", "YES",
                "-NSForceRightToLeftWritingDirection", "YES",
            ],
            orientations: [.portrait],
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

final class AdaptiveLayoutPortraitDarkRTLUITests: AdaptiveLayoutAppUITestCase {
    func testCoreScreensPassAccessibilityAuditsInPortraitDarkRTLAccessibilityXXXLReduceMotion() throws {
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
            app.buttons["BackButton"].tap()

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
            openSidebarDestination("Kanban")
            XCTAssertTrue(app.navigationBars["Kanban"].awaitExistence(timeout: 5))
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
/// snapshotting the app several times a second on a 3-core hosted runner.
func poll(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    var interval: TimeInterval = 0.1
    while !condition() {
        guard Date() < deadline else { return false }
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

    func sendFixtureMessage(_ message: String) throws {
        let composer = try openFixtureSession()
        let input = app.textViews.firstMatch
        if !input.awaitExistence(timeout: 2) {
            composer.tap()
            XCTAssertTrue(input.awaitExistence(timeout: 5))
        }
        // A chat can focus its composer as it opens. Typing, or querying the app, while the
        // keyboard is still sliding in can leave XCTest waiting a minute for the app to go idle
        // before every later step, so let it land first, as XCTest's one-second first check did.
        Thread.sleep(forTimeInterval: 1)
        input.typeText(message)
        let send = app.buttons["Send"]
        XCTAssertTrue(send.awaitExistence(timeout: Self.navigationTimeout))
        tapCenter(of: send)
    }

    func countElements(label: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).count
    }

    func countElements(containing text: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).count
    }

    /// Waits until the element stops moving, so a press lands where it was measured.
    func settledFrame(of element: XCUIElement) -> CGRect {
        awaitStable(timeout: 6, interval: 0.3) { element.frame } ?? element.frame
    }

    func settledCenter(of element: XCUIElement) -> CGPoint {
        let frame = settledFrame(of: element)
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    /// Presses by coordinate: transcript text reports itself as not hittable.
    func longPress(at point: CGPoint) {
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x, dy: point.y))
            .press(forDuration: 1.2)
    }
}

extension TalariaUITestCase {
    func openSidebarDestination(_ destination: String) {
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        // A tap while the screen behind is still settling (a menu closing, a rotation) can be
        // dropped, so open until the sidebar is up.
        repeatStep(3, until: { sidebar.exists && sidebar.isHittable }) {
            app.buttons["Open navigation"].tap()
            _ = poll(timeout: Self.navigationTimeout / 3) { sidebar.exists && sidebar.isHittable }
        }
        XCTAssertTrue(sidebar.exists, "The sidebar did not open")
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
        let row = app.buttons[label]
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
        repeatStep(10, until: { frame.minY >= viewportTop && frame.maxY <= viewportBottom }) {
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

fileprivate extension TalariaUITestCase {
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
        let searchControl = waitForSessionSearchControl(timeout: 5)
        XCTAssertNotNil(searchControl, "Missing the session search control")
        let viewportBottom = searchControl?.frame.minY ?? 0

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
