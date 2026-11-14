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
        var answeredAggregates: [String: TalariaAggregateActivityAttributes.ContentState] = [:]
        for aggregate in aggregates {
            var answered = aggregate.state
            for index in answered.rows.indices where Self.isWaiting(answered.rows[index], sessionID, publisher) {
                answered.rows[index].phase = "running"
                answered.rows[index].status = String(localized: "Working")
            }
            answeredAggregates[aggregate.id] = answered
            await display.updateAggregate(aggregate.id, answered)
        }

        guard let error = await refusal(publisherID: publisherID, sessionID: sessionID, choice: choice) else { return }
        for run in runs where display.runs().first(where: { $0.id == run.id })?.state == answeredRuns[run.id] {
            var restored = run.state
            restored.errorSummary = error
            await display.updateRun(run.id, restored)
        }
        for aggregate in aggregates
        where display.aggregates().first(where: { $0.id == aggregate.id })?.state == answeredAggregates[aggregate.id] {
            var restored = aggregate.state
            restored.subtitle = error
            await display.updateAggregate(aggregate.id, restored)
        }
    }

    /// Nil when the server took the answer or the approval is no longer pending; otherwise the error to show.
    private func refusal(publisherID: String?, sessionID: String, choice: ApprovalChoice) async -> String? {
        guard !appLock.locksBackgroundWork() else { return String(localized: "Unlock Talaria in the app first.") }
        guard let client = makeClient(publisherID) else { return String(localized: "Add a server in Talaria first.") }
        do {
            let response = try await client.respondApproval(sessionID: sessionID, choice: choice, approvalID: nil)
            // Same rule as the chat's approval card: only an explicit success or a cleared stale card is final.
            guard response.ok == true || response.staleCleared == true else {
                return String(localized: "The server did not accept that response. The request is still waiting.")
            }
            return nil
        } catch let error as APIError where error.indicatesExpiredPendingPrompt {
            return nil
        } catch APIError.network(let underlying) {
            // Unknown outcome: keep the answer only if the server no longer has the approval pending.
            if let pending = try? await client.approvalPending(sessionID: sessionID), pending.pending == nil { return nil }
            return APIError.network(underlying: underlying).localizedDescription
        } catch {
            return error.localizedDescription
        }
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
