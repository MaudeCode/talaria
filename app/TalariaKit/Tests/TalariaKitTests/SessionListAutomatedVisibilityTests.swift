import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit


@MainActor
extension SessionListMutationTests {
    /// The server classifies every row (`source_kind`, TAL-310); the app reads that kind and
    /// never scans source markers, so markers alone classify nothing here.
    func testSourceClassifiersReadTheServerKind() {
        XCTAssertTrue(SessionSummary(sessionId: "s1", sourceKind: .cron).isCronSession)
        XCTAssertTrue(SessionSummary(sessionId: "s2", sourceKind: .webhook).isWebhookSession)
        XCTAssertTrue(SessionSummary(sessionId: "s3", sourceKind: .subagent).isDelegatedSubagentSession)
        XCTAssertTrue(SessionSummary(sessionId: "s4", sourceKind: .claudeCode).isClaudeCodeSession)
        XCTAssertTrue(SessionSummary(sessionId: "s5", sourceKind: .messaging).isMessagingSession)

        let markersOnly = SessionSummary(
            sessionId: "cron_1",
            sourceTag: "webhook",
            rawSource: "signal",
            sessionSource: "subagent",
            sourceLabel: "claude_code"
        )
        XCTAssertFalse(markersOnly.isCronSession)
        XCTAssertFalse(markersOnly.isWebhookSession)
        XCTAssertFalse(markersOnly.isDelegatedSubagentSession)
        XCTAssertFalse(markersOnly.isClaudeCodeSession)
        XCTAssertFalse(markersOnly.isMessagingSession)
    }

    /// An older server sends no `source_kind`: the row is ordinary. A kind this build
    /// does not know is `.other`, also ordinary.
    func testSourceKindDecodesAbsentAndUnknownValuesAsOrdinary() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let absent = try decoder.decode(SessionSummary.self, from: Data(#"{"session_id":"cron_old","source_tag":"cron"}"#.utf8))
        XCTAssertNil(absent.sourceKind)
        XCTAssertFalse(absent.isCronSession)
        let unknown = try decoder.decode(SessionSummary.self, from: Data(#"{"session_id":"s","source_kind":"future_kind"}"#.utf8))
        XCTAssertEqual(unknown.sourceKind, .other)
        XCTAssertTrue(AutomatedSessionVisibility(showsCron: false, showsCli: false).shows(unknown))
    }

    func testAutomatedVisibilityShowAllKeepsEveryKind() {
        let visibility = AutomatedSessionVisibility.showAll
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "cron_1", sourceKind: .cron)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "cli-1", isCliSession: true)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "subagent", sourceKind: .subagent)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "normal")))
    }

    func testAutomatedVisibilityHidesSubagentsByDefaultAndShowsThemWhenEnabled() {
        let child = SessionSummary(sessionId: "subagent", sourceKind: .subagent)
        XCTAssertFalse(AutomatedSessionVisibility(showsCron: true, showsCli: true).shows(child))
        XCTAssertTrue(
            AutomatedSessionVisibility(
                showsCron: true,
                showsCli: true,
                showsSubagents: true
            ).shows(child)
        )
    }

    func testAutomatedVisibilityHidesCronIndependently() {
        let visibility = AutomatedSessionVisibility(showsCron: false, showsCli: true)
        XCTAssertFalse(visibility.shows(SessionSummary(sessionId: "cron_1", sourceKind: .cron)))
        XCTAssertFalse(visibility.shows(SessionSummary(sessionId: "c1", sourceKind: .cron)))
        // CLI and normal sessions stay visible.
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "cli-1", isCliSession: true)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "normal")))
    }

    func testAutomatedVisibilityHidesCliIndependently() {
        let visibility = AutomatedSessionVisibility(showsCron: true, showsCli: false)
        XCTAssertFalse(visibility.shows(SessionSummary(sessionId: "cli-1", isCliSession: true)))
        // Cron and normal sessions stay visible.
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "cron_1", sourceKind: .cron)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "normal")))
    }

    func testAutomatedVisibilityAppliesClaudeCodeChildPreferenceUnderCliParent() {
        let claudeCode = SessionSummary(
            sessionId: "claude-code",
            isCliSession: true,
            sourceKind: .claudeCode
        )
        let ordinaryCli = SessionSummary(sessionId: "ordinary-cli", isCliSession: true)

        let childHidden = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: true,
            showsClaudeCode: false
        )
        XCTAssertFalse(childHidden.shows(claudeCode))
        XCTAssertTrue(childHidden.shows(ordinaryCli))

        let childShown = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: true,
            showsClaudeCode: true
        )
        XCTAssertTrue(childShown.shows(claudeCode))

        let parentHidden = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: false,
            showsClaudeCode: true
        )
        XCTAssertFalse(parentHidden.shows(claudeCode))
        XCTAssertFalse(parentHidden.shows(ordinaryCli))
    }

    func testAutomatedVisibilityHidesBothKinds() {
        let visibility = AutomatedSessionVisibility(showsCron: false, showsCli: false)
        XCTAssertFalse(visibility.shows(SessionSummary(sessionId: "cron_1", sourceKind: .cron)))
        XCTAssertFalse(visibility.shows(SessionSummary(sessionId: "cli-1", isCliSession: true)))
        XCTAssertTrue(visibility.shows(SessionSummary(sessionId: "normal")))
    }

    @MainActor
    func testLoadRequestsAllSessionKindsForTheCompleteLocalCache() async throws {
        let viewModel = try makeViewModel { request in
            let components = URLComponents(
                url: try XCTUnwrap(request.url),
                resolvingAgainstBaseURL: false
            )
            let query = Dictionary(
                uniqueKeysWithValues: (components?.queryItems ?? []).map {
                    ($0.name, $0.value ?? "")
                }
            )
            XCTAssertEqual(query["show_cli_sessions"], "1")
            XCTAssertEqual(query["show_claude_code_sessions"], "1")
            XCTAssertEqual(query["show_cron_sessions"], "1")
            XCTAssertEqual(query["show_webhook_sessions"], "1")
            return apiTestJSONResponse(#"{"sessions":[]}"#, for: request)
        }

        await viewModel.load()

        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testScheduledSessionGroupsSeparatesAndCapsNewestNonArchivedCronSessions() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"ordinary","title":"Ordinary","updated_at":50},
                {"session_id":"cron_1","title":"Scheduled 1","updated_at":10,"source_kind":"cron"},
                {"session_id":"cron_2","title":"Scheduled 2","updated_at":20,"source_kind":"cron"},
                {"session_id":"cron_3","title":"Scheduled 3","updated_at":30,"source_kind":"cron"},
                {"session_id":"cron_4","title":"Scheduled 4","updated_at":40,"source_kind":"cron"},
                {"session_id":"cron_5","title":"Scheduled 5","updated_at":50,"source_kind":"cron"},
                {"session_id":"cron_6","title":"Scheduled 6","updated_at":60,"source_kind":"cron"},
                {"session_id":"cron_7","title":"Scheduled 7","updated_at":70,"source_kind":"cron"},
                {"session_id":"cron_archived","title":"Archived scheduled","updated_at":80,"archived":true,"source_kind":"cron"}
              ]
            }
            """, for: request)
        }

        await viewModel.load()
        let groups = viewModel.scheduledSessionGroups(searchText: "", selectedProjectID: nil)

        XCTAssertEqual(groups.ordinary.compactMap(\.sessionId), ["ordinary"])
        XCTAssertEqual(groups.totalScheduledCount, 7)
        XCTAssertEqual(
            groups.scheduled.compactMap(\.sessionId),
            ["cron_7", "cron_6", "cron_5", "cron_4", "cron_3", "cron_2", "cron_1"]
        )
        XCTAssertEqual(
            groups.scheduledPreview.compactMap(\.sessionId),
            ["cron_7", "cron_6", "cron_5", "cron_4", "cron_3"]
        )
        XCTAssertTrue(groups.hasAdditionalScheduledSessions)
        XCTAssertTrue(groups.showsDisclosure(isSearchActive: false))
    }

    /// The server's 200-row window would make a loaded-row count stop at 200 (TAL-482).
    @MainActor
    func testScheduledSessionGroupsShowServerCountsOverLoadedRows() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"cron_1","title":"Scheduled 1","updated_at":10,"source_kind":"cron"},
                {"session_id":"cron_2","title":"Scheduled 2","updated_at":20,"source_kind":"cron"},
                {"session_id":"hook-1","title":"Hook","updated_at":30,"source_tag":"webhook","source_kind":"webhook"}
              ],
              "scheduled_session_count": 200,
              "scheduled_sessions_truncated": true,
              "webhook_session_count": 3,
              "webhook_sessions_truncated": false
            }
            """, for: request)
        }

        await viewModel.load()
        let groups = viewModel.scheduledSessionGroups(searchText: "", selectedProjectID: nil)

        XCTAssertEqual(groups.totalScheduledCount, 200)
        XCTAssertTrue(groups.scheduledCountIsPartial)
        XCTAssertEqual(groups.totalWebhookCount, 3)
        XCTAssertFalse(groups.webhookCountIsPartial)
        XCTAssertEqual(groups.scheduled.compactMap(\.sessionId), ["cron_2", "cron_1"])

        let hidden = viewModel.scheduledSessionGroups(
            searchText: "",
            selectedProjectID: nil,
            automatedVisibility: AutomatedSessionVisibility(showsCron: false, showsCli: true, showsWebhook: true, showsClaudeCode: true)
        )
        XCTAssertEqual(hidden.totalScheduledCount, 0)
    }

    @MainActor
    func testScheduledSessionGroupsRespectCronVisibilityAndSearchWithoutCappingMatches() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"ordinary","title":"Needle ordinary","updated_at":5},
                {"session_id":"cron_1","title":"Needle scheduled 1","updated_at":10,"source_kind":"cron"},
                {"session_id":"cron_2","title":"Needle scheduled 2","updated_at":20,"source_kind":"cron"},
                {"session_id":"cron_3","title":"Needle scheduled 3","updated_at":30,"source_kind":"cron"},
                {"session_id":"cron_4","title":"Needle scheduled 4","updated_at":40,"source_kind":"cron"},
                {"session_id":"cron_5","title":"Needle scheduled 5","updated_at":50,"source_kind":"cron"},
                {"session_id":"cron_6","title":"Needle scheduled 6","updated_at":60,"source_kind":"cron"}
              ]
            }
            """, for: request)
        }

        await viewModel.load()
        let matches = viewModel.scheduledSessionGroups(searchText: "needle", selectedProjectID: nil)
        XCTAssertEqual(matches.ordinary.compactMap(\.sessionId), ["ordinary"])
        XCTAssertEqual(matches.scheduled.count, 6)
        XCTAssertEqual(matches.totalScheduledCount, 6)
        XCTAssertTrue(matches.showsDisclosure(isSearchActive: true))

        let noScheduledMatches = viewModel.scheduledSessionGroups(
            searchText: "ordinary",
            selectedProjectID: nil
        )
        XCTAssertFalse(noScheduledMatches.showsDisclosure(isSearchActive: true))
        XCTAssertTrue(noScheduledMatches.showsDisclosure(isSearchActive: false))

        let hidden = viewModel.scheduledSessionGroups(
            searchText: "",
            selectedProjectID: nil,
            automatedVisibility: AutomatedSessionVisibility(showsCron: false, showsCli: true)
        )
        XCTAssertTrue(hidden.scheduled.isEmpty)
        XCTAssertEqual(hidden.totalScheduledCount, 0)
        XCTAssertEqual(hidden.ordinary.compactMap(\.sessionId), ["ordinary"])
        XCTAssertFalse(hidden.showsDisclosure(isSearchActive: false))
    }

    @MainActor
    func testScheduledSessionGroupsApplyProjectFilterToScheduledAndOrdinaryRows() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"ordinary-1","title":"Ordinary one","project_id":"project-1"},
                {"session_id":"ordinary-2","title":"Ordinary two","project_id":"project-2"},
                {"session_id":"cron_1","title":"Scheduled one","project_id":"project-1","source_kind":"cron"},
                {"session_id":"cron_2","title":"Scheduled two","project_id":"project-2","source_kind":"cron"}
              ]
            }
            """, for: request)
        }

        await viewModel.load()
        let groups = viewModel.scheduledSessionGroups(
            searchText: "",
            selectedProjectID: "project-1"
        )

        XCTAssertEqual(groups.ordinary.compactMap(\.sessionId), ["ordinary-1"])
        XCTAssertEqual(groups.scheduled.compactMap(\.sessionId), ["cron_1"])
        // The badge is intentionally global even when rows are project-filtered:
        // issue #125 requires the total number of non-archived scheduled sessions.
        XCTAssertEqual(groups.totalScheduledCount, 2)
    }

    @MainActor
    func testWebhookSessionGroupsSeparateArchivedRowsAndCapPreview() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"ordinary","title":"Ordinary","updated_at":50},
                {"session_id":"cron_1","title":"Scheduled","updated_at":60,"source_kind":"cron"},
                {"session_id":"webhook_1","title":"Webhook 1","session_source":"webhook","updated_at":10,"source_kind":"webhook"},
                {"session_id":"webhook_2","title":"Webhook 2","source_tag":"webhook","updated_at":20,"source_kind":"webhook"},
                {"session_id":"webhook_3","title":"Webhook 3","source_tag":"webhook","updated_at":30,"source_kind":"webhook"},
                {"session_id":"webhook_4","title":"Webhook 4","source_tag":"webhook","updated_at":40,"source_kind":"webhook"},
                {"session_id":"webhook_5","title":"Webhook 5","source_tag":"webhook","updated_at":50,"source_kind":"webhook"},
                {"session_id":"webhook_6","title":"Webhook 6","source_tag":"webhook","updated_at":60,"source_kind":"webhook"},
                {"session_id":"webhook_7","title":"Webhook 7","source_tag":"webhook","updated_at":70,"source_kind":"webhook"},
                {"session_id":"webhook_archived","title":"Archived webhook","source_tag":"webhook","updated_at":80,"archived":true,"source_kind":"webhook"}
              ]
            }
            """, for: request)
        }

        await viewModel.load()
        let groups = viewModel.scheduledSessionGroups(searchText: "", selectedProjectID: nil)

        XCTAssertEqual(groups.ordinary.compactMap(\.sessionId), ["ordinary"])
        XCTAssertEqual(groups.scheduled.compactMap(\.sessionId), ["cron_1"])
        XCTAssertEqual(groups.totalWebhookCount, 7)
        XCTAssertEqual(
            groups.webhook.compactMap(\.sessionId),
            ["webhook_7", "webhook_6", "webhook_5", "webhook_4", "webhook_3", "webhook_2", "webhook_1"]
        )
        XCTAssertEqual(
            groups.webhookPreview.compactMap(\.sessionId),
            ["webhook_7", "webhook_6", "webhook_5", "webhook_4", "webhook_3"]
        )
        XCTAssertTrue(groups.hasAdditionalWebhookSessions)
        XCTAssertTrue(groups.showsWebhookDisclosure(isSearchActive: false))

        let hiddenGroups = viewModel.scheduledSessionGroups(
            searchText: "",
            selectedProjectID: nil,
            automatedVisibility: AutomatedSessionVisibility(
                showsCron: true,
                showsCli: true,
                showsWebhook: false
            )
        )
        XCTAssertEqual(hiddenGroups.ordinary.compactMap(\.sessionId), ["ordinary"])
        XCTAssertTrue(hiddenGroups.webhook.isEmpty)
        XCTAssertEqual(hiddenGroups.totalWebhookCount, 0)
        XCTAssertFalse(hiddenGroups.showsWebhookDisclosure(isSearchActive: false))
    }

    @MainActor
    func testWebhookSessionGroupsRespectSearchAndProjectFilter() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id":"ordinary-1","title":"Needle ordinary","project_id":"project-1"},
                {"session_id":"webhook-1","title":"Needle webhook","source_tag":"webhook","project_id":"project-1","source_kind":"webhook"},
                {"session_id":"webhook-2","title":"Other webhook","session_source":"webhook","project_id":"project-2","source_kind":"webhook"}
              ]
            }
            """, for: request)
        }

        await viewModel.load()
        let matches = viewModel.scheduledSessionGroups(
            searchText: "needle",
            selectedProjectID: "project-1"
        )

        XCTAssertEqual(matches.ordinary.compactMap(\.sessionId), ["ordinary-1"])
        XCTAssertEqual(matches.webhook.compactMap(\.sessionId), ["webhook-1"])
        XCTAssertEqual(matches.totalWebhookCount, 2)
        XCTAssertTrue(matches.showsWebhookDisclosure(isSearchActive: true))

        let noWebhookMatches = viewModel.scheduledSessionGroups(
            searchText: "ordinary",
            selectedProjectID: "project-1"
        )
        XCTAssertFalse(noWebhookMatches.showsWebhookDisclosure(isSearchActive: true))
        XCTAssertTrue(noWebhookMatches.showsWebhookDisclosure(isSearchActive: false))
    }

    @MainActor
    func testVisibleSessionsFiltersCronAndCliIndependently() async throws {
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            return apiTestJSONResponse("""
            {
              "sessions": [
                {"session_id": "normal-1", "title": "Normal one", "last_message_at": 50, "archived": false},
                {"session_id": "cron_job_1", "title": "Nightly digest", "last_message_at": 40, "archived": false, "source_kind": "cron"},
                {"session_id": "tagged-cron", "title": "Tagged cron", "source_tag": "cron", "last_message_at": 30, "archived": false, "source_kind": "cron"},
                {"session_id": "cli-1", "title": "CLI import", "is_cli_session": true, "last_message_at": 20, "archived": false, "source_kind": "cli"},
                {"session_id": "normal-2", "title": "Normal two", "last_message_at": 10, "archived": false}
              ]
            }
            """, for: request)
        }

        await viewModel.load()

        // Default keeps every row.
        XCTAssertEqual(
            Set(viewModel.visibleSessions(searchText: "", selectedProjectID: nil).compactMap(\.sessionId)),
            ["normal-1", "cron_job_1", "tagged-cron", "cli-1", "normal-2"]
        )

        // Hiding cron only removes cron rows; CLI and normal rows stay.
        XCTAssertEqual(
            Set(viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: nil,
                automatedVisibility: AutomatedSessionVisibility(showsCron: false, showsCli: true)
            ).compactMap(\.sessionId)),
            ["normal-1", "cli-1", "normal-2"]
        )

        // Hiding CLI only removes the CLI row; cron and normal rows stay.
        XCTAssertEqual(
            Set(viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: nil,
                automatedVisibility: AutomatedSessionVisibility(showsCron: true, showsCli: false)
            ).compactMap(\.sessionId)),
            ["normal-1", "cron_job_1", "tagged-cron", "normal-2"]
        )

        // Hiding both leaves only the normal WebUI sessions, newest first.
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: nil,
                automatedVisibility: AutomatedSessionVisibility(showsCron: false, showsCli: false)
            ).compactMap(\.sessionId),
            ["normal-1", "normal-2"]
        )
    }

    @MainActor
    func testVisibleSessionsFiltersSubagentsAcrossSearchAndProjects() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "normal-p1", "title": "Planning", "project_id": "p1", "last_message_at": 40},
                    {"session_id": "subagent-p1", "title": "Delegated research", "project_id": "p1", "source_tag": "subagent", "read_only": true, "last_message_at": 30, "source_kind": "subagent"},
                    {"session_id": "fork-p1", "title": "Ordinary fork", "project_id": "p1", "parent_session_id": "normal-p1", "relationship_type": "fork", "last_message_at": 20},
                    {"session_id": "normal-p2", "title": "Other project", "project_id": "p2", "last_message_at": 10}
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "subagent-p1", "title": "Delegated research", "match_type": "content"},
                    {"session_id": "normal-p2", "title": "Other project", "match_type": "content"}
                  ],
                  "query": "needle",
                  "count": 2
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        let hidden = AutomatedSessionVisibility(showsCron: true, showsCli: true)
        let shown = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: true,
            showsSubagents: true
        )

        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: "p1",
                automatedVisibility: hidden
            ).compactMap(\.sessionId),
            ["normal-p1", "fork-p1"]
        )
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: "p1",
                automatedVisibility: shown
            ).compactMap(\.sessionId),
            ["normal-p1", "subagent-p1", "fork-p1"]
        )
        XCTAssertTrue(
            viewModel.visibleSessions(
                searchText: "delegated",
                selectedProjectID: nil,
                automatedVisibility: hidden
            ).isEmpty
        )
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "delegated",
                selectedProjectID: nil,
                automatedVisibility: shown
            ).compactMap(\.sessionId),
            ["subagent-p1"]
        )

        await viewModel.searchSessions(query: "needle", debounceNanoseconds: 0)

        XCTAssertTrue(
            viewModel.visibleSessions(
                searchText: "needle",
                selectedProjectID: "p1",
                automatedVisibility: hidden
            ).isEmpty
        )
        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "needle",
                selectedProjectID: "p1",
                automatedVisibility: shown
            ).compactMap(\.sessionId),
            ["subagent-p1"]
        )
    }

    @MainActor
    func testVisibleSessionsFiltersClaudeCodeAcrossSearchAndProjects() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "normal-p1", "title": "Planning", "project_id": "p1", "last_message_at": 40},
                    {"session_id": "claude-p1", "title": "Imported transcript", "project_id": "p1", "source_tag": "claude_code", "raw_source": "claude_code", "is_cli_session": true, "read_only": true, "last_message_at": 30, "source_kind": "claude_code"},
                    {"session_id": "cli-p1", "title": "Terminal chat", "project_id": "p1", "source_tag": "cli", "is_cli_session": true, "last_message_at": 20, "source_kind": "cli"},
                    {"session_id": "normal-p2", "title": "Other project", "project_id": "p2", "last_message_at": 10}
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "claude-p1", "title": "Imported transcript", "match_type": "content"},
                    {"session_id": "cli-p1", "title": "Terminal chat", "match_type": "content"}
                  ],
                  "query": "needle",
                  "count": 2
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        let hidden = AutomatedSessionVisibility(
            showsCron: true,
            showsCli: true,
            showsClaudeCode: false
        )

        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "",
                selectedProjectID: "p1",
                automatedVisibility: hidden
            ).compactMap(\.sessionId),
            ["normal-p1", "cli-p1"]
        )

        await viewModel.searchSessions(query: "needle", debounceNanoseconds: 0)

        XCTAssertEqual(
            viewModel.visibleSessions(
                searchText: "needle",
                selectedProjectID: "p1",
                automatedVisibility: hidden
            ).compactMap(\.sessionId),
            ["cli-p1"]
        )
    }
}
