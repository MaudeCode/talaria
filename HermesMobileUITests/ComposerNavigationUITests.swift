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
        let session = app.staticTexts["Workstream L Kopiur"].firstMatch
        guard session.waitForExistence(timeout: 15) else {
            throw XCTSkip("Requires the maintainer's onboarded simulator fixture")
        }
        session.tap()

        let idleComposer = app.buttons["Message"]
        XCTAssertTrue(idleComposer.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Choose workspace path"].exists)
        XCTAssertTrue(app.buttons["Choose profile"].exists)

        idleComposer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.textViews.firstMatch.exists)

        app.keyboards.buttons["dictation"].firstMatch.tapIfExists()
        app.textViews.firstMatch.typeText("Composer transition check")
        XCTAssertFalse(app.buttons["Follow up"].exists)

        app.textViews.firstMatch.press(forDuration: 0.8)
        app.menuItems["Select All"].tapIfExists()
        app.keys["delete"].tapIfExists()
        app.swipeDown()

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 3))
        transcript.swipeDown(velocity: .fast)
        transcript.swipeDown(velocity: .fast)

        let followUp = app.buttons["Follow up"]
        XCTAssertTrue(followUp.waitForExistence(timeout: 5))
        XCTAssertFalse(idleComposer.exists)
        add(XCTAttachment(screenshot: XCUIScreen.main.screenshot()))

        followUp.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.textViews.firstMatch.exists)
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
        while !composerHeading.exists {
            app.swipeUp()
        }

        XCTAssertTrue(composerHeading.exists)
        XCTAssertTrue(app.staticTexts["Send While Responding"].exists)
        XCTAssertTrue(app.staticTexts["Dictation Provider"].exists)
        XCTAssertTrue(app.staticTexts["Workspace"].exists)
        XCTAssertTrue(app.staticTexts["Profile"].exists)
        XCTAssertTrue(app.staticTexts["Git Branch"].exists)
        XCTAssertTrue(app.staticTexts["Context Usage"].exists)
        add(XCTAttachment(screenshot: XCUIScreen.main.screenshot()))
    }
}

private extension XCUIElement {
    func tapIfExists() {
        if waitForExistence(timeout: 1) {
            tap()
        }
    }
}
