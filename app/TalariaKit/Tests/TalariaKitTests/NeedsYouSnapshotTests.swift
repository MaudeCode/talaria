import XCTest
@testable import TalariaKit

/// TAL-1479: the Needs you widget's snapshot, written from the Relay aggregate and from the session list's activity
/// summary read.
@MainActor
final class NeedsYouSnapshotTests: APIClientTestCase {
    private let server = URL(string: "https://example.test")!

    /// Server order: two approvals then an answer, interleaved with running rows; neither titles nor ids sort that way.
    private let serverRows: [(id: String, title: String, phase: String)] = [
        ("s-9", "Zeta deploy", "waiting_for_approval"),
        ("s-1", "Running build", "running"),
        ("s-5", "Alpha review", "waiting_for_approval"),
        ("s-2", "Mid question", "waiting_for_input"),
        ("s-3", "Starting chat", "starting"),
    ]

    func testRelayAndSessionListWritesProduceTheSameSnapshotInServerOrder() async throws {
        let relayStore = makeStore()
        let listStore = makeStore()
        let date = Date(timeIntervalSince1970: 1_800_000_000)

        let summary = try await summary(serverRows)
        XCTAssertTrue(relayStore.save(relay: relayAggregate(serverRows), at: date))
        XCTAssertTrue(listStore.save(summary: summary, serverURL: server, at: date))

        let relay = try XCTUnwrap(relayStore.load())
        XCTAssertEqual(relay, listStore.load())
        XCTAssertEqual(relay.rows.map(\.sessionID), ["s-9", "s-5", "s-2"])
        XCTAssertEqual(relay.rows.map(\.title), ["Zeta deploy", "Alpha review", "Mid question"])
        XCTAssertEqual(relay.rows.map(\.phase), ["waiting_for_approval", "waiting_for_approval", "waiting_for_input"])
        XCTAssertEqual(relay.updatedAt, date)
        XCTAssertEqual(relay.widgetURL, TalariaDeepLink.sessionURL(sessionID: "s-9", publisherID: "https://example.test"))
    }

    func testARefreshWithNoWaitingRowsWritesAnEmptySnapshot() async throws {
        let store = makeStore()
        let running = serverRows.filter { !$0.phase.hasPrefix("waiting") }

        let summary = try await summary(running)
        XCTAssertTrue(store.save(relay: relayAggregate(serverRows)))
        XCTAssertTrue(store.save(summary: summary, serverURL: server))
        XCTAssertEqual(store.load()?.rows, [])

        XCTAssertTrue(store.save(relay: relayAggregate(serverRows)))
        XCTAssertTrue(store.save(relay: nil))
        XCTAssertEqual(store.load()?.rows, [])
    }

    func testSessionListRefreshWritesTheServersWaitingChats() async throws {
        let store = makeStore()
        let summaryJSON = summaryJSON(serverRows)
        let client = makeClient { request in
            apiTestJSONResponse(request.url?.path == "/api/activity/summary" ? summaryJSON : #"{"sessions":[]}"#, for: request)
        }
        let viewModel = SessionListViewModel(server: server, client: client, needsYouStore: store)

        let loaded = await viewModel.load()
        XCTAssertTrue(loaded)
        for _ in 0..<200 where store.load() == nil { try await Task.sleep(for: .milliseconds(10)) }

        XCTAssertEqual(store.load()?.rows.map(\.sessionID), ["s-9", "s-5", "s-2"])
    }

    private func makeStore() -> NeedsYouSnapshotStore {
        let suite = "NeedsYouSnapshotTests.\(UUID().uuidString)"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        return NeedsYouSnapshotStore(defaults: UserDefaults(suiteName: suite))
    }

    private func relayAggregate(_ rows: [(id: String, title: String, phase: String)]) -> TalariaAggregateActivityAttributes.ContentState {
        TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: rows.count, title: "Talaria", subtitle: "", updatedAt: 0,
            rows: rows.map {
                .init(
                    publisherId: "https://example.test", publisherLabel: "example.test", sessionId: $0.id, title: $0.title,
                    phase: $0.phase, status: "", updatedAt: 0, deepLink: "/sessions/\($0.id)"
                )
            }
        )
    }

    private func summary(_ rows: [(id: String, title: String, phase: String)]) async throws -> ActivitySummary {
        let json = summaryJSON(rows)
        return try await makeClient { apiTestJSONResponse(json, for: $0) }.activitySummary()
    }

    private func summaryJSON(_ rows: [(id: String, title: String, phase: String)]) -> String {
        let items = rows.map {
            #"{"session_id":"\#($0.id)","title":"\#($0.title)","phase":"\#($0.phase)","started_at":1,"updated_at":2,"deep_link":"/sessions/\#($0.id)"}"#
        }
        return #"{"running_count":0,"waiting_count":0,"rows":[\#(items.joined(separator: ","))]}"#
    }
}
