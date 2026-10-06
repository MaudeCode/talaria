import XCTest

/// TAL-643: at regular width (iPad, the iPhone Duo inner display) each section fills the sidebar
/// column with its own list and opens the selected item beside it, instead of showing Chats.
final class RegularWidthNavigationUITests: TalariaUITestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Needs a regular-width iPad destination")
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        try super.tearDownWithError()
    }

    /// Selecting a chat rebuilds only the detail column, so the list keeps its search text.
    func testChatsKeepTheSessionsListAndItsSearchBesideTheChat() throws {
        launchFixture()
        let session = fixtureSessionButton
        XCTAssertTrue(session.awaitExistence(timeout: 15), "Missing deterministic session fixture")
        XCTAssertTrue(app.navigationBars["Chats"].exists)

        let control = try XCTUnwrap(waitForSessionSearchControl(timeout: 10), "Missing the session search control")
        control.tap()
        let search = sessionSearchField
        XCTAssertTrue(search.awaitExistence(timeout: Self.navigationTimeout), "Search did not open")
        search.typeText(String(fixtureSessionTitle.prefix(7)))
        XCTAssertTrue(session.awaitExistence(timeout: Self.navigationTimeout), "The search hid the fixture session")
        session.tap()
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")
        XCTAssertEqual(search.value as? String, String(fixtureSessionTitle.prefix(7)), "Opening a chat reset the list's search")
        XCTAssertTrue(session.isSelected, "The open chat's row is not marked selected")
        attachScreenshot(named: "Chats beside the open chat")
    }

    func testSettingsListsItsCategoriesBesideTheSelectedPage() throws {
        launchFixture()
        openSettings()

        XCTAssertFalse(app.navigationBars["Chats"].exists, "Settings must replace the Chats sidebar")
        XCTAssertTrue(
            app.navigationBars["Appearance"].awaitExistence(timeout: Self.navigationTimeout),
            "Entering Settings must open its first category beside the list"
        )
        XCTAssertTrue(app.buttons["settings-category-appearance"].isSelected)
        attachScreenshot(named: "Settings beside Appearance")

        tapCenter(of: app.buttons["settings-category-notificationsAndHaptics"])
        XCTAssertTrue(app.navigationBars["Notifications & Haptics"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.buttons["settings-category-appearance"].exists, "The category list must stay beside the page")
        XCTAssertTrue(app.buttons["settings-category-notificationsAndHaptics"].isSelected)
        XCTAssertFalse(app.buttons["settings-category-appearance"].isSelected)

        // A category's own sub-page pushes inside the detail column and pops back to it.
        tapCenter(of: app.buttons["settings-category-liveActivitiesAndWidgets"])
        XCTAssertTrue(app.navigationBars["Live Activities & Widgets"].awaitExistence(timeout: Self.navigationTimeout))
        tapSettingsRow(label: "Provider Quotas")
        XCTAssertTrue(app.navigationBars["Customization"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.buttons["settings-category-liveActivitiesAndWidgets"].isSelected, "The sub-page left the list")
        app.navigationBars["Customization"].buttons.firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Live Activities & Widgets"].awaitExistence(timeout: Self.navigationTimeout))
    }

    func testMemoryListsItsFilesBesideTheOpenFile() throws {
        launchFixture(additionalArguments: ["--ui-test-panels"])
        openSidebarDestination("Memory")

        let notes = element(label: "Fixture notes body.")
        XCTAssertTrue(releaseHeldLoads { notes.exists }, "Entering Memory must open My Notes beside the list")
        XCTAssertFalse(app.navigationBars["Chats"].exists, "Memory must replace the Chats sidebar")
        for title in ["My Notes", "User Profile", "Agent Soul"] {
            XCTAssertTrue(element(label: title).exists, "Missing the \(title) file row")
        }
        attachScreenshot(named: "Memory beside My Notes")

        element(label: "User Profile").tap()
        XCTAssertTrue(element(label: "Fixture user profile.").awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertFalse(notes.exists, "The detail must show only the selected file")

        app.buttons["Edit User Profile"].tap()
        let editor = app.textViews["User Profile"]
        XCTAssertTrue(editor.awaitExistence(timeout: Self.navigationTimeout), "Edit did not open the editor")
        editor.tap()
        editor.typeText(" Edited.")
        app.buttons["Save"].tap()
        XCTAssertTrue(
            element(labelContaining: "Edited.").awaitExistence(timeout: Self.navigationTimeout),
            "The saved file did not show its new content"
        )
    }

    func testSkillsAndTasksListBesideTheirSelectedItem() throws {
        launchFixture(additionalArguments: ["--ui-test-panels"])

        openSidebarDestination("Skills")
        XCTAssertTrue(app.staticTexts["Select a Skill"].awaitExistence(timeout: Self.navigationTimeout))
        let skill = element(label: "fixture-runner")
        XCTAssertTrue(releaseHeldLoads { skill.exists }, "The skill list did not load")
        skill.tap()
        XCTAssertTrue(app.navigationBars["fixture-runner"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.navigationBars["Skills"].exists, "The skill list must stay beside the skill")

        openSidebarDestination("Tasks")
        XCTAssertTrue(app.staticTexts["Select a Task"].awaitExistence(timeout: Self.navigationTimeout))
        let job = app.buttons.containing(.staticText, identifier: "Fixture Weekly Sweep").firstMatch
        XCTAssertTrue(releaseHeldLoads { job.exists }, "The job list did not load")
        job.tap()
        XCTAssertTrue(app.navigationBars["Fixture Weekly Sweep"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.navigationBars["Tasks"].exists, "The job list must stay beside the job")
        XCTAssertTrue(job.isSelected)
        attachScreenshot(named: "Tasks beside a job")
    }

    func testKanbanAndInsightsFillTheWidth() throws {
        launchFixture()
        openSidebarDestination("Kanban")
        let kanban = app.navigationBars["Kanban"]
        XCTAssertTrue(kanban.awaitExistence(timeout: Self.navigationTimeout), "Kanban did not open")
        XCTAssertFalse(app.navigationBars["Chats"].exists, "Kanban must hide the sidebar column")
        XCTAssertLessThan(kanban.settledFrame.minX, 1, "Kanban must start at the leading edge")
        XCTAssertEqual(app.buttons.matching(identifier: "sidebar.left").count, 1, "One drawer button, in Kanban's bar")
        attachScreenshot(named: "Kanban at full width")

        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Shape the fixture slice")).firstMatch
        XCTAssertTrue(card.awaitExistence(timeout: Self.navigationTimeout), "Kanban Board did not load")
        card.tap()
        XCTAssertTrue(app.buttons["BackButton"].awaitExistence(timeout: Self.navigationTimeout), "The card did not push")
        app.buttons["BackButton"].tap()
        XCTAssertTrue(kanban.awaitExistence(timeout: Self.navigationTimeout), "The card did not pop back to Kanban")

        openSidebarDestination("Insights")
        XCTAssertTrue(app.navigationBars["Insights"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertLessThan(app.navigationBars["Insights"].settledFrame.minX, 1, "Insights must start at the leading edge")
    }

    func testScheduledListStaysBesideItsChatAndLeadsBackToChats() throws {
        launchFixture(additionalArguments: ["--ui-test-sidebar-variety"])
        let expand = app.buttons["Expand scheduled sessions"]
        XCTAssertTrue(expand.awaitExistence(timeout: 15), "Missing the scheduled group")
        expand.tap()
        let viewAll = app.buttons["View all"].firstMatch
        XCTAssertTrue(viewAll.awaitExistence(timeout: Self.navigationTimeout), "Missing the scheduled group's View all")
        viewAll.tap()
        let scheduled = app.navigationBars["Scheduled sessions"]
        XCTAssertTrue(scheduled.awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertFalse(app.navigationBars["Chats"].exists, "The scheduled list must replace the Chats sidebar")
        XCTAssertTrue(app.staticTexts["Select a Chat"].exists)

        let row = app.buttons.containing(.staticText, identifier: "Scheduled Fixture 2").firstMatch
        row.tap()
        XCTAssertNotNil(waitForComposer(timeout: 15), "The scheduled chat did not open")
        XCTAssertTrue(scheduled.exists, "Opening a chat must keep the scheduled list beside it")
        XCTAssertTrue(row.isSelected)
        attachScreenshot(named: "Scheduled list beside its chat")

        scheduled.buttons["Chats"].tap()
        XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertNotNil(waitForComposer(timeout: 5), "Back to Chats must keep the open chat")
    }

    /// Each pass opens the drawer from the section the previous pass entered, so every section's
    /// drawer button is tapped. The closed drawer stays in the tree, so hittability proves nothing.
    func testEverySectionKeepsTheDrawerAndSwitchesBothColumns() throws {
        launchFixture()
        for (destination, sidebarTitle) in [
            ("Tasks", "Tasks"), ("Kanban", nil), ("Skills", "Skills"), ("Memory", "Memory"),
            ("Insights", nil), ("Settings", "Settings"), ("Chats", "Chats"),
        ] {
            openSidebarDestination(destination)
            if let sidebarTitle {
                XCTAssertTrue(
                    app.navigationBars[sidebarTitle].awaitExistence(timeout: Self.navigationTimeout),
                    "\(destination) did not fill the sidebar"
                )
            }
            let drawerButtons = app.buttons.matching(identifier: "sidebar.left")
            XCTAssertTrue(
                poll(timeout: Self.navigationTimeout) { drawerButtons.count == 1 },
                "\(destination) must show exactly one drawer button"
            )
        }
        openSidebar()
    }

    /// Last: XCTest's next action after Archived Chats waits for the app to go idle.
    func testArchivedChatFromSettingsOpensBesideTheArchivedList() throws {
        launchFixture()
        openSettings()
        tapCenter(of: app.buttons["settings-category-chats"])
        XCTAssertTrue(app.navigationBars["Chats"].awaitExistence(timeout: Self.navigationTimeout))
        tapSettingsRow(label: "Archived Chats")
        let archived = element(labelContaining: "Fixture Archived Session")
        XCTAssertTrue(archived.awaitExistence(timeout: Self.navigationTimeout))
        archived.tap()

        XCTAssertTrue(
            poll(timeout: Self.navigationTimeout) { !app.navigationBars["Settings"].exists },
            "Opening an archived chat must leave Settings"
        )
        XCTAssertTrue(app.navigationBars["Archived Chats"].exists, "The archived list must stay beside its chat")
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: "Fixture Archived Session").firstMatch.isSelected)
        attachScreenshot(named: "Archived chat beside its list")
    }
}

/// TAL-643: a size-class change keeps the section and its open item. A Pro Max iPhone is compact
/// in portrait and regular in landscape, so rotating it crosses the boundary the way closing an
/// iPhone Duo or narrowing an iPad window does.
final class SizeClassRoundTripUITests: TalariaUITestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        let device = ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? ""
        try XCTSkipUnless(device.contains("Pro Max"), "Needs a destination whose rotation changes the size class")
        XCUIDevice.shared.orientation = .portrait
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        try super.tearDownWithError()
    }

    func testSectionAndItemSurviveRotatingAcrossTheSizeClassBoundary() throws {
        launchFixture(additionalArguments: ["--ui-test-panels"])

        // Settings › Appearance.
        openSettings()
        tapSettingsCategory(id: "appearance", title: "Appearance")
        XCTAssertTrue(app.navigationBars["Appearance"].awaitExistence(timeout: Self.navigationTimeout))
        rotate(to: .landscapeLeft)
        XCTAssertTrue(app.buttons["settings-category-appearance"].awaitExistence(timeout: Self.navigationTimeout))
        XCTAssertTrue(app.buttons["settings-category-appearance"].isSelected, "Regular width lost the pushed category")
        XCTAssertTrue(app.navigationBars["Appearance"].exists)
        attachScreenshot(named: "Settings › Appearance in landscape")
        rotate(to: .portrait)
        XCTAssertTrue(
            app.navigationBars["Appearance"].buttons["Settings"].awaitExistence(timeout: Self.navigationTimeout),
            "Compact width must push Appearance over Settings"
        )
        // The drawer opens from stack roots; a pushed page offers Back.
        app.buttons["BackButton"].tap()

        // Memory › User.
        openSidebarDestination("Memory")
        let user = element(label: "User Profile")
        XCTAssertTrue(releaseHeldLoads { user.exists }, "Memory did not load")
        user.tap()
        XCTAssertTrue(element(label: "Fixture user profile.").awaitExistence(timeout: Self.navigationTimeout))
        rotate(to: .landscapeLeft)
        XCTAssertTrue(element(label: "My Notes").awaitExistence(timeout: Self.navigationTimeout), "Regular width lost the file list")
        XCTAssertTrue(element(label: "Fixture user profile.").exists, "Regular width lost the open file")
        rotate(to: .portrait)
        XCTAssertTrue(
            app.navigationBars["User Profile"].buttons["Memory"].awaitExistence(timeout: Self.navigationTimeout),
            "Compact width must push User Profile over Memory"
        )
        app.buttons["BackButton"].tap()

        // A selected chat.
        openSidebarDestination("Chats")
        tapFixtureSession(fixtureSessionButton)
        XCTAssertNotNil(waitForComposer(timeout: 15), "The fixture session did not open")
        rotate(to: .landscapeLeft)
        XCTAssertTrue(fixtureSessionButton.awaitExistence(timeout: Self.navigationTimeout), "Regular width lost the Chats list")
        XCTAssertNotNil(waitForComposer(timeout: 5), "Regular width lost the open chat")
        rotate(to: .portrait)
        XCTAssertNotNil(waitForComposer(timeout: Self.navigationTimeout), "Compact width lost the open chat")
        XCTAssertTrue(app.buttons["BackButton"].exists, "Compact width must push the chat over the list")
    }

    private func rotate(to orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        _ = app.navigationBars.firstMatch.settledFrame
    }
}

/// TAL-643: the quota widget's settings link opens its page over Live Activities & Widgets, at
/// both widths, so Back leads into Settings.
final class QuotaWidgetSettingsLinkUITests: TalariaUITestCase {
    func testWidgetSettingsLinkOpensItsPageOverItsCategory() throws {
        launchFixture()
        XCTAssertTrue(app.buttons["Open navigation"].awaitExistence(timeout: 15), "Missing deterministic app fixture")
        app.open(try XCTUnwrap(URL(string: "talaria://provider-quota-widget-settings")))
        let confirm = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if confirm.waitForExistence(timeout: 5) {
            confirm.tap()
        }

        let page = app.navigationBars["Customization"]
        XCTAssertTrue(page.awaitExistence(timeout: Self.navigationTimeout), "The link did not open the widget page")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertTrue(app.buttons["settings-category-liveActivitiesAndWidgets"].isSelected)
        }
        page.buttons.firstMatch.tap()
        XCTAssertTrue(
            app.navigationBars["Live Activities & Widgets"].awaitExistence(timeout: Self.navigationTimeout),
            "Back must lead to the widget's category"
        )
    }
}
