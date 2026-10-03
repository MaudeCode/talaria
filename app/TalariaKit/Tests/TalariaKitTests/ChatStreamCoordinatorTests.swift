import SwiftData
import XCTest
@testable import TalariaKit

final class ChatStreamCoordinatorTests: APIClientTestCase {
    @MainActor
    func testStartBuildsReplayURLAndStartsLiveActivity() throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-123", replayAfterSeq: 4, recoveryState: .reconnecting)

        let url = try XCTUnwrap(streamClient.startedURLs.first)
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(url.path, "/api/chat/stream")
        XCTAssertEqual(queryItems.first(where: { $0.name == "stream_id" })?.value, "stream-123")
        XCTAssertEqual(queryItems.first(where: { $0.name == "replay" })?.value, "1")
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "4")
        XCTAssertEqual(coordinator.activeStreamID, "stream-123")
        XCTAssertEqual(coordinator.recoveryState, .reconnecting)
        XCTAssertTrue(coordinator.isReplayConnection)
        XCTAssertEqual(delegate.startMonitoringCount, 1)
        XCTAssertEqual(liveActivityManager.starts, [
            CoordinatorSpyLiveActivityManager.Start(
                sessionID: "session-abc",
                sessionTitle: "Planning",
                streamID: "stream-123",
                startedAt: Self.fixedNow
            )
        ])
        XCTAssertTrue(liveActivityManager.aggregateArms.isEmpty)
    }

    @MainActor
    func testLocalStartArmsAggregateBeforeStartingPerSessionState() {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-123", armsAggregateForLocalWork: true)

        XCTAssertEqual(liveActivityManager.aggregateArms, [
            CoordinatorSpyLiveActivityManager.AggregateArm(
                sessionID: "session-abc",
                sessionTitle: "Planning",
                publisherURL: URL(string: "https://example.test")!
            )
        ])
        XCTAssertEqual(liveActivityManager.starts, [
            CoordinatorSpyLiveActivityManager.Start(
                sessionID: "session-abc",
                sessionTitle: "Planning",
                streamID: "stream-123",
                startedAt: Self.fixedNow
            )
        ])
    }

    @MainActor
    func testCancelledStreamInvalidatesItsSessionLoadPreparation() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient)

        coordinator.start(streamID: "stream-123")
        let preparation = coordinator.prepareForSessionLoad()
        XCTAssertTrue(coordinator.canApplySessionLoad(preparation))

        streamClient.emit(.cancelled)

        XCTAssertFalse(coordinator.canApplySessionLoad(preparation))
        XCTAssertNil(coordinator.activeStreamID)
    }

    @MainActor
    func testDoneInvalidatesOlderLoadButKeepsCompletionLoadCurrentThroughStreamEnd() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient)

        coordinator.start(streamID: "stream-123")
        let preCompletionPreparation = coordinator.prepareForSessionLoad()

        streamClient.emit(.done(DoneStreamEvent(session: nil)))

        XCTAssertFalse(coordinator.canApplySessionLoad(preCompletionPreparation))
        let completionPreparation = coordinator.prepareForSessionLoad()
        streamClient.emit(.streamEnd)
        XCTAssertTrue(coordinator.canApplySessionLoad(completionPreparation))
    }

    @MainActor
    func testSuspendSavesLastEventStopsStreamAndMarksLiveActivityStale() throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-123")
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-123:7")
        coordinator.suspendActiveStreamConnection()

        XCTAssertEqual(coordinator.lastEventID, "stream-123:7")
        XCTAssertTrue(coordinator.isConnectionSuspended)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(delegate.saveSnapshotCount, 1)
        XCTAssertEqual(delegate.stopMonitoringClearPromptValues, [true])
        XCTAssertEqual(liveActivityManager.markStaleCount, 1)
    }

    @MainActor
    func testForegroundReconnectActiveStreamReloadsAndRestartsWithoutReplay() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        XCTAssertEqual(delegate.loadMessagesCount, 1)
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "replay" }))
    }

    @MainActor
    func testForegroundReconnectActiveStreamDoesNotRestartAfterReplacementDuringLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }
        delegate.onLoadMessages = {
            coordinator.start(streamID: "stream-new")
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        XCTAssertEqual(coordinator.activeStreamID, "stream-new")
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertEqual(delegate.loadMessagesCount, 1)
    }

    @MainActor
    func testForegroundReconnectInactiveReplayDoesNotRestartLiveActivity() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let coordinator = makeCoordinator(streamClient: streamClient, liveActivityManager: liveActivityManager, delegate: delegate) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(
                #"{"active": false, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-123:9")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "replay" })?.value, "1")
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "9")
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(liveActivityManager.starts.count, 1)
        XCTAssertEqual(liveActivityManager.orphanedEnds.map(\.streamID), ["stream-123"])
        XCTAssertEqual(liveActivityManager.orphanedEnds.last?.status, .complete)
        let updateCount = liveActivityManager.updates.count
        streamClient.emit(.reasoning(ReasoningStreamEvent(text: "Replayed reasoning")))
        XCTAssertEqual(liveActivityManager.updates.count, updateCount)

        // Leaving and reopening during transcript replay must not create another card.
        coordinator.suspendActiveStreamConnection()
        await coordinator.reconnectIfNeeded()
        XCTAssertEqual(liveActivityManager.starts.count, 1)
        streamClient.emit(.done(DoneStreamEvent(session: nil)))
        XCTAssertTrue(liveActivityManager.ends.isEmpty)

        coordinator.start(streamID: "new-running-stream")
        XCTAssertEqual(liveActivityManager.starts.last?.streamID, "new-running-stream")
        XCTAssertEqual(liveActivityManager.starts.count, 2)
    }

    @MainActor
    func testForegroundReconnectInactiveCompletedTranscriptFinishesStream() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertEqual(delegate.loadMessagesCount, 1)
        XCTAssertEqual(delegate.completedNeedsTranscriptRefreshValues, [false])
        XCTAssertEqual(liveActivityManager.ends.last?.status, .complete)
    }

    @MainActor
    func testForegroundReconnectInactiveWithoutAssistantFinalizesFailedAndEndsLiveActivity() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        // The reloaded transcript holds no settled outcome for the run.
        delegate.serverTerminalState = nil
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        // #246: this path previously re-armed and returned, leaving the Live
        // Activity stuck on "running". It must now finalize as failed and end it.
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(delegate.loadMessagesCount, 1)
        XCTAssertEqual(liveActivityManager.ends.last?.status, .failed)
    }

    @MainActor
    func testForegroundReconnectInactiveEndsLiveActivityWithTheTurnsSettledOutcome() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "cancelled"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        // The run's own turn (its stream id) is read from the reloaded transcript, not the latest reply.
        XCTAssertEqual(delegate.terminalStateTurnIDs, ["stream-123"])
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertEqual(liveActivityManager.ends.last?.status, .cancelled)
        XCTAssertTrue(delegate.completedNeedsTranscriptRefreshValues.isEmpty)
    }

    @MainActor
    func testRefreshTranscriptIfCompletedWithoutAssistantKeepsWaitingWithoutEndingLiveActivity() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = nil
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")

        await coordinator.refreshTranscriptIfCompleted(streamID: "stream-123")

        // The live SSE is still connected here, so the foreground safety net must
        // keep waiting for the real completion rather than finalizing (#246). This
        // is the deliberate counterpart to the reconnect-after-suspend fix.
        XCTAssertEqual(coordinator.activeStreamID, "stream-123")
        XCTAssertEqual(delegate.loadMessagesCount, 1)
        XCTAssertTrue(liveActivityManager.ends.isEmpty)
    }

    @MainActor
    func testRefreshTranscriptIfCompletedBailsWhenStreamReplacedDuringLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        // A newer run starts while the transcript reload is suspended.
        delegate.onLoadMessages = {
            coordinator.start(streamID: "stream-new")
        }

        coordinator.start(streamID: "stream-123")

        await coordinator.refreshTranscriptIfCompleted(streamID: "stream-123")

        // PR #266: the post-load guard must bail so the newer stream is neither
        // finalized nor clobbered by the now-stale refresh.
        XCTAssertEqual(coordinator.activeStreamID, "stream-new")
        XCTAssertTrue(liveActivityManager.ends.isEmpty)
    }

    @MainActor
    func testRefreshTranscriptIfCompletedSkipsFinalizeWhenRunCompletesDuringLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        // The live SSE delivers completion while the transcript reload is suspended.
        delegate.onLoadMessages = {
            streamClient.emit(.done(DoneStreamEvent()))
        }

        coordinator.start(streamID: "stream-123")

        await coordinator.refreshTranscriptIfCompleted(streamID: "stream-123")

        // PR #266 #2: only the live-SSE completion finalizes; the now-stale refresh
        // must not finalize again (no double end / double finishStream). The run
        // generation captured before the load changed, so the refresh bails.
        XCTAssertEqual(liveActivityManager.ends.map(\.status), [.complete])
        XCTAssertNil(coordinator.activeStreamID)
    }

    @MainActor
    func testForegroundReconnectInactiveCompletedStreamDoesNotFinishReplacementAfterLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        delegate.onLoadMessages = {
            coordinator.start(streamID: "stream-new")
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        XCTAssertEqual(coordinator.activeStreamID, "stream-new")
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertTrue(delegate.completedNeedsTranscriptRefreshValues.isEmpty)
        XCTAssertTrue(liveActivityManager.ends.isEmpty)
    }

    @MainActor
    func testStaleDetectionWaitsForTransportQuietThresholdThenPollsStatus() async throws {
        var statusRequests = 0
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            timing: ChatStreamCoordinatorTiming(
                checkingInterval: 5,
                reconnectInterval: 18,
                runningToolReconnectInterval: 25,
                statusPollCooldown: 4,
                transportFreshInterval: 12
            )
        ) { request in
            statusRequests += 1
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: start)

        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(4.9))
        XCTAssertEqual(statusRequests, 0)
        XCTAssertEqual(coordinator.recoveryState, .idle)

        // #227: semantically quiet past checkingInterval, but the transport was
        // active 5.1s ago — still within transportFreshInterval, so no chip and
        // no status poll yet.
        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(5.1))
        XCTAssertEqual(statusRequests, 0)
        XCTAssertEqual(coordinator.recoveryState, .idle)

        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(12.1))
        XCTAssertEqual(statusRequests, 1)
        XCTAssertEqual(coordinator.recoveryState, .checking)
    }

    @MainActor
    func testHeartbeatKeepsSemanticallyQuietStreamOnOriginalConnection() async throws {
        var statusRequests = 0
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            statusRequests += 1
            return apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: Date().addingTimeInterval(-60))
        streamClient.emit(.heartbeat)

        await coordinator.recoverStaleStreamIfNeeded(now: Date().addingTimeInterval(1))

        // #227: the heartbeat 1s ago proves the transport is alive, so the
        // semantically quiet stream stays idle with zero status polls — no
        // "Checking stream" chip and no reconnect.
        XCTAssertEqual(statusRequests, 0)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.stopCount, 0)
        XCTAssertEqual(coordinator.recoveryState, .idle)
    }

    @MainActor
    func testHeartbeatDemotesCheckingStateToIdle() async throws {
        var statusRequests = 0
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            statusRequests += 1
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: Date().addingTimeInterval(-13))

        await coordinator.recoverStaleStreamIfNeeded(now: Date())
        XCTAssertEqual(statusRequests, 1)
        XCTAssertEqual(coordinator.recoveryState, .checking)

        streamClient.emit(.heartbeat)

        XCTAssertEqual(coordinator.recoveryState, .idle)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.stopCount, 0)
    }

    // The MockURLProtocol handler runs on URLSession's protocol thread while the
    // coordinator's status-poll await has suspended the main actor, so a
    // main-queue sync hop delivers the heartbeat deterministically *mid-flight*
    // — before the poll's continuation resumes (PR #238 review).
    @MainActor
    func testHeartbeatDuringStatusPollKeepsIdleStateWithoutReassertingChecking() async throws {
        var statusRequests = 0
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            statusRequests += 1
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { streamClient.emit(.heartbeat) }
            }
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: Date().addingTimeInterval(-13))

        await coordinator.recoverStaleStreamIfNeeded(now: Date())

        XCTAssertEqual(statusRequests, 1)
        XCTAssertEqual(coordinator.recoveryState, .idle)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.stopCount, 0)
    }

    @MainActor
    func testHeartbeatDuringForceReconnectStatusPollSkipsReconnect() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { streamClient.emit(.heartbeat) }
            }
            return apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: Date().addingTimeInterval(-19))

        await coordinator.recoverStaleStreamIfNeeded(now: Date())

        XCTAssertEqual(coordinator.recoveryState, .idle)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertEqual(streamClient.stopCount, 0)
    }

    @MainActor
    func testHeartbeatDoesNotDemoteReconnectingState() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: Date().addingTimeInterval(-20))

        await coordinator.recoverStaleStreamIfNeeded(now: Date())
        XCTAssertEqual(coordinator.recoveryState, .reconnecting)

        streamClient.emit(.heartbeat)

        XCTAssertEqual(coordinator.recoveryState, .reconnecting)
    }

    @MainActor
    func testMissingTransportActivityReconnectsStaleActiveStream() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: start)

        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(18.1))

        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(coordinator.recoveryState, .reconnecting)
    }

    @MainActor
    func testSilentInitialConnectionReconnectsWhenStale() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let coordinator = makeCoordinator(streamClient: streamClient) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        XCTAssertNil(coordinator.lastProgressDate)
        let connectionStartedAt = try XCTUnwrap(coordinator.lastTransportActivityDate)

        await coordinator.recoverStaleStreamIfNeeded(
            now: connectionStartedAt.addingTimeInterval(18.1)
        )

        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(coordinator.recoveryState, .reconnecting)
    }

    @MainActor
    func testStaleRecoveryDoesNotFinishReplacementStreamAfterTranscriptLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate,
            timing: ChatStreamCoordinatorTiming(
                checkingInterval: 5,
                reconnectInterval: 18,
                runningToolReconnectInterval: 25,
                statusPollCooldown: 4,
                transportFreshInterval: 12
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        delegate.onLoadMessages = {
            coordinator.start(streamID: "stream-new")
        }
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: start)

        // 12.1s: past transportFreshInterval, so the stale-recovery status poll
        // actually fires (#227).
        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(12.1))

        XCTAssertEqual(coordinator.activeStreamID, "stream-new")
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertTrue(delegate.completedNeedsTranscriptRefreshValues.isEmpty)
        XCTAssertTrue(liveActivityManager.ends.isEmpty)
    }

    @MainActor
    func testStaleRecoverySkipsFinalizeWhenRunCompletesDuringLoad() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate,
            timing: ChatStreamCoordinatorTiming(
                checkingInterval: 5,
                reconnectInterval: 18,
                runningToolReconnectInterval: 25,
                statusPollCooldown: 4,
                transportFreshInterval: 12
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        // The live SSE delivers completion while the stale-recovery transcript
        // reload is suspended.
        delegate.onLoadMessages = {
            streamClient.emit(.done(DoneStreamEvent()))
        }
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: start)

        // 12.1s: past transportFreshInterval, so the stale-recovery status poll
        // actually fires (#227).
        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(12.1))

        // PR #266 review #3: the run generation captured before the load changed
        // when `.done` finalized the run, so the now-stale stale-recovery path
        // bails via the shared canFinalizeRunAfterLoad guard instead of finalizing
        // a second time (no double end / double finishStream).
        XCTAssertEqual(liveActivityManager.ends.map(\.status), [.complete])
        XCTAssertNil(coordinator.activeStreamID)
    }

    @MainActor
    func testStaleRecoveryFinalizesInactiveStreamAndEndsLiveActivity() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        // The reloaded transcript surfaced the assistant reply for the completed run.
        delegate.serverTerminalState = "completed"
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate,
            timing: ChatStreamCoordinatorTiming(
                checkingInterval: 5,
                reconnectInterval: 18,
                runningToolReconnectInterval: 25,
                statusPollCooldown: 4,
                transportFreshInterval: 12
            )
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(#"{"active": false, "stream_id": "stream-123"}"#, for: request)
        }
        let start = Date(timeIntervalSince1970: 1_770_000_000)

        coordinator.start(streamID: "stream-123")
        coordinator.markProgress(now: start)

        // 12.1s: past transportFreshInterval, so the stale-recovery status poll
        // actually fires (#227).
        await coordinator.recoverStaleStreamIfNeeded(now: start.addingTimeInterval(12.1))

        // Happy path: server reports the stale run inactive and no concurrent run or
        // completion intervened, so canFinalizeRunAfterLoad lets the stale-recovery
        // path complete from the refreshed transcript and end the Live Activity.
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertFalse(coordinator.isConnectionSuspended)
        XCTAssertEqual(liveActivityManager.ends.map(\.status), [.complete])
    }

    @MainActor
    func testTransportErrorSuspendsAndReconnectsWithReplay() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(
                #"{"active": false, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-123:4")
        streamClient.emit(.transportError("lost connection"), lastEventID: "stream-123:4")

        try await waitUntil { streamClient.startedURLs.count == 2 }

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "4")
        XCTAssertEqual(delegate.saveSnapshotCount, 1)
        XCTAssertEqual(liveActivityManager.markStaleCount, 1)
    }

    @MainActor
    func testTransportErrorRetriesAfterTemporaryStatusFailure() async throws {
        var statusAttempts = 0
        let streamClient = CoordinatorSpySSEStreamingClient()
        let timing = ChatStreamCoordinatorTiming(
            checkingInterval: 5,
            reconnectInterval: 18,
            runningToolReconnectInterval: 25,
            statusPollCooldown: 0.01,
            transportFreshInterval: 12
        )
        let coordinator = makeCoordinator(streamClient: streamClient, timing: timing) { request in
            statusAttempts += 1
            if statusAttempts == 1 {
                throw URLError(.notConnectedToInternet)
            }
            return apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123"}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        streamClient.emit(.transportError("lost connection"))

        try await waitUntil { statusAttempts == 2 && streamClient.startedURLs.count == 2 }

        XCTAssertFalse(coordinator.isConnectionSuspended)
    }

    @MainActor
    func testCancelDoesNotFinishReplacementStreamWhenResponseReturnsLate() async throws {
        let cancelRequestStarted = expectation(description: "cancel request started")
        let releaseCancelResponse = DispatchSemaphore(value: 0)
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/cancel")
            cancelRequestStarted.fulfill()
            _ = releaseCancelResponse.wait(timeout: .now() + 10)
            return apiTestJSONResponse(#"{"ok": true}"#, for: request)
        }

        coordinator.start(streamID: "stream-cancel")
        let cancelTask = Task { @MainActor in
            try await coordinator.cancelActiveStream()
        }

        await fulfillment(of: [cancelRequestStarted], timeout: 10)
        coordinator.start(streamID: "stream-new")
        releaseCancelResponse.signal()
        let response = try await cancelTask.value

        XCTAssertEqual(response?.ok, true)
        XCTAssertEqual(coordinator.activeStreamID, "stream-new")
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertTrue(liveActivityManager.ends.isEmpty)
        XCTAssertEqual(delegate.finishCount, 0)
    }

    @MainActor
    func testTerminalFramesEndLiveActivityWithServerTerminalState() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )
        let frames: [(String, String, AgentRunActivityStatus)] = [
            ("apperror", #"{"type":"cancelled","terminal_state":"cancelled","message":"Task cancelled"}"#, .cancelled),
            ("apperror", #"{"type":"interrupted","terminal_state":"interrupted","message":"Lost"}"#, .failed),
            ("apperror", #"{"type":"compression_exhausted","terminal_state":"compression_exhausted","message":"Full"}"#, .failed),
            ("done", #"{"terminal_state":"no_response"}"#, .failed),
            ("done", #"{"terminal_state":"tool_limit_reached"}"#, .complete),
            ("done", #"{"terminal_state":"completed"}"#, .complete),
        ]
        for (index, (event, data, status)) in frames.enumerated() {
            coordinator.start(streamID: "stream-\(index)")
            for decoded in SSEEventDecoder.decodeFrame(eventType: event, data: data) {
                streamClient.emit(decoded)
            }
            XCTAssertNil(coordinator.activeStreamID, data)
            XCTAssertEqual(liveActivityManager.ends.last?.status, status, data)
        }
        // A cancelled run is not an error: it shows no failure message.
        XCTAssertEqual(delegate.errorMessages, ["Lost", "Full"])
        // Only the two turns the server reports complete get the completion haptic and notification.
        XCTAssertEqual(delegate.completedNeedsTranscriptRefreshValues.count, 2)
    }

    @MainActor
    func testCompletionErrorAndCancelFinalizeLiveActivity() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/cancel")
            return apiTestJSONResponse(#"{"ok": true}"#, for: request)
        }

        coordinator.start(streamID: "stream-complete")
        streamClient.emit(.done(DoneStreamEvent()))
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertEqual(delegate.completedNeedsTranscriptRefreshValues, [true])
        XCTAssertEqual(liveActivityManager.ends.last?.status, .complete)

        coordinator.start(streamID: "stream-error")
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 12.25,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        XCTAssertEqual(coordinator.liveTokensPerSecond, 12.25)
        streamClient.emit(.error("server failed"))
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertNil(coordinator.liveTokensPerSecond)
        XCTAssertEqual(delegate.errorMessages, ["server failed"])
        XCTAssertEqual(liveActivityManager.ends.last?.status, .failed)

        coordinator.start(streamID: "stream-cancel")
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 24.5,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        XCTAssertEqual(coordinator.liveTokensPerSecond, 24.5)
        let response = try await coordinator.cancelActiveStream()
        XCTAssertEqual(response?.ok, true)
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertNil(coordinator.liveTokensPerSecond)
        XCTAssertEqual(liveActivityManager.ends.last?.status, .cancelled)
    }

    @MainActor
    func testLiveResponseSpeedAcceptsOnlyCurrentSessionExactReadingsAndClearsOnLifecycleChanges() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate)

        coordinator.start(streamID: "stream-one")
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 12.25,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        XCTAssertEqual(coordinator.liveTokensPerSecond, 12.25)

        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 99,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "another-session"
        )))
        XCTAssertEqual(coordinator.liveTokensPerSecond, 12.25)

        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 12.25,
            isTokensPerSecondAvailable: true,
            isEstimated: true,
            sessionId: "session-abc"
        )))
        XCTAssertNil(coordinator.liveTokensPerSecond)

        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 24.5,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        _ = coordinator.prepareForSessionLoad()
        XCTAssertNil(coordinator.liveTokensPerSecond)

        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 24.5,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        coordinator.start(streamID: "stream-two")
        XCTAssertNil(coordinator.liveTokensPerSecond)

        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 36.75,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        streamClient.emit(.done(DoneStreamEvent(usage: ContextWindowSnapshot(
            contextUsedTokens: nil,
            contextWindowTokens: nil,
            contextUsagePercent: nil,
            thresholdTokens: nil,
            inputTokens: nil,
            outputTokens: nil,
            estimatedCost: nil,
            tokensPerSecond: 40.5
        ))))

        XCTAssertNil(coordinator.liveTokensPerSecond)
        XCTAssertEqual(delegate.donePayloads.last?.usage?.tokensPerSecond, 40.5)
    }

    @MainActor
    func testLiveResponseSpeedClearsImmediatelyWhenTransportFails() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate)

        coordinator.start(streamID: "stream-one")
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 12.25,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))
        XCTAssertEqual(coordinator.liveTokensPerSecond, 12.25)

        streamClient.emit(.transportError("Connection lost"))

        XCTAssertNil(coordinator.liveTokensPerSecond)
        XCTAssertTrue(coordinator.isConnectionSuspended)
    }

    @MainActor
    func testDecodedAppErrorEventTerminatesStreamAndSurfacesMessage() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-apperror")
        streamClient.emit(SSEEventDecoder.decode(
            eventType: "apperror",
            data: #"{"message": "Auto-compression failed", "type": "compression_error"}"#
        ))

        // apperror rides the terminal `.error` path: message surfaced, run failed,
        // socket stopped, stream fully finished (issue #25).
        XCTAssertEqual(delegate.errorMessages, ["Auto-compression failed"])
        XCTAssertEqual(liveActivityManager.ends.last?.status, .failed)
        XCTAssertNil(coordinator.activeStreamID)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(delegate.finishCount, 1)
    }

    @MainActor
    func testTerminalFenceRejectsLateContentAndCompetingTerminalsAfterDone() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-done")
        streamClient.emit(.token("Answer."))
        streamClient.emit(.done(DoneStreamEvent()))

        // Late content on the connection the completed response left open.
        streamClient.emit(.token(" leaked"))
        streamClient.emit(.reasoning(ReasoningStreamEvent(text: "leaked", titles: [])))
        streamClient.emit(.done(DoneStreamEvent()))
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 99,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: nil
        )))

        XCTAssertEqual(delegate.tokens, ["Answer."])
        XCTAssertEqual(delegate.donePayloads.count, 1)
        XCTAssertNil(coordinator.liveTokensPerSecond)

        // The fence still admits a post-completion title and same-session metering.
        streamClient.emit(.title(TitleStreamEvent(sessionId: "session-abc", title: "Renamed")))
        streamClient.emit(.metering(MeteringStreamEvent(
            tokensPerSecond: 21,
            isTokensPerSecondAvailable: true,
            isEstimated: false,
            sessionId: "session-abc"
        )))

        XCTAssertEqual(delegate.titles, ["Renamed"])
        XCTAssertEqual(coordinator.liveTokensPerSecond, 21)

        // One terminal transition and one teardown, however many terminals land —
        // including the ones still in flight when the connection was torn down.
        streamClient.emit(.streamEnd)
        streamClient.emitAfterStop(.error("late failure"))
        streamClient.emitAfterStop(.cancelled)
        streamClient.emitAfterStop(.token(" later"))

        XCTAssertTrue(delegate.errorMessages.isEmpty)
        XCTAssertEqual(delegate.tokens, ["Answer."])
        XCTAssertEqual(delegate.finishCount, 1)
        XCTAssertEqual(streamClient.stopCount, 1)
        XCTAssertEqual(liveActivityManager.ends.map(\.status), [.complete])
    }

    @MainActor
    func testConcurrentReconnectCallersShareOneStatusRequestLoadAndRestart() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        var statusRequestCount = 0
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            statusRequestCount += 1
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }
        delegate.onLoadMessages = { try? await Task.sleep(nanoseconds: 20_000_000) }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        async let first: Void = coordinator.reconnectIfNeeded()
        async let second: Void = coordinator.reconnectIfNeeded()
        _ = await (first, second)

        XCTAssertEqual(statusRequestCount, 1)
        XCTAssertEqual(delegate.loadMessagesCount, 1)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertFalse(coordinator.isConnectionSuspended)
    }

    @MainActor
    func testReconnectWithPersistenceContextTakesOverContextlessRequest() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        var statusRequestCount = 0
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            statusRequestCount += 1
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }
        let contextlessLoadStarted = expectation(description: "context-less transcript load started")
        // The context-less load stays in flight until the context-bearing caller cancels it; a fixed 200 ms
        // load could finish first on a slow runner, leaving nothing to take over.
        delegate.onLoadMessages = { [weak delegate] in
            guard delegate?.loadMessagesCount == 1 else { return }
            contextlessLoadStarted.fulfill()
            try? await Task.sleep(for: .seconds(10))
        }

        coordinator.start(streamID: "stream-123")
        coordinator.suspendActiveStreamConnection()

        let contextless = Task { @MainActor in await coordinator.reconnectIfNeeded() }
        await fulfillment(of: [contextlessLoadStarted], timeout: 10)
        await coordinator.reconnectIfNeeded(modelContext: try makeCoordinatorTestContext())
        await contextless.value

        // The context-bearing caller took ownership; the context-less one bailed.
        XCTAssertEqual(delegate.loadMessagesHadModelContext, [false, true])
        XCTAssertEqual(statusRequestCount, 2)
        XCTAssertEqual(streamClient.startedURLs.count, 2)
        XCTAssertFalse(coordinator.isConnectionSuspended)
    }

    @MainActor
    func testColdRelaunchResumesFromTheLoadedTranscriptCursor() async throws {
        let (streamClient, delegate, coordinator) = try await coldRelaunch(
            transcriptSeq: TranscriptSeq(streamId: "stream-cold", seq: 0)
        )

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "replay" })?.value, "1")
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        XCTAssertTrue(coordinator.isReplayConnection)
        // The load holds none of the run's output, so the replay opens a new streaming message
        // instead of continuing the previous turn's answer.
        XCTAssertNil(delegate.streamCoordinatorStreamingAssistantMessageID)
    }

    @MainActor
    func testColdRelaunchWithoutTranscriptCursorAttachesLiveWithoutReplay() async throws {
        // No journal (or an older server): the transcript already holds the persisted segments.
        let (streamClient, delegate, coordinator) = try await coldRelaunch(transcriptSeq: nil)

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "replay" }))
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
        XCTAssertFalse(coordinator.isReplayConnection)
        XCTAssertEqual(delegate.streamCoordinatorStreamingAssistantMessageID, "assistant-latest")
    }

    @MainActor
    func testColdRelaunchAgainstServerWithoutCursorFieldOmitsLoadedTurnAndReplaysFromZero() async throws {
        let (streamClient, delegate, _) = try await coldRelaunch(transcriptSeq: nil, statesTranscriptSeq: false)

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
        XCTAssertEqual(delegate.omitLoadedRunningTurnCount, 1)
    }

    @MainActor
    func testColdRelaunchAgainstServerWithoutCursorFieldAttachesLiveWhenNoTurnStartIsLoaded() async throws {
        let (streamClient, _, _) = try await coldRelaunch(
            transcriptSeq: nil, statesTranscriptSeq: false, omitsLoadedRunningTurn: false
        )

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
    }

    @MainActor
    func testColdRelaunchIgnoresATranscriptCursorForAnotherStream() async throws {
        let (streamClient, _, _) = try await coldRelaunch(
            transcriptSeq: TranscriptSeq(streamId: "stream-other", seq: 3)
        )

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
    }

    /// A relaunched process adopts `stream-cold` without a snapshot or cursor; the
    /// recovery reload runs the same prepare/reconcile pair a second time with the
    /// run already adopted, exactly as `ChatViewModel.loadMessages` does.
    @MainActor
    private func coldRelaunch(
        transcriptSeq: TranscriptSeq?,
        statesTranscriptSeq: Bool = true,
        omitsLoadedRunningTurn: Bool = true
    ) async throws -> (CoordinatorSpySSEStreamingClient, CoordinatorDelegateSpy, ChatStreamCoordinator) {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        delegate.restoredSnapshotEventID = nil
        delegate.omitsLoadedRunningTurn = omitsLoadedRunningTurn
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/stream/status")
            return apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-cold", "replay_available": true}"#,
                for: request
            )
        }
        delegate.onLoadMessages = { @MainActor in
            let reloadPreparation = coordinator.prepareForSessionLoad()
            coordinator.reconcileSessionLoad(
                loadedActiveStreamID: "stream-cold",
                preparation: reloadPreparation,
                usedCacheFallback: false,
                transcriptSeq: transcriptSeq,
                statesTranscriptSeq: statesTranscriptSeq
            )
        }

        let preparation = coordinator.prepareForSessionLoad()
        coordinator.reconcileSessionLoad(
            loadedActiveStreamID: "stream-cold",
            preparation: preparation,
            usedCacheFallback: false,
            transcriptSeq: transcriptSeq,
            statesTranscriptSeq: statesTranscriptSeq
        )
        XCTAssertTrue(coordinator.isConnectionSuspended)
        XCTAssertNil(coordinator.lastEventID)

        await coordinator.reconnectIfNeeded()
        return (streamClient, delegate, coordinator)
    }

    @MainActor
    func testTransportErrorReconnectAfterSameStreamReloadDoesNotReplayFromZero() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }
        // The recovery reload reconciles the same run back onto this coordinator,
        // which is not a cold adoption even though the run emitted no event IDs.
        delegate.onLoadMessages = { @MainActor in
            let preparation = coordinator.prepareForSessionLoad()
            coordinator.reconcileSessionLoad(
                loadedActiveStreamID: "stream-123",
                preparation: preparation,
                usedCacheFallback: false
            )
        }

        coordinator.start(streamID: "stream-123")
        streamClient.emit(.token("Before reconnect."))
        streamClient.emit(.transportError("Connection lost"))

        try await waitUntil { streamClient.startedURLs.count == 2 }

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "replay" }))
        XCTAssertFalse(coordinator.isReplayConnection)
    }

    @MainActor
    func testHeartbeatOnResumedConnectionConfirmsRecovery() {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate)

        coordinator.start(streamID: "stream-123")
        XCTAssertEqual(delegate.confirmedRecoveryCount, 0)

        // A heartbeat proves the transport is healthy even while the model is
        // semantically quiet, which is all a recovery warning was about.
        streamClient.emit(.heartbeat)

        XCTAssertEqual(delegate.confirmedRecoveryCount, 1)
    }

    @MainActor
    func testActiveReconnectResumesAfterItsOwnCursorAndNeverReappliesIt() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-warm", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-warm")
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-warm:5")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "replay" })?.value, "1")
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "5")
        // An overlapping frame at or below the cursor is already on screen.
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-warm:5")
        // A frame without its own id (the journal missed it) keeps the sticky id and is new.
        streamClient.emit(.token(" Unjournaled."), lastEventID: "stream-warm:5")
        streamClient.emit(.token(" More."), lastEventID: "stream-warm:6")
        XCTAssertEqual(delegate.tokens, ["Partial answer.", " Unjournaled.", " More."])
    }

    @MainActor
    func testFinishedJournalReplayNeverResumesFromAnotherStreamsCursor() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            apiTestJSONResponse(
                #"{"active": false, "stream_id": "stream-123", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-123")
        // A stale Last-Event-ID left by an earlier run.
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-old:9")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        let replayURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: replayURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(queryItems.first(where: { $0.name == "stream_id" })?.value, "stream-123")
        XCTAssertEqual(queryItems.first(where: { $0.name == "after_seq" })?.value, "0")
    }

    @MainActor
    func testActiveReconnectNeverResumesFromAnotherStreamsCursor() async throws {
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(streamClient: streamClient, delegate: delegate) { request in
            apiTestJSONResponse(
                #"{"active": true, "stream_id": "stream-warm", "replay_available": true}"#,
                for: request
            )
        }

        coordinator.start(streamID: "stream-warm")
        // A stale Last-Event-ID left by an earlier run.
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-old:9")
        coordinator.suspendActiveStreamConnection()

        await coordinator.reconnectIfNeeded()

        let resumedURL = try XCTUnwrap(streamClient.startedURLs.last)
        let queryItems = URLComponents(url: resumedURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertNil(queryItems.first(where: { $0.name == "after_seq" }))
        XCTAssertNil(ChatStreamCoordinator.runJournalReplayAfterSeq(from: "stream-old:9", streamID: "stream-warm"))
        XCTAssertNil(ChatStreamCoordinator.runJournalReplayAfterSeq(from: "9", streamID: "stream-warm"))
        XCTAssertEqual(ChatStreamCoordinator.runJournalReplayAfterSeq(from: "stream:warm:9", streamID: "stream:warm"), 9)
    }

    // MARK: - Run start seeding (TAL-163)

    /// Synthetic "now" for the coordinator's injected clock, well after every
    /// server timestamp the fixtures use so seeds read as past events.
    private static let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)

    @MainActor
    func testStartSeedsLiveActivityFromServerRunStartAndKeepsEarliestAcrossReattach() {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(liveActivityManager: liveActivityManager, delegate: delegate)
        let serverStart = Self.fixedNow.addingTimeInterval(-90)

        coordinator.start(streamID: "stream-123", runStartedAt: serverStart)
        XCTAssertEqual(coordinator.activeRunStartedAt, serverStart)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, serverStart)

        // Same-run reattach without a seed keeps the recorded start.
        coordinator.start(streamID: "stream-123", replayAfterSeq: 4, recoveryState: .reconnecting)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, serverStart)

        // A later seed for the same run cannot move the start forward.
        coordinator.start(streamID: "stream-123", runStartedAt: serverStart.addingTimeInterval(30))
        XCTAssertEqual(coordinator.activeRunStartedAt, serverStart)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, serverStart)

        // An earlier seed sharpens it.
        let earlier = serverStart.addingTimeInterval(-15)
        coordinator.start(streamID: "stream-123", runStartedAt: earlier)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, earlier)
    }

    @MainActor
    func testFutureRunStartClampsToInjectedNow() {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(liveActivityManager: liveActivityManager, delegate: delegate)

        coordinator.start(streamID: "stream-123", runStartedAt: Self.fixedNow.addingTimeInterval(120))

        XCTAssertEqual(coordinator.activeRunStartedAt, Self.fixedNow)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, Self.fixedNow)
    }

    @MainActor
    func testNewRunResetsRunStartToDiscoveryTime() {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let streamClient = CoordinatorSpySSEStreamingClient()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            delegate: delegate
        )

        coordinator.start(streamID: "stream-1", runStartedAt: Self.fixedNow.addingTimeInterval(-600))
        streamClient.emit(.done(DoneStreamEvent()))
        XCTAssertNil(coordinator.activeRunStartedAt)

        coordinator.start(streamID: "stream-2")
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, Self.fixedNow)
    }

    @MainActor
    func testLoadedSessionAdoptionSeedsRunStartAndSurvivesRecoveryReload() async throws {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        delegate.restoredSnapshotEventID = nil
        let coordinator = makeCoordinator(liveActivityManager: liveActivityManager, delegate: delegate) { request in
            apiTestJSONResponse(#"{"active": true, "stream_id": "stream-cold"}"#, for: request)
        }
        let serverStart = Self.fixedNow.addingTimeInterval(-300)

        // The recovery reload re-seeds with a later value; the earliest must win.
        delegate.onLoadMessages = { @MainActor in
            let reloadPreparation = coordinator.prepareForSessionLoad()
            coordinator.reconcileSessionLoad(
                loadedActiveStreamID: "stream-cold",
                preparation: reloadPreparation,
                usedCacheFallback: false,
                runStartedAt: serverStart.addingTimeInterval(45)
            )
        }

        coordinator.reconcileSessionLoad(
            loadedActiveStreamID: "stream-cold",
            preparation: coordinator.prepareForSessionLoad(),
            usedCacheFallback: false,
            runStartedAt: serverStart
        )
        XCTAssertEqual(coordinator.activeRunStartedAt, serverStart)

        await coordinator.reconnectIfNeeded()

        XCTAssertEqual(liveActivityManager.starts.map(\.startedAt), [serverStart])
    }

    @MainActor
    func testLoadedSessionAdoptionWithoutSeedCountsFromDiscovery() {
        let coordinator = makeCoordinator()

        coordinator.reconcileSessionLoad(
            loadedActiveStreamID: "stream-cold",
            preparation: coordinator.prepareForSessionLoad(),
            usedCacheFallback: false
        )

        XCTAssertEqual(coordinator.activeRunStartedAt, Self.fixedNow)
    }

    @MainActor
    func testSwitchingAwayAndBackKeepsRunStartForSameStream() async throws {
        let liveActivityManager = CoordinatorSpyLiveActivityManager()
        let delegate = CoordinatorDelegateSpy()
        let coordinator = makeCoordinator(liveActivityManager: liveActivityManager, delegate: delegate) { request in
            apiTestJSONResponse(#"{"active": true, "stream_id": "stream-123"}"#, for: request)
        }
        let serverStart = Self.fixedNow.addingTimeInterval(-45)

        coordinator.start(streamID: "stream-123", runStartedAt: serverStart)
        coordinator.suspendActiveStreamConnection()
        // Coming back reloads the session; the latest user turn is the only seed
        // it can offer and it is later than the server start already recorded.
        coordinator.reconcileSessionLoad(
            loadedActiveStreamID: "stream-123",
            preparation: coordinator.prepareForSessionLoad(),
            usedCacheFallback: false,
            runStartedAt: serverStart.addingTimeInterval(5)
        )
        await coordinator.reconnectIfNeeded()

        XCTAssertEqual(liveActivityManager.starts.count, 2)
        XCTAssertEqual(liveActivityManager.starts.last?.startedAt, serverStart)
    }

    func testRunStartRejectsUnusableEpochSeconds() {
        XCTAssertNil(ChatStreamCoordinator.runStart(fromEpochSeconds: nil))
        XCTAssertNil(ChatStreamCoordinator.runStart(fromEpochSeconds: 0))
        XCTAssertNil(ChatStreamCoordinator.runStart(fromEpochSeconds: -5))
        XCTAssertNil(ChatStreamCoordinator.runStart(fromEpochSeconds: .nan))
        XCTAssertNil(ChatStreamCoordinator.runStart(fromEpochSeconds: .infinity))
        XCTAssertEqual(
            ChatStreamCoordinator.runStart(fromEpochSeconds: 1_700_000_000),
            Date(timeIntervalSince1970: 1_700_000_000)
        )
    }

    private func makeCoordinatorTestContext() throws -> ModelContext {
        let container = try ModelContainer(
            for: CachedSession.self,
            CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        return ModelContext(container)
    }

    @MainActor
    private func makeCoordinator(
        streamClient: CoordinatorSpySSEStreamingClient? = nil,
        liveActivityManager: CoordinatorSpyLiveActivityManager? = nil,
        delegate: CoordinatorDelegateSpy? = nil,
        timing: ChatStreamCoordinatorTiming = .standard,
        now: @escaping () -> Date = { ChatStreamCoordinatorTests.fixedNow },
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data) = { request in
            apiTestJSONResponse(#"{"active": true}"#, for: request)
        }
    ) -> ChatStreamCoordinator {
        let streamClient = streamClient ?? CoordinatorSpySSEStreamingClient()
        let liveActivityManager = liveActivityManager ?? CoordinatorSpyLiveActivityManager()
        let delegate = delegate ?? CoordinatorDelegateSpy()
        let coordinator = ChatStreamCoordinator(
            client: makeClient(handler: handler),
            streamClient: streamClient,
            liveActivityManager: liveActivityManager,
            showsLiveActivityResponseExcerpts: false,
            timing: timing,
            now: now
        )
        coordinator.attach(delegate: delegate)
        return coordinator
    }

    private func waitUntil(
        timeout: TimeInterval = 10,
        condition: @escaping @MainActor @Sendable () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await MainActor.run(body: condition) {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Timed out waiting for condition")
    }
}

@MainActor
private final class CoordinatorDelegateSpy: ChatStreamCoordinatorDelegate {
    var streamCoordinatorSessionID: String? = "session-abc"
    var streamCoordinatorDisplayTitle = "Planning"
    var streamCoordinatorHasRunningLiveToolCall = false
    var streamCoordinatorHasPendingPrompt = false
    /// The loaded transcript's settled outcome for the run; nil while it has none.
    var serverTerminalState: String?
    private(set) var terminalStateTurnIDs: [String] = []
    var streamCoordinatorStreamingAssistantMessageID: String?

    private(set) var loadMessagesCount = 0
    private(set) var startMonitoringCount = 0
    private(set) var stopMonitoringClearPromptValues: [Bool] = []
    private(set) var saveSnapshotCount = 0
    private(set) var restoredSnapshotStreamIDs: [String] = []
    private(set) var removedSnapshotStreamIDs: [String?] = []
    private(set) var flushedNoticeCount = 0
    private(set) var drainQueueCount = 0
    private(set) var refreshTitleCount = 0
    private(set) var completedNeedsTranscriptRefreshValues: [Bool] = []
    private(set) var finishCount = 0
    private(set) var errorMessages: [String] = []
    private(set) var recoveryErrors: [String] = []
    private(set) var confirmedRecoveryCount = 0
    private(set) var titles: [String] = []
    private(set) var loadMessagesHadModelContext: [Bool] = []
    private(set) var tokens: [String] = []
    private(set) var donePayloads: [DoneStreamEvent] = []
    private(set) var pendingSteers: [PendingSteer] = []
    private(set) var withdrawnSteers: [SteerWithdrawnEvent] = []
    private(set) var consumedSteerIDs: [String] = []
    var latestAssistantMessageID: String? = "assistant-latest"
    var restoredSnapshotEventID: String?
    var appendTokenResult = true
    var doneHasCompletedTranscript = false
    var onLoadMessages: (() async -> Void)?

    func streamCoordinatorLoadMessages(modelContext: ModelContext?) async {
        loadMessagesCount += 1
        loadMessagesHadModelContext.append(modelContext != nil)
        await onLoadMessages?()
    }

    func streamCoordinatorLatestAssistantMessageID() -> String? {
        latestAssistantMessageID
    }

    func streamCoordinatorServerTerminalState(turnID: String) -> String? {
        terminalStateTurnIDs.append(turnID)
        return serverTerminalState
    }

    var omitsLoadedRunningTurn = true
    private(set) var omitLoadedRunningTurnCount = 0

    func streamCoordinatorOmitLoadedRunningTurn() -> Bool {
        omitLoadedRunningTurnCount += 1
        return omitsLoadedRunningTurn
    }

    func streamCoordinatorStartAuxiliaryMonitoring() {
        startMonitoringCount += 1
    }

    func streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: Bool) {
        stopMonitoringClearPromptValues.append(clearPrompt)
    }

    func streamCoordinatorSaveSnapshotIfNeeded() {
        saveSnapshotCount += 1
    }

    func streamCoordinatorRestoreSnapshotIfAvailable(streamID: String) -> String? {
        restoredSnapshotStreamIDs.append(streamID)
        return restoredSnapshotEventID
    }

    func streamCoordinatorRemoveSnapshot(streamID: String?) {
        removedSnapshotStreamIDs.append(streamID)
    }

    func streamCoordinatorFlushPinnedLocalNoticesToTranscript() {
        flushedNoticeCount += 1
    }

    func streamCoordinatorDrainQueuedSlashMessageIfIdle() {
        drainQueueCount += 1
    }

    func streamCoordinatorRefreshCompletedResponseTitleIfNeeded() {
        refreshTitleCount += 1
    }

    func streamCoordinatorDidCompleteCurrentResponse(needsTranscriptRefresh: Bool) {
        completedNeedsTranscriptRefreshValues.append(needsTranscriptRefresh)
    }

    func streamCoordinatorDidFinishStream() {
        finishCount += 1
    }

    func streamCoordinatorDidReceiveErrorMessage(_ message: String) {
        errorMessages.append(message)
    }

    func streamCoordinatorDidConfirmRecovery() {
        confirmedRecoveryCount += 1
    }

    func streamCoordinatorDidReceiveRecoveryError(_ error: Error) {
        recoveryErrors.append(error.localizedDescription)
    }

    func streamCoordinatorAppendToken(_ text: String) -> Bool {
        tokens.append(text)
        return appendTokenResult
    }

    func streamCoordinatorAppendInterimAssistant(_ payload: InterimAssistantStreamEvent) -> Bool {
        payload.text?.isEmpty == false
    }

    func streamCoordinatorAppendReasoning(_ payload: ReasoningStreamEvent) -> Bool {
        !payload.text.isEmpty || !payload.titles.isEmpty
    }

    func streamCoordinatorAppendToolCall(_ payload: ToolStreamEvent) -> Bool {
        true
    }

    func streamCoordinatorCompleteToolCall(_ payload: ToolStreamEvent) -> Bool {
        true
    }

    func streamCoordinatorUpdateTitle(_ payload: TitleStreamEvent) -> Bool {
        guard let title = payload.title, !title.isEmpty else { return false }
        titles.append(title)
        return true
    }

    func streamCoordinatorApplyDone(_ payload: DoneStreamEvent) -> Bool {
        donePayloads.append(payload)
        return doneHasCompletedTranscript
    }

    func streamCoordinatorApplySettledSession(_ session: SessionDetail) {}

    func streamCoordinatorApplyApprovalUpdate(_ update: ApprovalPendingResponse) {}

    func streamCoordinatorApplyClarificationUpdate(_ update: ClarificationPendingResponse) {}

    func streamCoordinatorConsumeSteeringHint(_ event: SteeringStreamEvent) -> Bool {
        guard let steerID = event.steerId else { return false }
        consumedSteerIDs.append(steerID)
        return true
    }

    func streamCoordinatorApplyPendingSteer(_ steer: PendingSteer) {
        pendingSteers.append(steer)
    }

    func streamCoordinatorWithdrawSteer(_ event: SteerWithdrawnEvent) {
        withdrawnSteers.append(event)
    }
}

@MainActor
private final class CoordinatorSpySSEStreamingClient: SSEStreamingClient {
    private(set) var startedURLs: [URL] = []
    private(set) var stopCount = 0
    private(set) var lastEventID: String?
    private var onEvent: (@MainActor (SSEEvent) -> Void)?
    private var lastStartedOnEvent: (@MainActor (SSEEvent) -> Void)?

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        startedURLs.append(url)
        lastEventID = nil
        self.onEvent = onEvent
        lastStartedOnEvent = onEvent
    }

    func stop() {
        stopCount += 1
        onEvent = nil
    }

    func emit(_ event: SSEEvent, lastEventID: String? = nil) {
        self.lastEventID = lastEventID
        onEvent?(event)
    }

    /// Delivers an event that a real connection still had in flight when the
    /// coordinator tore the run down.
    func emitAfterStop(_ event: SSEEvent) {
        lastStartedOnEvent?(event)
    }
}

@MainActor
private final class CoordinatorSpyLiveActivityManager: AgentLiveActivityManaging {
    struct AggregateArm: Equatable {
        let sessionID: String
        let sessionTitle: String
        let publisherURL: URL
    }

    struct Start: Equatable {
        let sessionID: String
        let sessionTitle: String
        let streamID: String?
        let startedAt: Date
    }

    struct End: Equatable {
        let status: AgentRunActivityStatus
        let activity: String
        let errorSummary: String?
    }

    private(set) var orphanedEnds: [(streamID: String, status: AgentRunActivityStatus)] = []

    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool {
        orphanedEnds.append((streamID, status))
        return true
    }

    private(set) var starts: [Start] = []
    private(set) var aggregateArms: [AggregateArm] = []
    private(set) var updates: [AgentLiveActivityEvent] = []
    private(set) var markStaleCount = 0
    private(set) var ends: [End] = []

    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date) {
        starts.append(Start(sessionID: sessionID, sessionTitle: sessionTitle, streamID: streamID, startedAt: startedAt))
    }

    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {
        aggregateArms.append(AggregateArm(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            publisherURL: publisherURL
        ))
    }

    func update(_ event: AgentLiveActivityEvent) {
        updates.append(event)
    }

    func markStale() {
        markStaleCount += 1
    }

    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?) {
        ends.append(End(status: status, activity: activity, errorSummary: errorSummary))
    }
}
