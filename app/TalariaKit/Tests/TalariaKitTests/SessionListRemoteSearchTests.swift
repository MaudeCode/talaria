import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit


@MainActor
extension SessionListMutationTests {
    func testRemoteSessionSearchAppendsLoadedContentMatchesAfterLocalMatchesAndPreservesProjectScope() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {
                      "session_id": "local-title",
                      "title": "Needle planning",
                      "project_id": "project-1",
                      "last_message_at": 30,
                      "archived": false
                    },
                    {
                      "session_id": "content-project",
                      "title": "Budget",
                      "project_id": "project-1",
                      "last_message_at": 20,
                      "archived": false
                    },
                    {
                      "session_id": "content-other-project",
                      "title": "Roadmap",
                      "project_id": "project-2",
                      "last_message_at": 40,
                      "archived": false
                    },
                    {
                      "session_id": "archived-session",
                      "title": "Archived",
                      "project_id": "project-1",
                      "archived": true
                    }
                  ]
                }
                """, for: request)
            case "/api/sessions/search":
                let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
                let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query["q"], "needle")
                XCTAssertEqual(query["content"], "1")
                XCTAssertEqual(query["depth"], "5")

                return apiTestJSONResponse("""
                {
                  "sessions": [
                    {"session_id": "content-project", "title": "Budget", "match_type": "content"},
                    {"session_id": "content-other-project", "title": "Roadmap", "match_type": "content"},
                    {"session_id": "local-title", "title": "Needle planning", "match_type": "content"},
                    {"session_id": "unknown-session", "title": "Unknown", "match_type": "content"},
                    {"session_id": "archived-session", "title": "Archived", "match_type": "content"},
                    {"session_id": "title-only", "title": "Needle remote", "match_type": "title"}
                  ],
                  "query": "needle",
                  "count": 6
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        await viewModel.load()
        await viewModel.searchSessions(query: "needle", debounceNanoseconds: 0)

        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: "project-1").compactMap(\.sessionId),
            ["local-title", "content-project"]
        )
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: "project-2").compactMap(\.sessionId),
            ["content-other-project"]
        )
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "needle", selectedProjectID: nil).compactMap(\.sessionId),
            ["local-title", "content-other-project", "content-project"]
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

        XCTAssertEqual(viewModel.remoteContentSearchSessionIDs, ["new-content"])
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
        XCTAssertEqual(viewModel.remoteContentSearchPreviews, ["with-preview": "the [REDACTED] needle café"])
        XCTAssertEqual(
            Set(viewModel.remoteContentSearchSessionIDs),
            ["with-preview", "without-preview", "blank-preview"]
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
        XCTAssertTrue(viewModel.remoteContentSearchSessionIDs.isEmpty)
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
