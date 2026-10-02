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
}
