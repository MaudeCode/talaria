import XCTest
@testable import TalariaKit

/// The load states the agent panels and the workspace and Settings screens render, asserted on
/// their view models with the payloads the UI fixture served. Each screen shows its empty state
/// when loading finished without an error or rows, and its failure with Try Again when loading
/// failed without rows; a retry that succeeds replaces the failure. Formerly
/// `AgentPanelEmptyStateUITests` and `ReadFailureUITests` (TAL-402).
@MainActor
final class ScreenLoadStateTests: APIClientTestCase {
    private static let server = URL(string: "https://example.test")!

    private func failing(_ request: URLRequest) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
        return (response, Data(#"{"error":"Fixture read failure"}"#.utf8))
    }

    private func session() throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data(#"{"session_id": "ui-fixture-session", "title": "T", "workspace": "/fixture"}"#.utf8)
        )
    }

    // MARK: - Agent panel empty states (TasksView "No Tasks", SkillsView "No Skills", …)

    func testTasksWithNoJobsShowTheEmptyState() async {
        let client = makeClient { request in
            switch request.url?.path {
            case "/api/crons": return apiTestJSONResponse(#"{"jobs":[]}"#, for: request)
            case "/api/crons/status": return apiTestJSONResponse(#"{"running":{}}"#, for: request)
            default: return apiTestJSONResponse(#"{"platforms":[]}"#, for: request)
            }
        }
        let model = TasksViewModel(server: Self.server, client: client)

        await model.load()

        // TasksView: not loading, no error, no jobs -> "No Tasks".
        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.jobs.isEmpty)
    }

    func testSkillsWithNoSkillsShowTheEmptyState() async {
        let client = makeClient { request in apiTestJSONResponse(#"{"skills":[]}"#, for: request) }
        let model = SkillsViewModel(client: client)

        await model.load()

        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.skills.isEmpty)
    }

    func testMemoryWithBlankSectionsShowsEachSectionsEmptyMessage() async {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"memory":"","user":"","soul":""}"#, for: request)
        }
        let model = MemoryViewModel(server: Self.server, client: client)

        await model.load()

        // MemorySectionContent shows the section's empty message ("No notes yet.") for blank content.
        XCTAssertTrue(model.hasLoaded)
        XCTAssertNil(model.errorMessage)
        for section in [MemorySection.memory, .user, .soul] {
            XCTAssertTrue(model.content(for: section).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    // MARK: - Workspace and Settings read failures

    func testFailedListingShowsTheFailureThenRetryLoadsTheRoot() async throws {
        var fails = true
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/list")
            if fails { return self.failing(request) }
            return apiTestJSONResponse("""
            {"path":".","workspace":"/fixture","entries":[{"name":"fixture-notes.txt","path":"fixture-notes.txt","type":"file","size":52,"is_dir":false}]}
            """, for: request)
        }
        let model = FileBrowserViewModel(session: try session(), server: Self.server, apiClient: client)

        await model.loadInitialRootIfNeeded()

        // FileBrowserView: an error and no entries -> "Could Not Load Files" with Try Again.
        XCTAssertFalse(model.isLoading)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertTrue(model.entries.isEmpty)

        fails = false
        await model.retryLastLoad()
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.entries.map(\.name), ["fixture-notes.txt"])
    }

    func testFailedGitStatusMarksTheMenuUnavailableAndTheSheetFailed() async throws {
        let client = makeClient { request in
            if request.url?.path == "/api/git-info" {
                return apiTestJSONResponse(#"{"git": {"is_git": true, "branch": "fixture-main"}}"#, for: request)
            }
            return self.failing(request)
        }
        let availability = GitWorkspaceAvailabilityViewModel(session: try session(), server: Self.server, apiClient: client)
        await availability.load()

        // ChatView builds the Git menu's presentation from these fields.
        let presentation = GitToolbarPresentation(
            hasRepository: availability.hasRepository,
            isLoading: availability.isLoading || availability.isStatusLoading,
            info: availability.gitInfo,
            status: availability.status,
            statusFailed: availability.statusError != nil
        )
        XCTAssertEqual(presentation.changesTitle, "Changes unavailable")
        XCTAssertTrue(presentation.changesAreEnabled, "A failed status must still open the sheet")

        // GitWorkspaceView: an error and no status -> "Could Not Load Changes" with Try Again.
        let sheet = GitWorkspaceViewModel(session: try session(), server: Self.server, apiClient: client)
        await sheet.load()
        XCTAssertFalse(sheet.isLoading)
        XCTAssertNil(sheet.status)
        XCTAssertNotNil(sheet.errorMessage)
    }

    func testFailedArchivedLoadShowsTheFailureThenRetryLoadsTheSessions() async {
        var fails = true
        let client = makeClient { request in
            if fails { return self.failing(request) }
            return apiTestJSONResponse("""
            {"archived_count":1,"sessions":[{"session_id":"ui-fixture-archived-session",\
            "title":"Fixture Archived Session","archived":true,"message_count":3}]}
            """, for: request)
        }
        let model = ArchivedSessionsViewModel(server: Self.server, client: client)

        await model.load()

        // ArchivedSessionsView: an error and no sessions -> "Could not load archived sessions" with Try Again.
        XCTAssertFalse(model.isLoading)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertTrue(model.sessions.isEmpty)

        fails = false
        await model.load()
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.sessions.map(\.title), ["Fixture Archived Session"])
    }
}

@MainActor
extension KanbanFeatureStateTests {
    /// KanbanStatusFocusView shows "No Cards in this Status" when a loaded Board has no visible
    /// Cards and no filters (formerly `AgentPanelEmptyStateUITests`, TAL-402).
    func testBoardWithNoCardsShowsTheEmptyStatus() async {
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: KanbanClientStub())

        await state.load()

        XCTAssertEqual(state.state, .compatible)
        XCTAssertNotNil(state.snapshot)
        XCTAssertTrue(state.visibleCards.isEmpty)
        XCTAssertFalse(state.hasActiveFilters)
    }
}
