import XCTest
import UIKit

final class ComposerNavigationUITests: XCTestCase {
    private let fixtureSessionTitle = "Workstream L Kopiur"
    private var app: XCUIApplication!

    private var fixtureSessionButton: XCUIElement {
        app.buttons.containing(.staticText, identifier: fixtureSessionTitle).firstMatch
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    func testChatListScrolls() throws {
        let session = fixtureSessionButton
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

        tapFixtureSession(session)
        XCTAssertTrue(app.buttons["Message"].waitForExistence(timeout: 15))
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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        add(XCTAttachment(screenshot: XCUIScreen.main.screenshot()))
    }

    func testSidebarReplacesRootTabs() throws {
        let openNavigation = app.buttons["Open navigation"]
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        guard openNavigation.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

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
        let idleComposer = app.buttons["Message"]
        if idleComposer.waitForExistence(timeout: 3) {
            return idleComposer
        }

        let session = fixtureSessionButton
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }
        tapFixtureSession(session)
        XCTAssertTrue(idleComposer.waitForExistence(timeout: 15))
        return idleComposer
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
        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ), let cgImage = image.cgImage else {
            throw XCTSkip("Could not read simulator screenshot pixels")
        }

        context.translateBy(x: -pixelX, y: pixelY - image.size.height + 1)
        context.draw(cgImage, in: CGRect(origin: .zero, size: image.size))
        return CGFloat(pixel[0...2].max() ?? 0) / 255
    }

}
