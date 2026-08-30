import XCTest
import UIKit

final class ComposerNavigationUITests: XCTestCase {
    private let fixtureSessionTitle = "UI Fixture Session"
    private var app: XCUIApplication!

    private var fixtureLaunchArguments: [String] {
        ["--ui-test-fixture"]
    }

    private var fixtureSessionButton: XCUIElement {
        app.buttons.containing(.staticText, identifier: fixtureSessionTitle).firstMatch
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = fixtureLaunchArguments
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    func testChatListScrolls() throws {
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
        let session = fixtureSessionButton
        XCTAssertTrue(session.waitForExistence(timeout: 15), "Missing deterministic session fixture")

        tapFixtureSession(session)
        XCTAssertTrue(waitForComposer(timeout: 15) != nil)
    }

    func testComposerCollapsesAndExpandsWithoutBottomNavigation() throws {
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

    func testComposerSettingsAreGroupedAndConfigurable() throws {
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

    func testSettingsRootContainsCategoriesInsteadOfLeafControls() throws {
        openSettings()

        XCTAssertTrue(app.buttons["settings-user-profile"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-apple-account"].exists)
        XCTAssertTrue(app.buttons["settings-sign-in-with-apple"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Haptic Feedback"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Default Model"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["Clear Offline Cache"].exists)
        let rootScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        rootScreenshot.name = "Settings category root"
        rootScreenshot.lifetime = .keepAlways
        add(rootScreenshot)

        for category in [
            ("appearance", "Appearance"),
            ("notificationsAndHaptics", "Notifications & Haptics"),
            ("chats", "Chats"),
            ("liveActivitiesAndWidgets", "Live Activities & Widgets"),
            ("siriAndShortcuts", "Siri & Shortcuts"),
            ("servers", "Servers"),
            ("providers", "Providers"),
            ("dataAndStorage", "Data & Storage"),
            ("about", "About"),
            ("developer", "Developer"),
        ] {
            tapSettingsCategory(id: category.0, title: category.1)
            app.navigationBars[category.1].buttons["Settings"].tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 3))
        }
    }

    func testSettingsTaxonomyKeepsMovedControlsWithTheirOwners() throws {
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

    func testConnectedRelaySettingsUsePassiveStatusAndManagedDisconnect() throws {
        app.terminate()
        app.launchArguments = fixtureLaunchArguments + ["--ui-test-relay-connected"]
        app.launch()
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

    func testInsightsShowsQuotaSurface() throws {
        app.terminate()
        app.launchArguments = fixtureLaunchArguments + ["--provider-quotas"]
        app.launch()

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
        app.terminate()
        app.launchArguments = fixtureLaunchArguments + ["--provider-quota-widget-fixture"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Widget fixture ready"].waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.staticTexts["Add or edit the Talaria Provider quotas widget to inspect its configured states."].exists
        )
    }

    func testWidgetCustomizationShowsSharedLockScreenPreviews() throws {
        app.terminate()
        app.launchArguments = fixtureLaunchArguments + ["--provider-quota-widget-customization"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Customization"].waitForExistence(timeout: 10))
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
    }

    func testWidgetCustomizationShowsDenseLargeQuotaLayouts() throws {
        app.terminate()
        app.launchArguments = ["--provider-quota-widget-customization"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Customization"].waitForExistence(timeout: 10))
        assertPreviewVisible(identifier: "provider-quota-widget-bars")

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

    func testSidebarReplacesRootTabs() throws {
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
        XCTAssertFalse(app.buttons["Pin"].exists)
        for destination in ["Chats", "Tasks", "Kanban", "Skills", "Memory", "Insights", "Settings"] {
            XCTAssertTrue(
                sidebar.descendants(matching: .any)[destination].exists,
                "Missing sidebar destination: \(destination)"
            )
        }

        closeNavigation.tap()
        XCTAssertTrue(mainSurface.waitForExistence(timeout: 3))
        XCTAssertEqual(mainSurface.frame.minX, app.frame.minX, accuracy: 1)
        XCTAssertEqual(navigationTitle.frame.minX, initialTitleFrame.minX, accuracy: 1)
        XCTAssertFalse(sidebar.isHittable)
    }

    func testSidebarSurfaceExtendsThroughSafeAreas() throws {
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        openNavigation.tap()
        XCTAssertTrue(app.buttons["Close navigation"].waitForExistence(timeout: 3))

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
    }

    func testSidebarIsAccessibilityModalUntilClosed() throws {
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        let mainSurface = app.descendants(matching: .any)["app-main-surface"]
        XCTAssertTrue(mainSurface.exists)
        openNavigation.tap()

        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        XCTAssertEqual(sidebar.elementType, .alert)
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertTrue(closeNavigation.waitForExistence(timeout: 3))

        closeNavigation.tap()
        XCTAssertTrue(mainSurface.waitForExistence(timeout: 3))
        XCTAssertTrue(openNavigation.exists)
    }

    func testSidebarHeaderRespectsTopSafeArea() throws {
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        openNavigation.tap()
        let closeNavigation = app.buttons["Close navigation"]
        XCTAssertTrue(closeNavigation.waitForExistence(timeout: 3))

        let statusBar = app.statusBars.firstMatch
        if statusBar.exists {
            XCTAssertGreaterThanOrEqual(closeNavigation.frame.minY, statusBar.frame.maxY)
        }
    }

    func testSidebarNewChatOpensExistingComposer() throws {
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

    @available(iOS 26.0, *)
    func testSidebarCloseHitchPerformance() throws {
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

    private func openFixtureSession() throws -> XCUIElement {
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

    private func openSettings() {
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

    private func tapSettingsCategory(id: String, title: String) {
        let category = app.buttons["settings-category-\(id)"]
        for _ in 0..<10 where !category.exists {
            app.swipeUp()
        }
        XCTAssertTrue(category.waitForExistence(timeout: 3), "Missing Settings category: \(title)")
        let viewportTop = app.navigationBars["Settings"].frame.maxY
        for _ in 0..<10
            where category.frame.minY < viewportTop || category.frame.maxY > app.frame.maxY {
            if category.frame.maxY > app.frame.maxY {
                app.swipeUp()
            } else {
                app.swipeDown()
            }
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

    private func waitForComposer(timeout: TimeInterval) -> XCUIElement? {
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

    private func tapFixtureSession(_ session: XCUIElement) {
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

    private func assertPreviewVisible(identifier: String) {
        XCTAssertTrue(
            app.descendants(matching: .any)[identifier].waitForExistence(timeout: 3)
        )
    }

    private func brightness(
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
