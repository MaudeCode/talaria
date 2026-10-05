import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit


@MainActor
extension SessionListMutationTests {
    func testRemoteSessionSearchShowsTheServerResultInItsOrderAndTitlesWhileItLoads() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "local-title", "title": "Needle planning", "last_message_at": 30, "archived": false},
                    {"session_id": "content-hit", "title": "Budget", "last_message_at": 20, "archived": false},
                    {"session_id": "no-match", "title": "Roadmap", "model": "needle-model", "last_message_at": 40, "archived": false}
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query["q"], "needle")
                XCTAssertEqual(query["content"], "1")
                XCTAssertEqual(query["depth"], "5")
                XCTAssertEqual(query["include_archived"], "0")

                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "not-loaded", "title": "Older content", "match_type": "content"},
                    {"session_id": "content-hit", "title": "Budget", "match_type": "content"},
                    {"session_id": "local-title", "title": "Needle planning", "match_type": "title"}
                  ],
                  "query": "needle",
                  "count": 3,
                  "sidebar_filtered": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        // Before the server answers, only titles match locally.
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: nil).compactMap(\.sessionId),
            ["local-title"]
        )

        await viewModel.searchSessions(query: "needle", debounceNanoseconds: 0)

        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: nil).compactMap(\.sessionId),
            ["not-loaded", "content-hit", "local-title"]
        )
    }

    @MainActor
    func testRemoteSessionSearchShowsAServerMatchForWordsInAnotherOrder() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {"sessions": [{"session_id": "relay", "title": "Relay deploy checklist", "last_message_at": 30, "archived": false}]}
                """, for: request)
            case "/api/sessions/search":
                return apiTestJSONResponse("""
                {
                  "sessions": [{"session_id": "relay", "title": "Relay deploy checklist", "match_type": "title"}],
                  "query": "deploy relay",
                  "count": 1,
                  "sidebar_filtered": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.searchSessions(query: "deploy relay", debounceNanoseconds: 0)

        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "deploy relay", selectedProjectID: nil).compactMap(\.sessionId),
            ["relay"]
        )
    }

    @MainActor
    func testRemoteSessionSearchSendsTheSelectedProjectAndVisibility() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "in-project", "title": "Budget", "project_id": "project-1", "last_message_at": 20},
                    {"session_id": "other-project", "title": "Needle roadmap", "project_id": "project-2", "last_message_at": 40}
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query["project_id"], "project-1")
                XCTAssertEqual(query["include_archived"], "0")
                XCTAssertEqual(query["show_cli_sessions"], "0")
                XCTAssertEqual(query["show_cron_sessions"], "1")
                XCTAssertEqual(query["show_webhook_sessions"], "1")
                XCTAssertEqual(query["show_claude_code_sessions"], "1")

                return apiTestJSONResponse("""
                {
                  "sessions": [{"session_id": "in-project", "title": "Budget", "project_id": "project-1", "match_type": "metadata"}],
                  "query": "needle",
                  "count": 1,
                  "sidebar_filtered": true
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        let visibility = AutomatedSessionVisibility(showsCron: true, showsCli: false)
        await viewModel.searchSessions(
            query: "needle",
            selectedProjectID: "project-1",
            automatedVisibility: visibility,
            debounceNanoseconds: 0
        )

        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: "project-1", automatedVisibility: visibility)
                .compactMap(\.sessionId),
            ["in-project"]
        )
        // Another project is a different search: until it is answered, only its titles match.
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: "project-2", automatedVisibility: visibility)
                .compactMap(\.sessionId),
            ["other-project"]
        )
    }

    @MainActor
    func testRemoteSessionSearchFromAnOldServerKeepsOnlyRowsTheListShows() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "local-title", "title": "Needle planning", "project_id": "project-1", "last_message_at": 30, "archived": false},
                    {"session_id": "content-project", "title": "Budget", "project_id": "project-1", "last_message_at": 20, "archived": false},
                    {"session_id": "content-other-project", "title": "Roadmap", "project_id": "project-2", "last_message_at": 40, "archived": false},
                    {"session_id": "archived-session", "title": "Archived", "project_id": "project-1", "archived": true}
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "content-project", "title": "Budget", "match_type": "content"},
                    {"session_id": "content-other-project", "title": "Roadmap", "match_type": "content"},
                    {"session_id": "unknown-session", "title": "Unknown", "match_type": "content"},
                    {"session_id": "archived-session", "title": "Archived", "match_type": "content"}
                  ],
                  "query": "needle",
                  "count": 4
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.searchSessions(query: "needle", selectedProjectID: "project-1", debounceNanoseconds: 0)

        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: "project-1").compactMap(\.sessionId),
            ["local-title", "content-project"]
        )
    }

    @MainActor
    func testRemoteSessionSearchIgnoresStaleResultsWhenQueryChanges() async throws {
        let oldSearchStarted = expectation(description: "old search started")
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {
                      "session_id": "old-content",
                      "title": "First result",
                      "archived": false
                    },
                    {
                      "session_id": "new-content",
                      "title": "Second result",
                      "archived": false
                    }
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                let searchQuery = query["q"] ?? ""

                if searchQuery == "old" {
                    oldSearchStarted.fulfill()
                    Thread.sleep(forTimeInterval: 0.15)
                    return apiTestJSONResponse("""
                    {
                      "sessions": [
                        {"session_id": "old-content", "title": "First result", "match_type": "content"}
                      ],
                      "query": "old",
                      "count": 1
                    }
                    """, for: request)
                }

                if searchQuery == "new" {
                    return apiTestJSONResponse("""
                    {
                      "sessions": [
                        {"session_id": "new-content", "title": "Second result", "match_type": "content", "match_preview": "second preview"}
                      ],
                      "query": "new",
                      "count": 1
                    }
                    """, for: request)
                }

                XCTFail("Unexpected search query: \(searchQuery)")
                throw URLError(.badURL)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        let oldTask = Task {
            await viewModel.searchSessions(query: "old", debounceNanoseconds: 0)
        }
        await fulfillment(of: [oldSearchStarted], timeout: 10)

        await viewModel.searchSessions(query: "new", debounceNanoseconds: 0)
        await oldTask.value

        XCTAssertEqual(viewModel.remoteSearchResults?.compactMap(\.sessionId), ["new-content"])
        XCTAssertEqual(viewModel.remoteContentSearchPreviews, ["new-content": "second preview"])
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "new", selectedProjectID: nil).compactMap(\.sessionId),
            ["new-content"]
        )
    }

    // MARK: - Content-match excerpts (TAL-164)

    private static let previewSessionsJSON = """
    {
      "sessions": [
        {"session_id": "with-preview", "title": "Budget", "archived": false},
        {"session_id": "without-preview", "title": "Roadmap", "archived": false},
        {"session_id": "blank-preview", "title": "Notes", "archived": false},
        {"session_id": "title-hit", "title": "Needle planning", "archived": false}
      ]
    }
    """

    private static let previewSearchJSON = """
    {
      "sessions": [
        {"session_id": "with-preview", "match_type": "content", "match_preview": "  the\\n[REDACTED]  needle\\tcafé "},
        {"session_id": "without-preview", "match_type": "content"},
        {"session_id": "blank-preview", "match_type": "content", "match_preview": " \\n "},
        {"session_id": "title-hit", "match_type": "title", "match_preview": "never shown"},
        {"session_id": "not-loaded", "match_type": "content", "match_preview": "not visible"}
      ],
      "query": "needle",
      "count": 5
    }
    """

    @MainActor
    func testContentMatchPreviewFollowsVisibleContentMatchesAndTheActiveQuery() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse(Self.previewSessionsJSON, for: request)
            case "/api/sessions/search":
                return apiTestJSONResponse(Self.previewSearchJSON, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.searchSessions(query: " Needle ", debounceNanoseconds: 0)

        // Whitespace collapses like upstream; redaction markers pass through untouched.
        XCTAssertEqual(
            viewModel.remoteContentSearchPreviews,
            ["with-preview": "the [REDACTED] needle café", "not-loaded": "not visible"]
        )
        XCTAssertEqual(
            viewModel.remoteSearchResults?.compactMap(\.sessionId),
            ["with-preview", "without-preview", "blank-preview", "title-hit", "not-loaded"]
        )

        let rows = Dictionary(
            uniqueKeysWithValues: viewModel.visibleSessions(searchText: "needle", selectedProjectID: nil)
                .map { ($0.sessionId ?? "", $0) }
        )
        let withPreview = try XCTUnwrap(rows["with-preview"])
        XCTAssertEqual(
            viewModel.contentMatchPreview(for: withPreview, searchText: "needle"),
            "the [REDACTED] needle café"
        )
        XCTAssertNil(viewModel.contentMatchPreview(for: try XCTUnwrap(rows["without-preview"]), searchText: "needle"))
        XCTAssertNil(viewModel.contentMatchPreview(for: try XCTUnwrap(rows["blank-preview"]), searchText: "needle"))
        XCTAssertNil(viewModel.contentMatchPreview(for: try XCTUnwrap(rows["title-hit"]), searchText: "needle"))

        // Text typed ahead of the debounced remote search must not reuse the old excerpt.
        XCTAssertNil(viewModel.contentMatchPreview(for: withPreview, searchText: "needles"))
        XCTAssertNil(viewModel.contentMatchPreview(for: withPreview, searchText: ""))

        viewModel.clearSearchResults()
        XCTAssertTrue(viewModel.remoteContentSearchPreviews.isEmpty)
        XCTAssertNil(viewModel.contentMatchPreview(for: withPreview, searchText: "needle"))
    }

    @MainActor
    func testContentMatchPreviewsClearWhenTheSearchFails() async throws {
        var searchCount = 0
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse(Self.previewSessionsJSON, for: request)
            case "/api/sessions/search":
                searchCount += 1
                if searchCount == 1 {
                    return apiTestJSONResponse(Self.previewSearchJSON, for: request)
                }
                throw URLError(.notConnectedToInternet)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.searchSessions(query: "needle", debounceNanoseconds: 0)
        XCTAssertFalse(viewModel.remoteContentSearchPreviews.isEmpty)

        await viewModel.searchSessions(query: "needle again", debounceNanoseconds: 0)

        XCTAssertNotNil(viewModel.searchErrorMessage)
        XCTAssertTrue(viewModel.remoteContentSearchPreviews.isEmpty)
        XCTAssertNil(viewModel.remoteSearchResults)
    }

    func testHighlightedPreviewEmphasizesEveryHitAcrossUnicodeForms() {
        let composedQuery = "caf\u{E9}"
        let decomposedPreview = "Caf\u{65}\u{301} first, then cafe\u{301} again, [REDACTED] kept"

        let highlighted = SessionRowPresentation.highlightedPreview(decomposedPreview, query: composedQuery)

        XCTAssertEqual(String(highlighted.characters), decomposedPreview)
        let hits = highlighted.runs.filter { $0.foregroundColor == .primary }.map { String(highlighted[$0.range].characters) }
        XCTAssertEqual(hits.count, 2)
        XCTAssertTrue(hits.allSatisfy { $0.caseInsensitiveCompare(composedQuery) == .orderedSame })
        XCTAssertTrue(highlighted.runs.allSatisfy { $0.foregroundColor == .primary || $0.foregroundColor == nil })
    }

    func testHighlightedPreviewCollapsesQueryWhitespaceLikeTheExcerpt() {
        let highlighted = SessionRowPresentation.highlightedPreview("the billing plan", query: " billing \n plan ")

        let hits = highlighted.runs.filter { $0.foregroundColor == .primary }.map { String(highlighted[$0.range].characters) }
        XCTAssertEqual(hits, ["billing plan"])
    }

    func testHighlightedPreviewLeavesUnmatchedTextAlone() {
        let highlighted = SessionRowPresentation.highlightedPreview("sk-[REDACTED] only", query: "sk-live")

        XCTAssertEqual(String(highlighted.characters), "sk-[REDACTED] only")
        XCTAssertTrue(highlighted.runs.allSatisfy { $0.foregroundColor == nil && $0.font == nil })
        XCTAssertTrue(
            SessionRowPresentation.highlightedPreview("anything", query: "   ").runs.allSatisfy { $0.foregroundColor == nil }
        )
    }

    // MARK: - Cron/CLI session classification (#256)

}
