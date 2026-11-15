import XCTest
@testable import TalariaKit

/// TAL-1479: the Needs you widget's snapshot, refreshed from the server's activity summary by the session list and
/// the Relay refresh.
@MainActor
final class NeedsYouSnapshotTests: APIClientTestCase {
    private let server = URL(string: "https://example.test")!

    /// The server's waiting group, in an order neither titles nor ids sort to, and a count beyond the rows it sent.
    private let summaryJSON = """
    {"running_count":1,"waiting_count":12,
     "rows":[\(row("s-9", "Zeta deploy", "waiting_for_approval")),\(row("s-1", "Running build", "running")),\(row("s-5", "Alpha review", "waiting_for_approval")),\(row("s-2", "Mid question", "waiting_for_input"))],
     "waiting":[\(row("s-9", "Zeta deploy", "waiting_for_approval")),\(row("s-5", "Alpha review", "waiting_for_approval")),\(row("s-2", "Mid question", "waiting_for_input"))],
     "running":[\(row("s-1", "Running build", "running"))],"approvals":[]}
    """

    func testARefreshSavesTheServersWaitingGroupAndCountInItsOrder() async throws {
        let store = makeStore()
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let json = summaryJSON
        let client = makeClient { apiTestJSONResponse(json, for: $0) }

        let saved = await store.refresh(client: client, serverURL: server, at: date)
        XCTAssertTrue(saved)

        let snapshot = try XCTUnwrap(store.load())
        XCTAssertEqual(snapshot.rows.map(\.sessionID), ["s-9", "s-5", "s-2"])
        XCTAssertEqual(snapshot.rows.map(\.title), ["Zeta deploy", "Alpha review", "Mid question"])
        XCTAssertEqual(snapshot.rows.map(\.phase), ["waiting_for_approval", "waiting_for_approval", "waiting_for_input"])
        XCTAssertEqual(snapshot.waitingCount, 12)
        XCTAssertEqual(snapshot.updatedAt, date)
        XCTAssertEqual(snapshot.widgetURL, TalariaDeepLink.sessionURL(sessionID: "s-9", publisherID: "https://example.test"))
    }

    func testARefreshWithNothingWaitingSavesAnEmptySnapshot() async throws {
        let store = makeStore()
        let json = summaryJSON
        let saved = await store.refresh(client: makeClient { apiTestJSONResponse(json, for: $0) }, serverURL: server)
        XCTAssertTrue(saved)

        let empty = #"{"running_count":0,"waiting_count":0,"rows":[],"waiting":[],"running":[],"approvals":[]}"#
        let savedEmpty = await store.refresh(client: makeClient { apiTestJSONResponse(empty, for: $0) }, serverURL: server)
        XCTAssertTrue(savedEmpty)
        XCTAssertEqual(store.load()?.rows, [])
        XCTAssertEqual(store.load()?.waitingCount, 0)
    }

    /// A sign-out while the read is in flight clears the snapshot; the read that finishes after it must not restore it.
    func testAReadOvertakenByAClearSavesNothing() async throws {
        let store = makeStore()
        let json = summaryJSON
        let client = makeClient { request in
            store.clear()
            return apiTestJSONResponse(json, for: request)
        }

        let saved = await store.refresh(client: client, serverURL: server)

        XCTAssertFalse(saved)
        XCTAssertNil(store.load())
    }

    func testSessionListRefreshSavesTheSameSnapshotAsTheRelayRefresh() async throws {
        let listStore = makeStore()
        let relayStore = makeStore()
        let json = summaryJSON
        let client = makeClient { request in
            apiTestJSONResponse(request.url?.path == "/api/activity/summary" ? json : #"{"sessions":[]}"#, for: request)
        }
        let viewModel = SessionListViewModel(server: server, client: client, needsYouStore: listStore)

        let loaded = await viewModel.load()
        XCTAssertTrue(loaded)
        for _ in 0..<200 where listStore.load() == nil { try await Task.sleep(for: .milliseconds(10)) }
        let relaySaved = await relayStore.refresh(client: client, serverURL: server)
        XCTAssertTrue(relaySaved)

        let list = try XCTUnwrap(listStore.load())
        let relay = try XCTUnwrap(relayStore.load())
        XCTAssertEqual(list.rows, relay.rows)
        XCTAssertEqual(list.waitingCount, relay.waitingCount)
        XCTAssertEqual(list.rows.map(\.sessionID), ["s-9", "s-5", "s-2"])
    }

    private func makeStore() -> NeedsYouSnapshotStore {
        let suite = "NeedsYouSnapshotTests.\(UUID().uuidString)"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        return NeedsYouSnapshotStore(defaults: UserDefaults(suiteName: suite))
    }
}

private func row(_ id: String, _ title: String, _ phase: String) -> String {
    #"{"session_id":"\#(id)","title":"\#(title)","phase":"\#(phase)","started_at":1,"updated_at":2,"deep_link":"/sessions/\#(id)"}"#
}
