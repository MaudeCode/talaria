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

final class ChatPrimaryStreamUITests: ChatUITestCase {
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
        XCTAssertTrue(app.staticTexts["Waiting for control input."].exists)
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
        XCTAssertTrue(app.descendants(matching: .any)["settings-apple-account"].exists)
        XCTAssertTrue(app.buttons["settings-sign-in-with-apple"].exists)
        for categoryID in ["appearance", "notificationsAndHaptics", "chats"] {
            XCTAssertTrue(app.buttons["settings-category-\(categoryID)"].exists)
        }
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

        let profile = app.buttons["settings-user-profile"]
        app.coordinate(withNormalizedOffset: CGVector(
            dx: profile.frame.midX / app.frame.width,
            dy: profile.frame.midY / app.frame.height
        )).tap()
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

        XCTAssertFalse(app.buttons["settings-sign-in-with-apple"].exists)

        let manageRelay = app.buttons["settings-manage-relay"]
        XCTAssertTrue(manageRelay.waitForExistence(timeout: 3))
        XCTAssertTrue(manageRelay.label.contains("Connected to"))
        app.coordinate(withNormalizedOffset: CGVector(
            dx: manageRelay.frame.midX / app.frame.width,
            dy: manageRelay.frame.midY / app.frame.height
        )).tap()

        XCTAssertTrue(app.navigationBars["Talaria Relay"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://ui-test.talaria.invalid"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-relay-server-https://removed.ui-test.invalid"].exists)
        XCTAssertFalse(app.buttons["Connect"].exists)
        let unenroll = app.buttons["Enrollment options for removed.ui-test.invalid"]
        XCTAssertTrue(unenroll.waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(
            dx: unenroll.frame.midX / app.frame.width,
            dy: unenroll.frame.midY / app.frame.height
        )).tap()
        XCTAssertTrue(app.buttons["This iPhone"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["All Devices"].exists)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["settings-disconnect-relay"].exists)
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
    static let variants = [
        Variant(name: "portrait light", arguments: ["-appTheme", "light"], orientation: .portrait),
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
            arguments: ["-appTheme", "dark"],
            orientation: .landscapeLeft,
            reduceMotion: true
        ),
    ]

    override func setUpWithError() throws {
        try super.setUpWithError()
        // Audits are plain assertions, so one run reports every screen and variant.
        continueAfterFailure = true
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        Self.setReduceMotion(false)
        try super.tearDownWithError()
    }

    /// The simulator's Reduce Motion switch has no launch-argument seam, so the runner
    /// writes the system accessibility preference the app reads at launch.
    static func setReduceMotion(_ enabled: Bool) {
        let domain = "com.apple.Accessibility" as CFString
        CFPreferencesSetValue(
            "ReduceMotionEnabled" as CFString,
            enabled ? kCFBooleanTrue : kCFBooleanFalse,
            domain,
            kCFPreferencesCurrentUser,
            kCFPreferencesAnyHost
        )
        CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
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
                let firstCategory = app.buttons["settings-category-appearance"]
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

final class AdaptiveLayoutOnboardingUITests: AdaptiveLayoutUITestCase {
    func testOnboardingScalesTitleAndRetainsFocusAcrossVariants() throws {
        var titleHeights: [String: CGFloat] = [:]
        for variant in Self.variants {
            try XCTContext.runActivity(named: variant.name) { _ in
                launchFixture(variant: variant, additionalArguments: ["--ui-test-onboarding"])
                let getStarted = app.buttons["Get Started"]
                XCTAssertTrue(getStarted.waitForExistence(timeout: 15), "Missing onboarding fixture [\(variant.name)]")
                try audit("Onboarding welcome", variant: variant)
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
                serverField.tap()
                XCTAssertTrue(hasKeyboardFocus(serverField), "Server field did not take focus [\(variant.name)]")
                XCUIDevice.shared.orientation = variant.orientation == .portrait ? .landscapeLeft : .portrait
                XCTAssertTrue(serverField.waitForExistence(timeout: 5), "Server URL field lost on rotation [\(variant.name)]")
                XCTAssertTrue(hasKeyboardFocus(serverField), "Rotation dropped field focus [\(variant.name)]")
                try audit("Onboarding connect", variant: variant)
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
    fileprivate var app: XCUIApplication!

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

    fileprivate func launch(arguments: [String]) {
        app.launchArguments = arguments
        app.launch()
    }

    fileprivate func launchFixture(additionalArguments: [String] = []) {
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

    func countElements(label: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).count
    }

    func countElements(containing text: String) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).count
    }

    func tapCenter(of element: XCUIElement) {
        app.coordinate(withNormalizedOffset: CGVector(
            dx: element.frame.midX / app.frame.width,
            dy: element.frame.midY / app.frame.height
        )).tap()
    }
}

fileprivate extension TalariaUITestCase {
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
        let viewportBottom = app.searchFields["Search sessions"].frame.minY

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
        Self.setReduceMotion(variant.reduceMotion)
        launchFixture(additionalArguments: variant.arguments + additionalArguments)
        if variant.reduceMotion {
            XCTAssertTrue(
                UIAccessibility.isReduceMotionEnabled,
                "Reduce Motion preference did not apply [\(variant.name)]"
            )
        }
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
            let auditTypes: XCUIAccessibilityAuditType = .all.subtracting([.contrast, .textClipped, .elementDetection])
            try app.performAccessibilityAudit(for: auditTypes) { issue in
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
            XCTAssertTrue(
                issues.isEmpty,
                "Accessibility audit failed on \(screen) [\(variant.name)]:\n" + issues.joined(separator: "\n")
            )
        }
    }

    func openSidebarDestination(_ destination: String) {
        app.buttons["Open navigation"].tap()
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        sidebar.descendants(matching: .any)[destination].firstMatch.tap()
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
