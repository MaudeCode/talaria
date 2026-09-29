import notify
import XCTest

/// Launched-app smoke coverage for the agent panels reached from the sidebar (TAL-71).
/// Every journey runs against the deterministic fixture server, so no owner server, live
/// Kanban worker or real account is involved.
class AgentPanelUITestCase: TalariaUITestCase {
    static let panels = ["Tasks", "Kanban", "Skills", "Memory", "Insights"]

    func launchPanelFixture(_ scenario: String) {
        launchFixture(additionalArguments: [scenario])
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
        for _ in 0..<3 where !chats.exists {
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
        // Matches `UITestPanelScenario.releaseLoadsNotification` in the app's fixture.
        notify_post("dev.kil.talaria.ui-test.release-panel-loads")
        XCTAssertTrue(loading.awaitNonExistence(timeout: 20), "\(panel) stayed in its loading state")
    }

    func tapRetry(in panel: String) {
        let retry = app.buttons["Try Again"].firstMatch
        XCTAssertTrue(retry.awaitExistence(timeout: 10), "\(panel) offered no recovery action")
        tapCenter(of: retry)
    }
}

/// Content, detail/editor surfaces and one safe primary interaction per panel.
final class AgentPanelContentUITests: AgentPanelUITestCase {
    func testTasksPanelOpensDetailAndEditorWithoutLosingItsList() throws {
        launchPanelFixture("--ui-test-panels")
        openPanel("Tasks")
        assertLoadingResolves("Loading tasks...", panel: "Tasks")

        let job = element(labelContaining: "Fixture Nightly Digest")
        XCTAssertTrue(job.awaitExistence(timeout: 10), "Tasks did not render the fixture jobs")
        XCTAssertTrue(element(labelContaining: "Fixture Weekly Sweep").exists)
        XCTAssertTrue(element(labelContaining: "Running now").exists)

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

        leavePanel("Tasks")
    }

    func testKanbanPanelOpensCardDetailWithoutDispatchingWork() throws {
        launchPanelFixture("--ui-test-panels")
        openPanel("Kanban")
        assertLoadingResolves("Loading Kanban", panel: "Kanban")

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

        leavePanel("Kanban")
    }

    func testSkillsPanelFiltersTogglesAndOpensASkill() throws {
        launchPanelFixture("--ui-test-panels")
        openPanel("Skills")
        assertLoadingResolves("Loading skills...", panel: "Skills")

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
        app.coordinate(withNormalizedOffset: CGVector(
            dx: disabledSkill.frame.midX / app.frame.width,
            dy: disabledSkill.frame.midY / app.frame.height
        )).press(forDuration: 1.2)
        let enable = app.buttons["Enable"].firstMatch
        XCTAssertTrue(enable.awaitExistence(timeout: 5), "The skill row offered no enable action")
        tapCenter(of: enable)
        XCTAssertTrue(
            disabledSkill.awaitNonExistence(timeout: 15),
            "Enabling a skill did not clear its Disabled badge"
        )

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

        leavePanel("Skills")
    }

    func testMemoryPanelSavesASectionThroughItsEditor() throws {
        launchPanelFixture("--ui-test-panels")
        openPanel("Memory")
        assertLoadingResolves("Loading memory...", panel: "Memory")

        XCTAssertTrue(
            element(labelContaining: "Fixture notes body").awaitExistence(timeout: 10),
            "Memory did not render its sections"
        )
        XCTAssertTrue(element(labelContaining: "Fixture user profile").exists)
        XCTAssertTrue(element(labelContaining: "Fixture agent soul").exists)

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

        leavePanel("Memory")
    }

    func testInsightsPanelShowsQuotasAnalyticsAndSwitchesTimeframe() throws {
        launchPanelFixture("--ui-test-panels")
        openPanel("Insights")
        assertLoadingResolves("Loading analytics…", panel: "Insights")

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
        tapCenter(of: app.buttons["7 Days"].firstMatch)
        XCTAssertTrue(
            element(labelContaining: "Last 7 Days").awaitExistence(timeout: 15),
            "Switching the analytics timeframe did not reload the analytics"
        )
        XCTAssertTrue(sessions.exists, "Switching the analytics timeframe lost the loaded analytics")

        leavePanel("Insights")
    }
}

/// Every panel's empty state, reached from payloads that carry no rows.
final class AgentPanelEmptyStateUITests: AgentPanelUITestCase {
    func testEveryAgentPanelShowsItsEmptyState() throws {
        launchPanelFixture("--ui-test-panels-empty")

        let emptyMessages = [
            "Tasks": "No Tasks",
            "Skills": "No Skills",
            "Memory": "No notes yet.",
            "Insights": "No quota sources reported by this server."
        ]

        for panel in Self.panels {
            openPanel(panel)
            if panel == "Kanban" {
                XCTAssertTrue(
                    app.descendants(matching: .any)["KanbanStatusSelector"].awaitExistence(timeout: 15),
                    "The Kanban Board did not load"
                )
                XCTAssertTrue(
                    element(labelled: "No Cards in this Status").awaitExistence(timeout: 10),
                    "Kanban did not show its empty Status"
                )
            } else {
                let message = try XCTUnwrap(emptyMessages[panel])
                let empty = element(labelContaining: message)
                if !empty.awaitExistence(timeout: 15) {
                    let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                    screenshot.name = "\(panel) empty state"
                    screenshot.lifetime = .deleteOnSuccess
                    add(screenshot)
                    XCTFail("\(panel) did not show its empty state")
                }
            }
            leavePanel(panel)
        }
    }
}

/// Every panel's load failure, and its recovery through Try Again on the same screen.
final class AgentPanelRecoveryUITests: AgentPanelUITestCase {
    func testEveryAgentPanelRecoversFromAFailedLoad() throws {
        launchPanelFixture("--ui-test-panels-error")

        let failures = [
            "Tasks": (error: "Could Not Load Tasks", content: "Fixture Nightly Digest"),
            "Skills": (error: "Could Not Load Skills", content: "fixture-runner"),
            "Memory": (error: "Could Not Load Memory", content: "Fixture notes body"),
            "Insights": (error: "Could Not Load Analytics", content: "Sessions")
        ]

        for panel in Self.panels {
            openPanel(panel)
            if panel == "Kanban" {
                tapRetry(in: panel)
                XCTAssertTrue(
                    app.descendants(matching: .any)["KanbanStatusSelector"].awaitExistence(timeout: 20),
                    "Kanban did not recover after Try Again"
                )
            } else {
                let expected = try XCTUnwrap(failures[panel])
                XCTAssertTrue(
                    element(labelContaining: expected.error).awaitExistence(timeout: 15),
                    "\(panel) did not surface its load failure"
                )
                tapRetry(in: panel)
                XCTAssertTrue(
                    element(labelContaining: expected.content).awaitExistence(timeout: 20),
                    "\(panel) did not recover after Try Again"
                )
                XCTAssertFalse(
                    element(labelContaining: expected.error).exists,
                    "\(panel) kept its error state after recovering"
                )
            }
            leavePanel(panel)
        }
    }
}
