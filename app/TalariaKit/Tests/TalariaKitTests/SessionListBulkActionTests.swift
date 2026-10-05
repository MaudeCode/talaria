import XCTest
@testable import TalariaKit

/// Select Chats (TAL-627): the selection is device-local; the server runs the bulk action
/// and answers for each ID.
@MainActor
final class SessionListBulkActionTests: XCTestCase {
    private let writable = SessionSummary(sessionId: "chat-a", canArchive: true, canDelete: true)
    private let subagent = SessionSummary(sessionId: "chat-b", readOnly: true, canArchive: false, canDelete: false)
    private let readOnlyImport = SessionSummary(sessionId: "chat-c", readOnly: true, canArchive: true, canDelete: false)
    private let another = SessionSummary(sessionId: "chat-d", canArchive: true, canDelete: true)

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testDeleteFollowsTheServerGateWithTheReadOnlyFallback() throws {
        XCTAssertTrue(SessionRowActionPolicy.canDelete(writable))
        XCTAssertFalse(SessionRowActionPolicy.canDelete(readOnlyImport))
        XCTAssertFalse(SessionRowActionPolicy.canDelete(SessionSummary(sessionId: "x", canDelete: false)))
        // An older server sends no `can_delete`: `read_only` decides, as before.
        XCTAssertFalse(SessionRowActionPolicy.canDelete(SessionSummary(sessionId: "legacy", readOnly: true)))
        XCTAssertTrue(SessionRowActionPolicy.canDelete(SessionSummary(sessionId: "legacy")))

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let decoded = try decoder.decode(SessionSummary.self, from: Data(#"{"session_id": "s", "read_only": false, "can_delete": false}"#.utf8))
        XCTAssertFalse(SessionRowActionPolicy.canDelete(decoded))
    }

    func testSelectionTogglesAndSelectAllCoversTheSelectableRows() throws {
        let viewModel = try makeViewModel { request in
            XCTFail("Selecting must not reach the server: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.toggleSelection(writable)
        XCTAssertEqual(viewModel.selectedSessionCount, 0, "Rows are only selectable in Select Chats.")

        viewModel.beginSelectingSessions()
        viewModel.toggleSelection(writable)
        XCTAssertTrue(viewModel.isSelected(writable))
        viewModel.toggleSelection(writable)
        XCTAssertFalse(viewModel.isSelected(writable))
        viewModel.toggleSelection(subagent)
        XCTAssertFalse(viewModel.isSelected(subagent), "A row the server lets neither archive nor delete stays out.")

        viewModel.toggleSelectAll([writable, subagent, readOnlyImport])
        XCTAssertEqual(Set(viewModel.selectedSessionsByID.keys), ["chat-a", "chat-c"])
        viewModel.toggleSelectAll([writable, subagent, readOnlyImport])
        XCTAssertEqual(viewModel.selectedSessionCount, 0)

        viewModel.toggleSelection(readOnlyImport)
        XCTAssertTrue(viewModel.canPerformBulkAction(.archive))
        XCTAssertFalse(viewModel.canPerformBulkAction(.delete))

        viewModel.endSelectingSessions()
        XCTAssertFalse(viewModel.isSelectingSessions)
        XCTAssertEqual(viewModel.selectedSessionCount, 0)
    }

    func testBulkDeleteSendsOneRequestAndKeepsOnlyTheFailedChatsSelected() async throws {
        var requests: [(path: String, body: [String: Any]?)] = []
        let viewModel = try makeViewModel { request in
            let path = request.url?.path ?? "nil"
            let body = apiTestBodyData(from: request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            requests.append((path, body))
            if path == "/api/sessions/bulk" {
                XCTAssertEqual(request.httpMethod, "POST")
                return apiTestJSONResponse("""
                {"results": [
                  {"session_id": "chat-a", "ok": true, "state_db_cleanup_failed": false},
                  {"session_id": "chat-c", "ok": false, "status": 409, "error": "Session has an active run; stop it before deleting"},
                  {"session_id": "chat-d", "ok": true, "state_db_cleanup_failed": false}
                ]}
                """, for: request)
            }
            return apiTestJSONResponse(#"{"sessions": [{"session_id": "chat-c", "title": "Still here"}]}"#, for: request)
        }
        viewModel.beginSelectingSessions()
        viewModel.toggleSelectAll([another, readOnlyImport, writable])

        let changed = await viewModel.performBulkAction(.delete)

        XCTAssertEqual(requests.map(\.path), ["/api/sessions/bulk", "/api/sessions"])
        XCTAssertEqual(requests.first?.body?["action"] as? String, "delete")
        XCTAssertEqual(requests.first?.body?["session_ids"] as? [String], ["chat-a", "chat-c", "chat-d"])
        XCTAssertEqual(changed.compactMap(\.sessionId).sorted(), ["chat-a", "chat-d"])
        XCTAssertEqual(Array(viewModel.selectedSessionsByID.keys), ["chat-c"])
        XCTAssertTrue(viewModel.isSelectingSessions)
        let message = try XCTUnwrap(viewModel.actionErrorMessage)
        XCTAssertTrue(message.contains("1 of 3"), message)
        XCTAssertTrue(message.contains("Session has an active run"), message)
        XCTAssertFalse(viewModel.isPerformingBulkAction)
    }

    func testBulkArchiveThatSucceedsForEveryChatEndsSelectChats() async throws {
        var bulkBody: [String: Any]?
        let viewModel = try makeViewModel { request in
            if request.url?.path == "/api/sessions/bulk" {
                bulkBody = apiTestBodyData(from: request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                return apiTestJSONResponse(#"{"results": [{"session_id": "chat-a", "ok": true}, {"session_id": "chat-d", "ok": true}]}"#, for: request)
            }
            return apiTestJSONResponse(#"{"sessions": []}"#, for: request)
        }
        viewModel.beginSelectingSessions()
        viewModel.toggleSelection(writable)
        viewModel.toggleSelection(another)

        let changed = await viewModel.performBulkAction(.archive)

        XCTAssertEqual(bulkBody?["action"] as? String, "archive")
        XCTAssertEqual(changed.count, 2)
        XCTAssertFalse(viewModel.isSelectingSessions)
        XCTAssertEqual(viewModel.selectedSessionCount, 0)
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    func testSelectChatsIsOfferedOnlyByAServerThatShipsTheDeleteGate() async throws {
        var listJSON = #"{"sessions": [{"session_id": "old", "title": "Old server"}]}"#
        let viewModel = try makeViewModel { request in apiTestJSONResponse(listJSON, for: request) }

        _ = await viewModel.load()
        XCTAssertFalse(viewModel.supportsBulkActions)

        listJSON = #"{"sessions": [{"session_id": "new", "title": "New server", "can_delete": true}]}"#
        _ = await viewModel.load()
        XCTAssertTrue(viewModel.supportsBulkActions)
    }

    func testBulkRequestFailureKeepsTheWholeSelection() async throws {
        let viewModel = try makeViewModel { request in
            apiTestJSONResponse(#"{"error": "Server unavailable"}"#, statusCode: 500, for: request)
        }
        viewModel.beginSelectingSessions()
        viewModel.toggleSelection(writable)

        let changed = await viewModel.performBulkAction(.archive)

        XCTAssertTrue(changed.isEmpty)
        XCTAssertEqual(Array(viewModel.selectedSessionsByID.keys), ["chat-a"])
        XCTAssertNotNil(viewModel.actionErrorMessage)
    }

    private func makeViewModel(
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) throws -> SessionListViewModel {
        MockURLProtocol.requestHandler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return SessionListViewModel(
            server: server,
            client: APIClient(baseURL: server, session: URLSession(configuration: configuration)),
            responseCache: ResponseCache(server: server, root: root)
        )
    }
}
