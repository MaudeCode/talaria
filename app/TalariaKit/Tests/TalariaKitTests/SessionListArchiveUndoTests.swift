import XCTest
@testable import TalariaKit

/// The Chats list offers to undo the latest archive (TAL-443).
@MainActor
final class SessionListArchiveUndoTests: XCTestCase {
    /// A stub server holding two chats; `/api/session/archive` moves one in or out of the archive.
    private final class StubServer {
        var archivedIDs: Set<String> = []
        var archiveBodies: [(id: String, archived: Bool)] = []
        var loadCount = 0
        var failingUnarchives = 0

        func handle(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
            switch request.url?.path {
            case "/api/sessions":
                loadCount += 1
                let rows = ["session-abc", "session-def"]
                    .filter { !archivedIDs.contains($0) }
                    .map { #"{"session_id": "\#($0)", "title": "\#($0)", "archived": false}"# }
                return apiTestJSONResponse(#"{"sessions": [\#(rows.joined(separator: ","))]}"#, for: request)
            case "/api/session/archive":
                let body = try XCTUnwrap(apiTestJSONBody(from: request))
                let id = try XCTUnwrap(body["session_id"] as? String)
                let archived = try XCTUnwrap(body["archived"] as? Bool)
                archiveBodies.append((id, archived))
                if !archived, failingUnarchives > 0 {
                    failingUnarchives -= 1
                    return apiTestJSONResponse(#"{"error": "unarchive failed"}"#, statusCode: 500, for: request)
                }
                if archived { archivedIDs.insert(id) } else { archivedIDs.remove(id) }
                return apiTestJSONResponse(#"{"ok": true}"#, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }
    }

    private func makeViewModel(
        _ stub: StubServer,
        archiveUndoLifetime: Duration = .seconds(60)
    ) throws -> SessionListViewModel {
        MockURLProtocol.requestHandler = stub.handle
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        return SessionListViewModel(
            server: server,
            client: APIClient(baseURL: server, session: URLSession(configuration: configuration)),
            archiveUndoLifetime: archiveUndoLifetime
        )
    }

    private func session(_ id: String, in viewModel: SessionListViewModel) throws -> SessionSummary {
        try XCTUnwrap(viewModel.sessions.first { $0.sessionId == id })
    }

    func testUndoSendsOneUnarchiveThenReloadsTheListFromTheServer() async throws {
        let stub = StubServer()
        let viewModel = try makeViewModel(stub)
        await viewModel.load()

        let didArchive = await viewModel.archive(try session("session-abc", in: viewModel))
        XCTAssertTrue(didArchive)
        XCTAssertEqual(viewModel.archiveUndo?.sessionID, "session-abc")
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-def"])

        let didUndo = await viewModel.undoArchive()

        XCTAssertTrue(didUndo)
        XCTAssertNil(viewModel.archiveUndo)
        XCTAssertEqual(stub.archiveBodies.filter { !$0.archived }.map(\.id), ["session-abc"])
        XCTAssertEqual(stub.loadCount, 3, "Undo reloads the list after the server confirms")
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-abc", "session-def"])
        XCTAssertNil(viewModel.actionErrorMessage)
    }

    func testASecondArchiveReplacesTheUndoSoOnlyTheLatestIsUndoable() async throws {
        let stub = StubServer()
        let viewModel = try makeViewModel(stub)
        await viewModel.load()

        _ = await viewModel.archive(try session("session-abc", in: viewModel))
        _ = await viewModel.archive(try session("session-def", in: viewModel))
        XCTAssertEqual(viewModel.archiveUndo?.sessionID, "session-def")

        let didUndo = await viewModel.undoArchive()
        let didUndoAgain = await viewModel.undoArchive()

        XCTAssertTrue(didUndo)
        XCTAssertFalse(didUndoAgain, "The earlier archive is no longer undoable")
        XCTAssertEqual(stub.archiveBodies.filter { !$0.archived }.map(\.id), ["session-def"])
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-def"])
    }

    func testAFailedUndoStaysOfferedForRetryAndSurfacesTheError() async throws {
        let stub = StubServer()
        stub.failingUnarchives = 1
        let viewModel = try makeViewModel(stub)
        await viewModel.load()
        _ = await viewModel.archive(try session("session-abc", in: viewModel))

        let didUndo = await viewModel.undoArchive()

        XCTAssertFalse(didUndo)
        XCTAssertEqual(viewModel.archiveUndo?.sessionID, "session-abc")
        XCTAssertEqual(viewModel.archiveUndo?.undoFailed, true)
        XCTAssertNotNil(viewModel.actionErrorMessage)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-def"])

        let didRetry = await viewModel.undoArchive()

        XCTAssertTrue(didRetry)
        XCTAssertNil(viewModel.archiveUndo)
        XCTAssertEqual(viewModel.sessions.compactMap(\.sessionId), ["session-abc", "session-def"])
    }

    func testTheUndoExpiresAfterItsLifetimeWithoutAnotherRequest() async throws {
        let stub = StubServer()
        let viewModel = try makeViewModel(stub, archiveUndoLifetime: .milliseconds(50))
        await viewModel.load()
        _ = await viewModel.archive(try session("session-abc", in: viewModel))
        XCTAssertNotNil(viewModel.archiveUndo)

        let deadline = ContinuousClock.now + .seconds(5)
        while viewModel.archiveUndo != nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        let didUndo = await viewModel.undoArchive()

        XCTAssertNil(viewModel.archiveUndo, "The undo did not expire")
        XCTAssertFalse(didUndo)
        XCTAssertEqual(stub.archiveBodies.count, 1, "An expired undo sent a request")
    }
}
