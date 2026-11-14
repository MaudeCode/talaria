import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of LiveActivityTests that need the App host; the rest run in TalariaKitTests (TAL-399).
@MainActor
final class LiveActivityTests: XCTestCase {
    func testSessionPhaseCannotChangeAnotherSessionOrANewerStream() throws {
        let manager = AgentLiveActivityManager(updateActivity: { _ in })
        manager.start(sessionID: "session-a", sessionTitle: "Running", streamID: "new-run", publisherURL: URL(string: "https://fixture.example")!, startedAt: Date())
        let before = try XCTUnwrap(manager.currentState)
        for phase in ["completed", "running", "stale", "waiting_for_approval"] {
            LiveActivityReconciler.applySessionPhase(phase, sessionID: "session-b", streamID: "new-run", manager: manager)
            LiveActivityReconciler.applySessionPhase(phase, sessionID: "session-a", streamID: "old-run", manager: manager)
            XCTAssertEqual(manager.currentState, before)
        }
        LiveActivityReconciler.applySessionPhase("completed", sessionID: "session-a", streamID: "new-run", manager: manager)
        XCTAssertEqual(manager.currentState?.isFinal, true)
    }

    func testFullExcerptSkipsNormalizationAndActivityUpdatesForTwoThousandTokens() async throws {
        try await assertFullExcerptSkipsFurtherTokens(
            initialToken: String(repeating: "a", count: 141), tailToken: " more",
            expectedExcerpt: String(repeating: "a", count: 137) + "..."
        )
    }

    func testCombiningMarkExcerptSkipsNormalizationAndActivityUpdates() async throws {
        try await assertFullExcerptSkipsFurtherTokens(
            initialToken: "e" + String(repeating: "\u{301}", count: 20_000), tailToken: "\u{301}"
        )
    }

    private func assertFullExcerptSkipsFurtherTokens(
        initialToken: String, tailToken: String, expectedExcerpt: String? = nil
    ) async throws {
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
        manager.update(.token(initialToken))
        await fulfillment(of: [excerptDelivered], timeout: 5)
        let fullState = try XCTUnwrap(manager.currentState)
        if let expectedExcerpt { XCTAssertEqual(fullState.responseExcerpt, expectedExcerpt) }
        XCTAssertTrue(fullState.responseExcerpt.hasSuffix("..."))
        XCTAssertLessThanOrEqual(fullState.responseExcerpt.unicodeScalars.count, 1_024)
        let initialNormalizations = normalizationRequests
        let initialUpdates = updates.count

        for _ in 0..<2_000 {
            manager.update(.token(tailToken))
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

    // TAL-836: a relay-backed activity stays live while the relay owns or is
    // registering for it; markStale writes the stale state only without a relay.
    private func relayHandoffFixture(
        limit: Duration = .seconds(10), minimumUpdateInterval: TimeInterval = 0
    ) -> (AgentLiveActivityManager, PerSessionRelayActivityRegistration, () -> [AgentRunActivityAttributes.ContentState]) {
        let registration = PerSessionRelayActivityRegistration()
        var updates: [AgentRunActivityAttributes.ContentState] = []
        let manager = AgentLiveActivityManager(
            minimumUpdateInterval: minimumUpdateInterval, relayRegistration: registration, relayHandoffLimit: limit,
            updateActivity: { updates.append($0) }
        )
        manager.start(
            sessionID: "relay-session", sessionTitle: "Relay", streamID: "relay-stream",
            publisherURL: URL(string: "https://fixture.example")!
        )
        registration.beginHandoff(activityID: "relay-activity")
        return (manager, registration, { updates })
    }

    private func yieldToPendingTasks() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testConfirmedRelayHandoffSendsNoStaleState() async {
        let (manager, registration, updates) = relayHandoffFixture()
        registration.settleHandoff(activityID: "relay-activity", confirmed: true)
        manager.markStale()
        await yieldToPendingTasks()
        XCTAssertFalse(updates().contains(where: \.isStale), "The relay owns freshness once it confirms the activity")
        XCTAssertNil(manager.activeConnectedStreamID)
    }

    func testPendingRelayHandoffThatSucceedsSendsNoStaleState() async throws {
        let (manager, registration, updates) = relayHandoffFixture(minimumUpdateInterval: 0.1)
        manager.update(.token("Queued behind the throttle"))
        manager.markStale()
        await yieldToPendingTasks()
        XCTAssertFalse(updates().contains(where: \.isStale), "A pending handoff keeps the last state")
        XCTAssertNil(manager.activeConnectedStreamID)
        registration.settleHandoff(activityID: "relay-activity", confirmed: true)
        try await Task.sleep(for: .milliseconds(500))
        await yieldToPendingTasks()
        XCTAssertEqual(updates().count, 1, "A queued foreground write must not overwrite the relay's content")
    }

    func testPendingRelayHandoffThatFailsSendsOneStaleState() async {
        let (manager, registration, updates) = relayHandoffFixture()
        manager.markStale()
        await yieldToPendingTasks()
        XCTAssertFalse(updates().contains(where: \.isStale))
        registration.settleHandoff(activityID: "relay-activity", confirmed: false)
        await yieldToPendingTasks()
        XCTAssertEqual(updates().filter(\.isStale).count, 1)
    }

    func testPendingRelayHandoffPastTheLimitSendsOneStaleState() async throws {
        let (manager, _, updates) = relayHandoffFixture(limit: .milliseconds(50))
        manager.markStale()
        await yieldToPendingTasks()
        XCTAssertFalse(updates().contains(where: \.isStale))
        try await Task.sleep(for: .milliseconds(500))
        await yieldToPendingTasks()
        XCTAssertEqual(updates().filter(\.isStale).count, 1)
    }

    func testStartOrEndDuringRelayHandoffCancelsTheDeferredStaleState() async throws {
        for finish in ["start", "end"] {
            let (manager, _, updates) = relayHandoffFixture(limit: .milliseconds(50))
            manager.markStale()
            if finish == "start" {
                manager.start(
                    sessionID: "relay-session", sessionTitle: "Relay", streamID: "relay-stream",
                    publisherURL: URL(string: "https://fixture.example")!
                )
            } else {
                manager.end(status: .complete, activity: "Response complete")
            }
            try await Task.sleep(for: .milliseconds(500))
            await yieldToPendingTasks()
            XCTAssertFalse(updates().contains(where: \.isStale), "\(finish) must cancel the deferred stale write")
        }
    }

    func testMarkStaleWithoutRelaySendsStaleStateImmediately() async {
        var updates: [AgentRunActivityAttributes.ContentState] = []
        let manager = AgentLiveActivityManager(minimumUpdateInterval: 0, updateActivity: { updates.append($0) })
        manager.start(
            sessionID: "local-session", sessionTitle: "Local", streamID: "local-stream",
            publisherURL: URL(string: "https://fixture.example")!
        )
        manager.markStale()
        XCTAssertEqual(manager.currentState?.isStale, true)
        XCTAssertNil(manager.activeConnectedStreamID)
        await yieldToPendingTasks()
        XCTAssertEqual(updates.filter(\.isStale).count, 1)
    }

    // MARK: - TAL-1463: Allow, Deny and Open on the Live Activity

    func testWaitingRunsOfferAllowAndDenyOrOpenAndRunningOffersNothing() throws {
        let publisher = "https://relay-publisher.example"
        let approval = AgentRunScenario.waiting.state
        let actions = try XCTUnwrap(LiveActivityRowActions(
            status: approval.status, isFinal: false, sessionID: approval.sessionID, publisherID: publisher
        ))
        XCTAssertEqual(actions.kind, .approval)
        for answer in [RespondToApprovalIntent.Answer.allow, .deny] {
            let intent = actions.intent(answer)
            XCTAssertEqual(intent.sessionID, approval.sessionID)
            XCTAssertEqual(intent.publisherID, publisher)
            XCTAssertEqual(intent.answer, answer)
        }
        let input = AgentRunActivityStateReducer.waitingForClarification(state: approval)
        let running = AgentRunScenario.running.state
        func labels(_ state: AgentRunActivityAttributes.ContentState) throws -> Set<String> {
            let lock = try hostWindow(AgentRunLockScreenView(state: state, publisherID: publisher), size: CGSize(width: 360, height: 160))
            let island = try hostWindow(
                AgentRunExpandedIslandBottomView(state: state, publisherID: publisher), size: CGSize(width: 360, height: 80)
            )
            return Set(HostedAccessibility.labels(in: lock) + HostedAccessibility.labels(in: island))
        }
        XCTAssertTrue(try labels(approval).isSuperset(of: ["Allow", "Deny"]))
        XCTAssertFalse(try labels(approval).contains("Open"))
        XCTAssertTrue(try labels(input).contains("Open"))
        XCTAssertTrue(try labels(input).isDisjoint(with: ["Allow", "Deny"]))
        XCTAssertTrue(try labels(running).isDisjoint(with: ["Allow", "Deny", "Open"]))
        XCTAssertTrue(try labels(AgentRunActivityStateReducer.stale(state: approval)).isSuperset(of: ["Allow", "Deny"]))
    }

    func testAllowFromTheLiveActivityAnswersThePendingApprovalAndLeavesTheWaitingState() async throws {
        let fixture = try ApprovalAnswerFixture(in: self)

        _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .allow).perform()

        XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": "once", "approval_id": "approval-s1"]])
        XCTAssertEqual(fixture.run.status, .thinking, "The run leaves waiting for approval at once")
        XCTAssertNil(fixture.run.errorSummary)
        XCTAssertEqual(fixture.aggregate.rows.map(\.phase), ["running", "waiting_for_approval"])
    }

    /// Nothing pending means the approval was answered elsewhere: nothing is sent and the rows stay answered.
    func testAnApprovalAlreadyAnsweredSendsNothing() async throws {
        let fixture = try ApprovalAnswerFixture(pendingBodies: ["{}"], in: self)

        _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .allow).perform()

        XCTAssertEqual(fixture.requests.value, [])
        XCTAssertEqual(fixture.run.status, .thinking)
    }

    func testRefusedDenyRestoresTheWaitingStateWithTheServersError() async throws {
        let fixture = try ApprovalAnswerFixture(responses: ["s1": (200, #"{"ok":false}"#)], in: self)

        _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .deny).perform()

        let error = "The server did not accept that response. The request is still waiting."
        XCTAssertEqual(fixture.requests.value, [["session_id": "s1", "choice": "deny", "approval_id": "approval-s1"]])
        XCTAssertEqual(fixture.updates.map(\.status), [.thinking, .waitingForApproval], "Optimistic first, then rolled back")
        XCTAssertEqual(fixture.run.status, .waitingForApproval)
        XCTAssertEqual(fixture.run.errorSummary, error)
        XCTAssertEqual(fixture.aggregate.rows.map(\.phase), ["waiting_for_approval", "waiting_for_approval"])
        XCTAssertEqual(fixture.aggregate.answerError, error)
        XCTAssertEqual(fixture.aggregate.subtitle, "2 waiting", "The server's subtitle stays")
    }

    /// Two rows answered at once: the refused one rolls back alone and the other keeps its answer.
    func testARefusedRowRollsBackWithoutUndoingAnotherRowsAnswer() async throws {
        let fixture = try ApprovalAnswerFixture(responses: ["s1": (200, #"{"ok":false}"#)], holdsRespondFor: "s1", in: self)

        // s1's answer reaches the server and waits there while s2 is answered in full.
        async let first = RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .allow).perform()
        let reached = await awaitCondition(timeout: 5) { fixture.requests.value.contains { $0["session_id"] == "s1" } }
        XCTAssertTrue(reached)
        _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s2", answer: .allow).perform()
        fixture.releaseHeldRespond()
        _ = try await first

        XCTAssertEqual(fixture.aggregate.rows.map(\.phase), ["waiting_for_approval", "running"])
        XCTAssertNotNil(fixture.aggregate.answerError)
    }

    /// The expanded island has no activity line or header, so a refused answer shows its error above the buttons.
    func testARefusedAnswersErrorShowsInTheExpandedIsland() throws {
        let error = "Unlock Talaria in the app first."
        var run = AgentRunScenario.waiting.state
        run.errorSummary = error
        let island = try hostWindow(AgentRunExpandedIslandBottomView(state: run), size: CGSize(width: 360, height: 100))
        XCTAssertNotNil(HostedAccessibility.element(in: island, label: error))

        var aggregate = TalariaAggregateActivityAttributes.ContentState(
            schemaVersion: 1, activeCount: 1, title: "Talaria", subtitle: "1 needs attention", updatedAt: 0, rows: []
        )
        aggregate.answerError = error
        let rows = try hostWindow(TalariaAggregateRows(state: aggregate, isStale: false, limit: 3, spacing: 5), size: CGSize(width: 360, height: 100))
        XCTAssertNotNil(HostedAccessibility.element(in: rows, label: error))
    }

    /// A 5xx leaves the outcome unknown: the answer stays when the server no longer has that approval pending.
    func testUnknownOutcomeKeepsTheAnswerOnlyWhenTheApprovalIsGone() async throws {
        let stillPending = #"{"pending":{"approval_id":"approval-s1"}}"#
        for (afterwards, keeps) in [("{}", true), (#"{"pending":{"approval_id":"approval-next"}}"#, true), (stillPending, false)] {
            let fixture = try ApprovalAnswerFixture(
                responses: ["s1": (502, "{}")], pendingBodies: [stillPending, afterwards], in: self
            )

            _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .allow).perform()

            XCTAssertEqual(fixture.requests.value.count, 1, "The answer is never sent twice")
            XCTAssertEqual(fixture.run.status, keeps ? .thinking : .waitingForApproval, afterwards)
        }
    }

    /// ActivityKit reads back the pre-answer state for a moment after an update; the rollback must still land.
    func testRefusalRollsBackWhileTheActivityStillReadsThePreAnswerState() async throws {
        let fixture = try ApprovalAnswerFixture(responses: ["s1": (200, #"{"ok":false}"#)], readsLag: true, in: self)

        _ = try await RespondToApprovalIntent(publisherID: ApprovalAnswerFixture.publisher, sessionID: "s1", answer: .allow).perform()

        XCTAssertEqual(fixture.updates.map(\.status), [.thinking, .waitingForApproval])
        XCTAssertNotNil(fixture.run.errorSummary)
        XCTAssertEqual(fixture.aggregate.rows.first?.phase, "waiting_for_approval")
    }
}

/// One waiting run on a relay publisher, as the per-run and aggregate activities show it, beside a second waiting
/// session, and a fixture server. `approval/pending` answers `pendingBodies` in turn (the last repeats), by default
/// the session's own pending approval; `approval/respond` answers `responses` per session, by default success, and
/// holds `heldSession`'s answer until `releaseHeldRespond()`.
@MainActor
private final class ApprovalAnswerFixture {
    static let publisher = "https://approvals.example.test"
    var run: AgentRunActivityAttributes.ContentState
    var aggregate: TalariaAggregateActivityAttributes.ContentState
    private var readRun: AgentRunActivityAttributes.ContentState
    private var readAggregate: TalariaAggregateActivityAttributes.ContentState
    private(set) var updates: [AgentRunActivityAttributes.ContentState] = []
    let requests = LockedTestValue<[[String: String]]>([])
    private let held = DispatchSemaphore(value: 0)

    func releaseHeldRespond() { held.signal() }

    /// `readsLag` serves each activity's state from before its latest update, as ActivityKit can.
    init(
        responses: [String: (status: Int, body: String)] = [:],
        pendingBodies: [String] = [],
        holdsRespondFor heldSession: String? = nil,
        readsLag: Bool = false,
        in test: XCTestCase
    ) throws {
        run = AgentRunActivityStateReducer.waitingForApproval(
            state: AgentRunActivityStateReducer.initialState(sessionID: "s1", sessionTitle: "Deploy")
        )
        readRun = run
        let row = { (session: String) in
            TalariaAggregateActivityAttributes.ContentState.Row(
                publisherId: Self.publisher, publisherLabel: "approvals", sessionId: session, title: session,
                phase: "waiting_for_approval", status: "Approval", updatedAt: 0, deepLink: ""
            )
        }
        aggregate = .init(schemaVersion: 1, activeCount: 2, title: "Talaria", subtitle: "2 waiting", updatedAt: 0, rows: [row("s1"), row("s2")])
        readAggregate = aggregate
        let requests = requests
        let pendingQueue = LockedTestValue(pendingBodies)
        let held = held
        let scope = MockURLProtocol.register { request in
            if request.url?.path == "/api/approval/pending" {
                let session = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "session_id" }?.value ?? ""
                let body = pendingQueue.value.first ?? #"{"pending":{"approval_id":"approval-\#(session)"}}"#
                if pendingQueue.value.count > 1 { pendingQueue.value.removeFirst() }
                return apiTestJSONResponse(body, for: request)
            }
            XCTAssertEqual(request.url?.path, "/api/approval/respond")
            let json = (apiTestBodyData(from: request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:])
                .compactMapValues { $0 as? String }
            requests.value.append(json)
            if json["session_id"] == heldSession { _ = held.wait(timeout: .now() + 5) }
            let response = responses[json["session_id"] ?? ""] ?? (200, #"{"ok":true,"choice":"once"}"#)
            return apiTestJSONResponse(response.body, statusCode: response.status, for: request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: scope]
        let client = APIClient(baseURL: URL(string: Self.publisher)!, session: URLSession(configuration: configuration))
        let lockName = "ApprovalAnswerFixture.\(UUID())"
        test.addTeardownBlock { UserDefaults().removePersistentDomain(forName: lockName) }
        let original = LiveActivityApprovalResponder.shared
        test.addTeardownBlock { @MainActor in LiveActivityApprovalResponder.shared = original }
        LiveActivityApprovalResponder.shared = LiveActivityApprovalResponder(
            makeClient: { TalariaRelayClient.originIdentifier($0 ?? "") == Self.publisher ? client : nil },
            appLock: AppLockModel(defaults: try XCTUnwrap(UserDefaults(suiteName: lockName))),
            display: .init(
                runs: { [unowned self] in [.init(id: "run", publisherID: Self.publisher, state: readsLag ? readRun : run)] },
                updateRun: { [unowned self] in XCTAssertEqual($0, "run"); readRun = run; run = $1; updates.append($1) },
                aggregates: { [unowned self] in [.init(id: "all", state: readsLag ? readAggregate : aggregate)] },
                updateAggregate: { [unowned self] in XCTAssertEqual($0, "all"); readAggregate = aggregate; aggregate = $1 }
            )
        )
    }
}
