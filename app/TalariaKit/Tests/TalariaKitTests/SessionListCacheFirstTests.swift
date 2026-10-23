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

    func testAServerErrorAfterTheCachedPaintShowsTheErrorInsteadOfStaleRows() async throws {
        let context = try makeContext()
        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "cached-1", title: "Cached chat", archived: false)],
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            in: context
        )
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse(#"{"error": "Server error"}"#, statusCode: 500, for: request)
        }
        viewModel.paintCachedStateIfEmpty(modelContext: context)

        await viewModel.load(modelContext: context)

        XCTAssertEqual(viewModel.sessions, [], "Without a connectivity failure the saved rows would pass for live ones")
        XCTAssertNotNil(viewModel.sessionLoadError)
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

    /// TAL-830: the server's storage state comes with the list, and a relaunch paints it with the cached rows, so a
    /// damaged `state.db` still explains the empty list before the server answers.
    func testRelaunchShowsTheLastAgentStorageStateBeforeTheListLoads() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cache = makeResponseCache(server: server)
        let client = try makeClient(server: server) { request in
            apiTestJSONResponse(
                #"{"sessions": [], "agent_storage": {"state": "corrupt", "reason": "state.db is damaged"}}"#,
                for: request
            )
        }
        let firstLaunch = SessionListViewModel(server: server, client: client, responseCache: cache)
        await firstLaunch.load()
        let corrupt = AgentStorage(state: .corrupt, reason: "state.db is damaged")
        XCTAssertEqual(firstLaunch.agentStorage, corrupt)

        let relaunchClient = try makeClient(server: server) { request in
            apiTestJSONResponse(#"{"sessions": [], "agent_storage": {"state": "ok", "reason": null}}"#, for: request)
        }
        let relaunch = SessionListViewModel(server: server, client: relaunchClient, responseCache: cache)
        relaunch.paintCachedStateIfEmpty(modelContext: try makeContext())
        XCTAssertEqual(relaunch.agentStorage, corrupt)

        await relaunch.load()
        XCTAssertEqual(relaunch.agentStorage, AgentStorage(state: .ok, reason: nil), "The server's answer replaces the cached state")
    }

    /// A list that was in flight across a profile switch keeps its storage state out of the new profile's cache.
    func testAListInFlightAcrossAProfileSwitchDoesNotCacheItsStorageStateForTheNewProfile() async throws {
        let server = try XCTUnwrap(URL(string: "https://tal830-profile-switch.test"))
        ActiveServerProfile.record("before", for: server)
        addTeardownBlock { ActiveServerProfile.record(nil, for: server) }
        let cache = makeResponseCache(server: server)
        let client = try makeClient(server: server) { request in
            ActiveServerProfile.record("after", for: server)
            return apiTestJSONResponse(
                #"{"sessions": [], "agent_storage": {"state": "corrupt", "reason": "state.db is damaged"}}"#,
                for: request
            )
        }

        await SessionListViewModel(server: server, client: client, responseCache: cache).load()

        XCTAssertNil(cache.entry(ResponseCache.Kind.agentStorage).load(AgentStorage.self), "The previous profile's state reached the new one's cache")
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
                {"session": {"session_id": "\(id)", "_messages_offset": 200, "_messages_truncated": true, "messages": [
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
        let prefetched = try CacheStore.cachedTranscriptWindow(serverURL: server, sessionID: "running-elsewhere", in: context)
        XCTAssertEqual(prefetched.messagesOffset, 200)
        XCTAssertTrue(prefetched.hasOlderMessages)
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

// TAL-1195: a failed reload keeps the saved rows and says why, and only a lost network reads as offline.
@MainActor
extension SessionListMutationTests {
    func testAFailedReloadKeepsTheSavedRowsUnderItsReasonUntilTheNextAnswer() async throws {
        let failures: [(error: Error?, statusCode: Int, reason: CacheFallbackReason)] = [
            (URLError(.notConnectedToInternet), 200, .offline),
            (URLError(.cannotConnectToHost), 200, .serverUnreachable),
            (nil, 503, .serverUnavailable),
            (URLError(.networkConnectionLost), 200, .connectionInterrupted),
            (URLError(.timedOut), 200, .connectionInterrupted),
        ]
        for failure in failures {
            let context = try makeContext()
            let requests = LockedCounter()
            let viewModel = try makeViewModel { request in
                switch request.url?.path {
                case "/api/sessions" where requests.increment() == 2:
                    if let error = failure.error { throw error }
                    return apiTestJSONResponse(#"{"error": "Unavailable"}"#, statusCode: failure.statusCode, for: request)
                case "/api/sessions":
                    return apiTestJSONResponse(#"{"sessions": [{"session_id": "saved-1", "title": "Saved chat"}]}"#, for: request)
                default:
                    return apiTestJSONResponse(#"{"active": "default", "profiles": [{"name": "default"}, {"name": "work"}]}"#, for: request)
                }
            }
            await viewModel.load(modelContext: context)
            await viewModel.loadActiveProfile()
            XCTAssertNil(viewModel.cachedDataReason)

            await viewModel.load(modelContext: context)

            XCTAssertEqual(viewModel.cachedDataReason, failure.reason, "\(failure.reason)")
            XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["saved-1"], "\(failure.reason)")
            XCTAssertTrue(viewModel.isViewingCachedData, "\(failure.reason): the saved rows keep their action gates")
            let work = try JSONDecoder().decode(ProfileSummary.self, from: Data(#"{"name": "work"}"#.utf8))
            let switched = await viewModel.switchActiveProfile(work)
            XCTAssertFalse(switched, "\(failure.reason): a profile switch stays refused on saved rows")

            await viewModel.load(modelContext: context)

            XCTAssertNil(viewModel.cachedDataReason, "\(failure.reason): the server's answer ends the fallback")
            XCTAssertFalse(viewModel.isViewingCachedData)
        }
    }

    /// Navigating away or backgrounding cancels a reload; that says nothing about the connection.
    func testACancelledReloadLeavesTheListAsItWas() async throws {
        let context = try makeContext()
        let requests = LockedCounter()
        let viewModel = try makeViewModel { request in
            if requests.increment() == 2 { throw URLError(.cancelled) }
            return apiTestJSONResponse(#"{"sessions": [{"session_id": "live-1", "title": "Live chat"}]}"#, for: request)
        }
        await viewModel.load(modelContext: context)

        let didApply = await viewModel.load(modelContext: context)

        XCTAssertFalse(didApply)
        XCTAssertNil(viewModel.cachedDataReason)
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["live-1"])
    }

    /// A reload sent for the previous profile that fails after a switch belongs to that profile: it neither marks the
    /// new profile's list as saved data nor puts the old rows back.
    func testAReloadFailingAfterAProfileSwitchLeavesTheNewProfileLive() async throws {
        let host = "tal1195-profile-switch.test"
        let requests = DeferredRequestsByPath()
        let reloadArrived = expectation(description: "reload arrived")
        let switchArrived = expectation(description: "switch arrived")
        DeferredMockURLProtocol.setOnRequest({ request in
            requests.record(request)
            switch request.request.url?.path {
            case "/api/sessions": reloadArrived.fulfill()
            case "/api/profile/switch": switchArrived.fulfill()
            default: XCTFail("Unexpected request: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://\(host)"))
        let context = try makeContext()
        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "old-profile", title: "Old profile chat", archived: false)],
            serverURL: server,
            in: context
        )
        let viewModel = SessionListViewModel(
            server: server,
            client: APIClient(baseURL: server, session: URLSession(configuration: configuration))
        )

        let reload = Task { await viewModel.load(modelContext: context) }
        await fulfillment(of: [reloadArrived], timeout: 5)
        let work = try JSONDecoder().decode(ProfileSummary.self, from: Data(#"{"name": "work"}"#.utf8))
        let switched = Task { await viewModel.switchActiveProfile(work) }
        await fulfillment(of: [switchArrived], timeout: 5)
        requests.request("/api/profile/switch")?.complete(withJSON: #"{"active": "work", "profiles": [{"name": "work"}]}"#)
        let didSwitch = await switched.value
        XCTAssertTrue(didSwitch)

        requests.request("/api/sessions")?.fail(with: URLError(.notConnectedToInternet))
        _ = await reload.value

        XCTAssertNil(viewModel.cachedDataReason, "The old profile's failure marked the new profile's list")
        XCTAssertEqual(viewModel.sessions, [], "The old profile's saved rows came back")
    }
}
