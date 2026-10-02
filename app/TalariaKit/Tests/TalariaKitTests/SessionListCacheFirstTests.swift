import SwiftData
import XCTest
@testable import TalariaKit

// TAL-437: a cold launch shows the last-known chats at once, then the server's.
@MainActor
extension SessionListMutationTests {
    func testColdListPaintsCachedRowsBeforeTheServerAnswersWithoutGoingOffline() async throws {
        let context = try makeContext()
        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "cached-1", title: "Cached chat", archived: false)],
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            in: context
        )
        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "other-server", title: "Elsewhere", archived: false)],
            serverURL: try XCTUnwrap(URL(string: "https://other.example.test")),
            in: context
        )
        let requests = LockedCounter()
        let viewModel = try makeViewModel { request in
            _ = requests.increment()
            return apiTestJSONResponse(
                #"{"sessions": [{"session_id": "server-1", "title": "From the server"}]}"#,
                for: request
            )
        }

        viewModel.paintCachedSessionsIfEmpty(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["cached-1"], "Only this server's saved rows")
        XCTAssertFalse(viewModel.isViewingCachedData, "Painting from cache is not offline mode")
        XCTAssertEqual(requests.count, 0, "The paint itself makes no request")

        await viewModel.load(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["server-1"])
        XCTAssertFalse(viewModel.isViewingCachedData)
    }

    func testCachedPaintNeverReplacesRowsAlreadyLoaded() async throws {
        let context = try makeContext()
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse(#"{"sessions": [{"session_id": "server-1", "title": "From the server"}]}"#, for: request)
        }
        await viewModel.load(modelContext: context)
        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "stale", title: "Stale", archived: false)],
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            in: context
        )

        viewModel.paintCachedSessionsIfEmpty(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["server-1"])
    }
}
