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

final class ChatNavigationUITests: ChatUITestCase {
    func testChatListScrolls() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")

        let initialY = session.frame.minY
        let sessionList = app.collectionViews.firstMatch
        XCTAssertTrue(sessionList.exists)
        sessionList.swipeUp(velocity: .slow)
        if session.exists {
            XCTAssertGreaterThan(abs(session.frame.minY - initialY), 20)
        }
    }

    func testChatSessionOpensFromList() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")

        tapFixtureSession(session)
        XCTAssertTrue(waitForComposer(timeout: 15) != nil)
    }
}

/// Long-press isolation between a message's links and its own actions (TAL-49).
final class ChatMessageInteractionUITests: ChatUITestCase {
    func testLongPressOnALinkShowsOnlyTheLinkActions() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)

        let link = app.links["FixtureLinkTarget"]
        XCTAssertTrue(link.waitForExistence(timeout: 15), "Missing the fixture's mixed text-and-link message")
        longPress(at: settledCenter(of: link))

        XCTAssertTrue(app.buttons["Open Link"].waitForExistence(timeout: 5), "The link's own actions did not open")
        XCTAssertFalse(app.buttons["Fork From Here"].exists, "A link press must not offer message actions")
        XCTAssertFalse(app.buttons["Listen"].exists, "A link press must not offer message actions")
    }

    func testLongPressOnMessageTextShowsMessageActionsAtThePressPoint() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)

        let message = element(labelContaining: "FixturePlainLead")
        XCTAssertTrue(message.waitForExistence(timeout: 15), "Missing the fixture's long assistant message")
        let before = settledFrame(of: message)
        // High in a tall bubble: the pre-TAL-49 context menu lifted the whole
        // bubble and pushed its menu to the top of the screen from here.
        let press = CGPoint(x: before.midX, y: before.minY + 12)
        longPress(at: press)

        let fork = app.buttons["Fork From Here"]
        XCTAssertTrue(fork.waitForExistence(timeout: 5), "The message actions did not open")
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
    }
}

final class ChatPrimaryStreamUITests: ChatUITestCase {
    func testBatchClarificationShowsChoicesAndDeliversTypedAndMultiSelectAnswers() throws {
        launchChatFixture(argument: "--ui-test-chat-batch-clarification", trace: "batch prompt -> typed answer -> next -> selected answers -> agent result")
        _ = try openFixtureSession()
        XCTAssertTrue(app.staticTexts["What sounds best for a quiet evening?"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["A movie"].exists)
        XCTAssertTrue(app.buttons["A book"].exists)
        XCTAssertTrue(app.staticTexts["Question 1 of 2"].exists)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
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
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(app.buttons["Next"].frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        app.buttons["Next"].tap()
        XCTAssertTrue(app.staticTexts["Which drinks?"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["Agent received: A movie | Tea, Water"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
    }

    func testClarificationRestoresOrdinaryDraftAfterAnswerAndNavigation() throws {
        launchChatFixture(argument: "--ui-test-chat-clarification", trace: "saved draft -> clarification -> answer -> restore -> navigate")
        _ = try openFixtureSession()
        XCTAssertTrue(app.staticTexts["Clarification Required"].waitForExistence(timeout: 5))
        let input = app.textViews.firstMatch
        XCTAssertEqual(input.value as? String, "")
        input.tap()
        input.typeText("Temporary fixture answer")
        app.buttons["Submit clarification"].tap()
        XCTAssertTrue(app.staticTexts["Clarification Required"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Agent received: Temporary fixture answer"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
        tapCenter(of: app.buttons["BackButton"])
        XCTAssertTrue(fixtureSessionButton.waitForExistence(timeout: 5))
        tapCenter(of: fixtureSessionButton)
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews.firstMatch.value as? String, "Ordinary fixture draft")
    }

    func testClarificationUsesOnlyTheComposerAndSendsSlashTextAsAnAnswer() throws {
        launchChatFixture(argument: "--ui-test-chat-full", trace: "clarification -> composer answer -> done")
        try sendFixtureMessage("Run the deterministic fixture")
        XCTAssertTrue(app.buttons["Allow once"].waitForExistence(timeout: 5))
        app.buttons["Allow once"].tap()
        XCTAssertTrue(app.staticTexts["Clarification Required"].waitForExistence(timeout: 5))
        let question = app.staticTexts["Which deterministic path should continue?"]
        XCTAssertTrue(question.exists)
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
        XCTAssertTrue(app.navigationBars["Deterministic Stream Complete"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Clarification Required"].exists)
        XCTAssertFalse(app.staticTexts["/interrupt is my answer"].exists)
    }

    func testChatStreamPreservesChronologyAndSettlesWithoutDuplication() throws {
        launchChatFixture(
            argument: "--ui-test-chat-full",
            trace: "start -> token -> reasoning -> token -> tool -> approval -> tool_complete -> token -> clarify -> title -> metering -> done -> stream_end -> reload"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        let optimisticMessage = app.staticTexts["Run the deterministic fixture"]
        XCTAssertTrue(optimisticMessage.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Approval required"].waitForExistence(timeout: 5))

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
        XCTAssertTrue(app.staticTexts["Clarification Required"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Which deterministic path should continue?"].exists)

        let finished = app.staticTexts["Fixture finished."]
        XCTAssertTrue(finished.exists)

        let clarificationChoice = app.buttons["Use the deterministic path"]
        XCTAssertTrue(clarificationChoice.exists)
        tapCenter(of: clarificationChoice)
        XCTAssertTrue(app.navigationBars["Deterministic Stream Complete"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Stop response"].waitForNonExistence(timeout: 5))

        let back = app.buttons["BackButton"]
        XCTAssertTrue(back.exists)
        tapCenter(of: back)
        XCTAssertTrue(fixtureSessionButton.waitForExistence(timeout: 5))
        tapCenter(of: fixtureSessionButton)
        XCTAssertTrue(app.navigationBars["Deterministic Stream Complete"].waitForExistence(timeout: 5))
        let worked = app.buttons["Worked"]
        XCTAssertTrue(worked.waitForExistence(timeout: 5))
        tapCenter(of: worked)

        let reloadedOpening = app.staticTexts["Fixture opening."]
        let reloadedThinking = element(labelContaining: "Thinking, Inspecting fixture")
        let reloadedProgress = app.staticTexts["Fixture progress."]
        let reloadedTool = element(labelContaining: "Called a tool, Completed")
        let reloadedFinished = app.staticTexts["Fixture finished."]
        XCTAssertTrue(reloadedOpening.waitForExistence(timeout: 5))
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

final class ChatRecoveryUITests: ChatUITestCase {
    func testChatStreamSupportsSteeringAndCancellation() throws {
        launchChatFixture(
            argument: "--ui-test-chat-controls",
            trace: "start -> token -> steer request -> steer_consumed -> cancel request -> cancel"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        XCTAssertTrue(app.staticTexts["Waiting for control input."].waitForExistence(timeout: 5))
        let composer = try XCTUnwrap(waitForComposer(timeout: 5))
        let input = app.textViews.firstMatch
        if !input.waitForExistence(timeout: 2) {
            composer.tap()
            XCTAssertTrue(input.waitForExistence(timeout: 5))
        }
        input.typeText("Keep the fixture concise")
        tapCenter(of: app.buttons["Send"])

        XCTAssertTrue(app.staticTexts["Keep the fixture concise"].waitForExistence(timeout: 5))
        XCTAssertTrue(element(labelContaining: "Steering hint").waitForExistence(timeout: 5))
        XCTAssertTrue(element(label: "Steering hint").waitForExistence(timeout: 5))
        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()

        XCTAssertTrue(stop.waitForNonExistence(timeout: 5))
        // The stopped turn settles into the server's scene: its outcome and the steer it took stay visible.
        XCTAssertTrue(app.staticTexts["Response cancelled"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Keep the fixture concise"].exists)
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }

    func testChatStreamSurfacesTerminalErrorAndRestoresComposer() throws {
        launchChatFixture(
            argument: "--ui-test-chat-error",
            trace: "start -> token -> error"
        )
        try sendFixtureMessage("Run the deterministic fixture")

        XCTAssertTrue(app.staticTexts["Partial fixture response."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Synthetic fixture failure"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Stop response"].waitForNonExistence(timeout: 5))
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }

    func testChatStreamReconnectsAfterTransportLoss() throws {
        launchChatFixture(
            argument: "--ui-test-chat-reconnect",
            trace: "start -> token -> transport error -> status(active) -> session reload -> reconnect -> token -> done -> stream_end"
        )
        try sendFixtureMessage("Run the deterministic fixture")
        XCTAssertTrue(element(labelContaining: "Before reconnect.").waitForExistence(timeout: 5))

        XCTAssertTrue(element(labelContaining: "After reconnect.").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Stop response"].waitForNonExistence(timeout: 5))
        XCTAssertEqual(countElements(containing: "Before reconnect."), 1)
        XCTAssertEqual(countElements(containing: "After reconnect."), 1)
        XCTAssertNotNil(waitForComposer(timeout: 5))
    }

    // TAL-250: reopening a running chat paints its work and a run-state check before the held session detail answers.
    func testReopeningRunningChatKeepsItsWorkVisibleWhileTheSessionLoads() throws {
        launchChatFixture(
            argument: "--ui-test-chat-reopen",
            trace: "start -> token + tool -> leave -> list streaming -> reopen (detail held 4s) -> active detail -> reconnect -> token -> done"
        )
        try sendFixtureMessage("Run the deterministic fixture")
        XCTAssertTrue(element(labelContaining: "Reopen fixture progress.").waitForExistence(timeout: 5))

        tapCenter(of: app.buttons["BackButton"])
        XCTAssertTrue(element(labelContaining: "Streaming").waitForExistence(timeout: 10), "The list never reported the run")
        tapCenter(of: fixtureSessionButton)

        XCTAssertTrue(
            element(labelContaining: "Reopen fixture progress.").waitForExistence(timeout: 2.5),
            "The running turn's work vanished while the session detail was held"
        )
        XCTAssertTrue(element(label: "Checking stream").waitForExistence(timeout: 1))

        XCTAssertTrue(element(labelContaining: "Reopen fixture done.").waitForExistence(timeout: 20))
        XCTAssertTrue(element(label: "Checking stream").waitForNonExistence(timeout: 5))
        XCTAssertEqual(countElements(containing: "Reopen fixture progress."), 1)
    }
}

final class ChatComposerUITests: ChatUITestCase {
    func testComposerCollapsesAndExpandsWithoutBottomNavigation() throws {
        launchFixture()
        let idleComposer = try openFixtureSession()
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-bottom-accessory"].exists)

        idleComposer.tap()
        let expandedTextView = app.textViews.firstMatch
        XCTAssertTrue(expandedTextView.waitForExistence(timeout: 10))
        expandedTextView.typeText("Composer transition check")
        XCTAssertFalse(app.buttons["Reply"].exists)

        app.terminate()
        app.launchArguments = fixtureLaunchArguments
        app.launch()
        _ = try openFixtureSession()

        let transcript = app.scrollViews["chat-detail:\(fixtureSessionTitle)"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 3))
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)
        transcript.swipeUp(velocity: .slow)

        XCTAssertTrue(app.buttons["Choose workspace path"].waitForNonExistence(timeout: 5))
        let collapsedComposer = app.buttons["Message"]
        XCTAssertTrue(collapsedComposer.exists)

        let composerOptions = app.buttons["Composer options"]
        XCTAssertTrue(composerOptions.exists)
        composerOptions.tap()
        XCTAssertTrue(app.buttons["Attach File"].waitForExistence(timeout: 3))
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
        XCTAssertTrue(reexpandedTextView.waitForExistence(timeout: 10))
        reexpandedTextView.typeText("Draft")

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            .press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            )
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 3))

        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
    }

}

class SettingsUITestCase: TalariaUITestCase {}

final class SettingsConfigurationUITests: SettingsUITestCase {
    func testComposerSettingsAreGroupedAndConfigurable() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "chats", title: "Chats")

        let composerHeading = app.staticTexts["Composer"]
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
            for _ in 0..<8 where !setting.exists {
                app.swipeUp()
            }
            XCTAssertTrue(setting.exists, "Missing composer setting: \(label)")
        }

        app.navigationBars["Chats"].buttons["Settings"].tap()
        tapSettingsCategory(id: "providers", title: "Providers")

        let percentage = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Quota Percentage"))
            .firstMatch
        for _ in 0..<12 where !percentage.exists {
            app.swipeUp()
        }
        XCTAssertTrue(percentage.exists)
        XCTAssertTrue(app.staticTexts["Used"].exists)

        let quotaRefresh = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Quota Refresh"))
            .firstMatch
        for _ in 0..<6 where !quotaRefresh.exists {
            app.swipeUp()
        }
        XCTAssertTrue(quotaRefresh.exists)
        XCTAssertTrue(app.staticTexts["Every 5 minutes"].exists)

        add(XCTAttachment(screenshot: XCUIScreen.main.screenshot()))
    }
}

final class SettingsStructureUITests: SettingsUITestCase {
    func testSettingsRootContainsCategoriesInsteadOfLeafControls() throws {
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
        XCTAssertTrue(app.navigationBars["Apple Account"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["settings-sign-in-with-apple"].waitForExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertFalse(app.descendants(matching: .any)["Haptic Feedback"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Default Model"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Clear Offline Cache"].exists)
        let rootScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        rootScreenshot.name = "Settings category root"
        rootScreenshot.lifetime = .keepAlways
        add(rootScreenshot)
    }

    func testSettingsTaxonomyKeepsMovedControlsWithTheirOwners() throws {
        launchFixture()
        openSettings()

        tapCenter(of: app.buttons["settings-user-profile"])
        XCTAssertTrue(app.navigationBars["User Profile"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["Display Name"].exists)
        app.navigationBars["User Profile"].buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))

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
            for _ in 0..<12 where !setting.exists {
                app.swipeUp()
            }
            XCTAssertTrue(setting.exists, "Missing \(category.2) under \(category.1)")
            app.navigationBars[category.1].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        }
    }
}

final class SettingsGeneralRoutingUITests: SettingsUITestCase {
    func testAppearanceAndSiriCategoriesRouteCorrectly() {
        assertSettingsCategoryRoutes([
            ("appearance", "Appearance"),
            ("siriAndShortcuts", "Siri & Shortcuts"),
        ])
    }
}

final class SettingsServerRoutingUITests: SettingsUITestCase {
    func testServerAndDataCategoriesRouteCorrectly() {
        assertSettingsCategoryRoutes([
            ("servers", "Servers"),
            ("dataAndStorage", "Data & Storage"),
        ])
    }
}

final class SettingsInfoRoutingUITests: SettingsUITestCase {
    func testAboutAndDeveloperCategoriesRouteCorrectly() {
        assertSettingsCategoryRoutes([
            ("about", "About"),
            ("developer", "Developer"),
        ])
    }
}

final class RelaySettingsUITests: SettingsUITestCase {
    func testConnectedRelaySettingsUsePassiveStatusAndManagedDisconnect() throws {
        launchFixture(additionalArguments: ["--ui-test-relay-connected"])
        openSettings()

        let appleAccount = app.buttons["settings-apple-account"]
        XCTAssertTrue(appleAccount.waitForExistence(timeout: 3))
        tapCenter(of: appleAccount)
        XCTAssertTrue(app.navigationBars["Apple Account"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["settings-sign-in-with-apple"].exists)

        let manageRelay = app.buttons["settings-manage-relay"]
        XCTAssertTrue(manageRelay.waitForExistence(timeout: 3))
        XCTAssertTrue(manageRelay.label.contains("Connected to"))
        tapCenter(of: manageRelay)

        XCTAssertTrue(app.navigationBars["Talaria Relay"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://ui-test.talaria.invalid"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://removed.ui-test.invalid"].exists)
        XCTAssertFalse(app.buttons["Connect"].exists)
        let unenroll = app.buttons["Enrollment options for removed.ui-test.invalid"]
        XCTAssertTrue(unenroll.waitForExistence(timeout: 3))
        tapCenter(of: unenroll)
        XCTAssertTrue(app.buttons["This iPhone"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["All Devices"].exists)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["settings-disconnect-relay"].exists)
    }

}

final class SettingsPersonalizationUITests: SettingsUITestCase {
    func testThemeAndAppIconSelectionsShowTheirCurrentChoice() throws {
        launchFixture()
        openSettings()
        tapSettingsCategory(id: "appearance", title: "Appearance")

        let theme = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Theme"))
            .firstMatch
        XCTAssertTrue(theme.waitForExistence(timeout: 3), "Missing the Theme picker")
        XCTAssertTrue(theme.staticTexts["System"].exists, "The Theme row should show the current theme")

        tapCenter(of: theme)
        let dark = app.buttons["Dark"]
        XCTAssertTrue(dark.waitForExistence(timeout: 3), "The Theme picker did not open")
        dark.tap()
        XCTAssertTrue(
            theme.staticTexts["Dark"].waitForExistence(timeout: 3),
            "Selecting a theme did not update the row"
        )

        // Restore the shared simulator's appearance; the fixture also resets it on launch.
        tapCenter(of: theme)
        let system = app.buttons["System"]
        XCTAssertTrue(system.waitForExistence(timeout: 3))
        system.tap()
        XCTAssertTrue(theme.staticTexts["System"].waitForExistence(timeout: 3))

        let appIcon = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "App Icon"))
            .firstMatch
        for _ in 0..<8 where !appIcon.exists {
            app.swipeUp()
        }
        XCTAssertTrue(appIcon.exists, "Missing the App Icon picker")
        XCTAssertTrue(appIcon.label.contains("System"), "The App Icon row should name the current icon")
        tapCenter(of: appIcon)

        // The choices only have to be reachable and report the current selection; switching
        // the icon is a system-level change the fixture deliberately leaves alone.
        let discoChoice = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Disco."))
            .firstMatch
        XCTAssertTrue(discoChoice.waitForExistence(timeout: 3), "The App Icon choices did not expand")
        let selectedChoice = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@ AND value == %@", "System.", "Selected"))
            .firstMatch
        XCTAssertTrue(selectedChoice.exists, "The current app icon is not marked as selected")
    }
}

final class SettingsServerContentUITests: SettingsUITestCase {
    func testProvidersAndArchivedChatsLoadContentAndSurfaceFailures() throws {
        launchFixture()
        openSettings()
        openProviders()
        XCTAssertTrue(
            element(labelContaining: "Fixture Provider").waitForExistence(timeout: 10),
            "The providers list did not show the fixture provider"
        )

        returnToSettingsRoot()
        openArchivedChats()
        XCTAssertTrue(
            element(labelContaining: "Fixture Archived Session").waitForExistence(timeout: 10),
            "The archived list did not show the fixture archived session"
        )

        app.terminate()
        launchFixture(additionalArguments: ["--ui-test-read-errors"])
        openSettings()
        openProviders()
        XCTAssertTrue(
            app.staticTexts["Could not load providers"].waitForExistence(timeout: 10),
            "A failed provider load must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists, "A failed provider load needs a retry")

        returnToSettingsRoot()
        openArchivedChats()
        XCTAssertTrue(
            app.staticTexts["Could not load archived sessions"].waitForExistence(timeout: 10),
            "A failed archived load must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists, "A failed archived load needs a retry")
    }
}

/// Every workspace destination hangs off an open chat, so these launches add the
/// deterministic file/Git fixture and drive the session's own toolbar.
class WorkspaceUITestCase: TalariaUITestCase {
    override var fixtureLaunchArguments: [String] {
        super.fixtureLaunchArguments + ["--ui-test-workspace"]
    }
}

final class WorkspaceFileBrowserUITests: WorkspaceUITestCase {
    func testFileBrowserLoadsNavigatesAndSurfacesFailures() throws {
        launchFixture(additionalArguments: ["--ui-test-workspace-slow-reads"])
        openFixtureSessionChat()
        openFiles()

        XCTAssertTrue(
            app.staticTexts["Loading files..."].waitForExistence(timeout: 10),
            "Missing the file browser loading state"
        )
        XCTAssertTrue(fileRow(folder: "fixture-dir").waitForExistence(timeout: 20), "The root listing never loaded")
        XCTAssertTrue(fileRow(file: "fixture-notes.txt").exists)
        XCTAssertFalse(app.buttons["Up"].isEnabled, "The root has no parent to walk up to")
        XCTAssertFalse(app.buttons["Root"].isEnabled)

        openDirectory("fixture-dir")
        XCTAssertTrue(
            fileRow(file: "nested-note.txt").waitForExistence(timeout: 20),
            "Opening a directory did not list its entries"
        )
        XCTAssertTrue(app.buttons["Up"].isEnabled)

        tapCenter(of: app.buttons["Open Root"])
        XCTAssertTrue(
            fileRow(file: "fixture-notes.txt").waitForExistence(timeout: 20),
            "The Root breadcrumb did not return to the root"
        )

        openDirectory("fixture-dir")
        XCTAssertTrue(fileRow(file: "nested-note.txt").waitForExistence(timeout: 20))
        tapCenter(of: app.buttons["Up"])
        XCTAssertTrue(
            fileRow(file: "fixture-notes.txt").waitForExistence(timeout: 20),
            "Up did not return to the root"
        )

        app.terminate()
        launchFixture(additionalArguments: ["--ui-test-read-errors"])
        openFixtureSessionChat()
        openFiles()
        XCTAssertTrue(
            app.staticTexts["Could Not Load Files"].waitForExistence(timeout: 20),
            "A failed listing must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists)
    }
}

final class WorkspaceFilePreviewUITests: WorkspaceUITestCase {
    func testTextImageAndUnsupportedPreviewsKeepTheirOwnExportActions() throws {
        launchFixture()
        openFixtureSessionChat()
        openFiles()

        openPreview(file: "fixture-notes.txt")
        let body = app.staticTexts
            .matching(NSPredicate(format: "label CONTAINS %@", "FixtureTextPreviewBody"))
            .firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 20), "The text preview did not render its content")
        XCTAssertTrue(app.buttons["Export file"].exists, "A text file should be exportable")
        XCTAssertFalse(app.buttons["Save image to Photos"].exists, "Only images save to Photos")
        app.buttons["BackButton"].tap()

        openPreview(file: "fixture-image.png")
        XCTAssertTrue(
            app.images["fixture-image.png"].waitForExistence(timeout: 20),
            "The image preview did not render its image"
        )
        XCTAssertTrue(app.buttons["Save image to Photos"].exists)
        XCTAssertTrue(app.buttons["Export file"].exists)
        app.buttons["BackButton"].tap()

        openPreview(file: "fixture-archive.zip")
        XCTAssertTrue(app.staticTexts["No Preview"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Preview is not available for this file type."].exists)
        XCTAssertFalse(app.buttons["Save image to Photos"].exists, "An archive is not an image")
        app.buttons["BackButton"].tap()

        app.terminate()
        launchFixture(additionalArguments: ["--ui-test-file-read-errors"])
        openFixtureSessionChat()
        openFiles()
        openPreview(file: "fixture-notes.txt")
        XCTAssertTrue(
            app.staticTexts["Could Not Load File"].waitForExistence(timeout: 20),
            "A failed preview must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists)
    }
}

/// A chat link that names a workspace file opens the source viewer at its line (TAL-169).
final class ChatWorkspaceFileLinkUITests: WorkspaceUITestCase {
    func testTappingAWorkspaceFileLinkOpensTheSourceViewerAtItsLine() throws {
        launchFixture()
        openFixtureSessionChat()

        let link = app.links["FixtureFileLink"]
        XCTAssertTrue(link.waitForExistence(timeout: 15), "Missing the fixture's workspace file link")
        tapCenter(of: link)

        XCTAssertTrue(
            app.navigationBars["fixture-notes.txt"].waitForExistence(timeout: 15),
            "The file link did not open the source viewer"
        )
        let secondLine = app.staticTexts["Second deterministic line."]
        XCTAssertTrue(secondLine.waitForExistence(timeout: 20), "The viewer did not render the linked file")
        XCTAssertTrue(app.staticTexts["Line 2"].exists, "The viewer should number its rows")
        XCTAssertTrue(app.buttons["Enable code line wrapping"].exists, "Source files offer a wrap toggle")
        XCTAssertTrue(app.buttons["Export file"].exists, "The linked file keeps the preview's export action")

        app.buttons["Done"].tap()
        XCTAssertTrue(waitForComposer(timeout: 10) != nil, "Dismissing the viewer should return to the chat")
    }
}

final class GitWorkspaceUITests: WorkspaceUITestCase {
    func testChangesSheetLoadsFixtureStatusAndSurfacesFailure() throws {
        launchFixture(additionalArguments: ["--ui-test-workspace-slow-reads"])
        openFixtureSessionChat()
        openGitActions()

        let changes = app.buttons
            .matching(NSPredicate(format: "label BEGINSWITH %@", "+"))
            .firstMatch
        XCTAssertTrue(changes.waitForExistence(timeout: 25), "The Git status never reached the actions menu")
        changes.tap()

        XCTAssertTrue(
            app.staticTexts["Loading…"].waitForExistence(timeout: 10),
            "Missing the Git changes loading state"
        )
        XCTAssertTrue(
            app.staticTexts["2 files changed"].waitForExistence(timeout: 25),
            "The changes sheet did not show the fixture status"
        )
        XCTAssertTrue(gitFileCard(named: "fixture-notes.txt").exists)
        XCTAssertTrue(gitFileCard(named: "nested-note.txt").exists)
        app.buttons["Done"].tap()

        app.terminate()
        launchFixture(additionalArguments: ["--ui-test-read-errors"])
        openFixtureSessionChat()
        openGitActions()
        let unavailable = app.buttons["Changes unavailable"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 25), "A failed status must still open the sheet")
        unavailable.tap()
        XCTAssertTrue(
            app.staticTexts["Could Not Load Changes"].waitForExistence(timeout: 20),
            "A failed status must be visible"
        )
        XCTAssertTrue(app.buttons["Try Again"].exists)
    }
}

final class GitRemoteActionUITests: WorkspaceUITestCase {
    func testPushNeedsConfirmationAndTheFixtureWriteCapability() throws {
        launchFixture()
        openFixtureSessionChat()

        openGitActions()
        tapGitMenuPush()
        let confirmation = app.alerts["Push Local Commits?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10), "Push must ask before contacting the remote")
        confirmation.buttons["Cancel"].tap()
        XCTAssertFalse(
            app.staticTexts["Push complete"].waitForExistence(timeout: 3),
            "Cancelling the confirmation must not push"
        )
        XCTAssertFalse(app.alerts["Git Action Failed"].exists)

        openGitActions()
        tapGitMenuPush()
        XCTAssertTrue(app.alerts["Push Local Commits?"].waitForExistence(timeout: 10))
        app.alerts["Push Local Commits?"].buttons["Push"].tap()
        let failure = app.alerts["Git Action Failed"]
        XCTAssertTrue(
            failure.waitForExistence(timeout: 20),
            "Without the fixture write capability a push must fail visibly"
        )
        XCTAssertTrue(failure.staticTexts["Fixture git writes are disabled."].exists)
        failure.buttons["OK"].tap()

        app.terminate()
        launchFixture(additionalArguments: ["--ui-test-git-writes"])
        openFixtureSessionChat()
        openGitActions()
        tapGitMenuPush()
        XCTAssertTrue(app.alerts["Push Local Commits?"].waitForExistence(timeout: 10))
        app.alerts["Push Local Commits?"].buttons["Push"].tap()
        XCTAssertTrue(
            app.staticTexts["Push complete"].waitForExistence(timeout: 25),
            "The granted fixture capability should complete the push"
        )
    }
}

class QuotaWidgetUITestCase: TalariaUITestCase {}

final class QuotaInsightsUITests: QuotaWidgetUITestCase {
    func testInsightsShowsQuotaSurface() throws {
        launchFixture(additionalArguments: ["--provider-quotas"])

        XCTAssertTrue(app.staticTexts["Provider quotas"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Refresh all provider quotas"].exists)
        XCTAssertTrue(app.buttons["Open provider quota settings"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["provider-quota-section"].exists)
        let quotaSource = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "provider-quota-source-"))
            .firstMatch
        XCTAssertTrue(quotaSource.waitForExistence(timeout: 10), "Expected at least one rendered quota source")
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
                    .waitForExistence(timeout: 3),
                "Expected warning details after tapping the warning button"
            )
        }
    }

    func testProviderQuotaWidgetFixturePreparesPreview() throws {
        launchFixture(additionalArguments: ["--provider-quota-widget-fixture"])

        XCTAssertTrue(app.staticTexts["Widget fixture ready"].waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts["Add or edit the Talaria Provider quotas widget to inspect its configured states."].exists
        )
    }
}

final class QuotaCustomizationUITests: QuotaWidgetUITestCase {
    func testWidgetCustomizationShowsSharedAndDenseLayouts() throws {
        launch(arguments: ["--provider-quota-widget-customization"])

        XCTAssertTrue(app.navigationBars["Customization"].waitForExistence(timeout: 10))
        assertPreviewVisible(identifier: "provider-quota-widget-bars")
        app.buttons["Lock %"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["provider-quota-lock-percentage"]
                .waitForExistence(timeout: 3)
        )

        app.buttons["Lock Pace"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["provider-quota-lock-pace"]
                .waitForExistence(timeout: 3)
        )

        app.buttons["Home"].tap()
        app.buttons["Medium"].tap()
        app.buttons["2"].tap()
        XCTAssertTrue(app.buttons["2"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-bars")

        app.buttons["Large"].tap()
        assertPreviewVisible(identifier: "provider-quota-widget-forecast")
        let twoProviders = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        twoProviders.name = "Detailed two-provider large quota widget preview"
        twoProviders.lifetime = .keepAlways
        add(twoProviders)

        app.buttons["1"].tap()
        XCTAssertTrue(app.buttons["1"].isSelected)
        app.buttons["1W"].tap()
        XCTAssertTrue(app.buttons["1W"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-classic")
        assertPreviewVisible(identifier: "provider-quota-widget-forecast")
        let oneWindow = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        oneWindow.name = "Expanded one-window large quota widget preview"
        oneWindow.lifetime = .keepAlways
        add(oneWindow)

        app.buttons["2W"].tap()
        XCTAssertTrue(app.buttons["2W"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-classic")
        assertPreviewVisible(identifier: "provider-quota-widget-forecast")
        let twoWindows = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        twoWindows.name = "Detailed two-window large quota widget preview"
        twoWindows.lifetime = .keepAlways
        add(twoWindows)

        app.buttons["3W"].tap()
        XCTAssertTrue(app.buttons["3W"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-classic")
        assertPreviewVisible(identifier: "provider-quota-widget-forecast")

        app.buttons["3"].tap()
        XCTAssertTrue(app.buttons["3"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-bars")

        app.buttons["4"].tap()
        XCTAssertTrue(app.buttons["4"].isSelected)
        assertPreviewVisible(identifier: "provider-quota-widget-bars")
        let bars = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        bars.name = "Bar four-source large quota widget preview"
        bars.lifetime = .keepAlways
        add(bars)
    }

}

class SidebarUITestCase: TalariaUITestCase {}

final class SidebarPresentationUITests: SidebarUITestCase {
    func testSidebarPresentationAndAccessibility() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

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
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertTrue(closeNavigation.waitForExistence(timeout: 3))
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
        XCTAssertTrue(mainSurface.waitForExistence(timeout: 3))
        XCTAssertEqual(mainSurface.frame.minX, app.frame.minX, accuracy: 1)
        XCTAssertEqual(navigationTitle.frame.minX, initialTitleFrame.minX, accuracy: 1)
        XCTAssertFalse(sidebar.isHittable)
    }
}

final class SidebarInteractionUITests: SidebarUITestCase {
    func testSidebarNewChatOpensExistingComposer() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        openNavigation.tap()
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        let newChat = sidebar.buttons["New Chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 3))
        newChat.tap()

        XCTAssertTrue(app.buttons["Composer options"].waitForExistence(timeout: 15))
        XCTAssertFalse(sidebar.isHittable)
    }

    func testFullyOpenSidebarClosesWithSlowDiagonalSwipe() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        openNavigation.tap()
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertTrue(closeNavigation.waitForExistence(timeout: 3))
        let mainSurface = app.descendants(matching: .any)["app-main-surface"]
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45))
            .press(
                forDuration: 0.2,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.57)),
                withVelocity: 100,
                thenHoldForDuration: 0.1
            )

        XCTAssertTrue(mainSurface.waitForExistence(timeout: 3))
        XCTAssertEqual(mainSurface.frame.minX, app.frame.minX, accuracy: 1)
    }
}

final class SidebarPerformanceUITests: SidebarUITestCase {
    @available(iOS 26.0, *)
    func testSidebarCloseHitchPerformance() throws {
        launchFixture()
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

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
            XCTAssertTrue(closeNavigation.waitForExistence(timeout: 3))

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

            XCTAssertTrue(mainSurface.waitForExistence(timeout: 3))
            XCTAssertEqual(mainSurface.frame.minX, app.frame.minX, accuracy: 1)
        }
    }

}

class AdaptiveLayoutUITestCase: TalariaUITestCase {
    struct Variant {
        let name: String
        let arguments: [String]
        let orientation: UIDeviceOrientation
        var reduceMotion = false
        var isRightToLeft: Bool { arguments.contains("-AppleTextDirection") }
    }

    /// One launch per variant; each launch walks every representative screen. Settings
    /// are bundled so the matrix stays at three launches instead of screens × settings.
    /// Every variant pins its text size so a reused simulator cannot leak one in.
    static let variants = [
        Variant(
            name: "portrait light",
            arguments: ["-appTheme", "light", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"],
            orientation: .portrait
        ),
        Variant(
            name: "portrait dark RTL AXXXL",
            arguments: [
                "-appTheme", "dark",
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                "-AppleTextDirection", "YES",
                "-NSForceRightToLeftWritingDirection", "YES",
            ],
            orientation: .portrait
        ),
        Variant(
            name: "landscape dark reduce-motion",
            arguments: ["-appTheme", "dark", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"],
            orientation: .landscapeLeft,
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

final class AdaptiveLayoutAppUITests: AdaptiveLayoutUITestCase {
    func testCoreScreensPassAccessibilityAuditsAcrossVariants() throws {
        for variant in Self.variants {
            try XCTContext.runActivity(named: variant.name) { _ in
                launchFixture(variant: variant)
                let openNavigation = app.buttons["Open navigation"]
                XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")
                XCTAssertTrue(fixtureSessionButton.waitForExistence(timeout: 15), "Missing deterministic session fixture")
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
                if !firstCategory.waitForExistence(timeout: 3) {
                    for _ in 0..<10 where !firstCategory.exists {
                        scrollSettingsRoot(up: true)
                    }
                }
                XCTAssertTrue(firstCategory.waitForExistence(timeout: 3), "Settings categories missing [\(variant.name)]")
                try audit("Settings root", variant: variant)

                tapSettingsCategory(id: "servers", title: "Servers")
                let addServer = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label BEGINSWITH %@", "Add Server"))
                    .firstMatch
                XCTAssertTrue(addServer.waitForExistence(timeout: 3), "Add Server row missing [\(variant.name)]")
                for _ in 0..<6 where addServer.frame.maxY > app.frame.maxY {
                    app.swipeUp()
                }
                let serverRow = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS %@", "ui-test.talaria.invalid"))
                    .firstMatch
                XCTAssertTrue(serverRow.exists, "Fixture server row missing [\(variant.name)]")
                let coveredRowCenter = serverRow.frame.center
                tap(at: addServer.frame.center)
                let editor = app.navigationBars["Add Server"]
                XCTAssertTrue(editor.waitForExistence(timeout: 5), "Add Server editor missing [\(variant.name)]")
                try audit("Add Server editor", variant: variant)
                // Modal isolation: a tap where the server row sits must not reach it.
                tap(at: coveredRowCenter)
                XCTAssertTrue(editor.exists, "Editor dismissed by a tap behind it [\(variant.name)]")
                editor.buttons["Cancel"].tap()
                XCTAssertTrue(editor.waitForNonExistence(timeout: 5), "Editor did not dismiss [\(variant.name)]")
                XCTAssertTrue(
                    app.navigationBars["Servers"].exists && addServer.waitForExistence(timeout: 3),
                    "Dismissing the editor must return to its launching screen [\(variant.name)]"
                )

                app.navigationBars["Servers"].buttons["Settings"].tap()
                XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
                openSidebarDestination("Kanban")
                XCTAssertTrue(app.navigationBars["Kanban"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.staticTexts["Loading Kanban"].waitForNonExistence(timeout: 15))
                XCTAssertTrue(
                    app.descendants(matching: .any)["KanbanStatusSelector"].waitForExistence(timeout: 5),
                    "Kanban Board did not load [\(variant.name)]"
                )
                try audit("Kanban board", variant: variant)
                app.terminate()
            }
        }
    }
}

final class KanbanBoardPickerUITests: AdaptiveLayoutUITestCase {
    /// The fixture's current Board carries a long localized name, so every variant renders
    /// the case that used to drop the Board picker out of the navigation bar entirely.
    func testBoardPickerAndToolbarActionsStayReachableAcrossVariants() throws {
        for variant in Self.variants {
            try XCTContext.runActivity(named: variant.name) { _ in
                launchFixture(variant: variant)
                XCTAssertTrue(
                    app.buttons["Open navigation"].waitForExistence(timeout: 15),
                    "Missing deterministic app fixture [\(variant.name)]"
                )
                openSidebarDestination("Kanban")
                let bar = app.navigationBars["Kanban"]
                XCTAssertTrue(bar.waitForExistence(timeout: 5), "Kanban bar missing [\(variant.name)]")
                XCTAssertTrue(app.staticTexts["Loading Kanban"].waitForNonExistence(timeout: 15))
                XCTAssertTrue(
                    app.descendants(matching: .any)["KanbanStatusSelector"].waitForExistence(timeout: 5),
                    "Kanban Board did not load [\(variant.name)]"
                )

                let picker = app.descendants(matching: .any)["KanbanBoardPicker"].firstMatch
                XCTAssertTrue(picker.waitForExistence(timeout: 5), "Board picker missing [\(variant.name)]")
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
                app.terminate()
            }
        }
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
        XCTAssertTrue(filters.waitForExistence(timeout: 3), "Card Filters unreachable [\(variant.name)]")
        let selectCards = usesOverflow ? app.buttons["Select Cards"].firstMatch : bar.buttons["Select Cards"]
        XCTAssertTrue(selectCards.exists, "Select Cards unreachable [\(variant.name)]")
        XCTAssertTrue(selectCards.isEnabled, "Select Cards disabled in the fixture Board [\(variant.name)]")
        tap(at: selectCards.frame.center)

        let cancel = secondaryAction("Cancel")
        XCTAssertTrue(
            cancel.waitForExistence(timeout: 3),
            "Selection mode did not survive the toolbar placement [\(variant.name)]"
        )
        tap(at: cancel.frame.center)
    }

    private func assertBoardMenuSelectsAnotherBoard(picker: XCUIElement, variant: Variant) {
        tap(at: picker.frame.center)
        let otherBoard = app.buttons["Fixture Board"].firstMatch
        XCTAssertTrue(otherBoard.waitForExistence(timeout: 3), "Board menu did not open [\(variant.name)]")
        otherBoard.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["KanbanBoardPicker"].firstMatch.waitForExistence(timeout: 5),
            "Board picker lost after selecting a Board [\(variant.name)]"
        )
    }
}

final class AdaptiveLayoutOnboardingUITests: AdaptiveLayoutUITestCase {
    func testOnboardingScalesTitleAndRetainsFocusAcrossVariants() throws {
        var titleHeights: [String: CGFloat] = [:]
        for variant in Self.variants {
            try XCTContext.runActivity(named: variant.name) { _ in
                launchFixture(variant: variant, additionalArguments: ["--ui-test-onboarding"])
                let getStarted = app.buttons["Get Started"]
                XCTAssertTrue(getStarted.waitForExistence(timeout: 15), "Missing onboarding fixture [\(variant.name)]")
                try audit("Onboarding welcome", variant: variant)
                // The welcome page scrolls once its text outgrows the page, so every
                // line and badge must clear the bottom bar after scrolling.
                let subtitle = app.staticTexts["Connect to your self-hosted Web UI over Tailscale."]
                let lastBadge = element(label: "Tailscale ready")
                let pageIndicator = element(label: "Page 1 of 5")
                XCTAssertTrue(pageIndicator.exists && lastBadge.exists, "Welcome page parts missing [\(variant.name)]")
                for _ in 0..<6 where lastBadge.frame.maxY > pageIndicator.frame.minY {
                    app.swipeUp()
                }
                XCTAssertLessThanOrEqual(subtitle.frame.maxY, pageIndicator.frame.minY, "Subtitle under bottom bar [\(variant.name)]")
                XCTAssertLessThanOrEqual(lastBadge.frame.maxY, pageIndicator.frame.minY, "Badges under bottom bar [\(variant.name)]")
                getStarted.tap()
                let setUp = app.buttons["Set Up"]
                XCTAssertTrue(setUp.waitForExistence(timeout: 5), "Features page missing [\(variant.name)]")
                setUp.tap()

                let step = app.staticTexts["STEP 1"]
                let title = app.staticTexts["Set up Hermes Web UI"]
                let description = app.staticTexts
                    .matching(NSPredicate(format: "label BEGINSWITH %@", "Send this prompt"))
                    .firstMatch
                XCTAssertTrue(title.waitForExistence(timeout: 5), "Step title missing [\(variant.name)]")
                XCTAssertTrue(step.exists && description.exists, "Step header parts missing [\(variant.name)]")
                XCTAssertGreaterThanOrEqual(title.frame.minX, app.frame.minX, "Title clipped [\(variant.name)]")
                XCTAssertLessThanOrEqual(title.frame.maxX, app.frame.maxX, "Title clipped [\(variant.name)]")
                XCTAssertLessThanOrEqual(step.frame.maxY, title.frame.minY + 1, "Title overlaps step label [\(variant.name)]")
                XCTAssertLessThanOrEqual(title.frame.maxY, description.frame.minY + 1, "Title overlaps description [\(variant.name)]")
                titleHeights[variant.name] = title.frame.height
                try audit("Onboarding step", variant: variant)

                app.buttons["Already have a server?"].tap()
                let continueAnyway = app.buttons["Continue Anyway"]
                XCTAssertTrue(continueAnyway.waitForExistence(timeout: 3), "Copy reminder missing [\(variant.name)]")
                continueAnyway.tap()
                XCTAssertTrue(app.staticTexts["STEP 2"].waitForExistence(timeout: 5), "Tailscale step missing [\(variant.name)]")
                app.buttons["Already have a server?"].tap()
                let serverField = app.textFields.firstMatch
                XCTAssertTrue(serverField.waitForExistence(timeout: 5), "Server URL field missing [\(variant.name)]")
                try audit("Onboarding connect", variant: variant)
                // Focus retention: the audit walks the page, so focus the field only afterwards.
                serverField.tap()
                XCTAssertTrue(hasKeyboardFocus(serverField), "Server field did not take focus [\(variant.name)]")
                XCUIDevice.shared.orientation = variant.orientation == .portrait ? .landscapeLeft : .portrait
                // iOS 27 usually resets the page-style TabView to the welcome page when the
                // device rotates with the keyboard up (TAL-201); not strict, because some
                // variants survive. Remove with that fix. Only the reset is expected: a
                // surviving field must still keep focus, and reading focus on a missing
                // field would interrupt the test before the remaining variants.
                let pagerReset = XCTExpectedFailure.Options()
                pagerReset.isEnabled = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27
                pagerReset.isStrict = false
                let fieldSurvived = serverField.waitForExistence(timeout: 5)
                XCTExpectFailure("TAL-201: iOS 27 pager resets on rotation", options: pagerReset) {
                    XCTAssertTrue(fieldSurvived, "Server URL field lost on rotation [\(variant.name)]")
                }
                if fieldSurvived {
                    XCTAssertTrue(hasKeyboardFocus(serverField), "Rotation dropped field focus [\(variant.name)]")
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

class TalariaUITestCase: XCTestCase {
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
}

fileprivate extension ChatUITestCase {
    func openFixtureSession() throws -> XCUIElement {
        if let composer = waitForComposer(timeout: 3) {
            return composer
        }

        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")
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
        if !input.waitForExistence(timeout: 2) {
            composer.tap()
            XCTAssertTrue(input.waitForExistence(timeout: 5))
        }
        input.typeText(message)
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
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
        var last = element.frame
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.3)
            let next = element.frame
            if next == last { return next }
            last = next
        }
        return last
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
        app.buttons["Open navigation"].tap()
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        sidebar.descendants(matching: .any)[destination].firstMatch.tap()
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
    func assertSettingsCategoryRoutes(_ categories: [(id: String, title: String)]) {
        launchFixture()
        openSettings()
        for category in categories {
            tapSettingsCategory(id: category.id, title: category.title)
            app.navigationBars[category.title].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        }
    }

    func openSettings() {
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")
        openNavigation.tap()

        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        sidebar.descendants(matching: .any)["Settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        let sidebarHidden = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == false"),
            object: sidebar
        )
        XCTAssertEqual(XCTWaiter.wait(for: [sidebarHidden], timeout: 3), .completed)
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
    /// where they are drawn instead. A missing element has a zero frame, which would tap the
    /// screen corner; the assertions keep that from passing as a silent stray tap.
    func tapCenter(of element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 5), "Missing tap target")
        let frame = element.frame
        XCTAssertTrue(frame.width > 0 && frame.height > 0, "Tap target has no frame")
        app.coordinate(withNormalizedOffset: CGVector(
            dx: frame.midX / app.frame.width,
            dy: frame.midY / app.frame.height
        )).tap()
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
        for _ in 0..<12 where !row.exists || row.frame.maxY > app.frame.maxY {
            app.swipeUp()
        }
        XCTAssertTrue(row.exists, "Missing settings row: \(label)")
        tapCenter(of: row)
    }

    func tapSettingsCategory(id: String, title: String) {
        let category = app.buttons["settings-category-\(id)"]
        for _ in 0..<10 where !category.exists {
            scrollSettingsRoot(up: true)
        }
        XCTAssertTrue(category.waitForExistence(timeout: 3), "Missing Settings category: \(title)")
        let viewportTop = app.navigationBars["Settings"].frame.maxY
        for _ in 0..<10
            where category.frame.minY < viewportTop || category.frame.maxY > app.frame.maxY {
            scrollSettingsRoot(up: category.frame.maxY > app.frame.maxY)
        }
        let visibleTop = max(category.frame.minY, viewportTop)
        let visibleBottom = min(category.frame.maxY, app.frame.maxY)
        XCTAssertGreaterThan(visibleBottom - visibleTop, 20)
        app.coordinate(withNormalizedOffset: CGVector(
            dx: category.frame.midX / app.frame.width,
            dy: ((visibleTop + visibleBottom) / 2) / app.frame.height
        )).tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 3))
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

    func tapFixtureSession(_ session: XCUIElement) {
        let sessionList = app.collectionViews.firstMatch
        let viewportTop = app.navigationBars["Chats"].frame.maxY
        let searchControl = waitForSessionSearchControl(timeout: 5)
        XCTAssertNotNil(searchControl, "Missing the session search control")
        let viewportBottom = searchControl?.frame.minY ?? 0

        for _ in 0..<12 {
            if session.exists,
               session.frame.minY >= viewportTop,
               session.frame.maxY <= viewportBottom {
                break
            }

            let scrollingUp = session.exists && session.frame.maxY > viewportBottom
            let startY = scrollingUp ? 0.65 : 0.55
            let endY = scrollingUp ? 0.55 : 0.65
            sessionList.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
                .press(
                    forDuration: 0.05,
                    thenDragTo: sessionList.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: endY)
                    )
                )
        }

        XCTAssertTrue(session.exists)
        XCTAssertGreaterThanOrEqual(session.frame.minY, viewportTop)
        XCTAssertLessThanOrEqual(session.frame.maxY, viewportBottom)
        session.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
}

fileprivate extension QuotaWidgetUITestCase {
    func assertPreviewVisible(identifier: String) {
        XCTAssertTrue(
            app.descendants(matching: .any)[identifier].waitForExistence(timeout: 3)
        )
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

            // Contrast is unreliable over blurred glass surfaces; the text-clipping audit
            // predicts from `lineLimit` instead of measuring the rendered variant; element
            // detection scans pixels and names no element to fix.
            var issues: [String] = []
            var unlocated: [String] = []
            let auditTypes: XCUIAccessibilityAuditType = .all.subtracting([.contrast, .textClipped, .elementDetection])
            try app.performAccessibilityAudit(for: auditTypes) { issue in
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

    /// Settings rows report `isHittable == false` to XCUI even when visible; tap by point.
    func tap(at point: CGPoint) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y)).tap()
    }

    func hasKeyboardFocus(_ element: XCUIElement) -> Bool {
        element.value(forKey: "hasKeyboardFocus") as? Bool ?? false
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}

fileprivate extension SettingsUITestCase {
    func openProviders() {
        tapSettingsCategory(id: "providers", title: "Providers")
        tapSettingsRow(label: "Providers")
    }

    /// Walks back out of a nested Settings destination to the category root.
    func returnToSettingsRoot() {
        let root = app.navigationBars["Settings"]
        for _ in 0..<3 where !root.exists {
            app.buttons["BackButton"].tap()
            _ = root.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(root.exists, "Did not return to the Settings root")
    }

    func openArchivedChats() {
        tapSettingsCategory(id: "chats", title: "Chats")
        tapSettingsRow(label: "Archived Chats")
        XCTAssertTrue(app.navigationBars["Archived Chats"].waitForExistence(timeout: 5))
    }
}

fileprivate extension WorkspaceUITestCase {
    func openFixtureSessionChat() {
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")
        tapFixtureSession(session)
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")
    }

    func openFiles() {
        let files = app.buttons["Files"]
        XCTAssertTrue(files.waitForExistence(timeout: 15), "Missing the Files toolbar button")
        files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 10), "The file browser did not open")
    }

    func openGitActions() {
        let git = app.buttons["Git actions"]
        XCTAssertTrue(git.waitForExistence(timeout: 25), "Missing the Git actions toolbar button")
        git.tap()
    }

    func tapGitMenuPush() {
        let push = app.buttons["Push"]
        XCTAssertTrue(push.waitForExistence(timeout: 5), "Missing the Push action")
        push.tap()
    }

    func openDirectory(_ name: String) {
        let row = fileRow(folder: name)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "Missing directory row: \(name)")
        tapCenter(of: row)
    }

    func openPreview(file name: String) {
        let row = fileRow(file: name)
        XCTAssertTrue(row.waitForExistence(timeout: 20), "Missing file row: \(name)")
        tapCenter(of: row)
        XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 10), "The preview did not open: \(name)")
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
