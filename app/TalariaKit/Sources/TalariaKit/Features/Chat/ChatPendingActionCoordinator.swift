import Foundation
import Observation
import OSLog

private let chatPendingActionCoordinatorLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "ChatPendingActionCoordinator"
)

/// Friendly stand-in for the server's 409 `{"stale": true}` respond rejection:
/// the prompt already expired, so the card is dismissed instead of erroring (issue #25).
struct PendingPromptExpiredError: LocalizedError, Equatable {
    enum Prompt: Equatable {
        case approval
        case clarification
        case connection
    }

    let prompt: Prompt

    var errorDescription: String? {
        switch prompt {
        case .approval:
            String(localized: "That approval request already expired, so the agent has moved on.")
        case .clarification:
            String(localized: "That clarification prompt already expired, so the agent has moved on.")
        case .connection:
            String(localized: "That connection request already expired, so the agent has moved on.")
        }
    }
}

@MainActor
protocol ChatPendingActionCoordinatorDelegate: AnyObject {
    var pendingActionSessionID: String? { get }
    var pendingActionHasActiveStream: Bool { get }
    var pendingActionHasRunningClarificationTool: Bool { get }
    var pendingActionIsStreamConnectionSuspended: Bool { get }

    func pendingActionCoordinatorWillSubmitAction()
    func pendingActionCoordinatorDidFailAction(_ error: Error)
}

@MainActor
@Observable
final class ChatPendingActionCoordinator {
    private(set) var approvalPrompt: ApprovalPromptState?
    private(set) var isRespondingToApproval = false
    private(set) var approvalErrorMessage: String?
    private(set) var isSessionApprovalBypassEnabled = false

    private(set) var clarificationPrompt: ClarificationPromptState? {
        didSet {
            if oldValue?.requestID != clarificationPrompt?.requestID {
                clarificationUpdateRevision &+= 1
                clarificationAnswers = [:]
                clarificationQuestionDrafts = [:]
            }
            if oldValue?.id != clarificationPrompt?.id {
                let saved = clarificationQuestionDrafts[clarificationPrompt?.questionID ?? ""]
                clarificationDraftResponse = saved?.text ?? ""
                clarificationSelectedChoices = saved?.choices ?? []
                clarificationErrorMessage = nil
            }
        }
    }
    private(set) var clarificationDraftResponse = ""
    private(set) var clarificationSelectedChoices: [String] = []
    private var clarificationAnswers: [String: JSONValue] = [:]
    private var clarificationQuestionDrafts: [String: (text: String, choices: [String])] = [:]

    func selectClarificationStep(_ index: Int, promptID: String) {
        guard let prompt = clarificationPrompt, prompt.id == promptID,
              prompt.sessionID == delegate?.pendingActionSessionID,
              !isRespondingToClarification,
              (0..<prompt.questionCount).contains(index), index != prompt.questionIndex else { return }
        saveClarificationDraft(for: prompt)
        var next = prompt
        next.questionIndex = index
        clarificationPendingBySession[prompt.sessionID] = next
        clarificationPrompt = next
    }

    private func saveClarificationDraft(for prompt: ClarificationPromptState) {
        guard let questionID = prompt.questionID else { return }
        clarificationQuestionDrafts[questionID] = (clarificationDraftResponse, clarificationSelectedChoices)
        let text = clarificationDraftResponse.trimmingCharacters(in: .whitespacesAndNewlines)
        if prompt.isMultiSelect {
            let values = clarificationSelectedChoices + (text.isEmpty ? [] : [text])
            clarificationAnswers[questionID] = values.isEmpty ? nil : .array(values.map(JSONValue.string))
        } else {
            clarificationAnswers[questionID] = text.isEmpty ? nil : .string(text)
        }
    }

    func toggleClarificationChoice(_ choice: String, promptID: String) {
        guard let prompt = clarificationPrompt, prompt.id == promptID,
              prompt.isMultiSelect, prompt.choices.contains(choice),
              prompt.sessionID == delegate?.pendingActionSessionID,
              !isRespondingToClarification else { return }
        if clarificationSelectedChoices.contains(choice) {
            clarificationSelectedChoices.removeAll { $0 == choice }
        } else {
            clarificationSelectedChoices.append(choice)
        }
    }

    func setClarificationDraftResponse(_ text: String, promptID: String) {
        guard clarificationPrompt?.id == promptID,
              clarificationPrompt?.sessionID == delegate?.pendingActionSessionID,
              !isRespondingToClarification else { return }
        clarificationDraftResponse = text
    }

    func submitClarificationDraft(promptID: String) async -> Bool {
        guard clarificationPrompt?.id == promptID else { return false }
        return await respondToClarification(clarificationDraftResponse)
    }

    private(set) var isRespondingToClarification = false
    private(set) var clarificationErrorMessage: String?
    /// A clarify-queue head that is the Agent's password-manager prompt (TAL-887): its own sheet, never the composer.
    private(set) var vaultPrompt: ClarificationPromptState? {
        didSet { if oldValue?.id != vaultPrompt?.id { clarificationErrorMessage = nil } }
    }

    fileprivate(set) var connection: ConnectionOperationState?
    /// Moves on every server statement of the operation, so an older read cannot overwrite a newer one.
    @ObservationIgnored fileprivate(set) var connectionChangeCount = 0
    @ObservationIgnored fileprivate var connectionPollingTask: Task<Void, Never>?
    /// An operation the user closed: a replayed frame of it stays closed.
    @ObservationIgnored fileprivate var dismissedConnectionOpID: String?

    weak var delegate: ChatPendingActionCoordinatorDelegate?
    var approvalHeadDidBecomeVisible: (ApprovalPromptState) -> Void = { _ in }
    /// Fires once when a clarify-queue head, a question or a vault prompt, becomes visible in the open chat.
    var clarificationHeadDidBecomeVisible: (ClarificationPromptState) -> Void = { _ in }

    fileprivate let client: APIClient
    fileprivate let pollingIntervals: ChatPollingIntervals

    private var approvalPendingBySession: [String: ApprovalPromptState] = [:]
    @ObservationIgnored private var approvalMonitor: PendingPromptMonitor
    @ObservationIgnored private var approvalUpdateRevision = 0

    private var clarificationPendingBySession: [String: ClarificationPromptState] = [:]
    @ObservationIgnored private var clarificationMonitor: PendingPromptMonitor
    @ObservationIgnored private var clarificationUpdateRevision = 0
    private var clarificationUsesPollingFallback = false

    var hasPendingPrompt: Bool {
        approvalPrompt != nil || clarificationPrompt != nil || vaultPrompt != nil || connection?.confirmed.settled == false
    }

    init(
        client: APIClient,
        approvalStreamClient: SSEStreamingClient,
        clarifyStreamClient: SSEStreamingClient,
        pollingIntervals: ChatPollingIntervals
    ) {
        self.client = client
        self.approvalMonitor = PendingPromptMonitor(stream: approvalStreamClient)
        self.clarificationMonitor = PendingPromptMonitor(stream: clarifyStreamClient)
        self.pollingIntervals = pollingIntervals
    }

    deinit {
        approvalMonitor.pollingTask?.cancel()
        clarificationMonitor.pollingTask?.cancel()
        connectionPollingTask?.cancel()
    }

    func refreshApprovalBypassState() async {
        guard let sessionID = delegate?.pendingActionSessionID else { return }

        do {
            let response = try await client.sessionYolo(sessionID: sessionID)
            isSessionApprovalBypassEnabled = response.yoloEnabled == true
            renderApprovalPromptForCurrentSession()
        } catch {
            // Approval bypass state is advisory UI; failures should not block chat.
        }
    }

    @discardableResult
    func respondToApproval(_ choice: ApprovalChoice) async -> Bool {
        guard let prompt = approvalPrompt,
              prompt.sessionID == delegate?.pendingActionSessionID
        else { return false }

        isRespondingToApproval = true
        approvalErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToApproval = false }

        do {
            let response = try await client.respondApproval(
                sessionID: prompt.sessionID,
                choice: choice,
                approvalID: prompt.pending.approvalId
            )

            // The protective refusals answer HTTP 200 with `{"ok": false}`
            // (`_handle_approval_respond` → `j(handler, {"ok": ok, …})`,
            // `api/routes.py:24549` @ 399cd7ab, and `j()` defaults to 200), so
            // only a non-2xx status threw and a deliberate refusal read as
            // success: the card was cleared, the user was told nothing, and the
            // agent stayed blocked. `stale_cleared` is the one false that still
            // means "this card is finished".
            //
            // Only an explicit success may clear a live card. A missing `ok`
            // is unknown and must fail closed.
            guard response.ok == true || response.staleCleared == true else {
                approvalErrorMessage = String(localized: "The server did not accept that response. The request is still waiting.")
                await refreshApprovalPending(sessionID: prompt.sessionID)
                return false
            }

            approvalPendingBySession[prompt.sessionID] = nil
            approvalPrompt = nil
            await refreshApprovalPending(sessionID: prompt.sessionID)
            return true
        } catch {
            if (error as? APIError)?.indicatesExpiredPendingPrompt == true {
                // The prompt already expired server-side: dismiss the stale card and
                // explain, instead of leaving a stuck card behind a generic failure.
                approvalPendingBySession[prompt.sessionID] = nil
                approvalPrompt = nil
                delegate?.pendingActionCoordinatorDidFailAction(PendingPromptExpiredError(prompt: .approval))
                await refreshApprovalPending(sessionID: prompt.sessionID)
                return false
            }

            approvalErrorMessage = error.localizedDescription
            delegate?.pendingActionCoordinatorDidFailAction(error)
            return false
        }
    }

    @discardableResult
    func skipApprovalsForCurrentSession() async -> Bool {
        guard let prompt = approvalPrompt,
              prompt.sessionID == delegate?.pendingActionSessionID
        else { return false }

        isRespondingToApproval = true
        approvalErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToApproval = false }

        do {
            let response = try await client.setSessionYolo(sessionID: prompt.sessionID, enabled: true)
            isSessionApprovalBypassEnabled = response.yoloEnabled ?? true
            approvalPendingBySession[prompt.sessionID] = nil
            approvalPrompt = nil
            return true
        } catch {
            approvalErrorMessage = error.localizedDescription
            delegate?.pendingActionCoordinatorDidFailAction(error)
            return false
        }
    }

    func disableApprovalBypassForCurrentSession() async -> Bool {
        guard isSessionApprovalBypassEnabled, !isRespondingToApproval,
              let sessionID = delegate?.pendingActionSessionID else { return false }
        isRespondingToApproval = true
        approvalErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToApproval = false }
        do {
            let response = try await client.setSessionYolo(sessionID: sessionID, enabled: false)
            guard response.yoloEnabled == false else {
                throw NSError(domain: "Talaria.ApprovalBypass", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: String(localized: "The server did not confirm that approval bypass is off.")
                ])
            }
            isSessionApprovalBypassEnabled = false
            await refreshApprovalPending(sessionID: sessionID)
            return true
        } catch {
            approvalErrorMessage = error.localizedDescription
            delegate?.pendingActionCoordinatorDidFailAction(error)
            return false
        }
    }

    func startMonitoring() {
        connectionRunDidStart()
        startApprovalMonitoring()
        startClarificationMonitoring()
    }

    func stopMonitoring(clearPrompt: Bool) {
        if clearPrompt { connectionRunDidEnd() }
        stopApprovalMonitoring(clearPrompt: clearPrompt)
        stopClarificationMonitoring(clearPrompt: clearPrompt)
    }

    func applyApprovalUpdate(_ update: ApprovalPendingResponse, sessionID: String) {
        approvalUpdateRevision &+= 1
        if let pending = update.pending, !pending.isEmpty {
            let prompt = ApprovalPromptState(
                sessionID: sessionID,
                pending: pending,
                pendingCount: max(update.pendingCount ?? 1, 1)
            )
            approvalPendingBySession[sessionID] = prompt
        } else {
            approvalPendingBySession[sessionID] = nil
        }

        renderApprovalPromptForCurrentSession()
    }

    @discardableResult
    func respondToClarification(_ responseText: String) async -> Bool {
        guard !isRespondingToClarification,
              let prompt = clarificationPrompt,
              prompt.sessionID == delegate?.pendingActionSessionID
        else { return false }

        let response = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !response.isEmpty || (prompt.isMultiSelect && !clarificationSelectedChoices.isEmpty) else {
            clarificationErrorMessage = String(localized: "Enter a response before submitting.")
            return false
        }

        // A prompt without a server step has nothing to answer.
        guard prompt.questionID != nil else { return false }
        clarificationDraftResponse = responseText
        saveClarificationDraft(for: prompt)
        if !prompt.isLastQuestion {
            selectClarificationStep(prompt.questionIndex + 1, promptID: prompt.id)
            return true
        }
        // Manual paging must not let the final page submit missing answers.
        for index in 0..<prompt.questionCount {
            var question = prompt
            question.questionIndex = index
            if let id = question.questionID, clarificationAnswers[id] == nil {
                selectClarificationStep(index, promptID: prompt.id)
                clarificationErrorMessage = String(localized: "Answer each question before submitting.")
                return false
            }
        }
        let answers = clarificationAnswers

        isRespondingToClarification = true
        clarificationErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToClarification = false }

        do {
            _ = try await client.respondClarification(
                sessionID: prompt.sessionID,
                clarifyID: prompt.pending.clarifyId,
                answers: answers
            )
            guard clarificationPrompt?.id == prompt.id,
                  delegate?.pendingActionSessionID == prompt.sessionID else { return true }
            clarificationPendingBySession[prompt.sessionID] = nil
            clarificationPrompt = nil
            await refreshClarificationPending(sessionID: prompt.sessionID)
            return true
        } catch {
            guard clarificationPrompt?.id == prompt.id,
                  delegate?.pendingActionSessionID == prompt.sessionID else { return false }
            if (error as? APIError)?.indicatesExpiredPendingPrompt == true {
                // The prompt already expired server-side: dismiss the stale card and
                // explain, instead of leaving a stuck card behind a generic failure.
                clarificationPendingBySession[prompt.sessionID] = nil
                clarificationPrompt = nil
                delegate?.pendingActionCoordinatorDidFailAction(PendingPromptExpiredError(prompt: .clarification))
                await refreshClarificationPending(sessionID: prompt.sessionID)
                return false
            }

            clarificationErrorMessage = error.localizedDescription
            delegate?.pendingActionCoordinatorDidFailAction(error)
            return false
        }
    }

    /// Answers a vault prompt with the typed `values` keyed by field, or declines it with `nil`. The values pass
    /// straight to the server; nothing here keeps them.
    @discardableResult
    func respondToVaultPrompt(_ values: [String: String]?, promptID: String) async -> Bool {
        guard !isRespondingToClarification,
              let prompt = vaultPrompt, prompt.id == promptID,
              prompt.sessionID == delegate?.pendingActionSessionID
        else { return false }

        isRespondingToClarification = true
        clarificationErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToClarification = false }

        do {
            _ = try await client.respondClarification(
                sessionID: prompt.sessionID,
                clarifyID: prompt.pending.clarifyId,
                answers: (values ?? [:]).mapValues(JSONValue.string),
                decline: values == nil
            )
            guard vaultPrompt?.id == prompt.id, delegate?.pendingActionSessionID == prompt.sessionID else { return true }
            clarificationPendingBySession[prompt.sessionID] = nil
            vaultPrompt = nil
            await refreshClarificationPending(sessionID: prompt.sessionID)
            return true
        } catch {
            guard vaultPrompt?.id == prompt.id, delegate?.pendingActionSessionID == prompt.sessionID else { return false }
            if (error as? APIError)?.indicatesExpiredPendingPrompt == true {
                clarificationPendingBySession[prompt.sessionID] = nil
                vaultPrompt = nil
                delegate?.pendingActionCoordinatorDidFailAction(PendingPromptExpiredError(prompt: .clarification))
                await refreshClarificationPending(sessionID: prompt.sessionID)
                return false
            }
            clarificationErrorMessage = error.localizedDescription
            delegate?.pendingActionCoordinatorDidFailAction(error)
            return false
        }
    }

    func applyClarificationUpdate(_ update: ClarificationPendingResponse, sessionID: String) {
        clarificationUpdateRevision &+= 1
        if let pending = update.pending, !pending.isEmpty {
            var prompt = ClarificationPromptState(
                sessionID: sessionID,
                pending: pending,
                pendingCount: max(update.pendingCount ?? 1, 1)
            )
            if let current = clarificationPendingBySession[sessionID], current.requestID == prompt.requestID {
                prompt.questionIndex = max(0, min(current.questionIndex, prompt.questionCount - 1))
            }
            clarificationPendingBySession[sessionID] = prompt
        } else {
            clarificationPendingBySession[sessionID] = nil
        }

        renderClarificationPromptForCurrentSession()
    }

    /// The session a monitor should start watching: the open one, while its stream runs and the
    /// monitor watches another.
    private func sessionToMonitor(_ monitor: PendingPromptMonitor) -> String? {
        guard let sessionID = delegate?.pendingActionSessionID,
              delegate?.pendingActionHasActiveStream == true,
              monitor.sessionID != sessionID
        else { return nil }
        return sessionID
    }

    /// Whether `sessionID` is still the open session with a live, connected stream.
    private func isLiveSession(_ sessionID: String) -> Bool {
        delegate?.pendingActionSessionID == sessionID
            && delegate?.pendingActionHasActiveStream == true
            && delegate?.pendingActionIsStreamConnectionSuspended != true
    }

    /// Runs `poll` every `interval` until cancelled or `sessionID` stops being the live session.
    private func pollingTask(
        sessionID: String,
        interval: UInt64,
        poll: @escaping @MainActor (ChatPendingActionCoordinator) async -> Void
    ) -> Task<Void, Never> {
        let sleep = pollingIntervals.sleep
        return Task { @MainActor [weak self] in
            while !Task.isCancelled {
                // Scoped so the sleep below does not retain the coordinator.
                do {
                    guard let self, self.isLiveSession(sessionID) else { break }
                    await poll(self)
                }
                guard !Task.isCancelled else { break }
                try? await sleep(interval)
            }
        }
    }

    private func startApprovalMonitoring() {
        guard let sessionID = sessionToMonitor(approvalMonitor) else { return }
        let initialRevision = approvalUpdateRevision
        var awaitsSnapshot = true
        approvalMonitor.start(sessionID: sessionID, url: client.approvalStreamURL(sessionID: sessionID)) { [weak self] event in
            guard let self else { return }
            // The stream opens with a snapshot of the server's local queue, which an owner chat's prompts never enter
            // (TAL-1043). An empty one that lands after the chat stream showed a newer approval must not hide it.
            if case .approvalPending(let update) = event, awaitsSnapshot {
                awaitsSnapshot = false
                if update.pending == nil, approvalUpdateRevision != initialRevision { return }
            }
            handleApprovalMonitorEvent(event, sessionID: sessionID)
        }
    }

    private func stopApprovalMonitoring(clearPrompt: Bool) {
        approvalMonitor.stop()

        guard clearPrompt else { return }
        if let sessionID = delegate?.pendingActionSessionID {
            approvalPendingBySession[sessionID] = nil
        }
        approvalPrompt = nil
        approvalErrorMessage = nil
    }

    private func handleApprovalMonitorEvent(_ event: SSEEvent, sessionID: String) {
        switch event {
        case .approvalPending(let update):
            applyApprovalUpdate(update, sessionID: sessionID)
        case .transportError, .error:
            startApprovalFallbackPolling(sessionID: sessionID)
        case .token, .interimAssistant, .reasoning, .toolStarted, .toolProgress, .toolCompleted, .title, .metering, .done, .clarificationPending, .connectionOperation,
             .steerConsumed, .steerPending, .steerWithdrawn, .notices, .runStatus, .compressing, .compressed, .streamEnd, .settledSession, .sessionSnapshot, .cancelled, .warning, .heartbeat, .ignored:
            break
        }
    }

    private func startApprovalFallbackPolling(sessionID: String) {
        guard approvalMonitor.sessionID == sessionID else { return }

        approvalMonitor.stream.stop()
        approvalMonitor.pollingTask?.cancel()
        approvalMonitor.pollingTask = pollingTask(sessionID: sessionID, interval: pollingIntervals.approvalNanoseconds) {
            await $0.refreshApprovalPending(sessionID: sessionID)
        }
    }

    private func refreshApprovalPending(sessionID: String) async {
        guard delegate?.pendingActionHasActiveStream == true else { return }

        do {
            let response = try await client.approvalPending(sessionID: sessionID)
            guard !Task.isCancelled else { return }
            applyApprovalUpdate(response, sessionID: sessionID)
        } catch {
            // The web UI also ignores degraded-mode polling failures.
            chatPendingActionCoordinatorLogger.debug(
                "Approval polling failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )
        }
    }

    private func renderApprovalPromptForCurrentSession() {
        guard let sessionID = delegate?.pendingActionSessionID else {
            approvalPrompt = nil
            return
        }

        // Bypass hides only approvals it can answer; an owner that refuses bypass still waits on this one (TAL-1043).
        guard delegate?.pendingActionHasActiveStream == true,
              let prompt = approvalPendingBySession[sessionID],
              !isSessionApprovalBypassEnabled || !prompt.pending.allowsApprovalBypass
        else {
            if approvalPrompt?.sessionID == sessionID {
                approvalPrompt = nil
            }
            return
        }

        let previous = approvalPrompt
        approvalPrompt = prompt
        if previous?.sessionID != prompt.sessionID || previous?.pending.approvalId != prompt.pending.approvalId {
            approvalHeadDidBecomeVisible(prompt)
        }
    }

    private func startClarificationMonitoring() {
        guard let sessionID = sessionToMonitor(clarificationMonitor) else { return }
        clarificationUsesPollingFallback = false
        let initialRevision = clarificationUpdateRevision
        clarificationMonitor.start(sessionID: sessionID, url: client.clarifyStreamURL(sessionID: sessionID)) { [weak self] event in
            self?.handleClarificationMonitorEvent(event, sessionID: sessionID, initialRevision: initialRevision)
        }
        startClarificationPolling(sessionID: sessionID)
    }

    private func stopClarificationMonitoring(clearPrompt: Bool) {
        clarificationMonitor.stop()
        clarificationUsesPollingFallback = false

        guard clearPrompt else { return }
        if let sessionID = delegate?.pendingActionSessionID {
            clarificationPendingBySession[sessionID] = nil
        }
        clarificationPrompt = nil
        vaultPrompt = nil
        clarificationErrorMessage = nil
    }

    private func handleClarificationMonitorEvent(_ event: SSEEvent, sessionID: String, initialRevision: Int) {
        switch event {
        case .clarificationPending(let update):
            applyClarificationUpdate(update, sessionID: sessionID)
        case .approvalPending(let update):
            // An empty initial snapshot has no clarification markers, so the
            // shared decoder classifies it as approvalPending. It can arrive
            // after the chat stream already delivered a newer clarification.
            if update.pending == nil, clarificationUpdateRevision == initialRevision {
                applyClarificationUpdate(
                    ClarificationPendingResponse(pending: nil, pendingCount: update.pendingCount),
                    sessionID: sessionID
                )
            }
        case .transportError, .error:
            startClarificationFallbackPolling(sessionID: sessionID)
        case .token, .interimAssistant, .reasoning, .toolStarted, .toolProgress, .toolCompleted, .title, .metering, .done, .connectionOperation,
             .steerConsumed, .steerPending, .steerWithdrawn, .notices, .runStatus, .compressing, .compressed, .streamEnd, .settledSession, .sessionSnapshot, .cancelled, .warning, .heartbeat, .ignored:
            break
        }
    }

    private func startClarificationFallbackPolling(sessionID: String) {
        guard clarificationMonitor.sessionID == sessionID else { return }
        clarificationUsesPollingFallback = true
        clarificationMonitor.stream.stop()
        startClarificationPolling(sessionID: sessionID)
    }

    private func startClarificationPolling(sessionID: String) {
        guard clarificationMonitor.sessionID == sessionID, clarificationMonitor.pollingTask == nil else { return }
        clarificationMonitor.pollingTask = pollingTask(
            sessionID: sessionID,
            interval: pollingIntervals.clarificationNanoseconds
        ) { coordinator in
            // Healthy streams need HTTP only when a running clarification
            // tool has no visible prompt, including a missed startup event.
            if coordinator.clarificationUsesPollingFallback
                || (coordinator.clarificationPrompt == nil
                    && coordinator.delegate?.pendingActionHasRunningClarificationTool == true) {
                await coordinator.refreshClarificationPending(sessionID: sessionID)
            }
        }
    }

    private func refreshClarificationPending(sessionID: String) async {
        guard delegate?.pendingActionHasActiveStream == true else { return }
        let revision = clarificationUpdateRevision

        do {
            let response = try await client.clarifyPending(sessionID: sessionID)
            guard !Task.isCancelled, revision == clarificationUpdateRevision, isLiveSession(sessionID) else { return }
            applyClarificationUpdate(response, sessionID: sessionID)
        } catch {
            // The web UI also ignores degraded-mode polling failures.
            chatPendingActionCoordinatorLogger.debug(
                "Clarification polling failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )
        }
    }

    private func renderClarificationPromptForCurrentSession() {
        let prompt = delegate?.pendingActionSessionID.flatMap { sessionID in
            delegate?.pendingActionHasActiveStream == true ? clarificationPendingBySession[sessionID] : nil
        }
        let previous = clarificationPrompt ?? vaultPrompt
        clarificationPrompt = prompt?.pending.vault == nil ? prompt : nil
        vaultPrompt = prompt?.pending.vault == nil ? nil : prompt
        if let prompt, previous?.requestID != prompt.requestID {
            clarificationHeadDidBecomeVisible(prompt)
        }
    }
}

// MARK: - Connection operation (TAL-1321)

/// The server states the operation and the user answers it. Every read is fenced by `connectionChangeCount`, every
/// answer by the operation it named, and only a read decides a lost answer: it is never sent again.
extension ChatPendingActionCoordinator {
    /// What the chat shows: the server's view with this user's own answers on top. Nil once Continue took the card away.
    var connectionOperation: ConnectorOperationView? {
        guard let connection, connection.sessionID == delegate?.pendingActionSessionID, !connection.isContinuing else { return nil }
        return connection.displayed
    }

    var connectionRunningTargets: Set<String> { visibleConnection?.runningTargets ?? [] }
    var connectionErrorMessage: String? { visibleConnection?.errorMessage }

    private var visibleConnection: ConnectionOperationState? {
        connection?.sessionID == delegate?.pendingActionSessionID ? connection : nil
    }

    /// A `connect_card` frame: the server's latest statement, in its order.
    func applyConnectionOperation(_ view: ConnectorOperationView, sessionID: String) {
        connectionChangeCount &+= 1
        showConnection(view, sessionID: sessionID)
    }

    /// A session detail's statement. An owner that holds no operation closes an open card; the result of one it settled
    /// stays to read. `changesAtFetch` drops a load that started before a newer statement arrived.
    func applyOwnerConnection(_ attachment: OwnerAttachment?, sessionID: String, changesAtFetch: Int?) {
        guard let attachment, attachment.statesConnection, changesAtFetch.map({ $0 == connectionChangeCount }) ?? true else { return }
        connectionChangeCount &+= 1
        if let view = attachment.connection {
            showConnection(view, sessionID: sessionID)
        } else if let connection, connection.sessionID == sessionID, !connection.confirmed.settled {
            closeConnection()
        }
    }

    func respondToConnectionOperation(_ move: ConnectorOperationMove, env: [String: String]?, opID: String) async {
        guard var state = visibleConnection, state.confirmed.opId == opID, state.offers(move) else { return }
        let owner = state.confirmed.owner
        state.inFlight.insert(move)
        state.errorMessage = nil
        connection = state
        delegate?.pendingActionCoordinatorWillSubmitAction()
        // A read already out left before this answer, so it cannot say whether the answer landed.
        connectionChangeCount &+= 1
        let changes = connectionChangeCount
        do {
            let view = try await client.respondConnectorOperation(opID: opID, owner: owner, move: move, env: env)
            guard var current = currentConnection(state) else { return }
            current.inFlight.remove(move)
            // A newer statement arrived on the way back, so this view may be the older one: a read decides.
            guard changes == connectionChangeCount else {
                if !current.confirmed.settled { current.unknown.insert(move) }
                connection = current
                await readConnectionOperation()
                return
            }
            connection = current
            connectionChangeCount &+= 1
            showConnection(view, sessionID: current.sessionID, closesSettled: move == .continueWithoutTheRest)
        } catch {
            await settleRefusedOrLostAnswer(move, error: error, of: state)
        }
    }

    private func settleRefusedOrLostAnswer(_ move: ConnectorOperationMove, error: Error, of state: ConnectionOperationState) async {
        guard var current = currentConnection(state) else { return }
        current.inFlight.remove(move)
        // Only a read from after this failure may decide what landed.
        connectionChangeCount &+= 1
        // A 404 is the server saying this operation is gone, which a refusal of one move does not say.
        if case .http(404, _)? = error as? APIError {
            connection = current
            closeConnection()
            delegate?.pendingActionCoordinatorDidFailAction(PendingPromptExpiredError(prompt: .connection))
            return
        }
        if !APIError.isDefinitiveWriteFailure(error) { current.unknown.insert(move) }
        // The server words why this connection refused the move.
        current.errorMessage = (error as? APIError)?.serverMessage ?? error.localizedDescription
        connection = current
        delegate?.pendingActionCoordinatorDidFailAction(error)
        await readConnectionOperation()
    }

    /// Back from an authorization link: the owner looks now, not at its next tick. The poll covers a failure.
    func wakeConnectionOperation() async {
        guard let state = visibleConnection, state.confirmed.canWake, !state.confirmed.settled else { return }
        let changes = connectionChangeCount
        do {
            let view = try await client.respondConnectorOperation(opID: state.confirmed.opId, owner: state.confirmed.owner, move: nil)
            guard changes == connectionChangeCount, currentConnection(state) != nil else { return }
            applyConnectionRead(view)
        } catch {
            chatPendingActionCoordinatorLogger.debug(
                "Connection wake failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )
        }
    }

    /// Closes a settled operation's result. A later frame of it stays closed.
    func dismissConnectionOperation(opID: String) {
        guard let state = visibleConnection, state.confirmed.opId == opID, state.confirmed.settled else { return }
        dismissedConnectionOpID = opID
        closeConnection()
    }

    /// Leaving the chat or its profile: nothing of the operation stays behind.
    func resetConnectionOperation() {
        connectionChangeCount &+= 1
        dismissedConnectionOpID = nil
        closeConnection()
    }

    /// A direct card ends with its turn, since nothing waits on it after that. A canonical owner keeps its own operation.
    func connectionRunDidEnd() {
        if connection?.confirmed.settled == false, connection?.confirmed.owner == nil { closeConnection() }
    }

    /// A new run starts clean of an earlier operation's result.
    func connectionRunDidStart() {
        if connection?.confirmed.settled == true { closeConnection() }
    }

    private func showConnection(_ view: ConnectorOperationView, sessionID: String, closesSettled: Bool = false) {
        guard dismissedConnectionOpID != view.opId else { return }
        if closesSettled, view.settled {
            dismissedConnectionOpID = view.opId
            closeConnection()
            return
        }
        if var current = connection, current.sessionID == sessionID, current.confirmed.opId == view.opId {
            // The user already moved on, and Continue's own answer closes the card.
            if view.settled, current.isContinuing {
                dismissedConnectionOpID = view.opId
                closeConnection()
                return
            }
            current.confirmed = view
            if view.settled {
                current.inFlight = []
                current.unknown = []
                current.errorMessage = nil
            }
            connection = current
        } else {
            connection = ConnectionOperationState(sessionID: sessionID, confirmed: view)
            stopConnectionPolling()
        }
        if view.settled { stopConnectionPolling() } else { startConnectionPolling() }
    }

    private func closeConnection() {
        connection = nil
        stopConnectionPolling()
    }

    /// The live state when `state`'s operation is still the one in this chat, which fences a late answer.
    private func currentConnection(_ state: ConnectionOperationState) -> ConnectionOperationState? {
        guard let connection, connection.confirmed.opId == state.confirmed.opId, connection.sessionID == state.sessionID,
              connection.sessionID == delegate?.pendingActionSessionID else { return nil }
        return connection
    }

    private func readConnectionOperation() async {
        guard let state = connection, state.sessionID == delegate?.pendingActionSessionID, !state.confirmed.settled else { return }
        let changes = connectionChangeCount
        do {
            let view = try await client.connectorOperation(opID: state.confirmed.opId, owner: state.confirmed.owner)
            guard changes == connectionChangeCount, currentConnection(state) != nil else { return }
            applyConnectionRead(view)
        } catch {
            guard changes == connectionChangeCount, let current = currentConnection(state) else { return }
            switch error as? APIError {
            case .http(404, _)?:
                // The owner closes an operation when it settles, so nothing here says it failed.
                if current.isContinuing { dismissedConnectionOpID = current.confirmed.opId }
                closeConnection()
            case .http(403, _)?:
                closeConnection()
                delegate?.pendingActionCoordinatorDidFailAction(error)
            default:
                // A failed read keeps the last view, and the next one tries again.
                chatPendingActionCoordinatorLogger.debug(
                    "Connection read failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
                )
            }
        }
    }

    /// A read decides every lost answer: one the server still offers did not land, so its error stays.
    private func applyConnectionRead(_ view: ConnectorOperationView) {
        guard var current = connection else { return }
        connectionChangeCount &+= 1
        let wasUnknown = current.unknown
        current.unknown = []
        current.confirmed = view
        if !wasUnknown.isEmpty, !wasUnknown.contains(where: current.confirmedOffers) { current.errorMessage = nil }
        connection = current
        showConnection(view, sessionID: current.sessionID, closesSettled: wasUnknown.contains(.continueWithoutTheRest))
    }

    private func startConnectionPolling() {
        guard connectionPollingTask == nil else { return }
        let sleep = pollingIntervals.sleep
        let interval = pollingIntervals.connectionNanoseconds
        connectionPollingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await sleep(interval)
                guard !Task.isCancelled else { break }
                // Scoped so the sleep above does not retain the coordinator.
                do {
                    guard let self else { break }
                    if self.delegate?.pendingActionIsStreamConnectionSuspended != true {
                        await self.readConnectionOperation()
                    }
                }
            }
        }
    }

    private func stopConnectionPolling() {
        connectionPollingTask?.cancel()
        connectionPollingTask = nil
    }
}

/// One prompt kind's SSE stream and fallback polling task, bound to the session they watch.
private struct PendingPromptMonitor {
    let stream: SSEStreamingClient
    private(set) var sessionID: String?
    var pollingTask: Task<Void, Never>?

    @MainActor mutating func start(sessionID: String, url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        stop()
        self.sessionID = sessionID
        stream.start(url: url, onEvent: onEvent)
    }

    @MainActor mutating func stop() {
        let isActive = sessionID != nil || pollingTask != nil
        pollingTask?.cancel()
        pollingTask = nil
        if isActive {
            stream.stop()
        }
        sessionID = nil
    }
}
