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
        await settle(.approval, publisherID: publisherID, sessionID: sessionID) {
            await answer(publisherID: publisherID, sessionID: sessionID, approval: approval, choice: choice)
        }
    }

    /// TAL-1488: marks the session's rows waiting for approval as "Denied · Undo" during Deny's Undo window, or restores
    /// them. False when no Live Activity shows the session, so the banner path posts its own Undo.
    @discardableResult
    func showDenying(_ denying: Bool, publisherID: String?, sessionID: String) async -> Bool {
        let publisher = origin(publisherID)
        let flag: Bool? = denying ? true : nil
        var shown = false
        for run in display.runs()
        where run.state.sessionID == sessionID && run.state.status == .waitingForApproval && origin(run.publisherID) == publisher {
            shown = true
            var state = run.state
            state.isDenying = flag
            if state != run.state { await display.updateRun(run.id, state) }
        }
        for aggregate in display.aggregates() {
            guard var state = currentAggregate(aggregate.id) else { continue }
            let rows = state.rows.indices.filter { isWaiting(state.rows[$0], sessionID, publisher, .approval) }
            guard !rows.isEmpty else { continue }
            shown = true
            for index in rows { state.rows[index].isDenying = flag }
            await writeAggregate(aggregate.id, state)
        }
        return shown
    }

    /// The prompt a session's rows wait on.
    enum Prompt {
        case approval, question

        var runStatus: AgentRunActivityStatus { self == .approval ? .waitingForApproval : .waitingForClarification }
        var rowPhase: String { self == .approval ? "waiting_for_approval" : "waiting_for_input" }
    }

    /// Optimistic update with rollback around `send`: the session's rows waiting on `prompt` leave that wait at once, and a
    /// refusal restores them with its error.
    private func settle(
        _ prompt: Prompt, publisherID: String?, sessionID: String, send: () async -> Outcome
    ) async -> Outcome {
        let publisher = origin(publisherID)
        let waits = { (row: TalariaAggregateActivityAttributes.ContentState.Row) in self.isWaiting(row, sessionID, publisher, prompt) }
        let runs = display.runs().filter {
            $0.state.sessionID == sessionID && $0.state.status == prompt.runStatus && origin($0.publisherID) == publisher
        }
        let aggregates = display.aggregates().filter { $0.state.rows.contains(where: waits) }

        var answeredRuns: [String: AgentRunActivityAttributes.ContentState] = [:]
        for run in runs {
            let answered = AgentRunActivityStateReducer.promptSettled(state: run.state)
            answeredRuns[run.id] = answered
            await display.updateRun(run.id, answered)
        }
        for aggregate in aggregates {
            // Patch the latest state, so an answer made meanwhile keeps its own rows.
            guard var answered = currentAggregate(aggregate.id) else { continue }
            for index in answered.rows.indices where waits(answered.rows[index]) {
                answered.rows[index] = Self.answered(answered.rows[index])
            }
            await writeAggregate(aggregate.id, answered)
        }

        let outcome = await send()
        guard case let .refused(error) = outcome else { return outcome }
        // ActivityKit can still read back the state from before the answer; anything else is a newer snapshot.
        for run in runs
        where [answeredRuns[run.id], run.state].contains(display.runs().first(where: { $0.id == run.id })?.state) {
            var restored = run.state
            restored.errorSummary = error
            restored.isDenying = nil
            await display.updateRun(run.id, restored)
        }
        // Only this session's rows roll back, so another row answered meanwhile keeps its own state.
        for aggregate in aggregates {
            guard var current = currentAggregate(aggregate.id) else { continue }
            var restoredRow = false
            for index in current.rows.indices {
                guard let original = aggregate.state.rows.first(where: { $0.id == current.rows[index].id && waits($0) }),
                      [Self.answered(original), original].contains(current.rows[index]) else { continue }
                current.rows[index] = original
                current.rows[index].isDenying = nil
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
        await settle(.question, publisherID: publisherID, sessionID: sessionID) {
            await sendReply(publisherID: publisherID, sessionID: sessionID, question: question, text: text)
        }
    }

    private func sendReply(publisherID: String?, sessionID: String, question: ShownQuestion, text: String) async -> Outcome {
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
        answered.isDenying = nil
        return answered
    }

    private func isWaiting(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row, _ sessionID: String, _ publisher: String?, _ prompt: Prompt
    ) -> Bool {
        row.sessionId == sessionID && row.phase == prompt.rowPhase && origin(row.publisherId) == publisher
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
