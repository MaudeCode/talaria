import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of LiveActivityTests that need the App host; the rest run in TalariaKitTests (TAL-399).
@MainActor
final class LiveActivityTests: XCTestCase {
    func testAggregateStaleWindowLeavesPriorityFiveDeliveryMargin() {
        XCTAssertEqual(TalariaAggregateLiveActivityManager.staleInterval, 10 * 60)
    }

    // #246 follow-up (PR #266 #3): the orphan reconciler must defer to a stream
    // whose SSE is live in this process. The manager tracks that ownership via the
    // lifecycle calls the coordinator already makes — set on `start`, cleared on
    // `markStale` (suspend/trouble) and `end` (finalize) — and
    // `orphanedActivities()` skips the tracked stream. This verifies the
    // ownership lifecycle directly (the ActivityKit-backed list isn't reachable in
    // unit tests, but the gate it consults is).
    @MainActor
    func testActiveConnectedStreamIDTracksLiveConnectionLifecycle() {
        let manager = AgentLiveActivityManager()

        // A live SSE connection claims the stream so the reconciler leaves it alone.
        manager.start(
            sessionID: "session-1",
            sessionTitle: "Title",
            streamID: "stream-abc",
            publisherURL: URL(string: "https://fixture.example")!
        )
        XCTAssertEqual(manager.activeConnectedStreamID, "stream-abc")

        // Suspension / transport trouble releases the claim — the suspended stream is
        // eligible for server-truth reconciliation again.
        manager.markStale()
        XCTAssertNil(manager.activeConnectedStreamID)

        // Reconnecting the same stream re-claims it.
        manager.start(
            sessionID: "session-1",
            sessionTitle: "Title",
            streamID: "stream-abc",
            publisherURL: URL(string: "https://fixture.example")!
        )
        XCTAssertEqual(manager.activeConnectedStreamID, "stream-abc")

        // Finalizing the run releases the claim.
        manager.end(status: .complete, activity: "Response complete")
        XCTAssertNil(manager.activeConnectedStreamID)
    }

    func testManagerKeepsEarliestStartAcrossSameRunReattach() throws {
        let manager = AgentLiveActivityManager()
        let publisherURL = URL(string: "https://fixture.example")!
        let discovered = Date(timeIntervalSince1970: 1_700_000_000)

        manager.start(sessionID: "session-1", sessionTitle: "Title", streamID: "stream-1", publisherURL: publisherURL, startedAt: discovered)
        XCTAssertEqual(manager.currentState?.startedAt, discovered)
        // A backdated run start must not backdate the activity's freshness: the
        // orphan reconciler keys its notification window on `updatedAt`.
        XCTAssertGreaterThan(try XCTUnwrap(manager.currentState?.updatedAt), discovered)

        // A later seed on the same run cannot move the timer forward.
        manager.start(sessionID: "session-1", sessionTitle: "Title", streamID: "stream-1", publisherURL: publisherURL, startedAt: discovered.addingTimeInterval(20))
        XCTAssertEqual(manager.currentState?.startedAt, discovered)

        // An earlier server start sharpens it.
        let serverStart = discovered.addingTimeInterval(-40)
        manager.start(sessionID: "session-1", sessionTitle: "Title", streamID: "stream-1", publisherURL: publisherURL, startedAt: serverStart)
        XCTAssertEqual(manager.currentState?.startedAt, serverStart)

        // A different run takes its own start.
        manager.start(sessionID: "session-1", sessionTitle: "Title", streamID: "stream-2", publisherURL: publisherURL, startedAt: discovered)
        XCTAssertEqual(manager.currentState?.startedAt, discovered)
        manager.end(status: .complete, activity: "Response complete")
    }

    func testAggregateModeStillTracksTheCurrentStreamForModeChanges() {
        let previous = UserDefaults.standard.string(forKey: TalariaLiveActivityMode.storageKey)
        UserDefaults.standard.set(
            TalariaLiveActivityMode.allRunning.rawValue,
            forKey: TalariaLiveActivityMode.storageKey
        )
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: TalariaLiveActivityMode.storageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: TalariaLiveActivityMode.storageKey)
            }
        }

        let manager = AgentLiveActivityManager()
        manager.start(
            sessionID: "session-1",
            sessionTitle: "Title",
            streamID: "stream-1",
            publisherURL: URL(string: "https://fixture.example")!
        )
        manager.update(.reasoning("Still tracked while aggregate mode renders"))

        XCTAssertEqual(manager.activeConnectedStreamID, "stream-1")
        manager.end(status: .complete, activity: "Response complete")
        XCTAssertNil(manager.activeConnectedStreamID)
    }
}
