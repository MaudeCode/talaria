import XCTest

final class ComposerNavigationUITests: XCTestCase {
    private var app: XCUIApplication!

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
        let session = app.staticTexts["Workstream L Kopiur"].firstMatch
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
        let session = app.staticTexts["Workstream L Kopiur"].firstMatch
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

        session.tap()
        XCTAssertTrue(app.buttons["Message"].waitForExistence(timeout: 15))
    }

    func testComposerCollapsesAndExpandsWithoutBottomNavigation() throws {
        var idleComposer = try openFixtureSession()
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
        idleComposer = try openFixtureSession()

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 3))
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)
        transcript.swipeUp(velocity: .slow)

        let reply = app.buttons["Reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertFalse(idleComposer.exists)

        let composerOptions = app.buttons["Composer options"]
        XCTAssertTrue(composerOptions.exists)
        composerOptions.tap()
        XCTAssertTrue(app.buttons["Attach File"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Photos"].exists)
        XCTAssertTrue(app.buttons["Camera"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()

        let collapsedComposerScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        collapsedComposerScreenshot.name = "Collapsed reply composer"
        collapsedComposerScreenshot.lifetime = .keepAlways
        add(collapsedComposerScreenshot)

        reply.tap()
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

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
            .press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.45))
            )

        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 3))
        let mainSurface = app.descendants(matching: .any)["app-main-surface"]
        XCTAssertEqual(mainSurface.frame.minY, app.frame.minY, accuracy: 1)
        XCTAssertEqual(mainSurface.frame.maxY, app.frame.maxY, accuracy: 1)
        let revealedTitleFrame = navigationTitle.frame
        let revealWidth = min(360, app.frame.width * 0.84)
        XCTAssertEqual(revealedTitleFrame.minX, initialTitleFrame.minX + revealWidth, accuracy: 1)
        XCTAssertEqual(revealedTitleFrame.minY, initialTitleFrame.minY, accuracy: 1)
        XCTAssertFalse(app.buttons["Pin"].exists)
        for destination in ["Chats", "Tasks", "Kanban", "Skills", "Memory", "Insights", "Settings"] {
            XCTAssertTrue(
                sidebar.descendants(matching: .any)[destination].exists,
                "Missing sidebar destination: \(destination)"
            )
        }

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.45))
            .press(
                forDuration: 0.1,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.45))
            )
        XCTAssertEqual(mainSurface.frame.minX, app.frame.minX, accuracy: 1)
        XCTAssertEqual(navigationTitle.frame.minX, initialTitleFrame.minX, accuracy: 1)
        XCTAssertFalse(sidebar.isHittable)
    }

    private func openFixtureSession() throws -> XCUIElement {
        let idleComposer = app.buttons["Message"]
        if idleComposer.waitForExistence(timeout: 3) {
            return idleComposer
        }

        let session = app.staticTexts["Workstream L Kopiur"].firstMatch
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }
        session.tap()
        XCTAssertTrue(idleComposer.waitForExistence(timeout: 15))
        return idleComposer
    }

}
