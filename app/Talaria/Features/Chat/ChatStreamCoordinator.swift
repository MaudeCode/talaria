import Foundation
import Observation
import OSLog
import SwiftData

private let chatStreamCoordinatorLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
    category: "ChatStreamCoordinator"
)

struct ChatStreamCoordinatorTiming: Equatable {
    let checkingInterval: TimeInterval
    let reconnectInterval: TimeInterval
    let runningToolReconnectInterval: TimeInterval
    let statusPollCooldown: TimeInterval
    // Transport quieter than this is treated as provably alive; must sit above
    // the server's ~5s SSE heartbeat cadence and below reconnectInterval (#227).
    let transportFreshInterval: TimeInterval

    static let standard = ChatStreamCoordinatorTiming(
        checkingInterval: 5,
        reconnectInterval: 18,
        runningToolReconnectInterval: 25,
        statusPollCooldown: 4,
        transportFreshInterval: 12
    )
}

struct ChatStreamLoadPreparation: Equatable {
    let activeStreamIDBeforeLoad: String?
    let shouldPrepareSuspendedStreamResume: Bool
    let responseGeneration: Int
}

@MainActor
protocol ChatStreamCoordinatorDelegate: AnyObject {
    var streamCoordinatorSessionID: String? { get }
    var streamCoordinatorDisplayTitle: String { get }
    var streamCoordinatorHasRunningLiveToolCall: Bool { get }
    var streamCoordinatorHasPendingPrompt: Bool { get }
    var streamCoordinatorLatestServerLoadHadAssistantResponseAfterLatestUser: Bool { get }
    var streamCoordinatorStreamingAssistantMessageID: String? { get set }

    func streamCoordinatorLoadMessages(modelContext: ModelContext?) async
    func streamCoordinatorLatestAssistantMessageID() -> String?
    /// Old-server fallback (TAL-316): drop the loaded running turn after its prompt
    /// so a replay from 0 renders it once. False when the load has no turn start.
    func streamCoordinatorOmitLoadedRunningTurn() -> Bool
    func streamCoordinatorStartAuxiliaryMonitoring()
    func streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: Bool)
    func streamCoordinatorSaveSnapshotIfNeeded()
    @discardableResult
    func streamCoordinatorRestoreSnapshotIfAvailable(streamID: String) -> String?
    func streamCoordinatorRemoveSnapshot(streamID: String?)
    func streamCoordinatorFlushPinnedLocalNoticesToTranscript()
    func streamCoordinatorDrainQueuedSlashMessageIfIdle()
    func streamCoordinatorRefreshCompletedResponseTitleIfNeeded()
    func streamCoordinatorDidCompleteCurrentResponse(needsTranscriptRefresh: Bool)
    func streamCoordinatorDidFinishStream()
    func streamCoordinatorDidReceiveErrorMessage(_ message: String)
    func streamCoordinatorDidReceiveRecoveryError(_ error: Error)
    func streamCoordinatorDidConfirmRecovery()

    @discardableResult
    func streamCoordinatorAppendToken(_ text: String) -> Bool
    @discardableResult
    func streamCoordinatorAppendInterimAssistant(_ payload: InterimAssistantStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorAppendReasoning(_ payload: ReasoningStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorAppendToolCall(_ payload: ToolStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorCompleteToolCall(_ payload: ToolStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorUpdateTitle(_ payload: TitleStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorApplyDone(_ payload: DoneStreamEvent) -> Bool
    func streamCoordinatorApplySettledSession(_ session: SessionDetail)
    func streamCoordinatorApplyApprovalUpdate(_ update: ApprovalPendingResponse)
    func streamCoordinatorApplyClarificationUpdate(_ update: ClarificationPendingResponse)
    @discardableResult
    func streamCoordinatorConsumeSteeringHint(_ event: SteeringStreamEvent) -> Bool
    @discardableResult
    func streamCoordinatorEnqueuePendingSteerLeftover(_ event: SteeringStreamEvent) -> Bool
}

@MainActor
@Observable
final class ChatStreamCoordinator {
    @ObservationIgnored private weak var delegate: (any ChatStreamCoordinatorDelegate)?
    private let client: APIClient
    private let streamClient: SSEStreamingClient
    private let configuredLiveActivityManager: any AgentLiveActivityManaging
    // Finished-journal replay restores messages without driving any Live Activity.
    private var publishesLiveActivity = true
    private var liveActivityManager: (any AgentLiveActivityManaging)? {
        publishesLiveActivity ? configuredLiveActivityManager : nil
    }
    private let timing: ChatStreamCoordinatorTiming
    private let now: () -> Date
    private var showsLiveActivityResponseExcerpts: Bool

    private(set) var activeStreamID: String? {
        didSet {
            guard activeStreamID != oldValue else { return }
            activeRunStartedAt = activeStreamID == nil ? nil : now()
        }
    }
    /// When the run behind the current stream started. Seeded by the caller from
    /// the server's `pending_started_at`, then the latest user turn's timestamp,
    /// and only failing both from the local moment this coordinator discovered
    /// the stream. Keyed to stream identity, so a same-run reattach keeps the
    /// per-session Live Activity timer counting from one instant.
    private(set) var activeRunStartedAt: Date?
    private(set) var recoveryState: ActiveStreamRecoveryState = .idle
    private(set) var isConnectionSuspended = false
    private(set) var hasCompletedCurrentResponse = false
    private(set) var lastEventID: String?
    private(set) var lastProgressDate: Date?
    private(set) var lastTransportActivityDate: Date?
    private(set) var liveTokensPerSecond: Double?
    private var lastRecoveryStatusCheckDate: Date?
    private(set) var isReplayConnection = false
    // The `after_seq` the current connection resumed from: its journal events at
    // or below it are already on screen, so they are never applied again.
    private var replayCursor: Int?
    // Bumped whenever the active run starts or finalizes. Captured before async
    // finalization work so stale tasks cannot finalize a newer run.
    private var runGeneration = 0
    // Bumped when response ownership starts or reaches a terminal state. The
    // post-done cleanup does not bump it again, so its completion reload survives.
    private var responseGeneration = 0
    // Terminal fence. Set by teardown and, unlike `hasCompletedCurrentResponse`,
    // deliberately not cleared by `finishStream`, so late semantic content and
    // competing terminal events arriving on the dead connection can neither mutate
    // nor re-finalize the run. Only the next run start or a session load clears it.
    private var hasFinishedCurrentRun = false
    // The latest applied session load's `transcript_seq` (TAL-316): its messages
    // hold nothing that stream's journal delivers after this cursor.
    private var loadedTranscriptSeq: TranscriptSeq?
    // The latest applied load came from a server that predates `transcript_seq`.
    private var loadedTranscriptPredatesCursor = false
    private var sharedReconnect: SharedReconnect?

    /// Whether the current run already reached `.done` or finished teardown.
    private var isCurrentRunTerminated: Bool {
        hasCompletedCurrentResponse || hasFinishedCurrentRun
    }

    /// The single in-flight `reconnectIfNeeded` for one (stream, run generation).
    /// Later callers await this task instead of firing their own status check,
    /// transcript load and restart.
    private struct SharedReconnect {
        let streamID: String
        let generation: Int
        let hasModelContext: Bool
        let task: Task<Void, Never>
    }

    init(
        client: APIClient,
        streamClient: SSEStreamingClient,
        liveActivityManager: any AgentLiveActivityManaging,
        showsLiveActivityResponseExcerpts: Bool,
        timing: ChatStreamCoordinatorTiming = .standard,
        now: @escaping () -> Date = Date.init
    ) {
        self.client = client
        self.streamClient = streamClient
        self.configuredLiveActivityManager = liveActivityManager
        self.showsLiveActivityResponseExcerpts = showsLiveActivityResponseExcerpts
        self.timing = timing
        self.now = now
    }

    func attach(delegate: any ChatStreamCoordinatorDelegate) {
        self.delegate = delegate
    }

    func setShowsLiveActivityResponseExcerpts(_ shows: Bool) {
        guard showsLiveActivityResponseExcerpts != shows else { return }

        showsLiveActivityResponseExcerpts = shows
        if !shows, activeStreamID != nil {
            liveActivityManager?.update(.clearResponseExcerpt)
        }
    }

    func prepareForNewResponse() {
        hasCompletedCurrentResponse = false
        hasFinishedCurrentRun = false
        isConnectionSuspended = false
        liveTokensPerSecond = nil
    }

    /// `runStartedAt` is the run's real start when the caller knows it: the
    /// server's `pending_started_at` from `/api/chat/start`, else the local send
    /// time. Reconnects and replays pass nil; they rejoin the same stream, whose
    /// start is already recorded.
    func start(
        streamID: String,
        replayAfterSeq: Int? = nil,
        recoveryState: ActiveStreamRecoveryState = .idle,
        armsAggregateForLocalWork: Bool = false,
        publishesLiveActivity: Bool = true,
        runStartedAt: Date? = nil
    ) {
        self.publishesLiveActivity = publishesLiveActivity
        hasCompletedCurrentResponse = false
        hasFinishedCurrentRun = false
        liveTokensPerSecond = nil
        runGeneration &+= 1
        responseGeneration &+= 1
        cancelSharedReconnect()
        activeStreamID = streamID
        seedActiveRunStart(runStartedAt)
        isConnectionSuspended = false
        if replayAfterSeq == nil {
            lastEventID = nil
        }
        replayCursor = replayAfterSeq

        markConnectionStarted(
            isReplay: replayAfterSeq != nil,
            recoveryState: recoveryState
        )
        startLiveActivity(
            streamID: streamID,
            armsAggregateForLocalWork: armsAggregateForLocalWork
        )
        streamClient.start(
            url: client.chatStreamURL(
                streamID: streamID,
                replayAfterSeq: replayAfterSeq
            )
        ) { [weak self] event in
            self?.handle(event)
        }
        delegate?.streamCoordinatorStartAuxiliaryMonitoring()
    }

    func cancelActiveStream() async throws -> ChatCancelResponse? {
        guard let activeStreamID else { return nil }

        let response = try await client.cancelChat(streamID: activeStreamID)
        guard self.activeStreamID == activeStreamID else { return response }
        guard response.ok != false else { return response }

        liveActivityManager?.end(status: .cancelled, activity: String(localized: "Response cancelled"), errorSummary: nil)
        finishStream()
        return response
    }

    func suspendActiveStreamConnection() {
        guard activeStreamID != nil, !hasCompletedCurrentResponse, !isConnectionSuspended else { return }

        lastEventID = streamClient.lastEventID ?? lastEventID
        delegate?.streamCoordinatorSaveSnapshotIfNeeded()
        liveActivityManager?.markStale()
        isConnectionSuspended = true
        streamClient.stop()
        delegate?.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
    }

    func prepareForSessionLoad() -> ChatStreamLoadPreparation {
        liveTokensPerSecond = nil
        let activeStreamIDBeforeLoad = activeStreamID
        if activeStreamIDBeforeLoad != nil, !hasCompletedCurrentResponse {
            delegate?.streamCoordinatorSaveSnapshotIfNeeded()
        }

        return ChatStreamLoadPreparation(
            activeStreamIDBeforeLoad: activeStreamIDBeforeLoad,
            shouldPrepareSuspendedStreamResume: activeStreamID == nil || isConnectionSuspended,
            responseGeneration: responseGeneration
        )
    }

    func canApplySessionLoad(_ preparation: ChatStreamLoadPreparation) -> Bool {
        responseGeneration == preparation.responseGeneration
    }

    func invalidateSessionLoads() {
        responseGeneration &+= 1
    }

    /// `runStartedAt` is when the loaded session says its in-flight turn started
    /// (`pending_started_at`, else the latest user turn's timestamp), so adopting
    /// a running stream counts from there instead of from this load.
    /// `transcriptSeq` is the load's `transcript_seq`, where its messages end in
    /// the active run's journal.
    func reconcileSessionLoad(
        loadedActiveStreamID rawLoadedActiveStreamID: String?,
        preparation: ChatStreamLoadPreparation,
        usedCacheFallback: Bool,
        runStartedAt: Date? = nil,
        transcriptSeq: TranscriptSeq? = nil,
        statesTranscriptSeq: Bool = true
    ) {
        hasCompletedCurrentResponse = false
        hasFinishedCurrentRun = false
        liveTokensPerSecond = nil
        loadedTranscriptSeq = usedCacheFallback ? nil : transcriptSeq
        loadedTranscriptPredatesCursor = !usedCacheFallback && !statesTranscriptSeq

        if usedCacheFallback {
            activeStreamID = nil
            isConnectionSuspended = false
            delegate?.streamCoordinatorStreamingAssistantMessageID = nil
            resetRecoveryState()
            return
        }

        let loadedActiveStreamID = rawLoadedActiveStreamID?.trimmingCharacters(in: .whitespacesAndNewlines)
        if preparation.shouldPrepareSuspendedStreamResume {
            delegate?.streamCoordinatorStreamingAssistantMessageID = nil
            if let streamID = loadedActiveStreamID, !streamID.isEmpty {
                activeStreamID = streamID
                seedActiveRunStart(runStartedAt)
                adoptLoadedStreamingAssistantMessage(streamID: streamID)
                isConnectionSuspended = true
                restoreSnapshotIfAvailable(streamID: streamID)
            } else {
                activeStreamID = nil
                isConnectionSuspended = false
                resetRecoveryState()
            }
        } else {
            let streamID = loadedActiveStreamID?.isEmpty == false
                ? loadedActiveStreamID
                : preparation.activeStreamIDBeforeLoad
            if let streamID {
                activeStreamID = streamID
                seedActiveRunStart(runStartedAt)
                adoptLoadedStreamingAssistantMessage(streamID: streamID)
                restoreSnapshotIfAvailable(streamID: streamID)
                if delegate?.streamCoordinatorStreamingAssistantMessageID == nil {
                    adoptLoadedStreamingAssistantMessage(streamID: streamID)
                }
            }
            isConnectionSuspended = false
        }
    }

    func reconnectIfNeeded(modelContext: ModelContext? = nil) async {
        guard let activeStreamID, isConnectionSuspended else { return }
        let generation = runGeneration

        if let inFlight = sharedReconnect,
           inFlight.streamID == activeStreamID,
           inFlight.generation == generation {
            // A persistence context lets the shared transcript load reconcile the
            // message cache, so a caller that brings one takes ownership from a
            // context-less request already in flight. Otherwise share its work.
            guard modelContext != nil, !inFlight.hasModelContext else {
                await inFlight.task.value
                return
            }

            cancelSharedReconnect()
        }

        let task = Task { @MainActor [weak self] in
            guard let self else { return }

            await self.performReconnect(
                streamID: activeStreamID,
                generation: generation,
                modelContext: modelContext
            )
        }
        sharedReconnect = SharedReconnect(
            streamID: activeStreamID,
            generation: generation,
            hasModelContext: modelContext != nil,
            task: task
        )
        await task.value
        if sharedReconnect?.task == task {
            sharedReconnect = nil
        }
    }

    private func cancelSharedReconnect() {
        guard let sharedReconnect else { return }

        self.sharedReconnect = nil
        sharedReconnect.task.cancel()
    }

    private func performReconnect(
        streamID activeStreamID: String,
        generation: Int,
        modelContext: ModelContext?
    ) async {
        do {
            let response = try await client.chatStreamStatus(streamID: activeStreamID)
            guard !Task.isCancelled, self.activeStreamID == activeStreamID, isConnectionSuspended else { return }

            if response.active == true {
                await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
                guard !Task.isCancelled, self.activeStreamID == activeStreamID, isConnectionSuspended else { return }

                let streamIDToResume = activeStreamID
                if delegate?.streamCoordinatorStreamingAssistantMessageID == nil {
                    restoreSnapshotIfAvailable(streamID: streamIDToResume)
                }
                if delegate?.streamCoordinatorStreamingAssistantMessageID == nil {
                    adoptLoadedStreamingAssistantMessage(streamID: streamIDToResume)
                }
                var replayAfterSeq = resumeAfterSeq(streamID: streamIDToResume)
                // ponytail: old-server fallback — delete once every supported Web ships `transcript_seq`.
                if replayAfterSeq == nil, loadedTranscriptPredatesCursor, response.replayAvailable == true,
                   delegate?.streamCoordinatorOmitLoadedRunningTurn() == true {
                    replayAfterSeq = 0
                }
                isConnectionSuspended = false
                start(streamID: streamIDToResume, replayAfterSeq: replayAfterSeq)
            } else if response.replayAvailable == true {
                let replayAfterSeq = Self.runJournalReplayAfterSeq(from: lastEventID, streamID: activeStreamID) ?? 0
                // Replaying a finished journal restores the transcript, not a running card.
                if response.active == false {
                    let outcome = LiveActivityReconciler.reconciledOutcome(forTerminalState: response.journal?.terminalState)
                    await configuredLiveActivityManager.endOrphanedActivity(
                        streamID: activeStreamID, status: outcome.status, activity: outcome.activity
                    )
                    guard !Task.isCancelled, self.activeStreamID == activeStreamID,
                          runGeneration == generation else { return }
                }
                start(streamID: activeStreamID, replayAfterSeq: replayAfterSeq, publishesLiveActivity: response.active != false)
            } else {
                await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
                // Bail if a concurrent completion/cancel/new run finalized or
                // replaced this run during the load (see canFinalizeRunAfterLoad).
                guard !Task.isCancelled,
                      canFinalizeRunAfterLoad(streamID: activeStreamID, capturedGeneration: generation) else { return }

                // #246: the server reports the run is over. Finalize it (and end
                // the Live Activity) instead of re-arming and leaving it dangling
                // on "running" when no assistant reply surfaced.
                finalizeInactiveStream(streamID: activeStreamID)
            }
        } catch {
            guard !Task.isCancelled else { return }

            if (error as? APIError)?.indicatesMissingStream == true,
               self.activeStreamID == activeStreamID,
               isConnectionSuspended {
                await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
                guard !Task.isCancelled,
                      canFinalizeRunAfterLoad(streamID: activeStreamID, capturedGeneration: generation) else { return }
                finalizeInactiveStream(streamID: activeStreamID)
                return
            }
            delegate?.streamCoordinatorDidReceiveRecoveryError(error)
            guard self.activeStreamID == activeStreamID, isConnectionSuspended else { return }
            let retryDelay = UInt64(max(timing.statusPollCooldown, 0.01) * 1_000_000_000)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: retryDelay)
                await self?.reconnectIfNeeded(modelContext: modelContext)
            }
        }
    }

    func refreshTranscriptIfCompleted(
        streamID expectedStreamID: String,
        modelContext: ModelContext? = nil
    ) async {
        guard activeStreamID == expectedStreamID, !isConnectionSuspended else { return }
        let generation = runGeneration

        do {
            let response = try await client.chatStreamStatus(streamID: expectedStreamID)
            guard response.active == false else { return }

            await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
            // Bail if a concurrent completion/cancel/new run finalized or replaced
            // this run during the load (see canFinalizeRunAfterLoad).
            guard canFinalizeRunAfterLoad(streamID: expectedStreamID, capturedGeneration: generation) else { return }

            guard delegate?.streamCoordinatorLatestServerLoadHadAssistantResponseAfterLatestUser == true else {
                // Foreground safety net: the live SSE is still connected and owns
                // completion, so a status poll that briefly reports inactive must
                // not finalize the run — keep waiting for the real `.done`. (This
                // is why #246's finalize-on-reopen fix deliberately excludes this
                // path; see finalizeInactiveStream.)
                activeStreamID = expectedStreamID
                isConnectionSuspended = false
                return
            }

            completeResponseFromRefreshedTranscriptAndFinishStream(streamID: expectedStreamID)
        } catch {
            // This is a foreground safety net. The primary SSE path owns visible
            // stream errors; a failed status poll should not interrupt it.
            chatStreamCoordinatorLogger.warning(
                "Active stream status refresh failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )
        }
    }

    func recoverStaleStreamIfNeeded(
        now: Date = Date(),
        modelContext: ModelContext? = nil
    ) async {
        guard let activeStreamID,
              !isConnectionSuspended,
              !hasCompletedCurrentResponse
        else {
            recoveryState = .idle
            return
        }

        guard delegate?.streamCoordinatorHasPendingPrompt != true else {
            recoveryState = .idle
            return
        }

        let reconnectInterval = delegate?.streamCoordinatorHasRunningLiveToolCall == true
            ? timing.runningToolReconnectInterval
            : timing.reconnectInterval
        guard let lastProgressDate else {
            guard let lastTransportActivityDate,
                  now.timeIntervalSince(lastTransportActivityDate) >= reconnectInterval
            else {
                recoveryState = .idle
                return
            }

            recoveryState = .checking
            lastRecoveryStatusCheckDate = now
            await recoverStaleStream(
                streamID: activeStreamID,
                forceReconnect: true,
                modelContext: modelContext
            )
            return
        }

        let elapsed = now.timeIntervalSince(lastProgressDate)
        guard elapsed >= timing.checkingInterval else {
            recoveryState = .idle
            return
        }

        let transportElapsed = now.timeIntervalSince(lastTransportActivityDate ?? lastProgressDate)
        guard transportElapsed >= timing.transportFreshInterval else {
            // #227: heartbeats prove the connection is alive during a
            // semantically quiet window (model thinking / slow tool call), so
            // stay idle and skip status polls. A genuinely silent transport
            // still escalates below once past transportFreshInterval.
            recoveryState = .idle
            return
        }

        recoveryState = .checking
        let shouldForceReconnect = transportElapsed >= reconnectInterval
        guard shouldForceReconnect || shouldPollStatus(now: now) else { return }

        lastRecoveryStatusCheckDate = now
        await recoverStaleStream(
            streamID: activeStreamID,
            forceReconnect: shouldForceReconnect,
            modelContext: modelContext
        )
    }

    func markProgress(now: Date = Date()) {
        lastProgressDate = now
        lastTransportActivityDate = now
        lastRecoveryStatusCheckDate = nil
        recoveryState = .idle
        delegate?.streamCoordinatorDidConfirmRecovery()
    }

    /// The sequence of a `stream_id:seq` run-journal event id, or nil unless the
    /// id belongs to `streamID`: another stream's cursor never resumes this one.
    nonisolated static func runJournalReplayAfterSeq(from eventID: String?, streamID: String) -> Int? {
        guard let eventID = eventID?.trimmingCharacters(in: .whitespacesAndNewlines),
              let delimiterIndex = eventID.lastIndex(of: ":"),
              eventID[..<delimiterIndex] == streamID,
              let sequence = Int(eventID[eventID.index(after: delimiterIndex)...])
        else {
            return nil
        }

        return max(0, sequence)
    }

    private func isCoveredByReplayCursor(_ event: SSEEvent) -> Bool {
        switch event {
        case .token, .interimAssistant, .reasoning, .toolStarted, .toolCompleted, .steerConsumed:
            guard let replayCursor, let activeStreamID,
                  let seq = Self.runJournalReplayAfterSeq(from: streamClient.lastEventID, streamID: activeStreamID)
            else { return false }
            return seq <= replayCursor
        default:
            return false
        }
    }

    /// Where to resume `streamID` (TAL-316): after this process's own cursor for
    /// that stream, else after the loaded transcript's cursor for it, else live
    /// without replay. Replay idempotence comes only from these cursors.
    private func resumeAfterSeq(streamID: String) -> Int? {
        if let ownSeq = Self.runJournalReplayAfterSeq(from: lastEventID, streamID: streamID) {
            return ownSeq
        }
        guard let loadedTranscriptSeq, loadedTranscriptSeq.streamId == streamID else { return nil }
        return loadedTranscriptSeq.seq
    }

    /// A load that states its transcript cursor for `streamID` holds none of that
    /// run's output, so the replay creates the streaming message; otherwise the
    /// run continues the latest loaded assistant message.
    private func adoptLoadedStreamingAssistantMessage(streamID: String) {
        delegate?.streamCoordinatorStreamingAssistantMessageID = loadedTranscriptSeq?.streamId == streamID
            ? nil
            : delegate?.streamCoordinatorLatestAssistantMessageID()
    }

    private func handle(_ event: SSEEvent) {
        // Terminal fence: once the run reached `.done` or finished teardown, the
        // only events it may still apply are a post-completion title, correctly
        // scoped metering, and terminal events — which can now only drive the
        // one-shot teardown, never a second finalization.
        if isCurrentRunTerminated {
            switch event {
            case .title, .metering, .streamEnd, .settledSession, .cancelled, .error, .transportError:
                break
            default:
                return
            }
        }

        lastEventID = streamClient.lastEventID ?? lastEventID
        lastTransportActivityDate = Date()
        if isCoveredByReplayCursor(event) {
            return
        }

        switch event {
        case .token(let text):
            if showsLiveActivityResponseExcerpts {
                liveActivityManager?.update(.token(text))
            }
            if delegate?.streamCoordinatorAppendToken(text) == true {
                markProgress()
            }
        case .interimAssistant(let payload):
            if showsLiveActivityResponseExcerpts,
               payload.alreadyStreamed != true,
               let text = payload.text {
                liveActivityManager?.update(.interimAssistant(text))
            }
            if delegate?.streamCoordinatorAppendInterimAssistant(payload) == true {
                markProgress()
            }
        case .reasoning(let payload):
            if !payload.text.isEmpty {
                liveActivityManager?.update(.reasoning(payload.text))
            }
            if delegate?.streamCoordinatorAppendReasoning(payload) == true {
                markProgress()
            }
        case .toolStarted(let payload):
            liveActivityManager?.update(.toolStarted(name: payload.name))
            if delegate?.streamCoordinatorAppendToolCall(payload) == true {
                markProgress()
            }
        case .toolCompleted(let payload):
            liveActivityManager?.update(.toolCompleted)
            if delegate?.streamCoordinatorCompleteToolCall(payload) == true {
                markProgress()
            }
        case .title(let payload):
            if delegate?.streamCoordinatorUpdateTitle(payload) == true {
                markProgress()
            }
        case .metering(let payload):
            // A session-less reading is attributable to the live run only while it
            // is still running; past termination it may belong to a newer one.
            guard payload.sessionId == delegate?.streamCoordinatorSessionID
                    || (payload.sessionId == nil && !isCurrentRunTerminated)
            else {
                break
            }
            liveTokensPerSecond = payload.displayableTokensPerSecond
        case .done(let payload):
            let hasCompletedTranscript = delegate?.streamCoordinatorApplyDone(payload) == true
            completeCurrentResponse(needsTranscriptRefresh: !hasCompletedTranscript)
        case .approvalPending(let update):
            liveActivityManager?.update(.waitingForApproval)
            delegate?.streamCoordinatorApplyApprovalUpdate(update)
            markProgress()
        case .clarificationPending(let update):
            liveActivityManager?.update(.waitingForClarification)
            delegate?.streamCoordinatorApplyClarificationUpdate(update)
            markProgress()
        case .steerConsumed(let event):
            if delegate?.streamCoordinatorConsumeSteeringHint(event) == true {
                markProgress()
            }
        case .pendingSteerLeftover(let event):
            if delegate?.streamCoordinatorEnqueuePendingSteerLeftover(event) == true {
                markProgress()
            }
        case .streamEnd:
            if !isCurrentRunTerminated {
                liveActivityManager?.end(status: .complete, activity: String(localized: "Response complete"), errorSummary: nil)
            }
            finishStream()
        case .settledSession(let session):
            // The server's settled turn (its scene, outcome and answer) replaces the live view, as after `done`.
            delegate?.streamCoordinatorApplySettledSession(session)
        case .cancelled:
            if !isCurrentRunTerminated {
                liveActivityManager?.end(status: .cancelled, activity: String(localized: "Response cancelled"), errorSummary: nil)
            }
            finishStream()
        case .error(let message):
            if !isCurrentRunTerminated {
                delegate?.streamCoordinatorDidReceiveErrorMessage(message)
                liveActivityManager?.end(status: .failed, activity: String(localized: "Response failed"), errorSummary: nil)
            }
            finishStream()
        case .transportError(let message):
            handleTransportError(message)
        case .heartbeat:
            // #227: a heartbeat proves the transport is alive without carrying
            // semantic progress — drop an already-shown "Checking stream" state
            // immediately. Never demote .reconnecting; that chip is owned by
            // the reconnect flow until real progress lands.
            if recoveryState == .checking {
                recoveryState = .idle
            }
            // The transport proved itself alive, which is all a recovery warning
            // was ever about — retract it without waiting for semantic content.
            delegate?.streamCoordinatorDidConfirmRecovery()
        case .ignored:
            break
        }
    }

    private func handleTransportError(_ message: String) {
        liveTokensPerSecond = nil
        guard activeStreamID != nil, !isCurrentRunTerminated else {
            if !isCurrentRunTerminated {
                delegate?.streamCoordinatorDidReceiveErrorMessage(message)
            }
            finishStream()
            return
        }

        guard !isConnectionSuspended else { return }

        lastEventID = streamClient.lastEventID ?? lastEventID
        delegate?.streamCoordinatorSaveSnapshotIfNeeded()
        liveActivityManager?.markStale()
        isConnectionSuspended = true
        streamClient.stop()
        delegate?.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)

        Task { @MainActor [weak self] in
            await self?.reconnectIfNeeded()
        }
    }

    private func shouldPollStatus(now: Date) -> Bool {
        guard let lastRecoveryStatusCheckDate else { return true }

        return now.timeIntervalSince(lastRecoveryStatusCheckDate) >= timing.statusPollCooldown
    }

    private func recoverStaleStream(
        streamID expectedStreamID: String,
        forceReconnect: Bool,
        modelContext: ModelContext?
    ) async {
        guard activeStreamID == expectedStreamID, !isConnectionSuspended else { return }
        let generation = runGeneration

        do {
            let response = try await client.chatStreamStatus(streamID: expectedStreamID)
            guard activeStreamID == expectedStreamID, !isConnectionSuspended else { return }

            if response.active == false {
                await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
                // Same generation/clobber guard as the reconnect and refresh paths;
                // the extra `!isConnectionSuspended` keeps the reconnect path owning
                // a stream that was suspended mid-load. (PR #266 review #3)
                guard canFinalizeRunAfterLoad(streamID: expectedStreamID, capturedGeneration: generation),
                      !isConnectionSuspended else { return }

                finalizeInactiveStream(streamID: expectedStreamID)
                return
            }

            // PR #238 review: recoveryState was set to .checking before this
            // await. If it changed mid-flight (a heartbeat or real progress
            // demoted it to .idle), the transport just proved itself alive —
            // don't resurrect the chip or churn a live connection; the next
            // recovery tick re-evaluates from scratch.
            guard recoveryState == .checking, forceReconnect else { return }

            reconnectStaleStream(
                streamID: expectedStreamID,
                usesReplay: response.replayAvailable == true
            )
        } catch {
            chatStreamCoordinatorLogger.warning(
                "Stale stream recovery status check failed category=\(APIError.privacySafeLogCategory(for: error), privacy: .public)"
            )

            if (error as? APIError)?.indicatesMissingStream == true,
               activeStreamID == expectedStreamID,
               !isConnectionSuspended {
                await delegate?.streamCoordinatorLoadMessages(modelContext: modelContext)
                guard canFinalizeRunAfterLoad(streamID: expectedStreamID, capturedGeneration: generation),
                      !isConnectionSuspended else { return }
                finalizeInactiveStream(streamID: expectedStreamID)
                return
            }

            // Same mid-flight demotion guard as the success path (PR #238
            // review): only a still-.checking state may escalate.
            guard recoveryState == .checking,
                  forceReconnect,
                  activeStreamID == expectedStreamID,
                  !isConnectionSuspended
            else { return }

            reconnectStaleStream(streamID: expectedStreamID, usesReplay: true)
        }
    }

    private func reconnectStaleStream(streamID: String, usesReplay: Bool) {
        guard activeStreamID == streamID, !isConnectionSuspended else { return }

        lastEventID = streamClient.lastEventID ?? lastEventID
        let replayAfterSeq = usesReplay ? Self.runJournalReplayAfterSeq(from: lastEventID, streamID: streamID) ?? 0 : nil
        delegate?.streamCoordinatorSaveSnapshotIfNeeded()
        liveActivityManager?.markStale()
        recoveryState = .reconnecting
        streamClient.stop()
        delegate?.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
        start(
            streamID: streamID,
            replayAfterSeq: replayAfterSeq,
            recoveryState: .reconnecting,
            publishesLiveActivity: publishesLiveActivity
        )
    }

    private func completeCurrentResponse(needsTranscriptRefresh: Bool) {
        runGeneration &+= 1
        responseGeneration &+= 1
        liveActivityManager?.end(status: .complete, activity: String(localized: "Response complete"), errorSummary: nil)
        delegate?.streamCoordinatorRemoveSnapshot(streamID: activeStreamID)
        delegate?.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
        activeStreamID = nil
        lastEventID = nil
        liveTokensPerSecond = nil
        delegate?.streamCoordinatorStreamingAssistantMessageID = nil
        hasCompletedCurrentResponse = true
        delegate?.streamCoordinatorDidCompleteCurrentResponse(needsTranscriptRefresh: needsTranscriptRefresh)
        resetRecoveryState()
    }

    private func completeResponseFromRefreshedTranscriptAndFinishStream(streamID completedStreamID: String?) {
        completeCurrentResponse(needsTranscriptRefresh: false)
        delegate?.streamCoordinatorRemoveSnapshot(streamID: completedStreamID)
        finishStream()
    }

    /// Whether `self` may still finalize the run captured before an awaited
    /// transcript load. Returns false (bail) when a concurrent completion / cancel
    /// / new run bumped the generation — finalizing would double-finalize — or when
    /// a *different* run is now active — finalizing would clobber the newer stream.
    /// A run reconciled to `nil` during the load still passes: it should be
    /// finalized from the refreshed transcript so its Live Activity can't dangle on
    /// "running" (#246). Shared by all three post-load finalize paths
    /// (reconnect-after-suspend, foreground refresh, stale recovery) so they stay in
    /// lockstep — recoverStaleStream previously used a stricter, hand-rolled guard.
    /// (PR #266 review #3)
    private func canFinalizeRunAfterLoad(streamID: String, capturedGeneration: Int) -> Bool {
        guard runGeneration == capturedGeneration else { return false }
        return activeStreamID == nil || activeStreamID == streamID
    }

    /// The server reports this stream is no longer active. Complete from the
    /// just-refreshed transcript when an assistant reply surfaced, otherwise
    /// finalize as failed. Either branch ends the Live Activity, so it can never
    /// dangle on "running" after the run is over (#246). Shared by the two paths
    /// with no live SSE behind them — reconnect-after-suspend and stale recovery.
    /// The foreground transcript-refresh safety net deliberately keeps waiting
    /// instead, because its live SSE still owns completion.
    private func finalizeInactiveStream(streamID: String?) {
        if delegate?.streamCoordinatorLatestServerLoadHadAssistantResponseAfterLatestUser == true {
            completeResponseFromRefreshedTranscriptAndFinishStream(streamID: streamID)
        } else {
            liveActivityManager?.end(status: .failed, activity: String(localized: "Response failed"), errorSummary: nil)
            finishStream()
        }
    }

    private func finishStream() {
        guard !hasFinishedCurrentRun else { return }

        hasFinishedCurrentRun = true
        let completedNormally = hasCompletedCurrentResponse
        runGeneration &+= 1
        cancelSharedReconnect()
        if !completedNormally {
            responseGeneration &+= 1
        }
        let finishedStreamID = activeStreamID
        streamClient.stop()
        delegate?.streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: true)
        delegate?.streamCoordinatorFlushPinnedLocalNoticesToTranscript()
        delegate?.streamCoordinatorRemoveSnapshot(streamID: finishedStreamID)
        activeStreamID = nil
        lastEventID = nil
        liveTokensPerSecond = nil
        delegate?.streamCoordinatorStreamingAssistantMessageID = nil
        hasCompletedCurrentResponse = false
        delegate?.streamCoordinatorDidFinishStream()
        isConnectionSuspended = false
        resetRecoveryState()
        delegate?.streamCoordinatorDrainQueuedSlashMessageIfIdle()
        if completedNormally {
            delegate?.streamCoordinatorRefreshCompletedResponseTitleIfNeeded()
        }
    }

    private func markConnectionStarted(
        isReplay: Bool,
        recoveryState: ActiveStreamRecoveryState
    ) {
        let startedAt = Date()
        lastProgressDate = isReplay ? startedAt : nil
        lastTransportActivityDate = startedAt
        lastRecoveryStatusCheckDate = nil
        self.recoveryState = recoveryState
        isReplayConnection = isReplay
    }

    private func resetRecoveryState() {
        recoveryState = .idle
        lastProgressDate = nil
        lastTransportActivityDate = nil
        lastRecoveryStatusCheckDate = nil
        isReplayConnection = false
    }

    private func startLiveActivity(
        streamID: String,
        armsAggregateForLocalWork: Bool
    ) {
        guard let sessionID = delegate?.streamCoordinatorSessionID else { return }
        let sessionTitle = delegate?.streamCoordinatorDisplayTitle ?? String(localized: "Untitled Session")

        if armsAggregateForLocalWork {
            liveActivityManager?.armAggregateForLocalWork(
                sessionID: sessionID,
                sessionTitle: sessionTitle,
                publisherURL: client.baseURL
            )
        }

        liveActivityManager?.start(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            streamID: streamID,
            publisherURL: client.baseURL,
            startedAt: activeRunStartedAt ?? now()
        )
    }

    /// A usable server run start: finite, positive epoch seconds. Anything else
    /// is treated as absent so callers fall back to a later seed.
    nonisolated static func runStart(fromEpochSeconds seconds: Double?) -> Date? {
        guard let seconds, seconds.isFinite, seconds > 0 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    /// Adopts a caller-supplied start for the run that is now active. The
    /// earliest start known for this stream wins, so a re-seed on a same-run
    /// reattach can sharpen the timer but never restart it; a future-dated seed
    /// (phone/server clock skew) clamps to `now` so the timer never counts
    /// backwards; nil leaves the discovery stamp alone.
    private func seedActiveRunStart(_ startedAt: Date?) {
        guard activeStreamID != nil, let startedAt else { return }
        let clamped = min(startedAt, now())
        activeRunStartedAt = min(activeRunStartedAt ?? clamped, clamped)
    }

    private func restoreSnapshotIfAvailable(streamID: String) {
        guard lastEventID == nil else {
            _ = delegate?.streamCoordinatorRestoreSnapshotIfAvailable(streamID: streamID)
            return
        }

        lastEventID = delegate?.streamCoordinatorRestoreSnapshotIfAvailable(streamID: streamID) ?? lastEventID
    }
}
