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

    func testRunningChatsNeverOpenedHereArePrefetchedOncePerRun() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "Already here", timestamp: 1, messageId: "m1")],
            serverURL: server,
            sessionID: "running-cached",
            in: context
        )
        let sessionReads = RecordedSessionIDs()
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {"sessions": [
                  {"session_id": "running-elsewhere", "title": "Started on the web", "is_streaming": true, "active_stream_id": "stream-1"},
                  {"session_id": "running-cached", "title": "Opened here", "is_streaming": true, "active_stream_id": "stream-2"},
                  {"session_id": "idle", "title": "Idle", "is_streaming": false}
                ]}
                """, for: request)
            case "/api/session":
                let id = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "session_id" }?.value ?? ""
                sessionReads.append(id)
                return apiTestJSONResponse("""
                {"session": {"session_id": "\(id)", "messages": [
                  {"role": "user", "content": "Asked on the web", "timestamp": 1770000100, "message_id": "u1"}
                ]}}
                """, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await viewModel.load(modelContext: context)

        await viewModel.prefetchRunningTranscripts(modelContext: context)
        await viewModel.prefetchRunningTranscripts(modelContext: context)

        XCTAssertEqual(sessionReads.values, ["running-elsewhere"], "Only the running chat with no saved transcript, once")
        XCTAssertEqual(
            try CacheStore.cachedMessages(serverURL: server, sessionID: "running-elsewhere", in: context).compactMap(\.content),
            ["Asked on the web"]
        )
    }

    func testPrefetchNeverOverwritesATranscriptSavedWhileItWasInFlight() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let requestArrived = expectation(description: "Prefetch request in flight")
        let release = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {"sessions": [{"session_id": "running", "title": "Running", "is_streaming": true, "active_stream_id": "s1"}]}
                """, for: request)
            case "/api/session":
                requestArrived.fulfill()
                release.wait()
                return apiTestJSONResponse("""
                {"session": {"session_id": "running", "messages": [
                  {"role": "user", "content": "Older page", "timestamp": 1770000100, "message_id": "u1"}
                ]}}
                """, for: request)
            default:
                XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
        await viewModel.load(modelContext: context)

        let prefetch = Task { await viewModel.prefetchRunningTranscripts(modelContext: context) }
        await fulfillment(of: [requestArrived], timeout: 5)
        // The user opens the chat and leaves it while the prefetch waits on the server.
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "Newer, saved by the chat", timestamp: 2, messageId: "u2")],
            serverURL: server,
            sessionID: "running",
            in: context
        )
        release.signal()
        await prefetch.value

        XCTAssertEqual(
            try CacheStore.cachedMessages(serverURL: server, sessionID: "running", in: context).compactMap(\.content),
            ["Newer, saved by the chat"]
        )
    }

    func testCachedRowsKeepTheServersLatestOrder() throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        func rows(_ ids: [String]) -> [SessionSummary] {
            ids.map { SessionSummary(sessionId: $0, title: $0, archived: false) }
        }
        try CacheStore.cacheSessions(rows(["a", "b", "c", "d"]), serverURL: server, in: context)
        try CacheStore.cacheSessions(rows(["c", "a", "d", "b"]), serverURL: server, in: context)

        XCTAssertEqual(
            try CacheStore.cachedSessions(serverURL: server, in: context).compactMap(\.sessionId),
            ["c", "a", "d", "b"]
        )
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

private final class RecordedSessionIDs: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    func append(_ id: String) {
        lock.withLock { recorded.append(id) }
    }

    var values: [String] {
        lock.withLock { recorded }
    }
}
