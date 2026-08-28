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
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.textViews.firstMatch.exists)

        app.textViews.firstMatch.typeText("Composer transition check")
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
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        XCTAssertTrue(app.textViews.firstMatch.exists)
        app.textViews.firstMatch.typeText("Draft")

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
        let openNavigation = app.buttons["Open navigation"]
        XCTAssertTrue(openNavigation.waitForExistence(timeout: 15), "Missing deterministic app fixture")

        openNavigation.tap()
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        sidebar.descendants(matching: .any)["Settings"].firstMatch.tap()

        let composerHeading = app.staticTexts["Composer"]
        for _ in 0..<8 where !composerHeading.exists {
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
            for _ in 0..<8 where !setting.exists {
                app.swipeUp()
            }
            XCTAssertTrue(setting.exists, "Missing composer setting: \(label)")
        }

        let percentage = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Percentage"))
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
