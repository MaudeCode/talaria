import XCTest

/// Launched-app smoke coverage for the agent panels reached from the sidebar (TAL-71).
/// Every journey runs against the deterministic fixture server, so no owner server, live
/// Kanban worker or real account is involved.
class AgentPanelUITestCase: TalariaUITestCase {
    static let panels = ["Tasks", "Kanban", "Skills", "Memory", "Insights"]

    func launchPanelFixture(_ scenario: String, additionalArguments: [String] = []) {
        launchFixture(additionalArguments: [scenario] + additionalArguments)
        XCTAssertTrue(
            app.buttons["Open navigation"].awaitExistence(timeout: 15),
            "Missing deterministic app fixture"
        )
    }

    func openPanel(_ panel: String) {
        openSidebarDestination(panel)
        XCTAssertTrue(
            app.navigationBars[panel].awaitExistence(timeout: 10),
            "Sidebar did not open the \(panel) panel"
        )
    }

    /// A panel is the navigation root, so it keeps the sidebar button where a pushed
    /// screen keeps Back; the sidebar is the way out. The button can still be mid-pop
    /// from a detail screen, so wait for it rather than assuming it is already there.
    func leavePanel(_ panel: String) {
        // The sidebar element stays in the tree while it is closed and its rows only
        // resolve once it has finished opening, so the destination itself is the signal
        // for whether the sidebar still has to be opened.
        let chats = app.descendants(matching: .any)["app-sidebar"]
            .descendants(matching: .any)["Chats"]
            .firstMatch
        let openNavigation = app.buttons["Open navigation"]
        repeatStep(3, until: { chats.exists }) {
            if openNavigation.awaitExistence(timeout: 3) {
                openNavigation.tap()
            }
            _ = chats.awaitExistence(timeout: 3)
        }
        XCTAssertTrue(
            chats.awaitExistence(timeout: Self.navigationTimeout),
            "\(panel) offered no way back to the session list"
        )
        chats.tap()
        XCTAssertTrue(
            app.navigationBars["Chats"].awaitExistence(timeout: 10),
            "Leaving \(panel) did not return to the session list"
        )
    }

    func tapBack(from bar: XCUIElement) {
        let back = bar.buttons["BackButton"]
        XCTAssertTrue(back.awaitExistence(timeout: Self.navigationTimeout), "The pushed screen offered no Back control")
        tapCenter(of: back)
    }

    func element(labelled label: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
    }

    /// The panel fixture holds each panel's first load until this releases it, so the loading
    /// surface stays up however long a slow runner takes to find it (TAL-401).
    func assertLoadingResolves(_ label: String, panel: String) {
        let loading = element(labelled: label)
        XCTAssertTrue(loading.awaitExistence(timeout: Self.navigationTimeout), "\(panel) never showed its loading state")
        XCTAssertTrue(releaseHeldLoads { !loading.exists }, "\(panel) stayed in its loading state")
    }

    /// From a panel's failed first load: its error (Kanban names none), Try Again, the held
    /// retry's loading state, and the error gone.
    func recoverFromFailedLoad(_ panel: String, error: String?, loading: String) {
        if let error {
            XCTAssertTrue(
                element(labelContaining: error).awaitExistence(timeout: 15),
                "\(panel) did not surface its load failure"
            )
        }
        tapRetry(in: panel)
        assertLoadingResolves(loading, panel: panel)
        if let error {
            XCTAssertFalse(element(labelContaining: error).exists, "\(panel) kept its error state after recovering")
        }
    }

    func tapRetry(in panel: String) {
        let retry = app.buttons["Try Again"].firstMatch
        XCTAssertTrue(retry.awaitExistence(timeout: 10), "\(panel) offered no recovery action")
        tapCenter(of: retry)
    }
}

/// Each panel's failed first load and its recovery through Try Again, then its content,
/// detail/editor surfaces and one safe primary interaction. The fixture fails each panel's first
/// load and holds the retry (`--ui-test-panels-error`), so one visit walks the failure, the
/// loading state and the content (TAL-402).
final class AgentPanelContentUITests: AgentPanelUITestCase {
    /// Each panel is reached from the previous one's sidebar, so one launch walks three
    /// panels and leaves through the Chats destination once (TAL-402).
    func testTasksKanbanAndMemoryPanels() throws {
        launchPanelFixture("--ui-test-panels-error")
        try assertTasksPanelOpensDetailAndEditorWithoutLosingItsList()
        try assertKanbanPanelOpensCardDetailWithoutDispatchingWork()
        try assertMemoryPanelSavesASectionThroughItsEditor()
        leavePanel("Memory")
    }

    func testSkillsAndInsightsPanels() throws {
        launchPanelFixture("--ui-test-panels-error")
        try assertSkillsPanelFiltersTogglesAndOpensASkill()
        try assertInsightsPanelShowsQuotasAnalyticsAndSwitchesTimeframe()
        leavePanel("Insights")
    }

    func testInsightsFailureDoesNotAggregateSessionRows() throws {
        launchPanelFixture("--ui-test-panels-error", additionalArguments: ["--ui-test-insights-refresh-error"])
        openPanel("Insights")
        let error = element(labelContaining: "Could Not Load Analytics")
        let hasError = error.awaitExistence(timeout: 10)
        XCTAssertTrue(hasError, "Insights must surface the server error instead of deriving session totals")
        let sidebar = app.descendants(matching: .any)["app-sidebar"]
        XCTAssertTrue(poll(timeout: Self.navigationTimeout) { !sidebar.isHittable })
        _ = app.buttons["Try Again"].firstMatch.settledFrame
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Insights failed server request"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertFalse(element(labelContaining: "Source: local session metadata").exists)
        tapRetry(in: "Insights")
        assertLoadingResolves("Loading analytics…", panel: "Insights")
        XCTAssertTrue(element(labelContaining: "Sessions").awaitExistence(timeout: 10))
        let recovered = XCTAttachment(screenshot: app.screenshot())
        recovered.name = "Insights recovered server snapshot"
        recovered.lifetime = .keepAlways
        add(recovered)

        app.buttons["7 Days"].tap()
        let warning = element(labelContaining: "Showing cached server analytics. Refresh failed")
        repeatStep(8, until: { warning.exists && !warning.frame.isEmpty && app.frame.contains(warning.frame) }) { app.swipeUp() }
        XCTAssertTrue(warning.awaitExistence(timeout: 10), "The failed refresh must explain the cached snapshot")
        XCTAssertFalse(element(labelContaining: "Could Not Load Analytics").exists)
        _ = warning.settledFrame
        let cached = XCTAttachment(screenshot: app.screenshot())
        cached.name = "Insights cached snapshot after failed refresh"
        cached.lifetime = .keepAlways
        add(cached)
    }

    private func assertTasksPanelOpensDetailAndEditorWithoutLosingItsList() throws {
        openPanel("Tasks")
        recoverFromFailedLoad("Tasks", error: "Could Not Load Tasks", loading: "Loading tasks...")

        let job = element(labelContaining: "Fixture Nightly Digest")
        XCTAssertTrue(job.awaitExistence(timeout: 10), "Tasks did not render the fixture jobs")
        XCTAssertTrue(element(labelContaining: "Fixture Weekly Sweep").exists)
        XCTAssertTrue(element(labelContaining: "Running now").exists)
        XCTAssertTrue(element(labelContaining: "Recent Completions").exists, "Tasks did not render the completion feed")
        XCTAssertTrue(element(labelContaining: "Failed").exists, "The fixture completion did not show its status")

        tapCenter(of: job)
        let detail = app.navigationBars["Fixture Nightly Digest"]
        XCTAssertTrue(detail.awaitExistence(timeout: 10), "Task detail did not open")
        XCTAssertTrue(
            element(labelContaining: "Deterministic fixture digest output").awaitExistence(timeout: 10),
            "Task detail did not render its recent output"
        )

        let run = app.descendants(matching: .any)["task-run-fixture-digest.md"].firstMatch
        XCTAssertTrue(run.awaitExistence(timeout: 10), "Task detail did not render its run history")
        tapCenter(of: run)
        let copyOutput = app.buttons["Copy Output"]
        XCTAssertTrue(copyOutput.awaitExistence(timeout: 10), "The run output sheet did not open")
        XCTAssertTrue(
            element(labelContaining: "## Response").awaitExistence(timeout: 10),
            "The run output sheet did not render the full output"
        )
        tapCenter(of: app.buttons["Done"].firstMatch)
        XCTAssertTrue(copyOutput.awaitNonExistence(timeout: 10), "The run output sheet did not dismiss")
        tapBack(from: detail)
        XCTAssertTrue(
            job.awaitExistence(timeout: 10),
            "Returning from Task detail lost the task list"
        )

        tapCenter(of: app.navigationBars["Tasks"].buttons["New Task"])
        let editor = app.navigationBars["New Task"]
        XCTAssertTrue(editor.awaitExistence(timeout: 10), "The New Task editor did not open")
        tapCenter(of: editor.buttons["Cancel"])
        XCTAssertTrue(editor.awaitNonExistence(timeout: 10), "The New Task editor did not dismiss")
        XCTAssertTrue(job.awaitExistence(timeout: 10), "Dismissing the editor lost the task list")
    }

    private func assertKanbanPanelOpensCardDetailWithoutDispatchingWork() throws {
        openPanel("Kanban")
        recoverFromFailedLoad("Kanban", error: nil, loading: "Loading Kanban")

        let selector = app.descendants(matching: .any)["KanbanStatusSelector"]
        XCTAssertTrue(selector.awaitExistence(timeout: 15), "The Kanban Board did not load")

        // Whichever Status the Board opens on, its Cards carry the fixture id prefix.
        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "FIXTURE-"))
            .firstMatch
        XCTAssertTrue(card.awaitExistence(timeout: 10), "The fixture Board rendered no Cards")
        let cardID = String(card.label.prefix { $0 != "," })

        // Reading a Card is the only Kanban interaction here: no move, complete, archive or
        // dispatch action runs, so no worker is ever launched.
        tapCenter(of: card)
        let detail = app.navigationBars["Fixture Card \(cardID)"]
        XCTAssertTrue(detail.awaitExistence(timeout: 10), "The Card detail did not open")
        tapBack(from: detail)
        XCTAssertTrue(
            selector.awaitExistence(timeout: 10) && card.awaitExistence(timeout: 10),
            "Returning from the Card detail lost the Board"
        )
    }

    private func assertSkillsPanelFiltersTogglesAndOpensASkill() throws {
        openPanel("Skills")
        recoverFromFailedLoad("Skills", error: "Could Not Load Skills", loading: "Loading skills...")

        let skill = element(labelContaining: "fixture-runner")
        XCTAssertTrue(skill.awaitExistence(timeout: 10), "Skills did not render the fixture skills")
        XCTAssertTrue(element(labelContaining: "fixture-archivist").exists)

        // Search is the panel's own filter; it needs no server state and reaches the
        // no-results empty state as well.
        let search = app.searchFields["Search skills..."]
        XCTAssertTrue(search.awaitExistence(timeout: 5), "Skills offered no search field")
        search.tap()
        search.typeText("reviewer")
        XCTAssertTrue(
            element(labelContaining: "fixture-reviewer").awaitExistence(timeout: 10),
            "Searching did not keep the matching skill"
        )
        XCTAssertFalse(element(labelContaining: "fixture-archivist").exists)

        search.typeText("-no-such-skill")
        XCTAssertTrue(
            element(labelled: "No Results").awaitExistence(timeout: 10),
            "Searching for nothing did not reach the no-results state"
        )
        // Closing search, not just clearing its text: an active search field owns the whole
        // navigation bar, so leaving it open would take the sidebar control with it.
        tapCenter(of: app.navigationBars["Skills"].buttons["Close"])
        XCTAssertTrue(skill.awaitExistence(timeout: 10), "Closing the search did not restore the list")
        XCTAssertTrue(
            app.buttons["Open navigation"].awaitExistence(timeout: 5),
            "Closing the search did not restore the navigation control"
        )

        // Enabling a Skill writes to fixture state only.
        let disabledSkill = app.descendants(matching: .any)
            .matching(NSPredicate(
                format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@", "fixture-archivist", "Disabled"
            ))
            .firstMatch
        XCTAssertTrue(disabledSkill.awaitExistence(timeout: 10), "The disabled fixture skill is missing")
        // The switch that turns a disabled skill back on stays interactive. Its full strength
        // is pinned by the `skill-row-disabled` visual references, which XCUI cannot see.
        // List rows report `isHittable == false` to XCUI even when visible (see `tapCenter`),
        // so the tap flipping fixture state below is what proves the switch takes a touch.
        // The switch sits over the row's link, outside the row element (TAL-647).
        let enable = app.switches["skill-toggle-fixture-archivist"].firstMatch
        XCTAssertTrue(enable.awaitExistence(timeout: 5), "The disabled skill row offered no Enable switch")
        XCTAssertTrue(enable.isEnabled, "The disabled skill's Enable switch is not interactive")
        tapCenter(of: enable)
        XCTAssertTrue(
            disabledSkill.awaitNonExistence(timeout: 15),
            "Enabling a skill did not clear its Disabled badge"
        )
        XCTAssertTrue(app.navigationBars["Skills"].exists, "Tapping the switch opened the skill instead")

        // The row above only proves the optimistic update, which the view model applies
        // before the request. Leaving and re-entering builds a fresh view model whose only
        // source is the fixture, so the badge comes back unless the toggle really reached it.
        leavePanel("Skills")
        openPanel("Skills")
        XCTAssertTrue(
            element(labelContaining: "fixture-archivist").awaitExistence(timeout: 15),
            "Re-entering Skills did not reload the list"
        )
        XCTAssertFalse(
            disabledSkill.exists,
            "Enabling a skill did not survive a reload from the server"
        )

        // The row's context menu is the other toggle path.
        longPress(at: settledCenter(of: element(labelContaining: "fixture-archivist")))
        let disable = app.buttons["Disable"].firstMatch
        XCTAssertTrue(disable.awaitExistence(timeout: 5), "The skill row offered no Disable action")
        tapCenter(of: disable)
        XCTAssertTrue(
            disabledSkill.awaitExistence(timeout: 15),
            "Disabling a skill from its context menu did not restore its Disabled badge"
        )

        tapCenter(of: skill)
        let detail = app.navigationBars["fixture-runner"]
        XCTAssertTrue(detail.awaitExistence(timeout: 10), "The skill detail did not open")
        XCTAssertTrue(
            element(labelContaining: "Deterministic fixture skill content").awaitExistence(timeout: 10),
            "The skill detail rendered no content"
        )
        tapBack(from: detail)
        XCTAssertTrue(
            app.navigationBars["Skills"].awaitExistence(timeout: 10)
                && skill.awaitExistence(timeout: 10),
            "Returning from the skill detail lost the skill list"
        )
    }

    private func assertMemoryPanelSavesASectionThroughItsEditor() throws {
        openPanel("Memory")
        recoverFromFailedLoad("Memory", error: "Could Not Load Memory", loading: "Loading memory...")

        // Memory lists its files; each opens on its own page (TAL-643).
        let notes = app.buttons.containing(.staticText, identifier: "My Notes").firstMatch
        XCTAssertTrue(notes.awaitExistence(timeout: 10), "Memory did not list its files")
        XCTAssertTrue(element(labelContaining: "User Profile").exists)
        XCTAssertTrue(element(labelContaining: "Agent Soul").exists)
        tapCenter(of: notes)
        XCTAssertTrue(
            element(labelContaining: "Fixture notes body").awaitExistence(timeout: 10),
            "My Notes did not open its content"
        )
        XCTAssertFalse(element(labelContaining: "Fixture user profile").exists, "The page must show one file")

        tapCenter(of: app.buttons["Edit My Notes"].firstMatch)
        let editor = app.navigationBars["Edit My Notes"]
        XCTAssertTrue(editor.awaitExistence(timeout: 10), "The memory editor did not open")

        let field = app.textViews["My Notes"]
        XCTAssertTrue(field.awaitExistence(timeout: 5), "The memory editor exposed no text field")
        field.tap()
        field.typeText(" Edited by fixture.")
        tapCenter(of: editor.buttons["Save"])
        XCTAssertTrue(editor.awaitNonExistence(timeout: 15), "Saving did not dismiss the memory editor")
        XCTAssertTrue(
            element(labelContaining: "Edited by fixture").awaitExistence(timeout: 15),
            "The saved memory text did not return with the reload"
        )
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.navigationBars["Memory"].awaitExistence(timeout: Self.navigationTimeout))
    }

    private func assertInsightsPanelShowsQuotasAnalyticsAndSwitchesTimeframe() throws {
        openPanel("Insights")
        recoverFromFailedLoad("Insights", error: "Could Not Load Analytics", loading: "Loading analytics…")

        XCTAssertTrue(
            element(labelled: "Provider quotas").awaitExistence(timeout: 10),
            "Insights did not render the provider quota section"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["provider-quota-section"].exists,
            "The provider quota section is missing its rows"
        )
        let sessions = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Sessions", "42"))
            .firstMatch
        XCTAssertTrue(sessions.awaitExistence(timeout: 10), "Insights did not render its analytics totals")

        // The analytics section header carries the loaded timeframe, which the view model
        // only advances once the new response lands; the cards alone stay visible through a
        // reload and would pass even if nothing switched.
        XCTAssertTrue(element(labelContaining: "Last 30 Days").exists, "Insights did not report its timeframe")
        // On a loaded hosted runner the segmented control can lift its thumb for a synthesized
        // tap and drop it without selecting (TAL-693). Nothing in the app reverts a selection, so
        // a segment that never shows selected is the tap's loss, not the reload's.
        let sevenDays = app.buttons["7 Days"].firstMatch
        repeatStep(3, until: { sevenDays.isSelected }) {
            tapCenter(of: sevenDays)
            _ = poll(timeout: 2) { sevenDays.isSelected }
        }
        XCTAssertTrue(sevenDays.isSelected, "The timeframe picker never took the 7 Days selection")
        XCTAssertTrue(
            element(labelContaining: "Last 7 Days").awaitExistence(timeout: 15),
            "Switching the analytics timeframe did not reload the analytics"
        )
        XCTAssertTrue(sessions.exists, "Switching the analytics timeframe lost the loaded analytics")
    }
}

/// TAL-435: a task added on the server while the app was in the background appears in the open
/// Tasks list as soon as the app returns, without a pull.
final class AgentPanelLiveRefreshUITests: AgentPanelUITestCase {
    func testOpenTasksListCatchesUpAfterTheAppReturnsFromTheBackground() throws {
        launchFixture(additionalArguments: ["--ui-test-panels", "--ui-test-change-while-backgrounded"])
        XCTAssertTrue(app.buttons["Open navigation"].awaitExistence(timeout: 15), "Missing deterministic app fixture")
        openPanel("Tasks")
        let knownJob = element(labelContaining: "Fixture Nightly Digest")
        XCTAssertTrue(releaseHeldLoads { knownJob.exists }, "Tasks did not render the fixture jobs")
        let jobAddedElsewhere = element(labelContaining: "FixtureJobAddedElsewhere")
        XCTAssertFalse(jobAddedElsewhere.exists)

        sendToBackground()
        app.activate()

        // The new job lands at the end of the list, below the completion feed.
        XCTAssertTrue(
            poll(timeout: 15) {
                if !jobAddedElsewhere.exists { app.swipeUp() }
                return jobAddedElsewhere.exists
            },
            "The open Tasks list never caught up with the job added while the app was away"
        )
    }
}

final class SidebarQuotaUITests: AgentPanelUITestCase {
    /// A pinned quota sits directly above Settings once the drawer is fully open (TAL-663).
    func testPinnedQuotaSitsAboveSettingsInOpenSidebar() {
        launchPanelFixture(
            "--ui-test-fixture",
            additionalArguments: ["-\(Self.firstSidebarSourceKey)", "ui-fixture-source"]
        )
        openPanel("Insights")
        let sidebar = openSidebar()
        let quota = sidebar.descendants(matching: .any)["app-sidebar-quota-ui-fixture-source"].firstMatch
        XCTAssertTrue(quota.awaitExistence(timeout: Self.navigationTimeout), "The pinned quota is missing from the sidebar")
        let gap = sidebar.buttons["Settings"].firstMatch.settledFrame.minY - quota.settledFrame.maxY
        attachScreenshot(named: "sidebar-pinned-quota")
        XCTAssertLessThan(gap, 60, "A blank gap opened between the pinned quota and Settings")
    }

    private static let firstSidebarSourceKey = "providerQuotaSidebar.source1"
}

/// TAL-483: every toolbar Refresh keeps its "Refresh" label and its place in the bar while it
/// loads, and is disabled meanwhile. The fixture holds each Refresh load until the test releases
/// it. On the iPhone Duo outer display the bar is vertical, so this is the Duo layout probe too.
final class RefreshToolbarButtonUITests: AgentPanelUITestCase {
    func testRefreshButtonsKeepTheirBarWhileLoading() throws {
        launchPanelFixture("--ui-test-panels", additionalArguments: ["--ui-test-hold-panel-refreshes"])
        let sidebar = app.buttons["Open navigation"]
        let back = app.buttons["BackButton"].firstMatch

        openPanel("Tasks")
        let job = element(labelContaining: "Fixture Nightly Digest")
        assertRefreshKeepsItsBar("Tasks", loaded: job, beside: sidebar)
        tapCenter(of: job)
        assertRefreshKeepsItsBar(
            "Task detail", loaded: element(labelContaining: "Deterministic fixture digest output"), beside: back
        )
        tapCenter(of: back)

        openPanel("Skills")
        let skill = element(labelContaining: "fixture-runner")
        assertRefreshKeepsItsBar("Skills", loaded: skill, beside: sidebar)
        tapCenter(of: skill)
        assertRefreshKeepsItsBar(
            "Skill detail", loaded: element(labelContaining: "Deterministic fixture skill content"), beside: back
        )
        tapCenter(of: back)

        openPanel("Memory")
        let notes = app.buttons.containing(.staticText, identifier: "My Notes").firstMatch
        XCTAssertTrue(releaseHeldLoads { notes.exists }, "Memory did not list its files")
        tapCenter(of: notes)
        assertRefreshKeepsItsBar("Memory", loaded: element(labelContaining: "Fixture notes body"), beside: back)
        tapCenter(of: back)

        openPanel("Insights")
        assertRefreshKeepsItsBar("Insights", loaded: element(labelled: "Provider quotas"), beside: sidebar)
    }

    /// Lets `screen` finish loading, then taps its Refresh and checks it during the held refresh
    /// and after it. `control` is the screen's own sidebar or Back button, which shares the bar.
    private func assertRefreshKeepsItsBar(_ screen: String, loaded: XCUIElement, beside control: XCUIElement) {
        let refresh = app.buttons["Refresh"].firstMatch
        XCTAssertTrue(
            releaseHeldLoads { loaded.exists && refresh.exists && refresh.isEnabled },
            "\(screen) offered no enabled Refresh once loaded"
        )
        tapCenter(of: refresh)
        XCTAssertTrue(poll(timeout: 10) { !refresh.isEnabled }, "\(screen)'s Refresh stayed enabled while loading")
        XCTAssertEqual(refresh.label, "Refresh", "\(screen)'s Refresh changed what VoiceOver reads while loading")
        assertRefresh(refresh, sharesTheBarWith: control, "\(screen) while loading")
        XCTAssertTrue(releaseHeldLoads { refresh.isEnabled }, "\(screen)'s refresh never finished")
        assertRefresh(refresh, sharesTheBarWith: control, "\(screen) after loading")
    }

    /// One bar holds both buttons: the same row in a horizontal bar, the same column in the Duo's
    /// vertical one. A Refresh the system moved to a bar of its own lines up with neither.
    private func assertRefresh(_ refresh: XCUIElement, sharesTheBarWith control: XCUIElement, _ state: String) {
        XCTAssertTrue(control.awaitExistence(timeout: 5), "\(state): missing \(control.label)")
        let button = refresh.settledFrame
        let neighbour = control.settledFrame
        attachScreenshot(named: "Refresh, \(state)")
        XCTAssertTrue(
            abs(button.midY - neighbour.midY) < 2 || abs(button.midX - neighbour.midX) < 2,
            "\(state): Refresh \(button) left the bar of \(control.label) \(neighbour)"
        )
    }
}
