import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria


final class SessionListMutationTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testReadOnlyRowsOfferExportButNoMutationActions() {
        let currentShape = SessionSummary(sessionId: "current", readOnly: true)
        let legacyShape = SessionSummary(sessionId: "legacy", isReadOnly: true)
        let normal = SessionSummary(sessionId: "normal")

        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: currentShape))
        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: legacyShape))
        XCTAssertFalse(
            SessionRowActionPolicy.offersMutationActions(
                for: SessionSummary(sessionId: "subagent", sourceTag: "subagent")
            )
        )
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
    func testDuplicatePolicyRejectsExternalSessionsBeforeAnyRequest() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            XCTFail("External sessions must not reach the duplicate endpoint.")
            throw URLError(.badURL)
        }
        let cliSession = SessionSummary(sessionId: "cli", isCliSession: true)
        let messagingSession = SessionSummary(
            sessionId: "telegram",
            rawSource: "telegram",
            sessionSource: "messaging"
        )

        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(cliSession))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(messagingSession))
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(SessionSummary(sessionId: "webui")))
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(SessionSummary(
            sessionId: "webui-override",
            isCliSession: true,
            sessionSource: "webui"
        )))
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

    func testExternalSourceClassificationPrefersExplicitWebUISource() {
        XCTAssertTrue(SessionSummary(sessionId: "cli", isCliSession: true).isExternalSourceSession)
        // Upstream stamps `is_cli_session` onto every TUI/ACP row; the raw marker
        // alone is not what `_isExternalSession` keys off.
        XCTAssertTrue(
            SessionSummary(sessionId: "tui", isCliSession: true, sourceTag: "  TUI  ", rawSource: "tui")
                .isExternalSourceSession
        )
        XCTAssertFalse(SessionSummary(sessionId: "tui-marker-only", rawSource: "tui").isExternalSourceSession)
        XCTAssertTrue(
            SessionSummary(sessionId: "discord", rawSource: "discord", sessionSource: "messaging")
                .isExternalSourceSession
        )
        XCTAssertTrue(SessionSummary(sessionId: "wecom", rawSource: "wecom_callback").isExternalSourceSession)

        // An explicit WebUI source wins over a stale is_cli_session flag.
        XCTAssertFalse(
            SessionSummary(sessionId: "webui", isCliSession: true, sessionSource: "webui")
                .isExternalSourceSession
        )
        XCTAssertFalse(SessionSummary(sessionId: "plain").isExternalSourceSession)
    }

    @MainActor
    func testOpeningExternalRowImportsOnceAndUsesAuthoritativeMetadata() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "cli-1",
                "title": "Imported title",
                "is_cli_session": true,
                "source_tag": "cli",
                "read_only": false
              },
              "imported": true
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
            matchType: "content"
        )

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(requestedPaths, ["/api/session/import_cli"])
        XCTAssertEqual(opened.title, "Imported title")
        XCTAssertFalse(opened.isSessionReadOnly)
        // List-only metadata the detail payload cannot carry survives the import.
        XCTAssertEqual(opened.isStreaming, true)
        XCTAssertEqual(opened.userMessageCount, 7)
        XCTAssertEqual(opened.matchType, "content")
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testOpeningReadOnlyImportKeepsSessionViewOnly() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse("""
            {
              "session": {
                "session_id": "telegram-1",
                "session_source": "messaging",
                "raw_source": "telegram",
                "read_only": true
              },
              "imported": false
            }
            """, for: request)
        }
        let row = SessionSummary(sessionId: "telegram-1", rawSource: "telegram", sessionSource: "messaging")

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertTrue(opened.isSessionReadOnly)
    }

    /// The list row and the import payload can use different historical read-only
    /// spellings. An authoritative answer must clear the stale alias, or the
    /// `isSessionReadOnly` OR keeps a writable import view-only.
    @MainActor
    func testWritableImportClearsStaleReadOnlyAliasFromTheRow() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse("""
            {
              "session": {"session_id": "cli-1", "title": "Writable now", "read_only": false},
              "imported": false
            }
            """, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true, isReadOnly: true)

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(opened.readOnly, false)
        XCTAssertNil(opened.isReadOnly)
        XCTAssertFalse(opened.isSessionReadOnly)
    }

    /// `SessionRowActionPolicy` reads the row, not the opened destination, so a
    /// regular-width sidebar would keep the pre-import actions without this.
    @MainActor
    func testImportRefreshesTheListRowSoItsActionsMatch() async throws {
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/sessions":
                return apiTestJSONResponse("""
                {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "archived": false}]}
                """, for: request)
            default:
                return apiTestJSONResponse("""
                {
                  "session": {
                    "session_id": "cli-1",
                    "title": "CLI",
                    "is_cli_session": true,
                    "read_only": true
                  },
                  "imported": false
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

    /// A `/api/sessions` refresh can land while the import is in flight. The
    /// import's own fields still win, but list-only metadata must come from the
    /// row as it stands when the import returns, not the tapped snapshot.
    @MainActor
    func testImportMergesOntoTheCurrentRowNotThePreAwaitSnapshot() async throws {
        let firstListArrived = expectation(description: "first sessions load arrived")
        let importArrived = expectation(description: "import arrived")
        let secondListArrived = expectation(description: "second sessions load arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pending in
            let index = requests.append(pending)
            let path: String = pending.request.url?.path ?? ""
            if path == "/api/sessions", index == 1 {
                firstListArrived.fulfill()
            } else if path == "/api/session/import_cli", index == 2 {
                importArrived.fulfill()
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
        {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "user_message_count": 1, "archived": false}]}
        """#)
        _ = await firstLoad.value

        let row = try XCTUnwrap(viewModel.sessions.first)
        let open = Task { await viewModel.sessionToOpen(for: row) }
        await fulfillment(of: [importArrived], timeout: 5)

        // The list refreshes with newer list-only metadata while the import is still out.
        let secondLoad = Task { await viewModel.load() }
        await fulfillment(of: [secondListArrived], timeout: 5)
        requests.request(at: 2).complete(withJSON: #"""
        {"sessions": [{"session_id": "cli-1", "title": "CLI", "is_cli_session": true, "user_message_count": 9, "archived": false}]}
        """#)
        _ = await secondLoad.value

        requests.request(at: 1).complete(withJSON: #"""
        {"session": {"session_id": "cli-1", "title": "Imported", "read_only": false}, "imported": true}
        """#)
        let openedResult = await open.value
        let opened = try XCTUnwrap(openedResult)

        XCTAssertEqual(opened.title, "Imported")
        XCTAssertEqual(opened.userMessageCount, 9)
        XCTAssertEqual(viewModel.sessions.first?.userMessageCount, 9)
    }

    @MainActor
    func testOpeningWebUIRowSkipsImport() async throws {
        let viewModel = try makeViewModel { _ in
            XCTFail("WebUI sessions must open without an import request.")
            throw URLError(.badURL)
        }
        let row = SessionSummary(sessionId: "webui-1", isCliSession: true, sessionSource: "webui")

        let opened = await viewModel.sessionToOpen(for: row)
        XCTAssertEqual(opened?.sessionId, "webui-1")
    }

    @MainActor
    func testFailedImportStaysOnTheListWithActionableCopy() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            return apiTestJSONResponse(#"{"error": "Session not found in CLI store"}"#, statusCode: 404, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true)

        let opened = await viewModel.sessionToOpen(for: row)

        XCTAssertNil(opened)
        XCTAssertEqual(requestedPaths, ["/api/session/import_cli", "/api/session"])
        XCTAssertEqual(
            viewModel.actionErrorMessage,
            "That session no longer exists on the server. Reopen another session or create a new one."
        )
    }

    /// A session the server already owns can still be opened through the canonical
    /// detail route when the import call itself fails.
    @MainActor
    func testAlreadyImportedSessionFallsBackToDetailRoute() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path ?? "nil"
            requestedPaths.append(path)

            if path == "/api/session/import_cli" {
                return apiTestJSONResponse(#"{"error": "import unavailable"}"#, statusCode: 500, for: request)
            }

            return apiTestJSONResponse("""
            {"session": {"session_id": "cli-1", "title": "Already imported", "read_only": false}}
            """, for: request)
        }
        let row = SessionSummary(sessionId: "cli-1", isCliSession: true, readOnly: true)

        let resolved = await viewModel.sessionToOpen(for: row)
        let opened = try XCTUnwrap(resolved)

        XCTAssertEqual(requestedPaths, ["/api/session/import_cli", "/api/session"])
        XCTAssertEqual(opened.title, "Already imported")
        XCTAssertFalse(opened.isSessionReadOnly)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    @MainActor
    func testSlowerEarlierTapCannotReplaceALaterSelection() async throws {
        let firstRequestArrived = expectation(description: "first import arrived")
        let secondRequestArrived = expectation(description: "second import arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { request in
            switch requests.append(request) {
            case 1: firstRequestArrived.fulfill()
            case 2: secondRequestArrived.fulfill()
            default: XCTFail("unexpected extra import request")
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

        requests.request(at: 1).complete(withJSON: #"{"session": {"session_id": "newer"}, "imported": true}"#)
        let newer = await secondTap.value
        requests.request(at: 0).complete(withJSON: #"{"session": {"session_id": "older"}, "imported": true}"#)
        let older = await firstTap.value

        XCTAssertEqual(newer?.sessionId, "newer")
        XCTAssertNil(older, "The superseded tap must not replace the newer destination.")
    }
}
