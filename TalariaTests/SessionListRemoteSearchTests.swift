import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria


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
                        {"session_id": "new-content", "title": "Second result", "match_type": "content"}
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
        await fulfillment(of: [oldSearchStarted], timeout: 1)

        await viewModel.searchSessions(query: "new", debounceNanoseconds: 0)
        await oldTask.value

        XCTAssertEqual(viewModel.remoteContentSearchSessionIDs, ["new-content"])
        XCTAssertEqual(
            viewModel.visibleSessions(searchText: "new", selectedProjectID: nil).compactMap(\.sessionId),
            ["new-content"]
        )
    }

    // MARK: - Cron/CLI session classification (#256)

}
