import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of LiveActivityTests that need the App host; the rest run in TalariaKitTests (TAL-399).
@MainActor
final class LiveActivityTests: XCTestCase {
    func testFullExcerptSkipsNormalizationAndActivityUpdatesForTwoThousandTokens() async throws {
        var normalizationRequests = 0
        var updates: [AgentRunActivityAttributes.ContentState] = []
        let excerptDelivered = expectation(description: "Full excerpt delivered")
        let manager = AgentLiveActivityManager(
            minimumUpdateInterval: 0,
            updateActivity: {
                updates.append($0)
                if updates.count == 2 { excerptDelivered.fulfill() }
            },
            setInterimAssistant: { text, state in
                normalizationRequests += 1
                return AgentRunActivityStateReducer.settingInterimAssistant(text, on: state)
            }
        )
        manager.start(
            sessionID: "prefix-fixture", sessionTitle: "Prefix fixture", streamID: "prefix-stream",
            publisherURL: URL(string: "https://fixture.example")!
        )
        manager.update(.token(String(repeating: "a", count: 141)))
        await fulfillment(of: [excerptDelivered], timeout: 5)
        let fullState = try XCTUnwrap(manager.currentState)
        XCTAssertEqual(fullState.responseExcerpt, String(repeating: "a", count: 137) + "...")
        let initialNormalizations = normalizationRequests
        let initialUpdates = updates.count

        for _ in 0..<2_000 {
            manager.update(.token(" more"))
            await Task.yield()
        }
        for _ in 0..<10 { await Task.yield() }

        // Each reducer request executes normalizedSingleLine; none should reach it after the cut.
        XCTAssertEqual(normalizationRequests - initialNormalizations, 0, "Full excerpts must skip normalization")
        XCTAssertEqual(updates.count - initialUpdates, 0, "Full excerpts must not request ActivityKit updates")
        XCTAssertEqual(manager.currentState, fullState)
    }

    func testUnchangedContentOnlyRefreshesAtStaleInterval() async throws {
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        var updates: [AgentRunActivityAttributes.ContentState] = []
        let refreshed = expectation(description: "Stale-content heartbeat")
        let manager = AgentLiveActivityManager(
            minimumUpdateInterval: 0, now: { clock },
            updateActivity: {
                updates.append($0)
                if updates.count == 2 { refreshed.fulfill() }
            }
        )
        manager.start(
            sessionID: "heartbeat-fixture", sessionTitle: "Heartbeat", streamID: "heartbeat-stream",
            publisherURL: URL(string: "https://fixture.example")!
        )
        clock += AgentLiveActivityManager.staleContentInterval - 1
        manager.update(.sessionTitle("Heartbeat"))
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(updates.count, 1, "A timestamp-only change must not push an update")
        clock += 1
        manager.update(.sessionTitle("Heartbeat"))
        await fulfillment(of: [refreshed], timeout: 5)
        XCTAssertEqual(updates.count, 2)
        XCTAssertEqual(updates.last?.updatedAt, clock)
    }

    func testFullExcerptPreservesPhaseChangesAndResets() async throws {
        var updates: [AgentRunActivityAttributes.ContentState] = []
        let resumed = expectation(description: "Token resumes the writing phase")
        var waitingForResume = false
        let manager = AgentLiveActivityManager(
            minimumUpdateInterval: 0,
            updateActivity: {
                updates.append($0)
                if waitingForResume && $0.status == .responding { resumed.fulfill() }
            }
        )
        let publisher = URL(string: "https://fixture.example")!
        manager.start(sessionID: "phase-fixture", sessionTitle: "Phases", streamID: "phase-stream", publisherURL: publisher)
        manager.update(.token(String(repeating: "x", count: 141)))
        let excerpt = manager.currentState?.responseExcerpt
        manager.update(.toolStarted(kind: .shell, name: "fixture"))
        XCTAssertEqual(manager.currentState?.status, .runningCommand)
        manager.update(.toolCompleted)
        XCTAssertEqual(manager.currentState?.currentActivity, "Processing result")
        waitingForResume = true
        manager.update(.token(" invisible tail"))
        await fulfillment(of: [resumed], timeout: 5)
        waitingForResume = false
        XCTAssertEqual(manager.currentState?.currentActivity, "Writing response")
        XCTAssertEqual(updates.last?.responseExcerpt, excerpt)
        manager.markStale()
        manager.update(.token(" resumes freshness"))
        XCTAssertEqual(manager.currentState?.isStale, false)

        manager.update(.clearResponseExcerpt)
        manager.update(.token("New reply"))
        XCTAssertEqual(manager.currentState?.responseExcerpt, "New reply")
        manager.start(sessionID: "phase-fixture", sessionTitle: "Phases", streamID: "next-stream", publisherURL: publisher)
        manager.update(.interimAssistant("Interim"))
        manager.update(.token(" reply"))
        XCTAssertEqual(manager.currentState?.responseExcerpt, "Interim reply")
    }

    func testStreamingPrefixPreservesWhitespaceAndExactLimit() {
        let manager = AgentLiveActivityManager(updateActivity: { _ in })
        manager.start(
            sessionID: "spacing-fixture", sessionTitle: "Spacing", streamID: "spacing-stream",
            publisherURL: URL(string: "https://fixture.example")!
        )
        for token in ["  hello", "\n\t", "world"] { manager.update(.token(token)) }
        XCTAssertEqual(manager.currentState?.responseExcerpt, "hello world")
        manager.update(.clearResponseExcerpt)
        manager.update(.token(String(repeating: "a", count: 140)))
        manager.update(.token("   "))
        XCTAssertEqual(manager.currentState?.responseExcerpt, String(repeating: "a", count: 140))
        manager.update(.token("b"))
        XCTAssertEqual(manager.currentState?.responseExcerpt, String(repeating: "a", count: 137) + "...")
    }

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
