import ActivityKit
import Foundation
import TalariaKit

/// TAL-1463: answers an approval from a Live Activity's Allow or Deny, in the App's process. Optimistic update with
/// rollback: the session's rows leave "waiting for approval" at once and the relay's next snapshot confirms them. A
/// refused answer restores the waiting rows with the error; an unknown outcome first asks the server whether the
/// approval is still pending. A rollback never overwrites a newer snapshot.
@MainActor
final class LiveActivityApprovalResponder {
    struct Run: Equatable {
        let id: String
        let publisherID: String?
        let state: AgentRunActivityAttributes.ContentState
    }

    struct Aggregate: Equatable {
        let id: String
        let state: TalariaAggregateActivityAttributes.ContentState
    }

    /// The Live Activities on screen; tests substitute an in-memory copy.
    struct Display {
        var runs: @MainActor () -> [Run]
        var updateRun: @MainActor (_ id: String, _ state: AgentRunActivityAttributes.ContentState) async -> Void
        var aggregates: @MainActor () -> [Aggregate]
        var updateAggregate: @MainActor (_ id: String, _ state: TalariaAggregateActivityAttributes.ContentState) async -> Void
    }

    /// What `RespondToApprovalIntent` answers through; tests substitute a fixture client and display.
    static var shared = LiveActivityApprovalResponder(
        makeClient: { AppIntentServer.saved(publisherID: $0)?.client() },
        appLock: .shared,
        display: .system
    )

    private let makeClient: (String?) -> APIClient?
    private let appLock: AppLockModel
    private let display: Display

    init(makeClient: @escaping (String?) -> APIClient?, appLock: AppLockModel, display: Display) {
        self.makeClient = makeClient
        self.appLock = appLock
        self.display = display
    }

    func respond(publisherID: String?, sessionID: String, choice: ApprovalChoice) async {
        let publisher = publisherID.flatMap(TalariaRelayClient.originIdentifier)
        let runs = display.runs().filter {
            $0.state.sessionID == sessionID && $0.state.status == .waitingForApproval
                && $0.publisherID.flatMap(TalariaRelayClient.originIdentifier) == publisher
        }
        let aggregates = display.aggregates().filter { $0.state.rows.contains { Self.isWaiting($0, sessionID, publisher) } }

        var answeredRuns: [String: AgentRunActivityAttributes.ContentState] = [:]
        for run in runs {
            let answered = AgentRunActivityStateReducer.promptSettled(state: run.state)
            answeredRuns[run.id] = answered
            await display.updateRun(run.id, answered)
        }
        for aggregate in aggregates {
            // Patch the latest state, so an answer made meanwhile keeps its own rows.
            guard var answered = currentAggregate(aggregate.id) else { continue }
            for index in answered.rows.indices where Self.isWaiting(answered.rows[index], sessionID, publisher) {
                answered.rows[index] = Self.answered(answered.rows[index])
            }
            await writeAggregate(aggregate.id, answered)
        }

        guard let error = await refusal(publisherID: publisherID, sessionID: sessionID, choice: choice) else { return }
        // ActivityKit can still read back the state from before the answer; anything else is a newer snapshot.
        for run in runs
        where [answeredRuns[run.id], run.state].contains(display.runs().first(where: { $0.id == run.id })?.state) {
            var restored = run.state
            restored.errorSummary = error
            await display.updateRun(run.id, restored)
        }
        // Only this session's rows roll back, so another row answered meanwhile keeps its own state.
        for aggregate in aggregates {
            guard var current = currentAggregate(aggregate.id) else { continue }
            var restoredRow = false
            for index in current.rows.indices {
                guard let original = aggregate.state.rows.first(where: {
                    $0.id == current.rows[index].id && Self.isWaiting($0, sessionID, publisher)
                }), [Self.answered(original), original].contains(current.rows[index]) else { continue }
                current.rows[index] = original
                restoredRow = true
            }
            guard restoredRow else { continue }
            current.answerError = error
            await writeAggregate(aggregate.id, current)
        }
    }

    /// Every aggregate state this responder wrote since the last snapshot, and the latest of them.
    private var aggregateWrites: [String: (states: Set<TalariaAggregateActivityAttributes.ContentState>, latest: TalariaAggregateActivityAttributes.ContentState)] = [:]

    /// The aggregate as it stands. ActivityKit can read back any state this responder wrote, or the one before them,
    /// for a moment after an update, so those read as the latest write; any other state is a newer snapshot.
    private func currentAggregate(_ id: String) -> TalariaAggregateActivityAttributes.ContentState? {
        guard let read = display.aggregates().first(where: { $0.id == id })?.state else { return nil }
        if let writes = aggregateWrites[id], writes.states.contains(read) { return writes.latest }
        aggregateWrites[id] = nil
        return read
    }

    private func writeAggregate(_ id: String, _ state: TalariaAggregateActivityAttributes.ContentState) async {
        let read = display.aggregates().first(where: { $0.id == id })?.state
        var states = aggregateWrites[id]?.states ?? Set(read.map { [$0] } ?? [])
        states.insert(state)
        aggregateWrites[id] = (states, state)
        await display.updateAggregate(id, state)
    }

    /// Nil when the server took the answer or the approval is no longer pending; otherwise the error to show.
    private func refusal(publisherID: String?, sessionID: String, choice: ApprovalChoice) async -> String? {
        guard !appLock.locksBackgroundWork() else { return String(localized: "Unlock Talaria in the app first.") }
        guard let client = makeClient(publisherID) else { return String(localized: "Add a server in Talaria first.") }
        // The server answers a prompt by its id (an owner session refuses any other), so read the pending one first.
        // None pending: the approval was already answered elsewhere.
        let approvalID: String?
        do {
            guard let pending = try await client.approvalPending(sessionID: sessionID).pending else { return nil }
            approvalID = pending.approvalId
        } catch {
            return error.localizedDescription
        }
        do {
            let response = try await client.respondApproval(sessionID: sessionID, choice: choice, approvalID: approvalID)
            // Same rule as the chat's approval card: only an explicit success or a cleared stale card is final.
            guard response.ok == true || response.staleCleared == true else {
                return String(localized: "The server did not accept that response. The request is still waiting.")
            }
            return nil
        } catch let error as APIError where error.indicatesExpiredPendingPrompt {
            return nil
        } catch {
            // A network loss, timeout or 5xx leaves the outcome unknown: keep the answer only if the server no longer
            // has this approval pending. The answer is never sent again.
            if !APIError.isDefinitiveWriteFailure(error),
               let pending = try? await client.approvalPending(sessionID: sessionID),
               pending.pending.map({ $0.approvalId != approvalID }) ?? true {
                return nil
            }
            return error.localizedDescription
        }
    }

    private static func answered(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row
    ) -> TalariaAggregateActivityAttributes.ContentState.Row {
        var answered = row
        answered.phase = "running"
        answered.status = String(localized: "Working")
        return answered
    }

    private static func isWaiting(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row, _ sessionID: String, _ publisher: String?
    ) -> Bool {
        row.sessionId == sessionID && row.phase == "waiting_for_approval"
            && TalariaRelayClient.originIdentifier(row.publisherId) == publisher
    }
}

extension LiveActivityApprovalResponder.Display {
    static let system = Self(
        runs: {
            Activity<AgentRunActivityAttributes>.activities.map {
                .init(id: $0.id, publisherID: $0.attributes.relayPublisherID, state: $0.content.state)
            }
        },
        updateRun: { await update(AgentRunActivityAttributes.self, id: $0, state: $1) },
        aggregates: {
            Activity<TalariaAggregateActivityAttributes>.activities.map { .init(id: $0.id, state: $0.content.state) }
        },
        updateAggregate: { await update(TalariaAggregateActivityAttributes.self, id: $0, state: $1) }
    )

    @MainActor
    private static func update(_: AgentRunActivityAttributes.Type, id: String, state: AgentRunActivityAttributes.ContentState) async {
        for activity in Activity<AgentRunActivityAttributes>.activities where activity.id == id {
            await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate))
        }
    }

    @MainActor
    private static func update(
        _: TalariaAggregateActivityAttributes.Type, id: String, state: TalariaAggregateActivityAttributes.ContentState
    ) async {
        for activity in Activity<TalariaAggregateActivityAttributes>.activities where activity.id == id {
            await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate))
        }
    }
}
