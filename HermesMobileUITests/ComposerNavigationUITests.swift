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

    func testComposerMovesIntoBottomAccessoryAndExpandsAgain() throws {
        var idleComposer = try openFixtureSession()
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)
        let initialBottomAccessory = app.descendants(matching: .any)["chat-bottom-accessory"]
        XCTAssertTrue(initialBottomAccessory.waitForExistence(timeout: 3))
        XCTAssertTrue(initialBottomAccessory.buttons["Choose workspace path"].exists)

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

        let sessionOptions = app.buttons["Session options"]
        XCTAssertTrue(sessionOptions.waitForExistence(timeout: 3))
        let bottomAccessory = app.descendants(matching: .any)["chat-bottom-accessory"]
        XCTAssertTrue(bottomAccessory.waitForExistence(timeout: 3))
        XCTAssertTrue(bottomAccessory.buttons["Session options"].exists)

        let chatsTab = app.tabBars.buttons["Chats"]
        XCTAssertTrue(chatsTab.exists)
        XCTAssertLessThan(abs(sessionOptions.frame.midY - chatsTab.frame.midY), 30)

        sessionOptions.tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Workspace:'")).firstMatch
                .waitForExistence(timeout: 3)
        )
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).tap()

        let integratedExtrasScreenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        integratedExtrasScreenshot.name = "Optional composer controls inside compact-tab composer"
        integratedExtrasScreenshot.lifetime = .keepAlways
        add(integratedExtrasScreenshot)
    }

    func testComposerSettingsAreGroupedAndConfigurable() throws {
        let chatsTab = app.tabBars.buttons["Chats"]
        guard chatsTab.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

        app.tabBars.buttons["More"].tap()
        let settings = app.staticTexts["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()

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

    func testBottomAccessoryIsAbsentFromRootPages() throws {
        let chatsTab = app.tabBars.buttons["Chats"]
        guard chatsTab.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }

        for tabName in ["Chats", "Tasks", "Kanban", "More"] {
            let tab = app.tabBars.buttons[tabName]
            tab.tap()
            XCTAssertTrue(tab.isSelected)
            assertNoBottomAccessory(on: tabName)
        }
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

    private func assertNoBottomAccessory(
        on page: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertFalse(
            app.descendants(matching: .any)["chat-bottom-accessory"].exists,
            "Unexpected chat bottom accessory on \(page)",
            file: file,
            line: line
        )
    }
}
