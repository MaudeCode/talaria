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

        viewModel.paintCachedStateIfEmpty(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["cached-1"], "Only this server's saved rows")
        XCTAssertFalse(viewModel.isViewingCachedData, "Painting from cache is not offline mode")
        XCTAssertEqual(requests.count, 0, "The paint itself makes no request")

        await viewModel.load(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["server-1"])
        XCTAssertFalse(viewModel.isViewingCachedData)
    }

    func testRelaunchShowsTheLastProjectsAndActiveProfileBeforeTheyLoad() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cache = makeResponseCache(server: server)
        let client = try makeClient(server: server) { request in
            switch request.url?.path {
            case "/api/projects":
                return apiTestJSONResponse(#"{"projects": [{"project_id": "p1", "name": "Launch"}]}"#, for: request)
            case "/api/profiles":
                return apiTestJSONResponse(
                    #"{"active": "work", "profiles": [{"name": "default", "is_default": true}, {"name": "work", "is_active": true}]}"#,
                    for: request
                )
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        let firstLaunch = SessionListViewModel(server: server, client: client, responseCache: cache)
        await firstLaunch.loadProjects(silently: true)
        await firstLaunch.loadActiveProfile()

        let requests = LockedCounter()
        let relaunchClient = try makeClient(server: server) { request in
            _ = requests.increment()
            throw URLError(.notConnectedToInternet)
        }
        let relaunch = SessionListViewModel(server: server, client: relaunchClient, responseCache: cache)
        relaunch.paintCachedStateIfEmpty(modelContext: try makeContext())

        XCTAssertEqual(relaunch.projects.compactMap(\.projectId), ["p1"])
        XCTAssertEqual(relaunch.activeProfileName, "work")
        XCTAssertEqual(requests.count, 0)
        XCTAssertFalse(relaunch.isViewingCachedData)
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

        viewModel.paintCachedStateIfEmpty(modelContext: context)

        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["server-1"])
    }
}
