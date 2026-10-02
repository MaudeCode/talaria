import XCTest
@testable import TalariaKit

// TAL-437: Kanban shows the last board while it loads, keeps it when the load fails, and waits
// for the live board before allowing any action.
@MainActor
extension KanbanFeatureStateTests {
    private func makeSeededCache() -> ResponseCache {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let cache = ResponseCache(server: URL(string: "https://example.test")!, root: root)
        cache.entry(ResponseCache.Kind.kanbanConfiguration).save(Data(
            #"{"columns":["triage","todo","ready","running","blocked","done"],"read_only":false}"#.utf8
        ))
        cache.entry(ResponseCache.Kind.kanbanBoards).save(Data(
            #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#.utf8
        ))
        cache.entry(ResponseCache.Kind.kanbanBoard("main")).save(Data(
            #"{"changed":true,"read_only":false,"columns":[{"name":"ready","tasks":[{"id":"CACHED-1","title":"Cached card","status":"ready"}]}]}"#.utf8
        ))
        return cache
    }

    func testOfflineLoadKeepsTheLastBoardButAllowsNoActions() async {
        let offline = URLError(.notConnectedToInternet)
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(
                configurationResult: .failure(offline),
                boardsResult: .failure(offline),
                boardResult: .failure(offline)
            ),
            responseCache: makeSeededCache()
        )

        await state.load()

        XCTAssertEqual(state.state, .compatible, "The cached board stays on screen")
        let cards: [KanbanCard] = (state.snapshot?.columns ?? []).flatMap { $0.cards ?? [] }
        XCTAssertEqual(cards.compactMap(\.cardID), ["CACHED-1"])
        XCTAssertTrue(state.isShowingCachedBoard)
        XCTAssertTrue(state.refreshFailed)
        XCTAssertFalse(state.canUseServerAuthoritativeActions, "Actions wait for the live board")
        XCTAssertFalse(state.canEditCards)
    }

    func testLiveBoardReplacesTheCachedOneAndRestoresActions() async {
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(),
            responseCache: makeSeededCache()
        )

        await state.load()

        XCTAssertFalse(state.isShowingCachedBoard)
        XCTAssertEqual(state.snapshot, KanbanFixtures.snapshot)
        XCTAssertTrue(state.canUseServerAuthoritativeActions)
    }

    func testRetryAfterAFailedLoadRestoresActionsOnTheLiveBoard() async {
        let client = ReconnectingKanbanClient()
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client,
            responseCache: makeSeededCache()
        )
        await state.load()
        XCTAssertTrue(state.isShowingCachedBoard)

        await client.reconnect()
        await state.retry()

        XCTAssertFalse(state.isShowingCachedBoard)
        XCTAssertEqual(state.snapshot, KanbanFixtures.snapshot)
        XCTAssertTrue(state.canUseServerAuthoritativeActions, "The live board restores actions")
    }
}

/// Offline until `reconnect()`, then answers like `KanbanClientStub`.
private actor ReconnectingKanbanClient: KanbanDataClient {
    private var isConnected = false

    func reconnect() { isConnected = true }

    private func requireConnection() throws {
        guard isConnected else { throw URLError(.notConnectedToInternet) }
    }

    func kanbanConfiguration() throws -> KanbanConfiguration {
        try requireConnection()
        return KanbanFixtures.configuration
    }

    func kanbanBoards() throws -> KanbanBoardsResponse {
        try requireConnection()
        return KanbanFixtures.boards
    }

    func kanbanBoard(_ request: KanbanBoardRequest) throws -> KanbanBoardSnapshot {
        try requireConnection()
        return KanbanFixtures.snapshot
    }

    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }
}
