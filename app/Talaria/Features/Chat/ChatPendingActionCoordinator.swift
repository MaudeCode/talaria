import Foundation
import Observation
import OSLog
import TalariaKit

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
    }

    let prompt: Prompt

    var errorDescription: String? {
        switch prompt {
        case .approval:
            String(localized: "That approval request already expired, so the agent has moved on.")
        case .clarification:
            String(localized: "That clarification prompt already expired, so the agent has moved on.")
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

    func selectClarificationQuestion(_ index: Int, promptID: String) {
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

    weak var delegate: ChatPendingActionCoordinatorDelegate?

    private let client: APIClient
    private let approvalStreamClient: SSEStreamingClient
    private let clarifyStreamClient: SSEStreamingClient
    private let pollingIntervals: ChatPollingIntervals

    private var approvalPendingBySession: [String: ApprovalPromptState] = [:]
    private var approvalMonitoringSessionID: String?
    @ObservationIgnored private var approvalPollingTask: Task<Void, Never>?

    private var clarificationPendingBySession: [String: ClarificationPromptState] = [:]
    private var clarificationMonitoringSessionID: String?
    @ObservationIgnored private var clarificationPollingTask: Task<Void, Never>?
    @ObservationIgnored private var clarificationUpdateRevision = 0
    private var clarificationUsesPollingFallback = false

    var hasPendingPrompt: Bool {
        approvalPrompt != nil || clarificationPrompt != nil
    }

    init(
        client: APIClient,
        approvalStreamClient: SSEStreamingClient,
        clarifyStreamClient: SSEStreamingClient,
        pollingIntervals: ChatPollingIntervals
    ) {
        self.client = client
        self.approvalStreamClient = approvalStreamClient
        self.clarifyStreamClient = clarifyStreamClient
        self.pollingIntervals = pollingIntervals
    }

    deinit {
        approvalPollingTask?.cancel()
        clarificationPollingTask?.cancel()
    }

    func refreshApprovalBypassState() async {
        guard let sessionID = delegate?.pendingActionSessionID else { return }

        do {
            let response = try await client.sessionYolo(sessionID: sessionID)
            isSessionApprovalBypassEnabled = response.yoloEnabled == true
            if isSessionApprovalBypassEnabled {
                approvalPrompt = nil
            } else {
                renderApprovalPromptForCurrentSession()
            }
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

    func startMonitoring() {
        startApprovalMonitoring()
        startClarificationMonitoring()
    }

    func stopMonitoring(clearPrompt: Bool) {
        stopApprovalMonitoring(clearPrompt: clearPrompt)
        stopClarificationMonitoring(clearPrompt: clearPrompt)
    }

    func applyApprovalUpdate(_ update: ApprovalPendingResponse, sessionID: String) {
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

        if prompt.questionID != nil {
            clarificationDraftResponse = responseText
            saveClarificationDraft(for: prompt)
            if !prompt.isLastQuestion {
                selectClarificationQuestion(prompt.questionIndex + 1, promptID: prompt.id)
                return true
            }
            // Manual paging must not let the final page submit missing answers.
            for index in 0..<prompt.questionCount {
                var question = prompt
                question.questionIndex = index
                if let id = question.questionID, clarificationAnswers[id] == nil {
                    selectClarificationQuestion(index, promptID: prompt.id)
                    clarificationErrorMessage = String(localized: "Answer each question before submitting.")
                    return false
                }
            }
        }
        let answers = clarificationAnswers

        isRespondingToClarification = true
        clarificationErrorMessage = nil
        delegate?.pendingActionCoordinatorWillSubmitAction()
        defer { isRespondingToClarification = false }

        do {
            // Old-server fallback. Delete response shaping once supported servers all ship steps.
            let wireResponse: String?
            if prompt.pending.steps != nil {
                wireResponse = nil
            } else {
                wireResponse = prompt.questionID == nil ? response
                    : String(decoding: try JSONEncoder().encode(["answers": answers]), as: UTF8.self)
            }
            _ = try await client.respondClarification(
                sessionID: prompt.sessionID,
                response: wireResponse,
                clarifyID: prompt.pending.clarifyId,
                answers: prompt.pending.steps != nil ? answers : nil
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

    func applyClarificationUpdate(_ update: ClarificationPendingResponse, sessionID: String) {
        clarificationUpdateRevision &+= 1
        if let pending = update.pending, !pending.isEmpty {
            var prompt = ClarificationPromptState(
                sessionID: sessionID,
                pending: pending,
                pendingCount: max(update.pendingCount ?? 1, 1)
            )
            if let current = clarificationPendingBySession[sessionID], current.requestID == prompt.requestID {
                prompt.questionIndex = min(current.questionIndex, prompt.questionCount - 1)
            }
            clarificationPendingBySession[sessionID] = prompt
        } else {
            clarificationPendingBySession[sessionID] = nil
        }

        renderClarificationPromptForCurrentSession()
    }

    private func startApprovalMonitoring() {
        guard let sessionID = delegate?.pendingActionSessionID,
              delegate?.pendingActionHasActiveStream == true,
              approvalMonitoringSessionID != sessionID
        else { return }

        stopApprovalMonitoring(clearPrompt: false)
        approvalMonitoringSessionID = sessionID
        approvalStreamClient.start(url: client.approvalStreamURL(sessionID: sessionID)) { [weak self] event in
            self?.handleApprovalMonitorEvent(event, sessionID: sessionID)
        }
    }

    private func stopApprovalMonitoring(clearPrompt: Bool) {
        let shouldStopStream = approvalMonitoringSessionID != nil || approvalPollingTask != nil
        approvalPollingTask?.cancel()
        approvalPollingTask = nil
        if shouldStopStream {
            approvalStreamClient.stop()
        }
        approvalMonitoringSessionID = nil

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
        case .token, .interimAssistant, .reasoning, .toolStarted, .toolCompleted, .title, .metering, .done, .clarificationPending,
             .steerConsumed, .pendingSteerLeftover, .streamEnd, .settledSession, .cancelled, .heartbeat, .ignored:
            break
        }
    }

    private func startApprovalFallbackPolling(sessionID: String) {
        guard approvalMonitoringSessionID == sessionID else { return }

        approvalStreamClient.stop()
        approvalPollingTask?.cancel()
        let pollingInterval = pollingIntervals.approvalNanoseconds
        approvalPollingTask = Task { @MainActor [weak self] in
            pollingLoop: while !Task.isCancelled {
                do {
                    guard let self,
                          self.delegate?.pendingActionSessionID == sessionID,
                          self.delegate?.pendingActionHasActiveStream == true,
                          self.delegate?.pendingActionIsStreamConnectionSuspended != true
                    else { break pollingLoop }

                    await self.refreshApprovalPending(sessionID: sessionID)
                }

                guard !Task.isCancelled else { break }
                try? await Task.sleep(nanoseconds: pollingInterval)
            }
        }
    }

    private func refreshApprovalPending(sessionID: String) async {
        guard delegate?.pendingActionHasActiveStream == true else { return }

        do {
            let response = try await client.approvalPending(sessionID: sessionID)
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

        guard delegate?.pendingActionHasActiveStream == true,
              !isSessionApprovalBypassEnabled,
              let prompt = approvalPendingBySession[sessionID]
        else {
            if approvalPrompt?.sessionID == sessionID {
                approvalPrompt = nil
            }
            return
        }

        approvalPrompt = prompt
    }

    private func startClarificationMonitoring() {
        guard let sessionID = delegate?.pendingActionSessionID,
              delegate?.pendingActionHasActiveStream == true,
              clarificationMonitoringSessionID != sessionID
        else { return }

        stopClarificationMonitoring(clearPrompt: false)
        clarificationMonitoringSessionID = sessionID
        let initialRevision = clarificationUpdateRevision
        clarifyStreamClient.start(url: client.clarifyStreamURL(sessionID: sessionID)) { [weak self] event in
            self?.handleClarificationMonitorEvent(event, sessionID: sessionID, initialRevision: initialRevision)
        }
        startClarificationPolling(sessionID: sessionID)
    }

    private func stopClarificationMonitoring(clearPrompt: Bool) {
        let shouldStopStream = clarificationMonitoringSessionID != nil || clarificationPollingTask != nil
        clarificationPollingTask?.cancel()
        clarificationPollingTask = nil
        if shouldStopStream {
            clarifyStreamClient.stop()
        }
        clarificationMonitoringSessionID = nil
        clarificationUsesPollingFallback = false

        guard clearPrompt else { return }
        if let sessionID = delegate?.pendingActionSessionID {
            clarificationPendingBySession[sessionID] = nil
        }
        clarificationPrompt = nil
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
        case .token, .interimAssistant, .reasoning, .toolStarted, .toolCompleted, .title, .metering, .done,
             .steerConsumed, .pendingSteerLeftover, .streamEnd, .settledSession, .cancelled, .heartbeat, .ignored:
            break
        }
    }

    private func startClarificationFallbackPolling(sessionID: String) {
        guard clarificationMonitoringSessionID == sessionID else { return }
        clarificationUsesPollingFallback = true
        clarifyStreamClient.stop()
        startClarificationPolling(sessionID: sessionID)
    }

    private func startClarificationPolling(sessionID: String) {
        guard clarificationMonitoringSessionID == sessionID, clarificationPollingTask == nil else { return }
        let pollingInterval = pollingIntervals.clarificationNanoseconds
        clarificationPollingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self,
                      self.delegate?.pendingActionSessionID == sessionID,
                      self.delegate?.pendingActionHasActiveStream == true,
                      self.delegate?.pendingActionIsStreamConnectionSuspended != true else { break }

                // Healthy streams need HTTP only when a running clarification
                // tool has no visible prompt, including a missed startup event.
                if self.clarificationUsesPollingFallback
                    || (self.clarificationPrompt == nil && self.delegate?.pendingActionHasRunningClarificationTool == true) {
                    await self.refreshClarificationPending(sessionID: sessionID)
                }
                guard !Task.isCancelled else { break }
                try? await Task.sleep(nanoseconds: pollingInterval)
            }
        }
    }

    private func refreshClarificationPending(sessionID: String) async {
        guard delegate?.pendingActionHasActiveStream == true else { return }
        let revision = clarificationUpdateRevision

        do {
            let response = try await client.clarifyPending(sessionID: sessionID)
            guard !Task.isCancelled, revision == clarificationUpdateRevision,
                  delegate?.pendingActionSessionID == sessionID,
                  delegate?.pendingActionHasActiveStream == true,
                  delegate?.pendingActionIsStreamConnectionSuspended != true else { return }
            applyClarificationUpdate(response, sessionID: sessionID)
        } catch {
            // The web UI also ignores degraded-mode polling failures.
            chatPendingActionCoordinatorLogger.debug(
                "Clarification polling failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )
        }
    }

    private func renderClarificationPromptForCurrentSession() {
        guard let sessionID = delegate?.pendingActionSessionID else {
            clarificationPrompt = nil
            return
        }

        guard delegate?.pendingActionHasActiveStream == true,
              let prompt = clarificationPendingBySession[sessionID]
        else {
            clarificationPrompt = nil
            return
        }

        clarificationPrompt = prompt
    }
}
