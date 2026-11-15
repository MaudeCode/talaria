import ActivityKit
import Foundation
import TalariaKit

/// TAL-1463: answers an approval from a Live Activity's Allow or Deny, or from Siri (TAL-2233), in the App's process.
/// Optimistic update with rollback: the session's rows leave "waiting for approval" at once and the relay's next
/// snapshot confirms them. A refused answer restores the waiting rows with the error; an unknown outcome first asks the
/// server whether the approval is still pending. A rollback never overwrites a newer snapshot.
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

    /// The approval the user saw and answers: the one a Live Activity showed (its `head_id`) or the one Siri read back
    /// (its `approval_id`). Nothing else pending is answered.
    enum ShownApproval: Equatable {
        case head(String)
        case approval(String?)

        func matches(_ pending: PendingApproval) -> Bool {
            switch self {
            case let .head(id): pending.headId == id
            case let .approval(id): pending.approvalId == id
            }
        }
    }

    /// TAL-1469: the question a notification's Reply answers: the one a Relay push named (its `head_id`) or a local alert
    /// named (its `clarify_id`). Nothing else pending is answered.
    enum ShownQuestion: Equatable, Sendable {
        case head(String)
        case clarify(String)

        func matches(_ pending: PendingClarification) -> Bool {
            switch self {
            case let .head(id): pending.headId == id
            case let .clarify(id): pending.clarifyId == id
            }
        }
    }

    /// What `RespondToApprovalIntent` and `RespondToApprovalByVoiceIntent` answer through; tests substitute a fixture
    /// client and display.
    static var shared = LiveActivityApprovalResponder(
        makeClient: { AppIntentServer.saved(publisherID: $0)?.client() },
        activeServer: { AppIntentServer.saved()?.url.absoluteString },
        appLock: .shared,
        display: .system
    )

    private let makeClient: (String?) -> APIClient?
    private let activeServer: () -> String?
    private let appLock: AppLockModel
    private let display: Display

    init(
        makeClient: @escaping (String?) -> APIClient?,
        activeServer: @escaping () -> String?,
        appLock: AppLockModel,
        display: Display
    ) {
        self.makeClient = makeClient
        self.activeServer = activeServer
        self.appLock = appLock
        self.display = display
    }

    /// How an answer ended. Only a refusal rolls the rows back; Siri says which of the others happened (TAL-2233).
    enum Outcome: Equatable {
        case answered
        /// Answered elsewhere or expired before this answer reached it; the rows stay answered.
        case settledElsewhere
        /// The error the rows show again.
        case refused(String)
    }

    @discardableResult
    func respond(publisherID: String?, sessionID: String, approval: ShownApproval, choice: ApprovalChoice) async -> Outcome {
        let publisher = origin(publisherID)
        let runs = display.runs().filter {
            $0.state.sessionID == sessionID && $0.state.status == .waitingForApproval && origin($0.publisherID) == publisher
        }
        let aggregates = display.aggregates().filter { $0.state.rows.contains { isWaiting($0, sessionID, publisher) } }

        var answeredRuns: [String: AgentRunActivityAttributes.ContentState] = [:]
        for run in runs {
            let answered = AgentRunActivityStateReducer.promptSettled(state: run.state)
            answeredRuns[run.id] = answered
            await display.updateRun(run.id, answered)
        }
        for aggregate in aggregates {
            // Patch the latest state, so an answer made meanwhile keeps its own rows.
            guard var answered = currentAggregate(aggregate.id) else { continue }
            for index in answered.rows.indices where isWaiting(answered.rows[index], sessionID, publisher) {
                answered.rows[index] = Self.answered(answered.rows[index])
            }
            await writeAggregate(aggregate.id, answered)
        }

        let outcome = await answer(publisherID: publisherID, sessionID: sessionID, approval: approval, choice: choice)
        guard case let .refused(error) = outcome else { return outcome }
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
                    $0.id == current.rows[index].id && isWaiting($0, sessionID, publisher)
                }), [Self.answered(original), original].contains(current.rows[index]) else { continue }
                current.rows[index] = original
                restoredRow = true
            }
            guard restoredRow else { continue }
            current.answerError = error
            await writeAggregate(aggregate.id, current)
        }
        return outcome
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

    private func answer(
        publisherID: String?, sessionID: String, approval: ShownApproval, choice: ApprovalChoice
    ) async -> Outcome {
        guard !appLock.locksBackgroundWork() else { return .refused(String(localized: "Unlock Talaria in the app first.")) }
        guard let client = makeClient(publisherID) else { return .refused(String(localized: "Add a server in Talaria first.")) }
        // The server answers a prompt by its id (an owner session refuses any other), so read the pending one first.
        // None pending: the approval was already answered elsewhere. Another one pending: the user never saw it, so
        // nothing is answered until it is reviewed.
        let approvalID: String?
        do {
            guard let pending = try await client.approvalPending(sessionID: sessionID).pending else { return .settledElsewhere }
            guard approval.matches(pending) else {
                return .refused(String(localized: "This approval changed. Open Talaria to review it."))
            }
            approvalID = pending.approvalId
        } catch {
            return .refused(error.localizedDescription)
        }
        do {
            let response = try await client.respondApproval(sessionID: sessionID, choice: choice, approvalID: approvalID)
            // Same rule as the chat's approval card: only an explicit success or a cleared stale card is final.
            if response.ok == true { return .answered }
            if response.staleCleared == true { return .settledElsewhere }
            return .refused(String(localized: "The server did not accept that response. The request is still waiting."))
        } catch let error as APIError where error.indicatesExpiredPendingPrompt {
            return .settledElsewhere
        } catch {
            // A network loss, timeout or 5xx leaves the outcome unknown: keep the answer only if the server no longer
            // has this approval pending, most likely because this answer took it. The answer is never sent again.
            if !APIError.isDefinitiveWriteFailure(error),
               let pending = try? await client.approvalPending(sessionID: sessionID),
               pending.pending.map({ $0.approvalId != approvalID }) ?? true {
                return .answered
            }
            return .refused(error.localizedDescription)
        }
    }

    /// TAL-1469: a banner's Reply answers the question the banner named, typed the way the chat's own card sends a typed
    /// answer, while that question is still the pending one. Another question pending, none pending (the text would
    /// answer nothing it was written for), several steps or a password manager prompt are answered in the chat.
    func reply(publisherID: String?, sessionID: String, question: ShownQuestion, text: String) async -> Outcome {
        guard !appLock.locksBackgroundWork() else { return .refused(String(localized: "Unlock Talaria in the app first.")) }
        guard let client = makeClient(publisherID) else { return .refused(String(localized: "Add a server in Talaria first.")) }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .refused(String(localized: "Enter a response before submitting.")) }
        let pending: PendingClarification?
        do {
            pending = try await client.clarifyPending(sessionID: sessionID).pending.flatMap { $0.isEmpty ? nil : $0 }
        } catch {
            return .refused(error.localizedDescription)
        }
        guard let pending, question.matches(pending) else {
            return .refused(String(localized: "This question changed. Open Talaria to answer it."))
        }
        guard pending.vault == nil, let steps = pending.steps, let step = steps.first, steps.count == 1 else {
            return .refused(String(localized: "Open Talaria to answer this one."))
        }
        do {
            _ = try await client.respondClarification(
                sessionID: sessionID, clarifyID: pending.clarifyId,
                answers: [step.qid: step.multiSelect ? .array([.string(text)]) : .string(text)]
            )
            return .answered
        } catch let error as APIError where error.indicatesExpiredPendingPrompt {
            return .refused(error.localizedDescription)
        } catch {
            // An unknown outcome keeps the answer only once this question is no longer the pending one.
            if !APIError.isDefinitiveWriteFailure(error),
               let current = try? await client.clarifyPending(sessionID: sessionID),
               current.pending.map({ $0.isEmpty || $0.clarifyId != pending.clarifyId }) ?? true {
                return .answered
            }
            return .refused(error.localizedDescription)
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

    private func isWaiting(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row, _ sessionID: String, _ publisher: String?
    ) -> Bool {
        row.sessionId == sessionID && row.phase == "waiting_for_approval" && origin(row.publisherId) == publisher
    }

    /// No publisher is the active server, as `makeClient` reads it: a run started without the relay and the relay's rows
    /// for that server are the same server's, so Siri's answer (TAL-2233) reaches both.
    private func origin(_ publisherID: String?) -> String? {
        (publisherID ?? activeServer()).flatMap(TalariaRelayClient.originIdentifier)
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
