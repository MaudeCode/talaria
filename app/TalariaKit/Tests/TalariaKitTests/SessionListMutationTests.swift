import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit


final class SessionListMutationTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    /// TAL-312: the server's per-action gates win; a read-only import can still be
    /// organised, a subagent child cannot, and an older server keeps the earlier rules.
    func testRowActionsFollowTheServerCapabilityFields() {
        let subagent = SessionSummary(sessionId: "child", readOnly: true, canPin: false, canArchive: false, canDuplicate: false)
        let readOnlyImport = SessionSummary(sessionId: "import", readOnly: true, canPin: true, canArchive: true, canDuplicate: true)
        let foreignRow = SessionSummary(sessionId: "cli", isCliSession: true, canPin: true, canArchive: true, canDuplicate: false)

        XCTAssertFalse(SessionRowActionPolicy.canPin(subagent))
        XCTAssertFalse(SessionRowActionPolicy.canArchive(subagent))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(subagent))
        XCTAssertTrue(SessionRowActionPolicy.canPin(readOnlyImport))
        XCTAssertTrue(SessionRowActionPolicy.canArchive(readOnlyImport))
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(readOnlyImport))
        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: readOnlyImport))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(foreignRow))

        // A row without the gates (one cached before TAL-723) offers none of these actions.
        let ungated = SessionSummary(sessionId: "ungated")
        XCTAssertFalse(SessionRowActionPolicy.canPin(ungated))
        XCTAssertFalse(SessionRowActionPolicy.canArchive(ungated))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(ungated))
    }

    func testReadOnlyRowsOfferExportButNoMutationActions() {
        let currentShape = SessionSummary(sessionId: "current", readOnly: true)
        let normal = SessionSummary(sessionId: "normal")

        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: currentShape))
        XCTAssertTrue(SessionRowActionPolicy.offersMutationActions(for: normal))

        XCTAssertTrue(SessionRowActionPolicy.canExport(currentShape, isViewingCachedData: false))
        XCTAssertFalse(SessionRowActionPolicy.canExport(currentShape, isViewingCachedData: true))
        XCTAssertFalse(
            SessionRowActionPolicy.canExport(
                SessionSummary(sessionId: nil, readOnly: true),
                isViewingCachedData: false
            )
        )
    }

    @MainActor
    func testDuplicateTheServerRefusesSendsNoRequest() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            XCTFail("A row the server will not duplicate must not reach the duplicate endpoint.")
            throw URLError(.badURL)
        }
        let cliSession = SessionSummary(sessionId: "cli", isCliSession: true, canDuplicate: false)
        let messagingSession = SessionSummary(
            sessionId: "telegram",
            rawSource: "telegram",
            sessionSource: "messaging",
            sourceKind: .messaging,
            canDuplicate: false
        )

        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(cliSession))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(messagingSession))
        // The server's gate decides, not the row's source.
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(SessionSummary(sessionId: "cli-with-sidecar", isCliSession: true, canDuplicate: true)))
        let duplicatedCLI = await viewModel.duplicate(cliSession)
        let duplicatedMessaging = await viewModel.duplicate(messagingSession)

        XCTAssertNil(duplicatedCLI)
        XCTAssertNil(duplicatedMessaging)
        XCTAssertEqual(viewModel.actionErrorMessage, "This command is not available in the mobile app.")
        XCTAssertTrue(requestedPaths.isEmpty)
    }

    func testCopyDeepLinkUsesExportAvailabilityRules() throws {
        let session = SessionSummary(sessionId: "session & /?=✓", readOnly: true)

        let url = try XCTUnwrap(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: false,
                isMutating: false
            )
        )
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), session.sessionId)
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: true,
                isMutating: false
            )
        )
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: false,
                isMutating: true
            )
        )
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: SessionSummary(sessionId: nil),
                isViewingCachedData: false,
                isMutating: false
            )
        )
    }

    func testExternalSourceClassificationFollowsTheServerKind() {
        XCTAssertTrue(SessionSummary(sessionId: "cli", isCliSession: true, sourceKind: .cli).isExternalSourceSession)
        XCTAssertTrue(SessionSummary(sessionId: "claude", isCliSession: true, sourceKind: .claudeCode).isExternalSourceSession)
        // A raw marker the server did not classify is not external.
        XCTAssertFalse(SessionSummary(sessionId: "tui-marker-only", rawSource: "tui").isExternalSourceSession)
        XCTAssertFalse(SessionSummary(sessionId: "signal-marker-only", rawSource: "signal").isExternalSourceSession)
        // A WebUI-born session never is, whatever a stale is_cli_session says.
        XCTAssertFalse(
            SessionSummary(sessionId: "webui", isCliSession: true, sessionSource: "webui", sourceKind: .webui)
                .isExternalSourceSession
        )
        XCTAssertFalse(SessionSummary(sessionId: "plain").isExternalSourceSession)
    }

    /// The server has no `import_cli` route; it decides writability in `GET /api/session` and
    /// claims a CLI session on its first send (TAL-256). The app opens external chats through
    /// that detail and keeps its `read_only` and capability flags.
    @MainActor
    func testOpeningExternalSessionUsesTheDetailRouteAndItsWritability() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            // What the server answers the removed route with; asserting no request reaches it.
            if request.url?.path == "/api/session/import_cli" {
                return apiTestJSONResponse(#"{"error": "not found"}"#, statusCode: 404, for: request)
            }
            return apiTestJSONResponse("""
            {"session": {"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "source_kind": "cli",
              "read_only": false, "can_pin": true, "can_archive": true, "can_duplicate": true}}
            """, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true, sourceKind: .cli, canDuplicate: false)

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(requestedPaths, ["/api/session"])
        XCTAssertFalse(opened.isSessionReadOnly)
        XCTAssertEqual(opened.canDuplicate, true)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    /// Signal and WhatsApp chats used to open without a detail load because the app's own
    /// messaging list missed them (TAL-310). Every platform the server files as messaging loads it.
    @MainActor
    func testOpeningEveryServerMessagingPlatformLoadsItsDetailFirst() async throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        for platform in ["signal", "whatsapp", "weixin", "wecom_callback"] {
            var requestedPaths: [String] = []
            let viewModel = try makeViewModel { request in
                requestedPaths.append(request.url?.path ?? "nil")
                return apiTestJSONResponse(#"{"session": {"session_id": "chat-\#(platform)", "title": "Chat", "source_kind": "messaging"}}"#, for: request)
            }
            let row = try decoder.decode(SessionSummary.self, from: Data("""
            {"session_id": "chat-\(platform)", "raw_source": "\(platform)", "is_cli_session": false, "source_kind": "messaging", "is_messaging_session": true}
            """.utf8))

            XCTAssertTrue(row.isMessagingSession, platform)
            _ = await viewModel.sessionToOpen(for: row)
            XCTAssertEqual(requestedPaths, ["/api/session"], platform)
        }
    }

    @MainActor
    func testOpeningExternalRowLoadsDetailOnceAndUsesAuthoritativeMetadata() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "cli-1",
                "title": "Detail title",
                "is_cli_session": true,
                "source_tag": "cli",
                "read_only": false
              }
            }
            """, for: request)
        }
        let row = SessionSummary(
            sessionId: "cli-1",
            title: "Stale title",
            isStreaming: true,
            isCliSession: true,
            userMessageCount: 7,
            readOnly: true,
            matchType: "content",
            matchPreview: "why it matched"
        )

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(requestedPaths, ["/api/session"])
        XCTAssertEqual(opened.title, "Detail title")
        XCTAssertFalse(opened.isSessionReadOnly)
        // List-only metadata the detail payload cannot carry survives the load.
        XCTAssertEqual(opened.isStreaming, true)
        XCTAssertEqual(opened.userMessageCount, 7)
        XCTAssertEqual(opened.matchType, "content")
        XCTAssertEqual(opened.matchPreview, "why it matched")
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testOpeningReadOnlyDetailKeepsSessionViewOnly() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse("""
            {
              "session": {
                "session_id": "telegram-1",
                "session_source": "messaging",
                "raw_source": "telegram",
                "source_kind": "messaging",
                "read_only": true
              }
            }
            """, for: request)
        }
        let row = SessionSummary(sessionId: "telegram-1", rawSource: "telegram", sessionSource: "messaging", sourceKind: .messaging)

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertTrue(opened.isSessionReadOnly)
    }

    /// An authoritative writable answer replaces a stale read-only flag on the row.
    @MainActor
    func testWritableDetailClearsStaleReadOnlyFromTheRow() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse("""
            {
              "session": {"session_id": "cli-1", "title": "Writable now", "read_only": false}
            }
            """, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true, readOnly: true)

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(opened.readOnly, false)
        XCTAssertFalse(opened.isSessionReadOnly)
    }

    /// `SessionRowActionPolicy` reads the row, not the opened destination, so a
    /// regular-width sidebar would keep the stale actions without this.
    @MainActor
    func testDetailRefreshesTheListRowSoItsActionsMatch() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "archived": false, "source_kind": "cli"}]}
                """, for: request)
            default:
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "cli-1",
                    "title": "CLI",
                    "is_cli_session": true,
                    "read_only": true
                  }
                }
                """, for: request)
            }
        }

        let didLoad = await viewModel.load()
        XCTAssertTrue(didLoad)
        let row = try XCTUnwrap(viewModel.sessions.first)
        XCTAssertTrue(SessionRowActionPolicy.offersMutationActions(for: row))

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertTrue(opened.isSessionReadOnly)
        let refreshedRow = try XCTUnwrap(viewModel.sessions.first)
        XCTAssertTrue(refreshedRow.isSessionReadOnly)
        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: refreshedRow))
    }

    /// A `/api/sessions` refresh can land while the detail load is in flight. The
    /// detail's own fields still win, but list-only metadata must come from the
    /// row as it stands when the detail returns, not the tapped snapshot.
    @MainActor
    func testDetailMergesOntoTheCurrentRowNotThePreAwaitSnapshot() async throws {
        let firstListArrived = expectation(description: "first sessions load arrived")
        let detailArrived = expectation(description: "detail arrived")
        let secondListArrived = expectation(description: "second sessions load arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pending in
            let index = requests.append(pending)
            let path: String = pending.request.url?.path ?? ""
            if path == "/api/sessions", index == 1 {
                firstListArrived.fulfill()
            } else if path == "/api/session", index == 2 {
                detailArrived.fulfill()
            } else if path == "/api/sessions", index == 3 {
                secondListArrived.fulfill()
            } else {
                XCTFail("unexpected request \(path) at \(index)")
            }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: server, session: URLSession(configuration: configuration))
        let viewModel = SessionListViewModel(server: server, client: client)

        let firstLoad = Task { await viewModel.load() }
        await fulfillment(of: [firstListArrived], timeout: 5)
        requests.request(at: 0).complete(withJSON: #"""
        {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "user_message_count": 1, "archived": false, "source_kind": "cli"}]}
        """#)
        _ = await firstLoad.value

        let row = try XCTUnwrap(viewModel.sessions.first)
        let open = Task { await viewModel.sessionToOpen(for: row) }
        await fulfillment(of: [detailArrived], timeout: 5)

        // The list refreshes with newer list-only metadata while the detail is still out.
        let secondLoad = Task { await viewModel.load() }
        await fulfillment(of: [secondListArrived], timeout: 5)
        requests.request(at: 2).complete(withJSON: #"""
        {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "user_message_count": 9, "archived": false, "source_kind": "cli"}]}
        """#)
        _ = await secondLoad.value

        requests.request(at: 1).complete(withJSON: #"""
        {"session": {"session_id": "cli-1", "title": "Imported", "read_only": false}}
        """#)
        let openedResult = await open.value
        let opened = try XCTUnwrap(openedResult)

        XCTAssertEqual(opened.title, "Imported")
        XCTAssertEqual(opened.userMessageCount, 9)
        XCTAssertEqual(viewModel.sessions.first?.userMessageCount, 9)
    }

    /// A `/api/sessions` response already in flight when the detail lands must not
    /// reinstate the stale row it captured.
    @MainActor
    func testInFlightListLoadDoesNotOverwriteTheLoadedRow() async throws {
        let firstListArrived = expectation(description: "first sessions load arrived")
        let staleListArrived = expectation(description: "stale sessions load arrived")
        let detailArrived = expectation(description: "detail arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pending in
            let index = requests.append(pending)
            let path: String = pending.request.url?.path ?? ""
            if path == "/api/sessions", index == 1 {
                firstListArrived.fulfill()
            } else if path == "/api/session", index == 2 {
                detailArrived.fulfill()
            } else if path == "/api/sessions", index == 3 {
                staleListArrived.fulfill()
            } else {
                XCTFail("unexpected request \(path) at \(index)")
            }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: server, session: URLSession(configuration: configuration))
        let viewModel = SessionListViewModel(server: server, client: client)

        let context = try makeContext()

        let writableRow = #"""
        {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "read_only": false, "archived": false, "source_kind": "cli"}]}
        """#
        let firstLoad = Task { await viewModel.load(modelContext: context) }
        await fulfillment(of: [firstListArrived], timeout: 5)
        requests.request(at: 0).complete(withJSON: writableRow)
        _ = await firstLoad.value

        // The open starts first, then a refresh captures the stale row while
        // the detail is still pending, and the detail reports it read-only before
        // that refresh is delivered. The record must outlive a load that began
        // before the claim completed, not merely before the open started.
        let row = try XCTUnwrap(viewModel.sessions.first)
        let open = Task { await viewModel.sessionToOpen(for: row, modelContext: context) }
        await fulfillment(of: [detailArrived], timeout: 5)

        let staleLoad = Task { await viewModel.load(modelContext: context) }
        await fulfillment(of: [staleListArrived], timeout: 5)
        requests.request(at: 1).complete(withJSON: #"""
        {"session": {"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "read_only": true, "source_kind": "cli"}}
        """#)
        let openedResult = await open.value
        let opened = try XCTUnwrap(openedResult)
        XCTAssertTrue(opened.isSessionReadOnly)

        requests.request(at: 2).complete(withJSON: writableRow)
        _ = await staleLoad.value

        let refreshedRow = try XCTUnwrap(viewModel.sessions.first)
        XCTAssertTrue(refreshedRow.isSessionReadOnly, "A stale list load must not reinstate the stale row's metadata.")
        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: refreshedRow))

        // The offline cache has to hold the applied row too, or the next cached
        // browse restores the stale writability.
        let cachedRow = try XCTUnwrap(
            CacheStore.cachedSessions(serverURL: server, in: context).first
        )
        XCTAssertTrue(cachedRow.isSessionReadOnly)
    }

    /// An expired login on the detail load reaches the auth manager.
    @MainActor
    func testExpiredLoginOnTheDetailLoadIsSurfaced() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse(#"{"error": "unauthorized"}"#, statusCode: 401, for: request)
        }

        let opened = await viewModel.sessionToOpen(for: SessionSummary(sessionId: "cli-1", isCliSession: true))

        XCTAssertNil(opened)
        XCTAssertEqual(requestedPaths, ["/api/session"])
        let lastError = try XCTUnwrap(viewModel.lastError)
        guard case APIError.unauthorized = lastError else {
            return XCTFail("expected unauthorized, got \(lastError)")
        }
    }

    @MainActor
    func testOpeningWebUIRowSkipsTheDetailLoad() async throws {
        let viewModel = try makeViewModel { _ in
            XCTFail("WebUI sessions must open without a detail request.")
            throw URLError(.badURL)
        }
        let row = SessionSummary(sessionId: "webui-1", isCliSession: true, sessionSource: "webui", sourceKind: .webui)

        let opened = await viewModel.sessionToOpen(for: row)
        XCTAssertEqual(opened?.sessionId, "webui-1")
    }

    @MainActor
    func testFailedDetailLoadStaysOnTheListWithActionableCopy() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse(#"{"error": "Session not found"}"#, statusCode: 404, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true)

        let opened = await viewModel.sessionToOpen(for: row)

        XCTAssertNil(opened)
        XCTAssertEqual(requestedPaths, ["/api/session"])
        XCTAssertEqual(
            viewModel.actionErrorMessage,
            "That session no longer exists on the server. Reopen another session or create a new one."
        )
    }

    // MARK: Launch restore

    @MainActor
    func testCachedLaunchRootIsInstalledBeforeAnyNetworkRequest() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cached = SessionSummary(sessionId: "cached", title: "Cached", isCliSession: true)
        try CacheStore.cacheSessions([cached], serverURL: server, in: context)
        var paths: [String] = []
        let model = try makeViewModel { request in
            paths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse(#"{"sessions":[{"session_id":"network","title":"Network"}]}"#, for: request)
        }
        var state = SessionNavigationState(lastSelectedSessionID: "cached")
        model.paintCachedStateIfEmpty(modelContext: context)
        let restored = try XCTUnwrap(state.sessionToRestore(from: model.sessions))
        state.select(restored)
        XCTAssertEqual(state.destination, .session(cached))
        XCTAssertTrue(paths.isEmpty, "The first root must be decided synchronously from local summaries")
        _ = await model.load(modelContext: context)
        XCTAssertNil(state.sessionToRestore(from: model.sessions))
        XCTAssertEqual(state.destination, .session(cached))
        XCTAssertEqual(paths, ["/api/sessions"])
    }

    @MainActor
    func testCacheMissStaysNewChatWhenTheServerLaterFindsTheID() async throws {
        let context = try makeContext()
        let model = try makeViewModel { request in
            apiTestJSONResponse(#"{"sessions":[{"session_id":"late","title":"Late"}]}"#, for: request)
        }
        var state = SessionNavigationState(lastSelectedSessionID: "late")
        model.paintCachedStateIfEmpty(modelContext: context)
        XCTAssertNil(state.sessionToRestore(from: model.sessions))
        XCTAssertTrue(state.launchRestoreResolved)
        _ = await model.load(modelContext: context)
        XCTAssertNil(state.sessionToRestore(from: model.sessions))
        XCTAssertNil(state.destination)
        XCTAssertNil(state.lastSelectedSessionID)
    }

    @MainActor
    func testExplicitRouteWinsOverTheSynchronousCachedCandidate() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheSessions([SessionSummary(sessionId: "cached")], serverURL: server, in: context)
        let model = try makeViewModel { request in
            XCTFail("A local launch decision must not request the network")
            throw URLError(.badURL)
        }
        var state = SessionNavigationState(lastSelectedSessionID: "cached")
        state.select(.memory)
        model.paintCachedStateIfEmpty(modelContext: context)
        XCTAssertNil(state.sessionToRestore(from: model.sessions))
        XCTAssertEqual(state.destination, .utility(.memory))
    }

    @MainActor
    func testOfflineRefreshCannotReplaceTheCachedLaunchRoot() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cached = SessionSummary(sessionId: "cached", title: "Cached")
        try CacheStore.cacheSessions([cached], serverURL: server, in: context)
        let model = try makeViewModel { _ in throw URLError(.notConnectedToInternet) }
        var state = SessionNavigationState(lastSelectedSessionID: "cached")
        model.paintCachedStateIfEmpty(modelContext: context)
        state.select(try XCTUnwrap(state.sessionToRestore(from: model.sessions)))
        _ = await model.load(modelContext: context)
        XCTAssertTrue(model.isViewingCachedData)
        XCTAssertNil(state.sessionToRestore(from: model.sessions))
        XCTAssertEqual(state.destination, .session(cached))
    }

    @MainActor
    func testSlowerEarlierTapCannotReplaceALaterSelection() async throws {
        let firstRequestArrived = expectation(description: "first load arrived")
        let secondRequestArrived = expectation(description: "second load arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { request in
            switch requests.append(request) {
            case 1: firstRequestArrived.fulfill()
            case 2: secondRequestArrived.fulfill()
            default: XCTFail("unexpected extra detail request")
            }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let client = APIClient(baseURL: server, session: URLSession(configuration: configuration))
        let viewModel = SessionListViewModel(server: server, client: client)

        let firstTap = Task { await viewModel.sessionToOpen(for: SessionSummary(sessionId: "older", isCliSession: true)) }
        await fulfillment(of: [firstRequestArrived], timeout: 5)
        let secondTap = Task { await viewModel.sessionToOpen(for: SessionSummary(sessionId: "newer", isCliSession: true)) }
        await fulfillment(of: [secondRequestArrived], timeout: 5)

        requests.request(at: 1).complete(withJSON: #"{"session": {"session_id": "newer"}}"#)
        let newer = await secondTap.value
        requests.request(at: 0).complete(withJSON: #"{"session": {"session_id": "older"}}"#)
        let older = await firstTap.value

        XCTAssertEqual(newer?.sessionId, "newer")
        XCTAssertNil(older, "The superseded tap must not replace the newer destination.")
    }
}
