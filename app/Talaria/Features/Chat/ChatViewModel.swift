import Foundation
import AVFoundation
import Observation
import SwiftData

@MainActor
@Observable
final class ChatViewModel {
    private static let messagePageLimit = 50

    private struct SessionLoadWaiter {
        let requestGeneration: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    private(set) var messages: [ChatMessage] = [] {
        didSet {
            if !isUpdatingStreamingAssistantContent {
                recomputeDisplayedTranscriptMessages()
            }
        }
    }
    /// Memoized transcript mapping. Structural changes rebuild it; paced content
    /// flushes replace only the active transcript row.
    private(set) var displayedTranscriptMessages: [TranscriptMessage] = []
#if DEBUG
    @ObservationIgnored private(set) var displayedTranscriptRecomputeCount = 0
#endif
    private(set) var isLoading = false
    private(set) var isLoadingOlderMessages = false
    private(set) var isStartingChat = false
    @ObservationIgnored private var isStartingMessageSend = false
    @ObservationIgnored private var messageSendWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var sessionLoadRequestGeneration = 0
    @ObservationIgnored private var latestAppliedSessionLoadRequestGeneration = 0
    @ObservationIgnored private var latestHandledSessionLoadFailureGeneration = 0
    @ObservationIgnored private var activeSessionLoadRequestGenerations: Set<Int> = []
    @ObservationIgnored private var sessionLoadWaiters: [SessionLoadWaiter] = []
    /// True while a recorded voice note is being transcribed, uploaded, and sent.
    /// Spans all three steps so the composer can show progress and disable input.
    private(set) var isSendingVoiceNote = false
    private(set) var isForkingMessage = false
    private(set) var isEditingMessage = false
    private(set) var isRegeneratingMessage = false
    private(set) var isCompressingSession = false
    private(set) var isCancellingStream = false
    private(set) var isViewingCachedData = false
    var activeStreamID: String? { streamCoordinator.activeStreamID }
    var activeStreamRecoveryState: ActiveStreamRecoveryState { streamCoordinator.recoveryState }
    var liveTokensPerSecond: Double? { streamCoordinator.liveTokensPerSecond }
    private(set) var errorMessage: String?
    private(set) var sendErrorMessage: String? {
        didSet {
            // Every other writer takes ownership of the banner, so stream recovery
            // can no longer retract it. Identity, not matching text: a send that
            // fails the same way as the recovery attempt is still its own error.
            ownsSendErrorForRecovery = false
        }
    }
    private var ownsSendErrorForRecovery = false
    private(set) var messageActionErrorMessage: String?
    private(set) var cacheErrorMessage: String?
    private(set) var lastError: Error?
    private(set) var displayTitle: String
    private(set) var listeningMessageID: String?
    private(set) var streamingScrollTrigger = 0
    /// Bumped when a cache-first cold open (#289) finishes reconciling the network
    /// transcript over the instantly-rendered cached one. The richer server content
    /// (tool-call / reasoning cards, content parts) is taller than the lighter cached
    /// render, so the view re-pins to the bottom on this token *without* animation —
    /// otherwise the height growth produces a visible scroll jump.
    private(set) var cacheFirstReconcileScrollToken = 0
    private var hasPrimedInitialCachedMessages = false
    /// The selected list row's server run state (TAL-250): a provisional hint for
    /// the first paint, never authority to adopt, resend or settle a run.
    private let selectedRowIsStreaming: Bool?
    private let selectedRowActiveStreamID: String?
    /// True from the first paint until the first session load answers, unless the
    /// selected row reported the session idle.
    private var isConfirmingRunState = false
    /// Shows that the run state is still being confirmed while no run is adopted.
    var showsRunStateCheck: Bool { isConfirmingRunState && activeStreamID == nil }
    @ObservationIgnored private var pendingStreamingScrollTriggerTask: Task<Void, Never>?
    @ObservationIgnored private var pendingAssistantTokenText = ""
    @ObservationIgnored private var pendingReasoningText = ""
    @ObservationIgnored private var pendingReasoningTitles: [String] = []
    @ObservationIgnored private var pendingStreamingContentFlushTask: Task<Void, Never>?
    @ObservationIgnored private var isUpdatingStreamingAssistantContent = false
    private(set) var completedToolCallGroups: [ToolCallGroup] = []
    private var completedToolCallGroupLookup = ToolCallGroupAnchorLookup()
    private(set) var completedReasoningGroups: [ReasoningGroup] = []
    private(set) var archivedAssistantActivity: [String: [AssistantActivityRow]] = [:]
    /// Earlier scene rows paged from the server for long completed turns, keyed by the turn's anchor.
    private(set) var earlierSceneRows: [String: [AssistantActivitySceneRow]] = [:]
    private var loadingEarlierSceneRows = Set<String>()
    var displayedReasoningGroups: [ReasoningGroup] {
        Self.reasoningDisplayGroups(
            messages: messages,
            messageOffset: messagesOffset,
            archivedGroups: completedReasoningGroups
        )
    }
    func completedToolCallGroupsForAnchor(_ anchorMessageID: String?) -> [ToolCallGroup] {
        completedToolCallGroupLookup.groups(anchorMessageID: anchorMessageID)
    }
    func archivedActivityRowsForAnchor(_ anchorMessageID: String?) -> [AssistantActivityRow] {
        anchorMessageID.flatMap { archivedAssistantActivity[$0] } ?? []
    }

    func earlierSceneRows(for transcriptMessage: TranscriptMessage) -> [AssistantActivitySceneRow] {
        earlierSceneRows[Self.earlierSceneRowsKey(transcriptMessage)] ?? []
    }

    /// Paged rows belong to one server turn: a regenerated reply at the same position is a new turn id, so it never
    /// picks up the previous answer's rows. Only an unstamped (older-server) row falls back to its anchor.
    private static func earlierSceneRowsKey(_ transcriptMessage: TranscriptMessage) -> String {
        transcriptMessage.message.turnId.map { "turn:\($0)" } ?? transcriptMessage.anchorID
    }

    /// Pages a completed turn's omitted scene rows (the server sends only the tail) until the scene is complete.
    func loadEarlierSceneRows(for transcriptMessage: TranscriptMessage) async {
        guard let sessionID,
              let scene = transcriptMessage.message.activityScene,
              scene.activityRowsOffset > 0
        else { return }
        let key = Self.earlierSceneRowsKey(transcriptMessage)
        guard earlierSceneRows[key] == nil, loadingEarlierSceneRows.insert(key).inserted else { return }
        defer { loadingEarlierSceneRows.remove(key) }
        var rows: [AssistantActivitySceneRow] = []
        var before = scene.activityRowsOffset
        do {
            while before > 0 {
                let page = try await client.anchorSceneRows(
                    sessionID: sessionID,
                    messageRef: scene.activitySceneRef,
                    messageIndex: messagesOffset + transcriptMessage.loadedIndex,
                    before: before
                )
                guard page.start < before, !page.rows.isEmpty else { break }
                rows = page.rows + rows
                before = page.start
            }
            earlierSceneRows[key] = rows
        } catch {
            errorMessage = String(localized: "Could not load earlier steps.")
        }
    }

    /// Tool calls for the latest assistant turn, driving the in-chat "file changes" recap
    /// card and composer "N changes" capsule (#316). A turn often spans multiple assistant
    /// messages (tool calls on one, the final text on the next), and the archived tool group
    /// anchors to the *first* of them — so collect every completed group in the current turn
    /// (since the last user message) plus any still-live calls, not just one anchor.
    var latestTurnToolCalls: [ToolCall] {
        let turnAnchors = Set(
            TranscriptTurnClassifier.currentTurnAssistantAnchorIDs(in: messages, messageOffset: messagesOffset)
        )
        var calls = completedToolCallGroups
            .filter { group in group.anchorMessageID.map(turnAnchors.contains) ?? false }
            .flatMap(\.toolCalls)
        calls.append(contentsOf: liveToolCalls)
        return calls
    }

    private func recomputeDisplayedTranscriptMessages() {
#if DEBUG
        displayedTranscriptRecomputeCount += 1
#endif
        displayedTranscriptMessages = Self.transcriptMessages(
            from: messages,
            messageOffset: messagesOffset
        )
        recomputeCompressionReferenceCard()
    }
    /// Synthesized "Context compaction · Reference only" card resolved from the
    /// session's `compression_anchor_*` metadata; nil when the session has no
    /// compaction metadata or the reference text is gated out.
    private(set) var compressionReferenceCard: CompressionReferenceCard?
    @ObservationIgnored private var compressionAnchorMetadata: CompressionAnchorMetadata?
    private func applyCompressionAnchorMetadata(from session: SessionDetail?) {
        compressionAnchorMetadata = CompressionAnchorMetadata(from: session)
        recomputeCompressionReferenceCard()
    }
    /// Mirrors the list-row merge rule: the server's `read_only` replaces the
    /// seeded flag; a detail that omits it keeps it.
    private func applyReadOnlyState(from session: SessionDetail?) {
        if let readOnly = session?.readOnly { isSessionReadOnly = readOnly }
        if let canBranch = session?.canBranch { self.canBranch = canBranch }
    }
    private func clearCompressionAnchorMetadata() {
        compressionAnchorMetadata = nil
        compressionReferenceCard = nil
    }
    private func recomputeCompressionReferenceCard() {
        // Not folded into the messages/messagesOffset observers alone:
        // applyCompletedStreamSession can update the metadata without
        // reassigning messages, so metadata changes recompute here too. The
        // equality guard keeps the overlapping triggers observer-silent.
        let card = Self.compressionReferenceCard(
            messages: messages,
            messagesOffset: messagesOffset,
            transcriptMessages: displayedTranscriptMessages,
            metadata: compressionAnchorMetadata
        )
        guard compressionReferenceCard != card else { return }

        compressionReferenceCard = card
    }
    private(set) var liveAssistantActivity = AssistantActivityTimeline()
    var liveActivityRows: [AssistantActivityRow] { liveAssistantActivity.rows }
    var liveToolCalls: [ToolCall] { liveAssistantActivity.toolCalls }
    var liveReasoningText: String { liveAssistantActivity.reasoningText }
    private(set) var streamingAssistantMessageID: String?
    private(set) var toolCallAnchorMessageID: String?
    private(set) var reasoningAnchorMessageID: String?
    private(set) var messagesOffset = 0 {
        didSet { recomputeDisplayedTranscriptMessages() }
    }
    private(set) var hasOlderMessages = false
    private(set) var contextWindowSnapshot: ContextWindowSnapshot?
    private(set) var responseCompletionHapticTrigger = 0
    private(set) var responseCompletionNeedsTranscriptRefresh = false
    private(set) var modelCatalogGroups: [ModelCatalogGroup] = []
    private(set) var agentCommands: [AgentCommand] = []
    private(set) var workspaceRoots: [WorkspaceRoot] = []
    private(set) var workspaceSuggestions: [String] = []
    private(set) var personalitySuggestions: [String] = ["none"]
    private(set) var skillSlashSuggestions: [SkillSlashSuggestion] = []
    private(set) var profileOptions: [ProfileSummary] = []
    private(set) var isSingleProfileMode = false
    private(set) var selectedProfileName: String?
    private(set) var selectedReasoningEffort: String?
    /// Model-aware effort vocabulary (`supported_efforts` from `GET /api/reasoning`).
    /// `nil` on older servers → the composer falls back to the static list (issue #18).
    private(set) var supportedReasoningEfforts: [String]?
    /// `supports_reasoning_effort`; `false` hides the composer effort control.
    private(set) var supportsReasoningEffort: Bool?
    /// Drops out-of-order `GET /api/reasoning` responses after rapid model switches
    /// so the gating never reflects a stale model (upstream #3750 class of bug).
    private var reasoningGatingFetchToken = 0
    var showsReasoningEffortControl: Bool {
        ReasoningEffortOption.showsEffortControl(
            supportsReasoningEffort: supportsReasoningEffort,
            supportedEfforts: supportedReasoningEfforts
        )
    }
    private(set) var isLoadingComposerConfiguration = false
    private(set) var isUpdatingComposerConfiguration = false
    private(set) var composerConfigurationErrorMessage: String?
    var pendingAttachments: [PendingAttachment] { attachmentCoordinator.pendingAttachments }
    var isUploadingAttachment: Bool { attachmentCoordinator.isUploadingAttachment }
    var attachmentUploadCount: Int { attachmentCoordinator.uploadInFlightCount }
    var attachmentUploadGeneration: Int { attachmentCoordinator.uploadStartGeneration }
    var uploadAttachmentErrorMessage: String? { attachmentCoordinator.uploadAttachmentErrorMessage }
    var localAttachmentPreviews: [String: [String: Data]] { attachmentCoordinator.localAttachmentPreviews }
    private(set) var pinnedLocalNotices: [String] = []
    var approvalPrompt: ApprovalPromptState? { pendingActionCoordinator.approvalPrompt }
    var isRespondingToApproval: Bool { pendingActionCoordinator.isRespondingToApproval }
    var approvalErrorMessage: String? { pendingActionCoordinator.approvalErrorMessage }
    var isSessionApprovalBypassEnabled: Bool { pendingActionCoordinator.isSessionApprovalBypassEnabled }
    var clarificationPrompt: ClarificationPromptState? { pendingActionCoordinator.clarificationPrompt }
    var clarificationDraftResponse: String { pendingActionCoordinator.clarificationDraftResponse }
    var clarificationSelectedChoices: [String] { pendingActionCoordinator.clarificationSelectedChoices }

    func selectClarificationQuestion(_ index: Int, promptID: String) {
        pendingActionCoordinator.selectClarificationQuestion(index, promptID: promptID)
    }

    func toggleClarificationChoice(_ choice: String, promptID: String) {
        pendingActionCoordinator.toggleClarificationChoice(choice, promptID: promptID)
    }

    func setClarificationDraftResponse(_ text: String, promptID: String) {
        pendingActionCoordinator.setClarificationDraftResponse(text, promptID: promptID)
    }

    func submitClarificationDraft(promptID: String) async -> Bool {
        await pendingActionCoordinator.submitClarificationDraft(promptID: promptID)
    }

    var isRespondingToClarification: Bool { pendingActionCoordinator.isRespondingToClarification }
    var clarificationErrorMessage: String? { pendingActionCoordinator.clarificationErrorMessage }
    private(set) var currentGoal: SubmittedGoal?
    private(set) var isSubmittingGoal = false
    private(set) var goalErrorMessage: String?
    private(set) var hasActivatedGoalCommand = false

    private let sessionID: String?
    private var currentWorkspace: String?
    private var currentModel: String?
    private var currentModelProvider: String?
    private var currentProfile: String?
    private let isCLISession: Bool
    /// Server-owned view-only state (TAL-152). Seeded from the list row and
    /// refreshed from every applied `SessionDetail`, which is authoritative.
    private(set) var isSessionReadOnly: Bool
    /// The server's branch gate (TAL-312), seeded and refreshed like `isSessionReadOnly`;
    /// an older server that omits it allowed branching.
    private(set) var canBranch: Bool
    private let server: URL
    let client: APIClient
    private let streamCoordinator: ChatStreamCoordinator
    private let pendingActionCoordinator: ChatPendingActionCoordinator
    private let attachmentCoordinator: ChatAttachmentCoordinator
    private let btwStreamClient: SSEStreamingClient
    private let liveActivityManager: any AgentLiveActivityManaging
    private let speechSynthesizerFactory: () -> any ChatSpeechSynthesizing
    private let listenAudioSession: any ListenAudioSessionControlling
    private let listenRemoteControlCenter: any ListenRemoteControlControlling
    private let userDefaults: UserDefaults
    private let pollingIntervals: ChatPollingIntervals
    // Real-time window over which rapid streaming updates coalesce into a single
    // scroll trigger / first content flush. Injectable so tests can drive
    // coalescing deterministically; production keeps the 16ms default.
    private let streamingScrollCoalescingDelayNanoseconds: UInt64
    // Display pacing for streamed assistant text (issue #212): after the first
    // coalesced flush, buffered tokens are revealed word-by-word at this cadence,
    // with the per-tick quota scaling up so the display never trails the live
    // stream by more than the max lag. Pacing affects display timing only — the
    // buffer and final content are untouched. Injectable for tests.
    private let streamingWordRevealCadenceNanoseconds: UInt64
    private let streamingMaxRevealLagNanoseconds: UInt64
    private var speechSynthesizer: (any ChatSpeechSynthesizing)?
    private var speechDelegate: SpeechSynthesizerDelegate?
    // Identity of the utterance currently being spoken. A stale finish/cancel callback
    // from a superseded utterance (e.g. switching messages mid-playback) is ignored so
    // it can't clear the new listen state or deactivate the session. See #252.
    private var activeListeningUtteranceID: ObjectIdentifier?
    // Server-TTS playback seam (#15): the factory builds an audio player from the
    // server's synthesized bytes; injectable so tests never construct a real
    // `AVAudioPlayer` (which requires decodable audio data).
    private let serverTTSAudioPlayerFactory: @MainActor (Data) throws -> any ListenAudioPlaying
    private var listenAudioPlayer: (any ListenAudioPlaying)?
    // Identity of the server-TTS player currently playing. Mirrors
    // `activeListeningUtteranceID`: a stale finish callback from a superseded player
    // must not clear the new listen state or deactivate the session.
    private var activeListenPlayerID: ObjectIdentifier?
    // In-flight `POST /api/tts` fetch for the Listen action. Cancelled by
    // `stopListening()`; exposed (read-only) so tests can await the async
    // server-first path deterministically.
    @ObservationIgnored private(set) var listenPreparationTask: Task<Void, Never>?
    // Identity of the Listen request the in-flight fetch belongs to. A response
    // arriving after stop/switch carries a stale ID and is dropped instead of
    // starting audio the user no longer wants.
    private var activeListenRequestID: UUID?
    private var listenPlaybackTitle = String(localized: "Talaria response")
    private(set) var listenPlaybackPhase: ListenPlaybackPhase = .idle
    private(set) var listenPlaybackElapsedTime: TimeInterval = 0
    private(set) var listenPlaybackDuration: TimeInterval = 0
    private(set) var listenPlaybackScrubTime: TimeInterval?
    private(set) var listenPlaybackSpeed: ListenPlaybackSpeed
    @ObservationIgnored private var listenPlaybackTicker: Timer?
    private var showsLiveActivityResponseExcerpts: Bool
    private var hasCompletedCurrentResponse: Bool { streamCoordinator.hasCompletedCurrentResponse }
    private var isStreamConnectionSuspended: Bool { streamCoordinator.isConnectionSuspended }
    var isActiveStreamConnectionSuspended: Bool { streamCoordinator.isConnectionSuspended }
    /// One owned fetch per autocomplete catalog. Concurrent callers await the same
    /// task, so a cancelled composer `.task(id:)` neither cancels the request nor
    /// lets a later caller see an empty catalog as loaded. A finished handle is the
    /// cache; a failed load clears it so the next caller retries (TAL-160).
    @ObservationIgnored private var personalitySuggestionsLoad: Task<Void, Error>?
    @ObservationIgnored private var skillSlashSuggestionsLoad: Task<Void, Error>?
    private var queuedSlashMessages: [QueuedSlashMessage] = []
    private var isDrainingQueuedSlashMessage = false
    private var activeBtwStreamID: String?
    private var activeBtwMessageID: String?
    private var activeBtwQuestion: String?
    private var activeBtwAnswer = ""
    private var backgroundPromptsByTaskID: [String: String] = [:]
    @ObservationIgnored private var backgroundPollTask: Task<Void, Never>?
    private var isRefreshingCompletedResponseTitle = false
    // The latest applied load's `pending_started_at`: when its running turn began.
    private var loadedPendingStartedAt: Double?
    private var needsComposerConfigurationReload = false
    private var pendingExplicitModelPick = false
    private(set) var composerConfigurationInteractionGeneration = 0

    init(
        session: SessionSummary,
        server: URL,
        client: APIClient? = nil,
        streamClient: SSEStreamingClient? = nil,
        approvalStreamClient: SSEStreamingClient? = nil,
        clarifyStreamClient: SSEStreamingClient? = nil,
        btwStreamClient: SSEStreamingClient? = nil,
        liveActivityManager: (any AgentLiveActivityManaging)? = nil,
        showsLiveActivityResponseExcerpts: Bool = false,
        pollingIntervals: ChatPollingIntervals = .standard,
        streamingScrollCoalescingDelayNanoseconds: UInt64 = 16_000_000,
        streamingWordRevealCadenceNanoseconds: UInt64 = 48_000_000,
        streamingMaxRevealLagNanoseconds: UInt64 = 1_000_000_000,
        speechSynthesizerFactory: @escaping () -> any ChatSpeechSynthesizing = { AVSpeechSynthesizer() },
        listenAudioSession: (any ListenAudioSessionControlling)? = nil,
        listenRemoteControlCenter: (any ListenRemoteControlControlling)? = nil,
        serverTTSAudioPlayerFactory: (@MainActor (Data) throws -> any ListenAudioPlaying)? = nil,
        draftAttachmentStore: any ChatDraftAttachmentStoring = ChatDraftAttachmentStore.shared,
        userDefaults: UserDefaults = .standard
    ) {
        sessionID = session.sessionId
        currentWorkspace = session.workspace
        currentModel = session.model
        currentModelProvider = session.modelProvider
        currentProfile = session.profile
        isCLISession = session.isCliSession == true
        isSessionReadOnly = session.isSessionReadOnly
        canBranch = session.canBranch != false
        selectedRowIsStreaming = session.isStreaming
        selectedRowActiveStreamID = Self.nonEmpty(session.activeStreamId)
        self.server = server
        let resolvedClient = client ?? APIClient(baseURL: server)
        let resolvedStreamClient = streamClient ?? SSEClient()
        let resolvedLiveActivityManager = liveActivityManager ?? AgentLiveActivityManager.shared
        self.client = resolvedClient
        self.streamCoordinator = ChatStreamCoordinator(
            client: resolvedClient,
            streamClient: resolvedStreamClient,
            liveActivityManager: resolvedLiveActivityManager,
            showsLiveActivityResponseExcerpts: showsLiveActivityResponseExcerpts
        )
        self.pendingActionCoordinator = ChatPendingActionCoordinator(
            client: resolvedClient,
            approvalStreamClient: approvalStreamClient ?? SSEClient(),
            clarifyStreamClient: clarifyStreamClient ?? SSEClient(),
            pollingIntervals: pollingIntervals
        )
        self.attachmentCoordinator = ChatAttachmentCoordinator(
            client: resolvedClient,
            draftAttachmentStore: draftAttachmentStore
        )
        self.btwStreamClient = btwStreamClient ?? SSEClient()
        self.liveActivityManager = resolvedLiveActivityManager
        self.showsLiveActivityResponseExcerpts = showsLiveActivityResponseExcerpts
        self.pollingIntervals = pollingIntervals
        self.streamingScrollCoalescingDelayNanoseconds = streamingScrollCoalescingDelayNanoseconds
        self.streamingWordRevealCadenceNanoseconds = streamingWordRevealCadenceNanoseconds
        self.streamingMaxRevealLagNanoseconds = streamingMaxRevealLagNanoseconds
        self.speechSynthesizerFactory = speechSynthesizerFactory
        self.listenAudioSession = listenAudioSession ?? ListenAudioSessionController()
        self.listenRemoteControlCenter = listenRemoteControlCenter ?? ListenRemoteControlController()
        self.userDefaults = userDefaults
        self.listenPlaybackSpeed = ListenPlaybackSpeed.stored(in: userDefaults)
        self.serverTTSAudioPlayerFactory = serverTTSAudioPlayerFactory
            ?? { try ServerTTSAudioPlayer(data: $0) }
        displayTitle = Self.displayTitle(from: session.title)
        self.streamCoordinator.attach(delegate: self)
        self.pendingActionCoordinator.delegate = self
        self.attachmentCoordinator.delegate = self
    }

    deinit {
        backgroundPollTask?.cancel()
        pendingStreamingScrollTriggerTask?.cancel()
        pendingStreamingContentFlushTask?.cancel()
        listenPreparationTask?.cancel()
        listenPlaybackTicker?.invalidate()
    }

    func setShowsLiveActivityResponseExcerpts(_ shows: Bool) {
        guard showsLiveActivityResponseExcerpts != shows else { return }

        showsLiveActivityResponseExcerpts = shows
        streamCoordinator.setShowsLiveActivityResponseExcerpts(shows)
    }

    var showsListenPlaybackBar: Bool {
        listenPlaybackPhase != .idle
    }

    var listenPlaybackDisplayTime: TimeInterval {
        listenPlaybackScrubTime ?? listenPlaybackElapsedTime
    }

    nonisolated static func resetActiveStreamSnapshotsForTesting() {
        ActiveChatStreamSnapshotStore.shared.removeAll()
    }

    // Test seam: deterministically await the in-flight coalesced scroll-trigger task
    // so streaming assertions never depend on the real coalescing window elapsing.
    // No-op when no trigger is pending.
    func awaitPendingStreamingScrollTriggerForTesting() async {
        await pendingStreamingScrollTriggerTask?.value
    }

    private struct ActiveStreamMessageMerge {
        let messages: [ChatMessage]
        let streamingAssistantMessageID: String?
        let usedSnapshotMessagesOffset: Bool
    }

    var selectedModelID: String? {
        currentModel
    }

    var selectedModelProviderID: String? {
        currentModelProvider
    }

    var selectedWorkspacePath: String? {
        currentWorkspace
    }

    var selectedProfileTitle: String {
        let profileName = selectedProfileName ?? currentProfile
        guard let profileName, !profileName.isEmpty else {
            return String(localized: "Profile")
        }

        if let option = profileOptions.first(where: { $0.name == profileName }) {
            return option.displayName
        }

        return profileName == "default" ? String(localized: "Default") : profileName
    }

    var selectedModelTitle: String {
        guard let currentModel, !currentModel.isEmpty else {
            return String(localized: "Model")
        }

        let catalogName = modelCatalogGroups
            .flatMap(\.models)
            .firstMatchingSelection(modelID: currentModel, providerID: currentModelProvider)?
            .displayName

        return catalogName ?? Self.compactModelTitle(currentModel)
    }

    func isSelectedProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }
        return profileName == (Self.nonEmpty(selectedProfileName) ?? Self.nonEmpty(currentProfile))
    }

    var hasStreamingAssistantMessageContent: Bool {
        guard let streamingAssistantMessageID,
              let message = messages.first(where: { $0.messageId == streamingAssistantMessageID })
        else { return false }

        return message.content?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private func scheduleStreamingScrollTrigger() {
        guard pendingStreamingScrollTriggerTask == nil else { return }

        let expectedSessionID = sessionID
        let delay = streamingScrollCoalescingDelayNanoseconds
        pendingStreamingScrollTriggerTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self else { return }

            self.pendingStreamingScrollTriggerTask = nil
            guard !Task.isCancelled, self.sessionID == expectedSessionID else { return }

            self.streamingScrollTrigger += 1
        }
    }

    private func cancelPendingStreamingScrollTrigger() {
        pendingStreamingScrollTriggerTask?.cancel()
        pendingStreamingScrollTriggerTask = nil
    }

    private func scheduleStreamingContentFlush(afterNanoseconds delay: UInt64? = nil) {
        guard pendingStreamingContentFlushTask == nil else { return }

        let expectedSessionID = sessionID
        let resolvedDelay = delay ?? streamingScrollCoalescingDelayNanoseconds
        pendingStreamingContentFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: resolvedDelay)
            guard let self else { return }

            self.pendingStreamingContentFlushTask = nil
            guard !Task.isCancelled, self.sessionID == expectedSessionID else { return }

            self.drainStreamingContentTick()
        }
    }

    /// One paced flush tick: drains a word-cadence quota of buffered assistant
    /// text (reasoning still flushes whole — pacing applies to assistant content
    /// only) and reschedules itself at the word cadence while a backlog remains.
    /// Completion paths (done/cancel/error/interim/snapshot) bypass pacing via
    /// `flushPendingStreamingContent()`, which cancels any scheduled tick.
    private func drainStreamingContentTick() {
        var didMutate = false
        let quota = StreamingWordDrain.drainQuota(
            backlogUnitCount: StreamingWordDrain.unitCount(in: pendingAssistantTokenText),
            cadenceNanoseconds: streamingWordRevealCadenceNanoseconds,
            maxLagNanoseconds: streamingMaxRevealLagNanoseconds
        )
        if flushAssistantTokens(maxWordUnits: quota) {
            didMutate = true
        }
        if flushReasoningChunks() {
            didMutate = true
        }

        if didMutate {
            scheduleStreamingScrollTrigger()
        }

        if !pendingAssistantTokenText.isEmpty {
            scheduleStreamingContentFlush(afterNanoseconds: streamingWordRevealCadenceNanoseconds)
        }
    }

    private func cancelPendingStreamingContentFlush() {
        pendingStreamingContentFlushTask?.cancel()
        pendingStreamingContentFlushTask = nil
    }

    private func resetPendingStreamingContentBuffers() {
        cancelPendingStreamingContentFlush()
        pendingAssistantTokenText = ""
        pendingReasoningText = ""
        pendingReasoningTitles = []
    }

    func flushPendingStreamingContent() {
        cancelPendingStreamingContentFlush()

        var didMutate = false
        if flushAssistantTokens() {
            didMutate = true
        }
        if flushReasoningChunks() {
            didMutate = true
        }

        if didMutate {
            scheduleStreamingScrollTrigger()
        }
    }

    private var requestProfileName: String? {
        Self.nonEmpty(selectedProfileName) ?? Self.nonEmpty(currentProfile)
    }

    private var requestModelProvider: String? {
        Self.nonEmpty(currentModelProvider)
    }

    private func explicitModelPickForChatStart() -> Bool {
        pendingExplicitModelPick && Self.nonEmpty(currentModel) != nil
    }

    private func completeExplicitModelPickForChatStart(_ explicitModelPick: Bool) {
        if explicitModelPick {
            pendingExplicitModelPick = false
        }
    }

    func loadComposerConfiguration() async {
        if isLoadingComposerConfiguration {
            needsComposerConfigurationReload = true
            return
        }

        isLoadingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        lastError = nil
        defer { isLoadingComposerConfiguration = false }

        repeat {
            needsComposerConfigurationReload = false

            let initialState = composerConfigurationState
            let result = await ChatComposerConfigLoader(client: client)
                .loadConfiguration(from: initialState)

            guard composerConfigurationState == initialState else {
                needsComposerConfigurationReload = true
                continue
            }

            applyComposerConfigurationState(result.state)

            if let error = result.configurationError {
                lastError = error
                composerConfigurationErrorMessage = error.localizedDescription
            }
        } while needsComposerConfigurationReload
    }

    /// Refreshes the model catalog when a picker opens: refetch `/api/models`
    /// (so the sheet stops pinning the chat-load-time snapshot), then overlay
    /// the active provider's live list from `/api/models/live`. Failures are
    /// silent by design — the picker keeps whatever it already shows.
    func refreshModelCatalogForPickerOpen() async {
        if let response = try? await client.models() {
            let groups = response.catalogGroups
            if !groups.isEmpty {
                modelCatalogGroups = groups
            }
        }

        if let live = try? await client.modelsLive() {
            modelCatalogGroups = modelCatalogGroups.mergingLiveModels(from: live)
        }
    }

    private var composerConfigurationState: ChatComposerConfigState {
        ChatComposerConfigState(
            currentWorkspace: currentWorkspace,
            currentModel: currentModel,
            currentModelProvider: currentModelProvider,
            currentProfile: currentProfile,
            selectedProfileName: selectedProfileName,
            selectedReasoningEffort: selectedReasoningEffort,
            supportedReasoningEfforts: supportedReasoningEfforts,
            supportsReasoningEffort: supportsReasoningEffort,
            modelCatalogGroups: modelCatalogGroups,
            agentCommands: agentCommands,
            workspaceRoots: workspaceRoots,
            workspaceSuggestions: workspaceSuggestions,
            profileOptions: profileOptions,
            isSingleProfileMode: isSingleProfileMode
        )
    }

    private func applyComposerConfigurationState(_ state: ChatComposerConfigState) {
        currentWorkspace = state.currentWorkspace
        currentModel = state.currentModel
        currentModelProvider = state.currentModelProvider
        currentProfile = state.currentProfile
        selectedProfileName = state.selectedProfileName
        selectedReasoningEffort = state.selectedReasoningEffort
        supportedReasoningEfforts = state.supportedReasoningEfforts
        supportsReasoningEffort = state.supportsReasoningEffort
        modelCatalogGroups = state.modelCatalogGroups
        agentCommands = state.agentCommands
        workspaceRoots = state.workspaceRoots
        workspaceSuggestions = state.workspaceSuggestions
        profileOptions = state.profileOptions
        isSingleProfileMode = state.isSingleProfileMode
    }

    func refreshApprovalBypassState() async {
        await pendingActionCoordinator.refreshApprovalBypassState()
    }

    @discardableResult
    func selectComposerModel(
        _ option: ModelCatalogOption,
        recordsInteraction: Bool = true
    ) async -> Bool {
        if recordsInteraction {
            composerConfigurationInteractionGeneration &+= 1
        }
        guard !option.matchesSelection(modelID: currentModel, providerID: currentModelProvider) else {
            return false
        }

        guard !isViewingCachedData else {
            composerConfigurationErrorMessage = String(localized: "Reconnect to the server to change models.")
            return false
        }

        guard activeStreamID == nil else {
            composerConfigurationErrorMessage = String(localized: "Wait for the current response to finish before changing models.")
            return false
        }

        guard let sessionID else {
            composerConfigurationErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.updateSession(
                id: sessionID,
                workspace: currentWorkspace,
                model: option.id,
                modelProvider: option.providerID
            )

            currentModel = response.session?.model ?? option.id
            currentModelProvider = response.session?.modelProvider ?? option.providerID
            currentWorkspace = response.session?.workspace ?? currentWorkspace
            pendingExplicitModelPick = true
            // Still inside the isUpdatingComposerConfiguration window, so the
            // effort menu stays disabled until the new model's gating lands —
            // no interactable flash of the previous model's options (issue #18).
            await refreshReasoningEffortGating()
            return true
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Re-queries `GET /api/reasoning` for the current model/provider and updates
    /// the effort gating (issue #18). Failures are silent to the user, but reset
    /// the gating to the "unknown" fallback (static effort list, control shown) —
    /// keeping the previous model's gating after a successful model switch could
    /// hide the control for a model that supports it, or offer efforts the new
    /// model rejects. If the selected effort is no longer supported, snaps to the
    /// server's coerced `reasoning_effort`.
    func refreshReasoningEffortGating() async {
        guard !isViewingCachedData else { return }

        reasoningGatingFetchToken += 1
        let token = reasoningGatingFetchToken

        guard let response = try? await client.reasoning(
            model: Self.nonEmpty(currentModel),
            provider: Self.nonEmpty(currentModelProvider)
        ) else {
            if token == reasoningGatingFetchToken {
                supportedReasoningEfforts = nil
                supportsReasoningEffort = nil
            }
            return
        }

        guard token == reasoningGatingFetchToken else { return }

        supportedReasoningEfforts = response.normalizedSupportedEfforts
        supportsReasoningEffort = response.supportsReasoningEffort

        if let selected = Self.nonEmpty(selectedReasoningEffort)?.lowercased(),
           let supported = supportedReasoningEfforts,
           !supported.contains(selected),
           let serverEffort = Self.nonEmpty(response.effectiveEffort) {
            selectedReasoningEffort = serverEffort
        }
    }

    /// Refetches the workspace registry after the manager sheet mutated it
    /// (issue #22), so the picker reflects adds/removes/renames/reorders.
    func refreshWorkspaceRoots() async {
        guard !isViewingCachedData else { return }

        do {
            let response = try await client.workspaces()
            workspaceRoots = response.workspaces ?? []
            workspaceSuggestions = workspaceRoots.compactMap(\.path)
        } catch {
            lastError = error
        }
    }

    func loadWorkspaceSuggestions(prefix: String) async {
        guard !isViewingCachedData else {
            workspaceSuggestions = workspaceRoots.compactMap(\.path)
            return
        }

        do {
            let response = try await client.workspaceSuggestions(prefix: prefix)
            workspaceSuggestions = response.suggestions ?? []
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
        }
    }

    func loadPersonalitySuggestions() async {
        let load = personalitySuggestionsLoad ?? Task {
            do {
                personalitySuggestions = (try await client.personalities()).slashAutocompleteNames
            } catch {
                personalitySuggestionsLoad = nil
                lastError = error
                composerConfigurationErrorMessage = error.localizedDescription
                if personalitySuggestions.isEmpty {
                    personalitySuggestions = ["none"]
                }
                throw error
            }
        }
        personalitySuggestionsLoad = load
        _ = try? await load.value
    }

    func loadSkillSlashSuggestions() async {
        _ = try? await skillSlashSuggestionsLoadTask().value
    }

    private func skillSlashSuggestionsLoadTask() -> Task<Void, Error> {
        let load = skillSlashSuggestionsLoad ?? Task {
            do {
                let response = try await client.skills()
                skillSlashSuggestions = SlashSkillFormatter.suggestions(from: response.skills ?? [])
            } catch {
                skillSlashSuggestionsLoad = nil
                lastError = error
                throw error
            }
        }
        skillSlashSuggestionsLoad = load
        return load
    }

    @discardableResult
    func selectWorkspacePath(
        _ path: String,
        recordsInteraction: Bool = true
    ) async -> Bool {
        if recordsInteraction {
            composerConfigurationInteractionGeneration &+= 1
        }
        let workspace = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workspace.isEmpty else { return false }

        guard workspace != currentWorkspace else {
            return false
        }

        guard !isViewingCachedData else {
            composerConfigurationErrorMessage = String(localized: "Reconnect to the server to change workspace.")
            return false
        }

        guard activeStreamID == nil else {
            composerConfigurationErrorMessage = String(localized: "Wait for the current response to finish before changing workspace.")
            return false
        }

        guard let sessionID else {
            composerConfigurationErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        let previousWorkspace = currentWorkspace
        currentWorkspace = workspace
        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.updateSession(
                id: sessionID,
                workspace: workspace,
                model: currentModel,
                modelProvider: currentModelProvider
            )

            currentWorkspace = response.session?.workspace ?? workspace
            currentModel = response.session?.model ?? currentModel
            currentModelProvider = response.session?.modelProvider ?? currentModelProvider
            return true
        } catch {
            currentWorkspace = previousWorkspace
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return false
        }
    }

    func switchProfile(
        _ profile: ProfileSummary,
        startNewSession: Bool,
        recordsInteraction: Bool = true
    ) async -> ProfileSwitchOutcome? {
        if recordsInteraction {
            composerConfigurationInteractionGeneration &+= 1
        }
        guard !isViewingCachedData else {
            composerConfigurationErrorMessage = String(localized: "Reconnect to the server to change profiles.")
            return nil
        }

        guard activeStreamID == nil else {
            composerConfigurationErrorMessage = String(localized: "Wait for the current response to finish before changing profiles.")
            return nil
        }

        guard let profileName = profile.normalizedName else {
            composerConfigurationErrorMessage = String(localized: "The server did not provide a profile name.")
            return nil
        }

        if !startNewSession, isSelectedProfile(profile) {
            return nil
        }

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.switchProfile(name: profileName)
            profileOptions = response.profiles ?? profileOptions
            selectedProfileName = response.active ?? profileName
            currentProfile = selectedProfileName

            if let defaultWorkspace = response.defaultWorkspace, !defaultWorkspace.isEmpty {
                currentWorkspace = defaultWorkspace
            }

            if let defaultModel = response.defaultModel, !defaultModel.isEmpty {
                currentModel = defaultModel
                currentModelProvider = Self.nonEmpty(profile.provider)
            }
            pendingExplicitModelPick = false

            await loadComposerConfiguration()

            guard startNewSession else {
                return ProfileSwitchOutcome(session: nil)
            }

            let newSessionResponse = try await client.createSession(
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName
            )

            guard let session = newSessionResponse.session else {
                composerConfigurationErrorMessage = String(localized: "The server did not return the new profile session.")
                return nil
            }

            return ProfileSwitchOutcome(session: SessionSummary(from: session))
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func selectReasoningEffort(
        _ effort: String,
        recordsInteraction: Bool = true
    ) async -> Bool {
        if recordsInteraction {
            composerConfigurationInteractionGeneration &+= 1
        }
        let selectedEffort = effort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !selectedEffort.isEmpty else { return false }

        guard selectedEffort != selectedReasoningEffort else {
            return false
        }

        guard !isViewingCachedData else {
            composerConfigurationErrorMessage = String(localized: "Reconnect to the server to change reasoning.")
            return false
        }

        guard activeStreamID == nil else {
            composerConfigurationErrorMessage = String(localized: "Wait for the current response to finish before changing reasoning.")
            return false
        }

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.saveReasoningEffort(selectedEffort)
            selectedReasoningEffort = response.effectiveEffort ?? selectedEffort
            return true
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return false
        }
    }

    /// Restores one new-chat settings snapshot only while the configuration
    /// remains untouched. Profile owns the defaults for the remaining fields,
    /// so a missing or rejected profile stops the whole replay rather than
    /// projecting its model/workspace/reasoning choices onto another profile.
    func restoreDraftSettings(
        _ rawSettings: ChatDraftSettings,
        expectedInteractionGeneration: Int
    ) async {
        guard canContinueDraftSettingsRestore(expectedInteractionGeneration) else { return }
        guard messages.isEmpty, activeStreamID == nil else { return }
        let settings = rawSettings.normalized()

        if let profileName = settings.profileName {
            guard let option = profileOptions.first(where: { $0.normalizedName == profileName }) else {
                return
            }
            if !isSelectedProfile(option) {
                let outcome = await switchProfile(
                    option,
                    startNewSession: false,
                    recordsInteraction: false
                )
                guard outcome != nil,
                      canContinueDraftSettingsRestore(expectedInteractionGeneration),
                      isSelectedProfile(option) else {
                    return
                }
            }
        }

        guard canContinueDraftSettingsRestore(expectedInteractionGeneration) else { return }
        if let modelID = settings.modelID,
           let option = modelCatalogGroups
               .flatMap(\.slashAutocompleteModels)
               .firstMatchingSelection(modelID: modelID, providerID: settings.modelProviderID),
           !option.matchesSelection(modelID: currentModel, providerID: currentModelProvider) {
            _ = await selectComposerModel(option, recordsInteraction: false)
            guard canContinueDraftSettingsRestore(expectedInteractionGeneration) else { return }
        }

        if let workspace = settings.workspacePath,
           workspace != currentWorkspace,
           workspaceRoots.contains(where: { $0.path == workspace }) {
            _ = await selectWorkspacePath(workspace, recordsInteraction: false)
            guard canContinueDraftSettingsRestore(expectedInteractionGeneration) else { return }
        }

        if let effort = settings.reasoningEffort,
           effort != selectedReasoningEffort,
           showsReasoningEffortControl {
            let supportedEfforts = supportedReasoningEfforts
            if supportedEfforts == nil || supportedEfforts?.contains(effort.lowercased()) == true {
                _ = await selectReasoningEffort(effort, recordsInteraction: false)
            }
        }
    }

    func markComposerConfigurationInteraction() {
        composerConfigurationInteractionGeneration &+= 1
    }

    private func canContinueDraftSettingsRestore(_ expectedInteractionGeneration: Int) -> Bool {
        !Task.isCancelled
            && composerConfigurationInteractionGeneration == expectedInteractionGeneration
    }

    /// Saves and uploads a freshly staged file into the pending strip. Returns
    /// nil unless both the durable draft copy and server upload succeed.
    @discardableResult
    func uploadAttachment(data: Data, filename: String, previewData: Data? = nil) async -> PendingAttachment? {
        await attachmentCoordinator.uploadAttachment(
            data: data,
            filename: filename,
            previewData: previewData
        )
    }

    /// Re-uploads a restored draft attachment from its durable local copy,
    /// preserving the draft record's identity. Quiet on failure (returns nil):
    /// the caller reports in aggregate and keeps the record for a later retry.
    @discardableResult
    func reuploadDraftAttachment(_ draftAttachment: ChatDraftAttachment, data: Data) async -> PendingAttachment? {
        await attachmentCoordinator.reuploadDraftAttachment(data: data, draftAttachment: draftAttachment)
    }

    func clearPendingAttachments() {
        attachmentCoordinator.clearPendingAttachments()
    }

    func removePendingAttachment(id: UUID) {
        attachmentCoordinator.removePendingAttachment(id: id)
    }

    func setUploadAttachmentError(_ message: String?) {
        attachmentCoordinator.setUploadAttachmentError(message)
    }

    func attachmentImageData(path: String) async -> Data? {
        await attachmentCoordinator.attachmentImageData(path: path)
    }

    func attachmentRawData(path: String) async -> Data? {
        await attachmentCoordinator.attachmentRawData(path: path)
    }

    func transcriptMediaThumbnailData(for reference: TranscriptMediaReference) async -> Data? {
        await attachmentCoordinator.transcriptMediaThumbnailData(for: reference)
    }

    func transcriptMediaData(for reference: TranscriptMediaReference) async -> Data? {
        await attachmentCoordinator.transcriptMediaData(for: reference)
    }

    func loadMessages(
        modelContext: ModelContext? = nil,
        waitsForPendingMessageSend: Bool = true
    ) async {
        guard let sessionID else {
            errorMessage = String(localized: "The server did not provide a session ID.")
            return
        }

        resetPendingStreamingContentBuffers()
        let streamLoadPreparation = streamCoordinator.prepareForSessionLoad()
        sessionLoadRequestGeneration &+= 1
        let loadRequestGeneration = sessionLoadRequestGeneration
        activeSessionLoadRequestGenerations.insert(loadRequestGeneration)
        isLoading = true
        errorMessage = nil
        cacheErrorMessage = nil
        lastError = nil
        defer {
            isLoading = false
            finishSessionLoadRequest(loadRequestGeneration)
        }

        // Cache-first render (#289): capture the pre-reload window *before* painting
        // any cached transcript, so the network reconcile below replaces it cleanly
        // (no merge, no duplication). Then, on a cold open with a populated cache,
        // render the cached messages immediately so the loading skeleton never shows.
        let previousMessages = messages
        let previousMessagesOffset = messagesOffset
        let usesPrimedInitialCache = hasPrimedInitialCachedMessages && !previousMessages.isEmpty
        hasPrimedInitialCachedMessages = false
        let cacheFirstPlaceholder: [ChatMessage]
        if previousMessages.isEmpty, let modelContext {
            cacheFirstPlaceholder = renderCachedMessagesBeforeReload(
                sessionID: sessionID,
                modelContext: modelContext
            )
        } else if usesPrimedInitialCache {
            cacheFirstPlaceholder = previousMessages
        } else {
            cacheFirstPlaceholder = []
        }
        let renderedCacheFirst = !cacheFirstPlaceholder.isEmpty

        do {
            let response = try await client.session(
                id: sessionID,
                includeMessages: true,
                messageLimit: Self.messagePageLimit,
                // Cold load only: widen the window to renderable-dense (upstream #3790) so a
                // tool-heavy session opens populated. "Load earlier" keeps the raw cap.
                expandRenderable: true
            )
            let session = response.session
            let loadedMessages = session?.messages ?? []
            let loadedActiveStreamID = session?.activeStreamId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let reloadedMessages: [ChatMessage]
            if let modelContext {
                do {
                    let cachedMessages = try CacheStore.cachedMessages(
                        serverURL: server,
                        sessionID: sessionID,
                        in: modelContext,
                        limit: Self.messagePageLimit
                    )
                    reloadedMessages = Self.mergingLoadedMessages(
                        loadedMessages,
                        withCachedLocalOptimisticMessages: cachedMessages
                    )
                } catch {
                    cacheErrorMessage = error.localizedDescription
                    reloadedMessages = loadedMessages
                }
            } else if let activeStreamIDBeforeLoad = streamLoadPreparation.activeStreamIDBeforeLoad,
                      loadedActiveStreamID == activeStreamIDBeforeLoad {
                // No persistence context, so the cache merge above cannot run and an
                // optimistic prompt the server has not persisted yet would vanish.
                // The same run is still authoritative, so carry it across the reload.
                // Without a cache there is nothing to tell a fresh prompt from an old
                // identical one, so any equivalent user message counts as confirmation:
                // dropping a duplicate is what this path already did, showing one twice
                // is not. A different (or finished) run owns the transcript, so its
                // rows win instead.
                reloadedMessages = Self.insertingUnconfirmedLocalUserMessages(
                    from: previousMessages,
                    into: loadedMessages,
                    requiresRecentTimestamp: false
                )
            } else {
                reloadedMessages = loadedMessages
            }
            let canMergePendingMessageSend = waitsForPendingMessageSend
                && isStartingMessageSend
                && streamCoordinator.canApplySessionLoad(streamLoadPreparation)
            if waitsForPendingMessageSend {
                await waitForMessageSendToFinish()
            }
            await waitForNewerSessionLoadRequests(after: loadRequestGeneration)
            guard loadRequestGeneration > latestAppliedSessionLoadRequestGeneration else { return }
            if canMergePendingMessageSend,
               !streamCoordinator.canApplySessionLoad(streamLoadPreparation) {
                guard let currentActiveStreamID = activeStreamID else { return }
                saveActiveStreamSnapshotIfNeeded()
                let currentMessages = messages
                let currentMessagesOffset = messagesOffset
                let loadStartMessageIDs = Set(previousMessages.compactMap(\.messageId))
                var mergedMessages = Self.mergingLoadedMessages(
                    reloadedMessages,
                    withCachedLocalOptimisticMessages: currentMessages
                )
                for message in currentMessages where Self.isLocalOptimisticUserMessage(message) {
                    guard let messageID = message.messageId,
                          !loadStartMessageIDs.contains(messageID),
                          !mergedMessages.contains(where: { $0.messageId == messageID })
                    else { continue }
                    Self.insertLocalOptimisticMessage(message, into: &mergedMessages)
                }
                applyReadOnlyState(from: session)
                applyReloadedMessages(
                    mergedMessages,
                    from: session,
                    previousMessages: currentMessages,
                    previousMessagesOffset: currentMessagesOffset
                )
                restoreActiveStreamSnapshotIfAvailable(streamID: currentActiveStreamID)
                isViewingCachedData = false
                lastError = nil
                errorMessage = nil
                cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
                if renderedCacheFirst {
                    cacheFirstReconcileScrollToken += 1
                }
                latestAppliedSessionLoadRequestGeneration = loadRequestGeneration
                isConfirmingRunState = false
                return
            }
            guard streamCoordinator.canApplySessionLoad(streamLoadPreparation) else { return }
            // After load arbitration only: a superseded response must not leave its
            // read-only flag behind once its transcript has been rejected.
            applyReadOnlyState(from: session)
            applyCompressionAnchorMetadata(from: session)
            applyReloadedMessages(
                reloadedMessages,
                from: session,
                previousMessages: previousMessages,
                previousMessagesOffset: previousMessagesOffset
            )
            if renderedCacheFirst {
                // The taller server transcript has now replaced the lighter cache-first
                // render; signal the view to re-pin to the bottom without a visible jump.
                cacheFirstReconcileScrollToken += 1
            }
            responseCompletionNeedsTranscriptRefresh = false
            isViewingCachedData = false
            lastError = nil
            errorMessage = nil
            contextWindowSnapshot = ContextWindowSnapshot(
                contextLength: session?.contextLength,
                thresholdTokens: session?.thresholdTokens,
                lastPromptTokens: session?.lastPromptTokens,
                inputTokens: session?.inputTokens,
                outputTokens: session?.outputTokens,
                estimatedCost: session?.estimatedCost
            )
            if let modelContext {
                do {
                    try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }
            if let title = session?.title {
                displayTitle = Self.displayTitle(from: title)
            }
            setCompletedToolCallGroups(ToolCallGroup.groups(
                persistedToolCalls: session?.toolCalls ?? [],
                messages: messages,
                messageOffset: messagesOffset
            ))
            completedReasoningGroups = []
            liveAssistantActivity.removeAll()
            pinnedLocalNotices = []
            toolCallAnchorMessageID = nil
            reasoningAnchorMessageID = nil
            attachmentCoordinator.removeAllLocalPreviews()
            loadedPendingStartedAt = session?.pendingStartedAt
            streamCoordinator.reconcileSessionLoad(
                loadedActiveStreamID: loadedActiveStreamID,
                preparation: streamLoadPreparation,
                usedCacheFallback: false,
                runStartedAt: Self.activeRunStartDate(pendingStartedAt: session?.pendingStartedAt, messages: messages),
                transcriptSeq: session?.transcriptSeq,
                statesTranscriptSeq: session?.statesTranscriptSeq ?? true
            )
            latestAppliedSessionLoadRequestGeneration = loadRequestGeneration
            isConfirmingRunState = false
        } catch {
            if waitsForPendingMessageSend {
                await waitForMessageSendToFinish()
            }
            await waitForNewerSessionLoadRequests(after: loadRequestGeneration)
            guard loadRequestGeneration > latestAppliedSessionLoadRequestGeneration else { return }
            guard loadRequestGeneration > latestHandledSessionLoadFailureGeneration else { return }
            guard streamCoordinator.canApplySessionLoad(streamLoadPreparation) else { return }
            lastError = error
            if CacheFallbackPolicy.shouldUseCache(for: error), let modelContext {
                do {
                    let cachedMessages = try CacheStore.cachedMessages(
                        serverURL: server,
                        sessionID: sessionID,
                        in: modelContext,
                        limit: Self.messagePageLimit
                    )
                    if !cachedMessages.isEmpty {
                        clearCompressionAnchorMetadata()
                        messages = cachedMessages
                        responseCompletionNeedsTranscriptRefresh = false
                        messagesOffset = 0
                        hasOlderMessages = false
                        isViewingCachedData = true
                        contextWindowSnapshot = nil
                        errorMessage = nil
                        setCompletedToolCallGroups([])
                        completedReasoningGroups = []
                        liveAssistantActivity.removeAll()
                        pinnedLocalNotices = []
                        toolCallAnchorMessageID = nil
                        reasoningAnchorMessageID = nil
                        streamingAssistantMessageID = nil
                        attachmentCoordinator.removeAllLocalPreviews()
                        streamCoordinator.reconcileSessionLoad(
                            loadedActiveStreamID: nil,
                            preparation: streamLoadPreparation,
                            usedCacheFallback: true
                        )
                    } else {
                        if renderedCacheFirst {
                            revertCacheFirstPlaceholder(
                                cacheFirstPlaceholder,
                                to: previousMessages,
                                previousMessagesOffset: previousMessagesOffset
                            )
                        }
                        isViewingCachedData = false
                        errorMessage = error.localizedDescription
                    }
                } catch {
                    if renderedCacheFirst {
                        revertCacheFirstPlaceholder(
                            cacheFirstPlaceholder,
                            to: previousMessages,
                            previousMessagesOffset: previousMessagesOffset
                        )
                    }
                    cacheErrorMessage = error.localizedDescription
                    isViewingCachedData = false
                    errorMessage = lastError?.localizedDescription
                }
            } else {
                if renderedCacheFirst {
                    revertCacheFirstPlaceholder(
                        cacheFirstPlaceholder,
                        to: previousMessages,
                        previousMessagesOffset: previousMessagesOffset
                    )
                }
                isViewingCachedData = false
                errorMessage = error.localizedDescription
            }
            latestHandledSessionLoadFailureGeneration = loadRequestGeneration
            isConfirmingRunState = false
        }
    }

    /// Performs only the fast, local portion of an existing session's first
    /// load. The network reconcile is intentionally started by `ChatView` after
    /// its navigation appearance completes so rendering a richer transcript
    /// cannot stall the system push animation.
    func prepareInitialMessageLoad(modelContext: ModelContext) {
        guard let sessionID else { return }

        isLoading = true
        if sessionLoadRequestGeneration == 0 {
            isConfirmingRunState = selectedRowIsStreaming != false
        }
        guard messages.isEmpty else { return }

        // A run this process already streamed keeps its live snapshot, which is newer
        // than the cache, so it paints first. The session load then keeps it (same
        // run) or replaces it (finished or replaced run).
        if selectedRowIsStreaming != false, let selectedRowActiveStreamID {
            restoreActiveStreamSnapshotIfAvailable(streamID: selectedRowActiveStreamID)
        }
        if messages.isEmpty {
            _ = renderCachedMessagesBeforeReload(sessionID: sessionID, modelContext: modelContext)
        }
        hasPrimedInitialCachedMessages = !messages.isEmpty
    }

    /// Cache-first render (#289): on a cold session open, paint the cached transcript
    /// immediately so the loading skeleton never appears, then let the in-flight
    /// `loadMessages` network reload reconcile silently in place. Keeps
    /// `isViewingCachedData` off because this is the success-expected window, not an
    /// offline failure — the offline indicator stays tied to a real network error.
    /// Returns the cached messages it rendered (empty if nothing was cached), so the
    /// caller can revert the placeholder if the reload surfaces an error instead of
    /// content — but only while the transcript is still that exact placeholder.
    private func renderCachedMessagesBeforeReload(
        sessionID: String,
        modelContext: ModelContext
    ) -> [ChatMessage] {
        let cachedMessages: [ChatMessage]
        do {
            cachedMessages = try CacheStore.cachedMessages(
                serverURL: server,
                sessionID: sessionID,
                in: modelContext,
                limit: Self.messagePageLimit
            )
        } catch {
            // A cache read failure must not block the normal network load; fall back
            // to the existing skeleton-until-network behavior.
            return []
        }

        guard !cachedMessages.isEmpty else { return [] }

        messages = cachedMessages
        messagesOffset = 0
        hasOlderMessages = false
        isViewingCachedData = false
        return cachedMessages
    }

    /// Undo a cache-first placeholder (#289) when the reload fails without adopting
    /// the offline cache, so the existing error UI (empty transcript + message) shows
    /// instead of a stale cached transcript masquerading as live.
    private func revertCacheFirstPlaceholder(
        _ placeholder: [ChatMessage],
        to previousMessages: [ChatMessage],
        previousMessagesOffset: Int
    ) {
        // Only undo the cache-first paint if nothing mutated the transcript since the
        // prime (e.g. an optimistic send during the load window) — otherwise we'd wipe
        // in-flight local content while its send/stream is still running.
        guard messages == placeholder else { return }
        messages = previousMessages
        messagesOffset = previousMessagesOffset
        hasOlderMessages = previousMessagesOffset > 0
    }

    @discardableResult
    func loadOlderMessages(modelContext: ModelContext? = nil) async -> Bool {
        guard let sessionID else {
            errorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard !isLoadingOlderMessages, hasOlderMessages else {
            return false
        }

        guard messagesOffset > 0 else {
            hasOlderMessages = false
            return false
        }

        // Reveal already-received stream text instead of dropping it; the replay
        // dedup counters stay valid because flushing only moves pending content
        // into the transcript.
        flushPendingStreamingContent()
        let messageBefore = messagesOffset
        isLoadingOlderMessages = true
        errorMessage = nil
        cacheErrorMessage = nil
        lastError = nil
        defer { isLoadingOlderMessages = false }

        do {
            let response = try await client.session(
                id: sessionID,
                includeMessages: true,
                messageLimit: Self.messagePageLimit,
                messageBefore: messageBefore
            )
            guard let session = response.session else {
                hasOlderMessages = false
                return false
            }

            // Pagination is outside session-load arbitration, so it must not
            // refresh read-only state; the cold load and live paths own that.
            let olderMessages = session.messages ?? []
            let mergedMessages = Self.prependingOlderMessages(olderMessages, to: messages)
            let didAddMessages = mergedMessages.count > messages.count
            applyCompressionAnchorMetadata(from: session)
            messages = mergedMessages
            responseCompletionNeedsTranscriptRefresh = false
            updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
            isViewingCachedData = false
            contextWindowSnapshot = ContextWindowSnapshot(
                contextLength: session.contextLength,
                thresholdTokens: session.thresholdTokens,
                lastPromptTokens: session.lastPromptTokens,
                inputTokens: session.inputTokens,
                outputTokens: session.outputTokens,
                estimatedCost: session.estimatedCost
            )
            if let title = session.title {
                displayTitle = Self.displayTitle(from: title)
            }
            currentWorkspace = session.workspace ?? currentWorkspace
            currentModel = session.model ?? currentModel
            currentModelProvider = session.modelProvider ?? currentModelProvider
            currentProfile = session.profile ?? currentProfile
            setCompletedToolCallGroups(ToolCallGroup.groups(
                persistedToolCalls: session.toolCalls ?? [],
                messages: messages,
                messageOffset: messagesOffset
            ))
            completedReasoningGroups = []

            if let modelContext {
                do {
                    try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }

            return didAddMessages
        } catch {
            lastError = error
            errorMessage = error.localizedDescription
            return false
        }
    }

    func actionContext(for message: ChatMessage, visibleIndex: Int) -> MessageActionContext? {
        guard !message.isLocalSteeringHint, message.steer == nil else { return nil }
        return MessageActionContext(
            message: message,
            visibleIndex: visibleIndex,
            messagesOffset: messagesOffset
        )
    }

    nonisolated static func precedingUserMessageText(
        in messages: [ChatMessage],
        beforeVisibleIndex visibleIndex: Int
    ) -> String? {
        guard !messages.isEmpty, visibleIndex > 0 else { return nil }

        let startIndex = min(visibleIndex - 1, messages.count - 1)
        guard startIndex >= 0 else { return nil }

        for index in stride(from: startIndex, through: 0, by: -1) {
            let message = messages[index]
            guard message.role == "user" else { continue }

            let text = message.content?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let text, !text.isEmpty {
                return text
            }
        }

        return nil
    }

    nonisolated static func mergingLoadedMessages(
        _ loadedMessages: [ChatMessage],
        withCachedLocalOptimisticMessages cachedMessages: [ChatMessage]
    ) -> [ChatMessage] {
        let serverMergedMessages = loadedMessages.map { loadedMessage in
            guard loadedMessage.role == "assistant",
                  let cachedMessage = cachedMessages.last(where: {
                      $0.role == "assistant" && $0.id == loadedMessage.id
                  })
            else { return loadedMessage }

            return ChatMessage(
                role: loadedMessage.role,
                content: loadedMessage.content,
                timestamp: loadedMessage.timestamp,
                messageId: loadedMessage.messageId,
                name: loadedMessage.name,
                toolCallId: loadedMessage.toolCallId,
                toolUseId: loadedMessage.toolUseId,
                toolCalls: loadedMessage.toolCalls ?? cachedMessage.toolCalls,
                contentParts: loadedMessage.contentParts ?? cachedMessage.contentParts,
                reasoning: loadedMessage.reasoning ?? cachedMessage.reasoning,
                reasoningTitles: loadedMessage.reasoningTitles ?? cachedMessage.reasoningTitles,
                activityScene: loadedMessage.activityScene ?? cachedMessage.activityScene,
                attachments: loadedMessage.attachments,
                turnDuration: loadedMessage.turnDuration ?? cachedMessage.turnDuration,
                turnTps: loadedMessage.turnTps ?? cachedMessage.turnTps,
                turnId: loadedMessage.turnId ?? cachedMessage.turnId,
                steer: loadedMessage.steer ?? cachedMessage.steer
            )
        }
        let mergedMessages = preservingLocalSteeringTurns(
            serverMergedMessages,
            cachedMessages: cachedMessages
        )
        return insertingUnconfirmedLocalUserMessages(
            from: cachedMessages,
            into: mergedMessages,
            requiresRecentTimestamp: true
        )
    }

    /// Re-inserts the local optimistic user rows the reloaded transcript has not
    /// confirmed yet, so a prompt in flight renders exactly once.
    nonisolated private static func insertingUnconfirmedLocalUserMessages(
        from localMessages: [ChatMessage],
        into loadedMessages: [ChatMessage],
        requiresRecentTimestamp: Bool
    ) -> [ChatMessage] {
        let unconfirmedMessages = localMessages.filter { localMessage in
            isLocalOptimisticUserMessage(localMessage)
                && !localMessage.isLocalSteeringHint
                && !loadedMessagesContainEquivalentUserMessage(
                    loadedMessages,
                    localMessage: localMessage,
                    requiresRecentTimestamp: requiresRecentTimestamp
                )
        }

        guard !unconfirmedMessages.isEmpty else {
            return loadedMessages
        }

        return unconfirmedMessages.reduce(into: loadedMessages) { partialMessages, localMessage in
            insertLocalOptimisticMessage(localMessage, into: &partialMessages)
        }
    }

    /// The server persists a steer as a hidden `_steer` row once the Agent takes it and renders it from the turn's
    /// scene when the turn completes. While the stream is live the local hint is its only rendering, so every hint
    /// survives; afterwards only hints the server has neither taken nor persisted do, after the in-flight turn's rows.
    nonisolated private static func preservingLocalSteeringTurns(
        _ loadedMessages: [ChatMessage],
        cachedMessages: [ChatMessage],
        streamIsActive: Bool = false
    ) -> [ChatMessage] {
        let persistedSteerIDs = Set(loadedMessages.compactMap { message -> String? in
            guard case .string(let steerID)? = message.steer?["steer_id"] else { return nil }
            return steerID
        })
        let pendingHints = cachedMessages.filter { message in
            message.isLocalSteeringHint
                && (streamIsActive || (
                    message.steeringHintState != .consumed
                        && message.messageId.map(persistedSteerIDs.contains) != true
                ))
        }
        return pendingHints.isEmpty ? loadedMessages : loadedMessages + pendingHints
    }

    nonisolated private static func isOrdinaryUserTurnBoundary(_ message: ChatMessage) -> Bool {
        TranscriptTurnClassifier.isUserTurnBoundary(message) && !message.isLocalSteeringHint
    }

    nonisolated private static func prependingOlderMessages(
        _ olderMessages: [ChatMessage],
        to currentMessages: [ChatMessage]
    ) -> [ChatMessage] {
        guard !olderMessages.isEmpty else { return currentMessages }

        var seenIDs = Set(currentMessages.map(\.id))
        var uniqueOlderMessages: [ChatMessage] = []
        uniqueOlderMessages.reserveCapacity(olderMessages.count)

        for message in olderMessages {
            guard seenIDs.insert(message.id).inserted else { continue }
            uniqueOlderMessages.append(message)
        }

        return uniqueOlderMessages + currentMessages
    }

    private func applyReloadedMessages(
        _ reloadedMessages: [ChatMessage],
        from session: SessionDetail?,
        previousMessages: [ChatMessage],
        previousMessagesOffset: Int
    ) {
        let reloadedMessagesOffset = Self.resolvedMessagesOffset(
            from: session,
            loadedMessageCount: reloadedMessages.count
        )

        if let expandedMessages = Self.mergingReloadedMessages(
            reloadedMessages,
            intoCurrentMessages: previousMessages,
            currentMessagesOffset: previousMessagesOffset,
            reloadedMessagesOffset: reloadedMessagesOffset
        ) {
            messages = expandedMessages
            messagesOffset = previousMessagesOffset
            hasOlderMessages = previousMessagesOffset > 0
            return
        }

        if let trimmedMessages = Self.trimmingReloadedMessages(
            reloadedMessages,
            toPreserveCurrentMessages: previousMessages,
            currentMessagesOffset: previousMessagesOffset,
            reloadedMessagesOffset: reloadedMessagesOffset
        ) {
            messages = trimmedMessages
            messagesOffset = previousMessagesOffset
            hasOlderMessages = previousMessagesOffset > 0 || session?.messagesTruncated == true
            return
        }

        messages = reloadedMessages
        updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
    }

    nonisolated private static func mergingReloadedMessages(
        _ reloadedMessages: [ChatMessage],
        intoCurrentMessages currentMessages: [ChatMessage],
        currentMessagesOffset: Int,
        reloadedMessagesOffset: Int
    ) -> [ChatMessage]? {
        guard currentMessagesOffset < reloadedMessagesOffset,
              let firstReloadedMessage = reloadedMessages.first,
              let overlapIndex = currentMessages.firstIndex(where: { $0.id == firstReloadedMessage.id }),
              overlapIndex > currentMessages.startIndex
        else {
            return nil
        }

        return Array(currentMessages[..<overlapIndex]) + reloadedMessages
    }

    /// Mid-session reloads (turn-end `.done`, the completion refresh, or a
    /// pull-to-refresh while reading) can come back with a *smaller*
    /// `_messages_offset` than the window on screen — the server widened the
    /// page, or `.done` omitted the offset entirely and it resolved to 0.
    /// Adopting that shrunken offset renumbers every positional
    /// `transcript:<absoluteIndex>` renderID, SwiftUI remounts the whole list,
    /// and a reader who scrolled up is dumped at the top of the session.
    ///
    /// When the reloaded window still contains the first message we're already
    /// showing at the absolute index implied by both offsets, drop the reloaded
    /// rows *before* that overlap and keep the current offset: rows on screen
    /// keep their renderIDs, and the tail is replaced with the
    /// server-authoritative content. Returns nil when the windows don't align
    /// (fall back to plain replacement).
    nonisolated private static func trimmingReloadedMessages(
        _ reloadedMessages: [ChatMessage],
        toPreserveCurrentMessages currentMessages: [ChatMessage],
        currentMessagesOffset: Int,
        reloadedMessagesOffset: Int
    ) -> [ChatMessage]? {
        guard reloadedMessagesOffset < currentMessagesOffset,
              let firstCurrentMessage = currentMessages.first
        else {
            return nil
        }

        let overlapIndex = currentMessagesOffset - reloadedMessagesOffset
        guard reloadedMessages.indices.contains(overlapIndex),
              reloadedMessages[overlapIndex].id == firstCurrentMessage.id
        else {
            return nil
        }

        return Array(reloadedMessages[overlapIndex...])
    }

    private func updateOlderMessagePagination(from session: SessionDetail?, loadedMessageCount: Int) {
        let resolvedOffset = Self.resolvedMessagesOffset(
            from: session,
            loadedMessageCount: loadedMessageCount
        )
        messagesOffset = resolvedOffset
        hasOlderMessages = resolvedOffset > 0 || session?.messagesTruncated == true
    }

    nonisolated private static func resolvedMessagesOffset(
        from session: SessionDetail?,
        loadedMessageCount: Int
    ) -> Int {
        if let messagesOffset = session?.messagesOffset {
            return max(0, messagesOffset)
        }

        guard session?.messagesTruncated == true,
              let messageCount = session?.messageCount
        else {
            return 0
        }

        return max(0, messageCount - loadedMessageCount)
    }

    nonisolated private static func mergingLoadedMessages(
        _ loadedMessages: [ChatMessage],
        withActiveStreamSnapshot snapshot: ActiveChatStreamSnapshot
    ) -> ActiveStreamMessageMerge {
        guard !snapshot.messages.isEmpty else {
            return ActiveStreamMessageMerge(
                messages: loadedMessages,
                streamingAssistantMessageID: latestAssistantMessageID(in: loadedMessages),
                usedSnapshotMessagesOffset: false
            )
        }

        guard let snapshotAssistantMessageID = snapshot.streamingAssistantMessageID,
              let snapshotAssistant = snapshot.messages.first(where: { $0.messageId == snapshotAssistantMessageID })
        else {
            if loadedMessages.isEmpty {
                return ActiveStreamMessageMerge(
                    messages: snapshot.messages,
                    streamingAssistantMessageID: latestAssistantMessageIDAfterLatestSteeringHint(
                        in: snapshot.messages
                    ),
                    usedSnapshotMessagesOffset: true
                )
            }

            let mergedMessages = preservingLocalSteeringTurns(
                loadedMessages,
                cachedMessages: snapshot.messages,
                streamIsActive: true
            )
            return ActiveStreamMessageMerge(
                messages: mergedMessages,
                streamingAssistantMessageID: latestAssistantMessageIDAfterLatestSteeringHint(
                    in: mergedMessages
                ),
                usedSnapshotMessagesOffset: false
            )
        }

        guard !loadedMessages.isEmpty else {
            return ActiveStreamMessageMerge(
                messages: snapshot.messages,
                streamingAssistantMessageID: snapshotAssistant.messageId,
                usedSnapshotMessagesOffset: true
            )
        }

        var mergedMessages = preservingLocalSteeringTurns(
            loadedMessages,
            cachedMessages: snapshot.messages,
            streamIsActive: true
        )
        let latestUserIndex = mergedMessages.lastIndex { $0.role == "user" }
        let assistantSearchRange: Range<Int>
        if let latestUserIndex {
            assistantSearchRange = mergedMessages.index(after: latestUserIndex)..<mergedMessages.endIndex
        } else {
            assistantSearchRange = mergedMessages.startIndex..<mergedMessages.endIndex
        }

        if let assistantIndex = assistantSearchRange.reversed().first(where: { mergedMessages[$0].role == "assistant" }) {
            let loadedAssistant = mergedMessages[assistantIndex]
            mergedMessages[assistantIndex] = ChatMessage(
                role: loadedAssistant.role,
                content: reconciledActiveStreamContent(
                    loadedContent: loadedAssistant.content,
                    snapshotContent: snapshotAssistant.content
                ),
                timestamp: loadedAssistant.timestamp ?? snapshotAssistant.timestamp,
                messageId: loadedAssistant.messageId ?? snapshotAssistant.messageId,
                name: loadedAssistant.name ?? snapshotAssistant.name,
                toolCallId: loadedAssistant.toolCallId ?? snapshotAssistant.toolCallId,
                toolUseId: loadedAssistant.toolUseId ?? snapshotAssistant.toolUseId,
                toolCalls: loadedAssistant.toolCalls ?? snapshotAssistant.toolCalls,
                contentParts: loadedAssistant.contentParts ?? snapshotAssistant.contentParts,
                reasoning: loadedAssistant.reasoning ?? snapshotAssistant.reasoning,
                reasoningTitles: loadedAssistant.reasoningTitles ?? snapshotAssistant.reasoningTitles,
                activityScene: loadedAssistant.activityScene ?? snapshotAssistant.activityScene,
                attachments: loadedAssistant.attachments ?? snapshotAssistant.attachments,
                turnDuration: loadedAssistant.turnDuration ?? snapshotAssistant.turnDuration,
                turnTps: loadedAssistant.turnTps ?? snapshotAssistant.turnTps,
                turnId: loadedAssistant.turnId ?? snapshotAssistant.turnId,
                steer: loadedAssistant.steer ?? snapshotAssistant.steer
            )
            return ActiveStreamMessageMerge(
                messages: mergedMessages,
                streamingAssistantMessageID: mergedMessages[assistantIndex].messageId,
                usedSnapshotMessagesOffset: false
            )
        }

        if !messagesContainEquivalentMessage(mergedMessages, candidate: snapshotAssistant) {
            mergedMessages.append(snapshotAssistant)
        }

        return ActiveStreamMessageMerge(
            messages: mergedMessages,
            streamingAssistantMessageID: snapshotAssistant.messageId,
            usedSnapshotMessagesOffset: false
        )
    }

    nonisolated private static func reconciledActiveStreamContent(
        loadedContent: String?,
        snapshotContent: String?
    ) -> String? {
        let loaded = loadedContent ?? ""
        let snapshot = snapshotContent ?? ""

        if loaded.isEmpty {
            return snapshotContent
        }

        if snapshot.isEmpty {
            return loadedContent
        }

        if loaded.hasPrefix(snapshot) {
            return loadedContent
        }

        if snapshot.hasPrefix(loaded) {
            return snapshotContent
        }

        return loadedContent
    }

    nonisolated private static func messagesContainEquivalentMessage(
        _ messages: [ChatMessage],
        candidate: ChatMessage
    ) -> Bool {
        if let candidateID = candidate.messageId,
           messages.contains(where: { $0.messageId == candidateID }) {
            return true
        }

        let candidateContent = candidate.content?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard candidateContent?.isEmpty == false else { return false }

        return messages.contains { message in
            message.role == candidate.role &&
                message.content?.trimmingCharacters(in: .whitespacesAndNewlines) == candidateContent
        }
    }

    /// When the loaded session's in-flight turn started, for seeding the stream
    /// coordinator's run clock: the server's `pending_started_at` first, then the
    /// latest visible user turn's timestamp. Nil leaves the coordinator counting
    /// from when it discovered the stream.
    nonisolated private static func activeRunStartDate(
        pendingStartedAt: Double?,
        messages: [ChatMessage]
    ) -> Date? {
        ChatStreamCoordinator.runStart(fromEpochSeconds: pendingStartedAt)
            ?? ChatStreamCoordinator.runStart(
                fromEpochSeconds: messages.last(where: TranscriptTurnClassifier.isUserTurnBoundary)?.timestamp
            )
    }

    nonisolated private static func remappedAnchorMessageID(
        _ anchorMessageID: String?,
        from snapshotStreamingAssistantMessageID: String?,
        to restoredStreamingAssistantMessageID: String?
    ) -> String? {
        guard let anchorMessageID,
              anchorMessageID == snapshotStreamingAssistantMessageID,
              snapshotStreamingAssistantMessageID != restoredStreamingAssistantMessageID
        else {
            return anchorMessageID
        }

        return restoredStreamingAssistantMessageID ?? anchorMessageID
    }

    nonisolated private static func isLocalOptimisticUserMessage(_ message: ChatMessage) -> Bool {
        message.role == "user" && message.messageId?.hasPrefix("local-") == true
    }

    nonisolated private static func loadedMessagesContainEquivalentUserMessage(
        _ loadedMessages: [ChatMessage],
        localMessage: ChatMessage,
        requiresRecentTimestamp: Bool = true
    ) -> Bool {
        let localContent = normalizedUserMessageContent(localMessage)
        let localAttachmentKeys = attachmentKeys(for: localMessage)

        return loadedMessages.contains { loadedMessage in
            guard loadedMessage.role == "user" else { return false }

            if loadedMessage.messageId == localMessage.messageId {
                return true
            }

            guard normalizedUserMessageContent(loadedMessage) == localContent else {
                return false
            }

            if !localAttachmentKeys.isEmpty {
                let loadedAttachmentKeys = attachmentKeys(for: loadedMessage)
                guard !loadedAttachmentKeys.isEmpty,
                      loadedAttachmentKeys.isSuperset(of: localAttachmentKeys)
                else {
                    return false
                }
            }

            guard requiresRecentTimestamp,
                  let localTimestamp = localMessage.timestamp,
                  let loadedTimestamp = loadedMessage.timestamp
            else {
                return true
            }

            return loadedTimestamp >= localTimestamp - 300
        }
    }

    nonisolated private static func insertLocalOptimisticMessage(
        _ localMessage: ChatMessage,
        into messages: inout [ChatMessage]
    ) {
        if !messages.contains(where: { $0.role == "user" }),
           let firstAssistantIndex = messages.firstIndex(where: { $0.role == "assistant" }) {
            messages.insert(localMessage, at: firstAssistantIndex)
            return
        }

        guard let localTimestamp = localMessage.timestamp,
              let insertionIndex = messages.firstIndex(where: { loadedMessage in
                  guard let loadedTimestamp = loadedMessage.timestamp else { return false }
                  return loadedTimestamp > localTimestamp
              })
        else {
            messages.append(localMessage)
            return
        }

        messages.insert(localMessage, at: insertionIndex)
    }

    nonisolated private static func latestAssistantMessageID(in messages: [ChatMessage]) -> String? {
        messages.last(where: { $0.role == "assistant" })?.messageId
    }

    nonisolated private static func latestAssistantMessageIDAfterLatestSteeringHint(
        in messages: [ChatMessage]
    ) -> String? {
        guard let steeringIndex = messages.lastIndex(where: \.isLocalSteeringHint) else {
            return latestAssistantMessageID(in: messages)
        }
        return messages[messages.index(after: steeringIndex)...]
            .last(where: { $0.role == "assistant" })?
            .messageId
    }

    nonisolated private static func latestAssistantAnchorID(in messages: [ChatMessage], messageOffset: Int?) -> String? {
        guard let index = messages.lastIndex(where: { $0.role == "assistant" }) else {
            return nil
        }

        return TranscriptTurnClassifier.anchorID(
            for: messages[index],
            at: index,
            messageOffset: messageOffset
        )
    }

    nonisolated static func deduplicatedReasoningTexts(_ texts: [String]) -> [String] {
        var seen: Set<String> = []

        return texts.compactMap { text in
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }

            let key = trimmed
                .components(separatedBy: .whitespacesAndNewlines)
                .filter { !$0.isEmpty }
                .joined(separator: " ")

            guard seen.insert(key).inserted else { return nil }
            return trimmed
        }
    }

    nonisolated private static func normalizedUserMessageContent(_ message: ChatMessage) -> String {
        guard let content = message.content else { return "" }

        // Share the single parser with the display layer so the two can never
        // disagree about what counts as an attachment reference — including the
        // synthesized message, which an attachment-only send shows as an empty
        // optimistic bubble while the server replays it as text. Its own
        // attachments are the evidence, so an unattached message that merely
        // reads like it is never collapsed into a match. Trim the result because
        // this normalized form is compared for dedup equality.
        return MessageAttachment
            .contentWithoutAttachmentReferences(in: content, attachments: message.attachments)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated private static func attachmentKeys(for message: ChatMessage) -> Set<String> {
        // Match on `MessageAttachment.identityKey` (lowercased basename): the
        // server returns attachment paths inconsistently on reload, so basename
        // matching is the only reliable way to dedupe an optimistic bubble
        // against its reloaded copy. See `identityKey` for the full rationale.
        Set((message.attachments ?? []).compactMap(\.identityKey))
    }

    func sendMessage(_ draft: String, modelContext: ModelContext? = nil) async -> Bool {
        // Reentrancy guard, mirroring `sendVoiceNote`. It must run before
        // `prepareForSend` so a rejected send never consumes the composer's
        // staged attachments, and before `performChatSend` so a rejected caller
        // never reaches that method's `defer { isStartingChat = false }`.
        guard !isStartingChat, !isSendingVoiceNote else { return false }
        guard !isViewingCachedData else {
            sendErrorMessage = String(localized: "Reconnect to the server to send a message.")
            return false
        }

        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // A textless send is valid when it carries staged files: the composed
        // text then *is* the synthesized attachment message. Compose it before
        // `prepareForSend` consumes the attachments, and reject on the composed
        // result so an empty draft with unusable references still bails without
        // spending them.
        let composedMessage = PendingAttachment.chatMessageText(
            draft: message,
            attachments: attachmentCoordinator.pendingAttachments
        )
        guard !composedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }

        guard let sessionID else {
            sendErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        let localMessageID = "local-\(UUID().uuidString)"
        let attachmentPreparation = attachmentCoordinator.prepareForSend(localMessageID: localMessageID)

        let didStart = await performChatSend(
            sessionID: sessionID,
            localMessageID: localMessageID,
            // The optimistic row carries exactly what the server will store, so
            // the bubble cannot change appearance across a reload — and so the
            // display layer sees the trailing marker that tells a typed message
            // apart from a synthesized attachment-only one.
            displayContent: composedMessage,
            messageForAPI: composedMessage,
            messageAttachments: attachmentPreparation.messageAttachments,
            apiPayloads: attachmentPreparation.apiPayloads,
            attachmentsToRestoreOnFailure: attachmentPreparation.attachments,
            modelContext: modelContext
        )
        if didStart {
            for attachment in attachmentPreparation.attachments {
                guard let fileName = attachment.draftFileName else { continue }
                await attachmentCoordinator.deleteDraftCopy(named: fileName)
            }
        }
        return didStart
    }

    /// Records → transcribes → uploads → sends a server-transcribed voice note
    /// (Telegram-style). The sent message's text is the transcript and its sole
    /// attachment is the audio clip, rendered as a playable note by the inline
    /// audio player. Aborts (toast, no partial send) if transcription fails or
    /// returns nothing. Returns true only if the chat send started.
    @discardableResult
    func sendVoiceNote(audioData: Data, filename: String, modelContext: ModelContext? = nil) async -> Bool {
        // Reentrancy guard: bail if a voice note OR a regular chat send is already
        // in flight. It has to live here rather than only in `performChatSend`,
        // because transcription and upload run before that call and must not start
        // at all while another send owns the pipeline. Without it two overlapping
        // sends would both flip `isStartingChat`/`isSendingVoiceNote` and race their
        // `defer { … = false }` (clearing the flag while the other still runs, and
        // firing two concurrent `startChat`s). The UI already blocks this; the guard
        // keeps a future caller (accessibility shortcut, test harness) safe too.
        guard !isSendingVoiceNote, !isStartingChat else { return false }
        guard !isViewingCachedData else {
            setUploadAttachmentError(String(localized: "Reconnect to the server to send a voice note."))
            return false
        }
        guard !audioData.isEmpty else { return false }
        guard audioData.count <= PendingAttachment.maximumUploadBytes else {
            setUploadAttachmentError(PendingAttachment.uploadTooLargeMessage(filename: filename))
            return false
        }
        guard let sessionID else {
            setUploadAttachmentError(String(localized: "The server did not provide a session ID."))
            return false
        }

        isSendingVoiceNote = true
        setUploadAttachmentError(nil)
        sendErrorMessage = nil
        lastError = nil
        // Releasing the pipeline is the queue's natural trigger. A successful voice
        // note starts a stream, so the drain no-ops and stream completion drives it
        // as usual; a failed one leaves no stream behind, so without this a message
        // queued during the voice note would wait for the next unrelated trigger.
        defer {
            isSendingVoiceNote = false
            drainQueuedSlashMessageIfIdle()
        }

        // 1. Transcribe via server STT. Any error or empty transcript aborts the
        //    whole send — no fallback, no partial message (per the issue).
        let transcript: String
        do {
            let response = try await client.transcribeAudio(data: audioData, filename: filename)
            if let serverError = response.error?.trimmingCharacters(in: .whitespacesAndNewlines),
               !serverError.isEmpty {
                setUploadAttachmentError(serverError)
                return false
            }
            let text = (response.transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                setUploadAttachmentError(String(localized: "Couldn't transcribe that voice note. Try recording again."))
                return false
            }
            transcript = text
        } catch {
            lastError = error
            setUploadAttachmentError(error.localizedDescription)
            return false
        }

        // 2. Upload the clip as a standalone attachment (kept out of the composer's
        //    pending list). On failure the coordinator already surfaced the error.
        guard let pending = await attachmentCoordinator.uploadStandaloneAttachment(
            data: audioData,
            filename: filename
        ) else {
            return false
        }

        // 3. Send a chat message: text = transcript, attachments = [the clip].
        let messageAttachment = MessageAttachment(
            name: pending.name,
            path: pending.path,
            mime: pending.mime,
            size: pending.size,
            isImage: pending.isImage
        )
        let localMessageID = "local-\(UUID().uuidString)"
        // The API message text is the bare transcript — NOT chatMessageText(…),
        // which would append a "[Attached files: <clip>.m4a]" suffix. That suffix
        // is the agent's only signal about a non-image attachment (the server
        // strips attachment metadata before the model call and never embeds audio),
        // so it makes the agent try to "inspect" / transcribe the clip itself
        // instead of just answering the transcript. The clip still rides along in
        // `messageAttachments` / `apiPayloads` purely so the inline player renders
        // and persists; it's display-only and never reaches the model. (#330)
        return await performChatSend(
            sessionID: sessionID,
            localMessageID: localMessageID,
            displayContent: transcript,
            messageForAPI: transcript,
            messageAttachments: [messageAttachment],
            apiPayloads: [pending.toJSONValue()],
            attachmentsToRestoreOnFailure: [],
            modelContext: modelContext
        )
    }

    /// Shared optimistic-append + `startChat` + rollback core used by both the
    /// text composer (`sendMessage`) and the voice-note flow (`sendVoiceNote`).
    /// `attachmentsToRestoreOnFailure` is re-staged into the composer if the send
    /// fails — empty for voice notes, whose clip isn't a composer attachment.
    private func performChatSend(
        sessionID: String,
        localMessageID: String,
        displayContent: String,
        messageForAPI: String,
        messageAttachments: [MessageAttachment],
        apiPayloads: [JSONValue]?,
        attachmentsToRestoreOnFailure: [PendingAttachment],
        modelContext: ModelContext?
    ) async -> Bool {
        // Single-owner backstop for the shared start pipeline: only one caller may
        // own the optimistic row, the `startChat` request, and `isStartingChat` at a
        // time. Deliberately does not test `isSendingVoiceNote` — the voice pipeline
        // sets that flag before calling in, so it would reject itself. `isStartingChat`
        // is set below without an intervening suspension, so a second caller that
        // reaches here while the first is awaiting its request is rejected here
        // instead of racing the append and the `defer`.
        guard !isStartingChat else {
            restorePendingAttachments(attachmentsToRestoreOnFailure)
            return false
        }
        isStartingChat = true
        isStartingMessageSend = true
        sendErrorMessage = nil
        lastError = nil
        archiveLiveActivityIfNeeded()
        liveAssistantActivity.removeAll()
        reasoningAnchorMessageID = nil
        toolCallAnchorMessageID = nil
        streamCoordinator.prepareForNewResponse()
        responseCompletionNeedsTranscriptRefresh = false
        defer { finishMessageSend() }

        let optimisticMessage = ChatMessage(
            role: "user",
            content: displayContent,
            timestamp: Date().timeIntervalSince1970,
            messageId: localMessageID,
            attachments: messageAttachments.isEmpty ? nil : messageAttachments
        )
        messages.append(optimisticMessage)

        cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)

        do {
            let explicitModelPick = explicitModelPickForChatStart()
            let sentAt = Date()
            let response = try await client.startChat(
                sessionID: sessionID,
                message: messageForAPI,
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName,
                explicitModelPick: explicitModelPick,
                attachments: apiPayloads
            )

            guard let streamID = response.streamId else {
                sendErrorMessage = response.error ?? String(localized: "The server did not return a stream ID.")
                rollbackOptimisticMessage(id: localMessageID)
                cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
                restorePendingAttachments(attachmentsToRestoreOnFailure)
                return false
            }

            completeExplicitModelPickForChatStart(explicitModelPick)
            streamCoordinator.start(
                streamID: streamID,
                armsAggregateForLocalWork: true,
                runStartedAt: response.runStartedAt(sentAt: sentAt)
            )
            return true
        } catch {
            if let streamID = (error as? APIError)?.activeStreamID {
                rollbackOptimisticMessage(id: localMessageID)
                cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
                restorePendingAttachments(attachmentsToRestoreOnFailure)
                // The existing run may have started outside this view model. Reconcile
                // the server transcript first so the SSE tokens attach to the persisted
                // assistant turn instead of creating a second bubble with only the tail.
                await loadMessages(modelContext: modelContext, waitsForPendingMessageSend: false)
                _ = restoreActiveStreamSnapshotIfAvailable(streamID: streamID)
                streamingAssistantMessageID = TranscriptTurnClassifier
                    .currentTurnAssistantAnchorIDs(in: messages, messageOffset: messagesOffset)
                    .first
                streamCoordinator.start(streamID: streamID)
                // The server kept the earlier run, not this newly submitted text.
                // Report an unaccepted send so ChatView restores the draft while
                // the coordinator reconnects to the existing response.
                return false
            }
            lastError = error
            sendErrorMessage = error.localizedDescription
            rollbackOptimisticMessage(id: localMessageID)
            cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
            restorePendingAttachments(attachmentsToRestoreOnFailure)
            return false
        }
    }

    private func waitForMessageSendToFinish() async {
        guard isStartingMessageSend else { return }

        await withCheckedContinuation { continuation in
            if isStartingMessageSend {
                messageSendWaiters.append(continuation)
            } else {
                continuation.resume()
            }
        }
    }

    private func finishMessageSend() {
        isStartingChat = false
        isStartingMessageSend = false
        let waiters = messageSendWaiters
        messageSendWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func waitForNewerSessionLoadRequests(after requestGeneration: Int) async {
        guard activeSessionLoadRequestGenerations.contains(where: { $0 > requestGeneration }) else {
            return
        }

        await withCheckedContinuation { continuation in
            if activeSessionLoadRequestGenerations.contains(where: { $0 > requestGeneration }) {
                sessionLoadWaiters.append(SessionLoadWaiter(
                    requestGeneration: requestGeneration,
                    continuation: continuation
                ))
            } else {
                continuation.resume()
            }
        }
    }

    private func finishSessionLoadRequest(_ requestGeneration: Int) {
        activeSessionLoadRequestGenerations.remove(requestGeneration)

        var pending: [SessionLoadWaiter] = []
        var ready: [CheckedContinuation<Void, Never>] = []
        for waiter in sessionLoadWaiters {
            if activeSessionLoadRequestGenerations.contains(where: { $0 > waiter.requestGeneration }) {
                pending.append(waiter)
            } else {
                ready.append(waiter.continuation)
            }
        }
        sessionLoadWaiters = pending
        for continuation in ready {
            continuation.resume()
        }
    }

    func submitGoal(args rawArgs: String, modelContext: ModelContext? = nil) async -> Bool {
        guard !isViewingCachedData else {
            goalErrorMessage = String(localized: "Reconnect to the server to manage goals.")
            sendErrorMessage = goalErrorMessage
            return false
        }

        let args = rawArgs.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !args.isEmpty else { return false }

        guard let sessionID else {
            goalErrorMessage = String(localized: "The server did not provide a session ID.")
            sendErrorMessage = goalErrorMessage
            return false
        }

        guard activeStreamID == nil else {
            goalErrorMessage = String(localized: "Wait for the current response to finish before changing goals.")
            sendErrorMessage = goalErrorMessage
            return false
        }

        isSubmittingGoal = true
        goalErrorMessage = nil
        sendErrorMessage = nil
        lastError = nil
        defer { isSubmittingGoal = false }

        do {
            let response = try await client.submitGoal(
                sessionID: sessionID,
                args: args,
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName
            )

            currentGoal = response.goal

            if response.ok == false || response.action?.lowercased() == "error" {
                goalErrorMessage = response.displayMessage ?? String(localized: "Goal request failed.")
                sendErrorMessage = goalErrorMessage
                return false
            }

            hasActivatedGoalCommand = true

            guard response.kickoffPromptText != nil else {
                if let message = response.displayMessage {
                    appendLocalNoticeMessage(message)
                }
                return true
            }

            return await attachGoalKickoffStream(
                noticeMessage: response.displayMessage,
                modelContext: modelContext
            )
        } catch {
            lastError = error
            goalErrorMessage = error.localizedDescription
            sendErrorMessage = goalErrorMessage
            return false
        }
    }

    private func attachGoalKickoffStream(noticeMessage: String?, modelContext: ModelContext?) async -> Bool {
        await loadMessages(modelContext: modelContext)

        if let errorMessage {
            goalErrorMessage = errorMessage
            sendErrorMessage = errorMessage
            return false
        }

        guard let streamID = activeStreamID else {
            if let noticeMessage {
                appendLocalNoticeMessage(noticeMessage)
            }
            return true
        }

        if streamingAssistantMessageID == nil {
            restoreActiveStreamSnapshotIfAvailable(streamID: streamID)
        }
        if streamingAssistantMessageID == nil {
            streamingAssistantMessageID = Self.latestAssistantMessageID(in: messages)
        }
        if let noticeMessage {
            pinLocalNoticeMessage(noticeMessage)
        }

        streamCoordinator.start(streamID: streamID, armsAggregateForLocalWork: true)
        return true
    }

    private func rollbackOptimisticMessage(id: String) {
        messages.removeAll { $0.messageId == id }
        attachmentCoordinator.removeLocalPreviews(messageID: id)
    }

    private func restorePendingAttachments(_ attachments: [PendingAttachment]) {
        attachmentCoordinator.restorePendingAttachments(attachments)
    }

    private func cacheCurrentMessages(sessionID: String, modelContext: ModelContext?) {
        guard let modelContext else { return }

        do {
            try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
        } catch {
            cacheErrorMessage = error.localizedDescription
        }
    }

    func cacheCompletedResponse(modelContext: ModelContext) {
        guard let sessionID else { return }
        cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
    }

    func clearTranscript() {
        cancelPendingStreamingScrollTrigger()
        resetPendingStreamingContentBuffers()
        clearCompressionAnchorMetadata()
        messages = []
        messagesOffset = 0
        hasOlderMessages = false
        setCompletedToolCallGroups([])
        completedReasoningGroups = []
        archivedAssistantActivity = [:]
        liveAssistantActivity.removeAll()
        pinnedLocalNotices = []
        streamingAssistantMessageID = nil
        toolCallAnchorMessageID = nil
        reasoningAnchorMessageID = nil
        attachmentCoordinator.removeAllLocalPreviews()
        sendErrorMessage = nil
    }

    func executeSlashCommand(_ command: SlashCommand, args: String = "") async -> SlashCommandExecutionResult {
        switch command.handler {
        case .clientSide(let action):
            switch action {
            case .clear:
                clearTranscript()
                return .executed(message: nil)
            case .stop:
                await cancelActiveStream()
                return .executed(message: nil)
            case .new:
                return await createSessionFromSlashCommand()
            case .help:
                return .executed(message: Self.slashCommandHelpText)
            }
        case .serverSide(let action):
            return await executeServerSideSlashCommand(action, args: args)
        case .unsupported:
            return .unsupported(friendlyMessage: SlashCommandExecutor.unsupportedMessage(for: command.name))
        }
    }

    private func executeServerSideSlashCommand(
        _ action: ServerSideAction,
        args: String
    ) async -> SlashCommandExecutionResult {
        switch action {
        case .model:
            return await switchModelFromSlashCommand(args)
        case .workspace:
            return await switchWorkspaceFromSlashCommand(args)
        case .reasoning:
            return await switchReasoningFromSlashCommand(args)
        case .title:
            return await renameSessionFromSlashCommand(args)
        case .personality:
            return await setPersonalityFromSlashCommand(args)
        case .skills:
            return await searchSkillsFromSlashCommand(args)
        case .branch:
            return await branchSessionFromSlashCommand(args)
        case .undo:
            return await undoLastExchangeFromSlashCommand()
        case .retry:
            return await retryLastTurnFromSlashCommand()
        case .compress:
            return await compressSessionFromSlashCommand(args)
        case .queue:
            return await queueMessageFromSlashCommand(args)
        case .steer:
            return await steerResponseFromSlashCommand(args)
        case .interrupt:
            return await interruptResponseFromSlashCommand(args)
        case .status:
            return .executed(message: statusMessageFromSlashCommand())
        case .btw:
            return await askBtwFromSlashCommand(args)
        case .background:
            return await startBackgroundFromSlashCommand(args)
        case .goal:
            return await submitGoalFromSlashCommand(args)
        }
    }

    func submitStreamingMessage(
        _ draft: String,
        behavior: StreamingSendBehavior
    ) async -> SlashCommandExecutionResult {
        switch behavior {
        case .steer:
            // Steering has no attachment channel, so a textless send — which
            // exists only to deliver its staged files — has to queue instead of
            // steering an empty string that would drop them.
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !attachmentCoordinator.pendingAttachments.isEmpty {
                return await queueMessageFromSlashCommand(draft)
            }
            return await steerResponseFromSlashCommand(draft)
        case .interrupt:
            return await interruptResponseFromSlashCommand(draft)
        case .queue:
            return await queueMessageFromSlashCommand(draft)
        }
    }

    private func queueMessageFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let message = args.trimmingCharacters(in: .whitespacesAndNewlines)
        // Staged files make a textless queue valid; `sendMessage` synthesizes
        // the message when the drain replays it.
        guard !message.isEmpty || !attachmentCoordinator.pendingAttachments.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /queue <message>"))
        }

        guard activeStreamID != nil else {
            let sent = await sendMessage(message)
            return sent ? .executed(message: nil) : .unsupported(friendlyMessage: sendErrorMessage ?? String(localized: "Could not send the queued message."))
        }

        let position = enqueueQueuedSlashMessage(message, attachments: attachmentCoordinator.consumePendingAttachments())
        return .executed(message: String(localized: "Queued for next turn (#\(position))."))
    }

    private func steerResponseFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let message = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /steer <message>"))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard activeStreamID != nil else {
            let sent = await sendMessage(message)
            return sent ? .executed(message: nil) : .unsupported(friendlyMessage: sendErrorMessage ?? String(localized: "Could not send the steering message."))
        }

        let steeringHint = appendSteeringHint(message)
        do {
            let response = try await client.steerChat(
                sessionID: sessionID,
                text: message,
                steerID: steeringHint.messageID
            )
            if response.accepted == true {
                updateSteeringHint(id: steeringHint.messageID, state: .waiting)
                finalizeSteeringPhase(
                    assistantMessageID: steeringHint.precedingAssistantMessageID,
                    endingAt: steeringHint.timestamp
                )
                return .executed(message: nil)
            }
        } catch {
            lastError = error
        }

        removeSteeringHint(id: steeringHint.messageID)
        _ = enqueueQueuedSlashMessage(message, attachments: attachmentCoordinator.consumePendingAttachments())
        await cancelActiveStream()
        return .executed(message: String(localized: "Steer was unavailable, so the message was queued and the current response was stopped."))
    }

    private func interruptResponseFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let message = args.trimmingCharacters(in: .whitespacesAndNewlines)
        // Same as `/queue`: staged files carry the intent when the text is empty.
        guard !message.isEmpty || !attachmentCoordinator.pendingAttachments.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /interrupt <message>"))
        }

        guard activeStreamID != nil else {
            let sent = await sendMessage(message)
            return sent ? .executed(message: nil) : .unsupported(friendlyMessage: sendErrorMessage ?? String(localized: "Could not send the interrupt message."))
        }

        enqueueQueuedSlashMessage(message, attachments: attachmentCoordinator.consumePendingAttachments(), atFront: true)
        await cancelActiveStream()

        if activeStreamID != nil {
            return .executed(message: String(localized: "Could not stop the current response yet, so the interrupt message was queued for the next turn."))
        }

        return .executed(message: String(localized: "Interrupted the current response and queued your message to send next."))
    }

    private func statusMessageFromSlashCommand() -> String {
        let running = activeStreamID == nil ? String(localized: "No") : String(localized: "Yes")
        let queued = queuedSlashMessages.count
        let backgroundTasks = backgroundPromptsByTaskID.count
        let profile = selectedProfileName ?? currentProfile ?? "default"
        let workspace = currentWorkspace ?? String(localized: "Unknown")
        let model = currentModel ?? String(localized: "Unknown")
        let provider = currentModelProvider ?? providerFromModel(model) ?? String(localized: "Unknown")
        let messageCount = messages.filter { $0.role != "tool" }.count
        let tokens = statusTokenLine()

        return String(localized: """
        Session status:

        - Session ID: \(sessionID ?? "Unknown")
        - Title: \(displayTitle)
        - Model: \(model)
        - Provider: \(provider)
        - Profile: \(profile)
        - Workspace: \(workspace)
        - Agent running: \(running)
        - Queued messages: \(queued)
        - Background tasks: \(backgroundTasks)
        - Messages loaded: \(messageCount)
        - Tokens: \(tokens)
        """)
    }

    private func askBtwFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let question = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /btw <question>"))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to ask a side question."))
        }

        guard !isCLISession else {
            return .unsupported(friendlyMessage: String(localized: "/btw is available for WebUI sessions only."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before using /btw."))
        }

        guard activeBtwStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current /btw answer to finish first."))
        }

        do {
            let response = try await client.startBtw(sessionID: sessionID, question: question)
            if let error = response.error, !error.isEmpty {
                return .unsupported(friendlyMessage: error)
            }

            guard let streamID = response.streamId, !streamID.isEmpty else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return a /btw stream."))
            }

            startBtwStream(streamID: streamID, question: question)
            return .executed(message: nil)
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func startBackgroundFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let prompt = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /background <prompt>"))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to start a background task."))
        }

        guard !isCLISession else {
            return .unsupported(friendlyMessage: String(localized: "/background is available for WebUI sessions only."))
        }

        do {
            let response = try await client.startBackground(sessionID: sessionID, prompt: prompt)
            if let error = response.error, !error.isEmpty {
                return .unsupported(friendlyMessage: error)
            }

            guard let taskID = response.taskId, !taskID.isEmpty else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return a background task."))
            }

            backgroundPromptsByTaskID[taskID] = prompt
            startBackgroundPollingIfNeeded(parentSessionID: sessionID)
            return .executed(message: String(localized: "Background task started. I'll add the result here when it completes."))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func submitGoalFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let goalArgs = args.trimmingCharacters(in: .whitespacesAndNewlines)
        let didSubmit = await submitGoal(args: goalArgs.isEmpty ? "status" : goalArgs)
        return didSubmit ? .executed(message: nil) : .unsupported(friendlyMessage: goalErrorMessage ?? String(localized: "Could not submit the goal command."))
    }

    private func switchModelFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let requestedModel = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedModel.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /model <id>"))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard canRunConfigurationSlashCommand(String(localized: "change models")) else {
            return .unsupported(friendlyMessage: composerConfigurationErrorMessage ?? String(localized: "Model switching is unavailable."))
        }

        let match = modelOption(matching: requestedModel)

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        sendErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.updateSession(
                id: sessionID,
                workspace: currentWorkspace,
                model: match?.id ?? requestedModel,
                modelProvider: match?.providerID
            )

            currentModel = response.session?.model ?? match?.id ?? requestedModel
            currentModelProvider = response.session?.modelProvider ?? match?.providerID ?? currentModelProvider
            currentWorkspace = response.session?.workspace ?? currentWorkspace
            pendingExplicitModelPick = true
            await refreshReasoningEffortGating()
            return .executed(message: nil)
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func switchWorkspaceFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let requestedWorkspace = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedWorkspace.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /workspace <path>"))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard canRunConfigurationSlashCommand(String(localized: "change workspace")) else {
            return .unsupported(friendlyMessage: composerConfigurationErrorMessage ?? String(localized: "Workspace switching is unavailable."))
        }

        let workspace = workspacePath(matching: requestedWorkspace) ?? requestedWorkspace

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        sendErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.updateSession(
                id: sessionID,
                workspace: workspace,
                model: currentModel,
                modelProvider: currentModelProvider
            )

            currentWorkspace = response.session?.workspace ?? workspace
            currentModel = response.session?.model ?? currentModel
            currentModelProvider = response.session?.modelProvider ?? currentModelProvider
            workspaceSuggestions = workspaceRoots.compactMap(\.path)
            return .executed(message: nil)
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func switchReasoningFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let reasoning = args.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !reasoning.isEmpty else {
            return .unsupported(friendlyMessage: String(localized: "Usage: /reasoning show|hide|none|minimal|low|medium|high|xhigh"))
        }

        guard canRunConfigurationSlashCommand(String(localized: "change reasoning")) else {
            return .unsupported(friendlyMessage: composerConfigurationErrorMessage ?? String(localized: "Reasoning changes are unavailable."))
        }

        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        sendErrorMessage = nil
        lastError = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            if Self.reasoningDisplayArgs.contains(reasoning) {
                _ = try await client.saveReasoningDisplay(reasoning)
            } else if Self.reasoningEffortArgs.contains(reasoning) {
                let response = try await client.saveReasoningEffort(reasoning)
                selectedReasoningEffort = response.effectiveEffort ?? reasoning
            } else {
                return .unsupported(friendlyMessage: String(localized: "Unknown reasoning level: \(reasoning)."))
            }
            return .executed(message: nil)
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func renameSessionFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let title = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            return .executed(message: String(localized: "Current title: **\(displayTitle)**\n\nUse `/title <text>` to rename this session."))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before renaming the session."))
        }

        lastError = nil
        sendErrorMessage = nil

        do {
            let response = try await client.renameSession(id: sessionID, title: title)
            if let error = response.error {
                return .unsupported(friendlyMessage: error)
            }
            displayTitle = Self.displayTitle(from: response.session?.title ?? title)
            return .executed(message: String(localized: "Title set to **\(displayTitle)**."))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func setPersonalityFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        let requestedPersonality = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedPersonality.isEmpty else {
            return await personalityListMessage()
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before changing personality."))
        }

        let normalized = requestedPersonality.lowercased()
        let name = Self.personalityClearArgs.contains(normalized) ? "" : requestedPersonality

        lastError = nil
        sendErrorMessage = nil

        do {
            let response = try await client.setPersonality(sessionID: sessionID, name: name)
            if let error = response.error {
                return .unsupported(friendlyMessage: error)
            }

            if name.isEmpty || response.personality == nil {
                return .executed(message: String(localized: "Personality cleared."))
            }

            return .executed(message: String(localized: "Personality set to **\(response.personality ?? name)**."))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func personalityListMessage() async -> SlashCommandExecutionResult {
        do {
            let personalities = (try await client.personalities()).personalities ?? []
            guard !personalities.isEmpty else {
                return .executed(message: String(localized: "No personalities are configured on the server."))
            }

            let list = personalities.compactMap { personality -> String? in
                guard let name = personality.name, !name.isEmpty else { return nil }
                if let description = personality.description, !description.isEmpty {
                    return "- **\(name)** - \(description)"
                }
                return "- **\(name)**"
            }
            .joined(separator: "\n")

            return .executed(message: String(localized: "Available personalities:\n\n\(list)\n\nUse `/personality <name>` or `/personality none`."))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func searchSkillsFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        do {
            let suggestions = try await skillSuggestionsForSlashCommand()
            if let invocation = SlashSkillFormatter.invocation(from: args, suggestions: suggestions) {
                let sent = await sendMessage(SlashSkillFormatter.messageText(for: invocation))
                if sent {
                    return .executed(message: nil)
                }
                return .unsupported(friendlyMessage: sendErrorMessage ?? String(localized: "Could not send the skill message."))
            }

            return .executed(message: SlashSkillFormatter.message(for: suggestions, query: SlashSkillFormatter.skillQuery(from: args)))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    func executeSkillShortcutCommand(name: String, args: String) async -> SlashCommandExecutionResult? {
        do {
            let suggestions = try await skillSuggestionsForSlashCommand()
            guard let skill = SlashSkillFormatter.skill(named: name, in: suggestions) else {
                return nil
            }

            let message = args.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !message.isEmpty else {
                return .executed(message: SlashSkillFormatter.detailMessage(for: skill))
            }

            let commandText = "/\(skill.slashName) \(message)"
            let sent = await sendMessage(commandText)
            if sent {
                return .executed(message: nil)
            }
            return .unsupported(friendlyMessage: sendErrorMessage ?? String(localized: "Could not send the skill message."))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func skillSuggestionsForSlashCommand() async throws -> [SkillSlashSuggestion] {
        try await skillSlashSuggestionsLoadTask().value
        return skillSlashSuggestions
    }

    private func branchSessionFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to fork a conversation."))
        }

        guard canBranch else {
            return .unsupported(friendlyMessage: String(localized: "This conversation can't be forked."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before forking."))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        let title = args.trimmingCharacters(in: .whitespacesAndNewlines)

        isForkingMessage = true
        messageActionErrorMessage = nil
        lastError = nil
        sendErrorMessage = nil
        defer { isForkingMessage = false }

        do {
            let response = try await client.branchSession(
                id: sessionID,
                title: title.isEmpty ? nil : title
            )

            guard let forkedSessionID = response.sessionId else {
                return .unsupported(
                    friendlyMessage: response.error ?? String(localized: "The server did not return the forked session ID.")
                )
            }

            let forkedResponse = try await client.session(
                id: forkedSessionID,
                includeMessages: false,
                messageLimit: nil
            )

            guard let forkedSessionDetail = forkedResponse.session else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return the forked session."))
            }

            return .openedSession(SessionSummary(from: forkedSessionDetail))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func createSessionFromSlashCommand() async -> SlashCommandExecutionResult {
        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to start a new session."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before starting a new session."))
        }

        isUpdatingComposerConfiguration = true
        lastError = nil
        sendErrorMessage = nil
        composerConfigurationErrorMessage = nil
        defer { isUpdatingComposerConfiguration = false }

        do {
            let response = try await client.createSession(
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName
            )

            guard let session = response.session else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return the new session."))
            }

            return .openedSession(SessionSummary(from: session))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func compressSessionFromSlashCommand(_ args: String) async -> SlashCommandExecutionResult {
        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to compress context."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before compressing context."))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        let focusTopic = args.trimmingCharacters(in: .whitespacesAndNewlines)

        isCompressingSession = true
        lastError = nil
        sendErrorMessage = nil
        messageActionErrorMessage = nil
        defer { isCompressingSession = false }

        do {
            let response = try await client.compressSession(
                id: sessionID,
                focusTopic: focusTopic.isEmpty ? nil : focusTopic
            )

            if let error = response.error {
                return .unsupported(friendlyMessage: error)
            }

            guard let session = response.session else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return the compressed session."))
            }

            applyReadOnlyState(from: session)
            applyCompressionAnchorMetadata(from: session)
            messages = session.messages ?? []
            updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
            isViewingCachedData = false
            let snapshot = ContextWindowSnapshot(
                contextLength: session.contextLength,
                thresholdTokens: session.thresholdTokens,
                lastPromptTokens: session.lastPromptTokens,
                inputTokens: session.inputTokens,
                outputTokens: session.outputTokens,
                estimatedCost: session.estimatedCost
            )
            contextWindowSnapshot = snapshot.replacingTokensUsed(response.summary?.compressedTokenEstimate)
            if let title = session.title {
                displayTitle = Self.displayTitle(from: title)
            }
            currentWorkspace = session.workspace ?? currentWorkspace
            currentModel = session.model ?? currentModel
            currentModelProvider = session.modelProvider ?? currentModelProvider
            currentProfile = session.profile ?? currentProfile
            setCompletedToolCallGroups(ToolCallGroup.groups(
                persistedToolCalls: session.toolCalls ?? [],
                messages: messages,
                messageOffset: messagesOffset
            ))
            completedReasoningGroups = []
            liveAssistantActivity.removeAll()
            streamingAssistantMessageID = nil
            toolCallAnchorMessageID = nil
            reasoningAnchorMessageID = nil
            streamCoordinator.prepareForNewResponse()
            responseCompletionNeedsTranscriptRefresh = false
            attachmentCoordinator.removeAllLocalPreviews()

            let headline = response.summary?.headline?.trimmingCharacters(in: .whitespacesAndNewlines)
            let tokenLine = response.summary?.tokenLine?.trimmingCharacters(in: .whitespacesAndNewlines)
            let focus = response.focusTopic?.trimmingCharacters(in: .whitespacesAndNewlines)
            let details = [headline, tokenLine, focus.map { String(localized: "Focus: \($0)") }]
                .compactMap { value -> String? in
                    guard let value, !value.isEmpty else { return nil }
                    return value
                }
                .joined(separator: "\n")

            if details.isEmpty {
                return .executed(message: String(localized: "Context compressed."))
            }

            return .executed(message: String(localized: "Context compressed.\n\n\(details)"))
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func undoLastExchangeFromSlashCommand() async -> SlashCommandExecutionResult {
        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to undo messages."))
        }

        guard !isCLISession else {
            return .unsupported(friendlyMessage: String(localized: "Undo is available for WebUI sessions only."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before undoing messages."))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        lastError = nil
        sendErrorMessage = nil

        do {
            let response = try await client.undoSession(id: sessionID)
            if let error = response.error {
                return .unsupported(friendlyMessage: error)
            }

            await loadMessages()
            if let lastError {
                return .unsupported(friendlyMessage: lastError.localizedDescription)
            }

            return .executed(message: nil)
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func retryLastTurnFromSlashCommand() async -> SlashCommandExecutionResult {
        guard !isViewingCachedData else {
            return .unsupported(friendlyMessage: String(localized: "Reconnect to the server to retry messages."))
        }

        guard !isCLISession else {
            return .unsupported(friendlyMessage: String(localized: "Retry is available for WebUI sessions only."))
        }

        guard activeStreamID == nil else {
            return .unsupported(friendlyMessage: String(localized: "Wait for the current response to finish before retrying messages."))
        }

        guard let sessionID else {
            return .unsupported(friendlyMessage: String(localized: "The server did not provide a session ID."))
        }

        isStartingChat = true
        lastError = nil
        sendErrorMessage = nil
        archiveLiveActivityIfNeeded()
        liveAssistantActivity.removeAll()
        reasoningAnchorMessageID = nil
        toolCallAnchorMessageID = nil
        streamCoordinator.prepareForNewResponse()
        responseCompletionNeedsTranscriptRefresh = false
        defer { isStartingChat = false }

        do {
            let retryResponse = try await client.retrySession(id: sessionID)
            if let error = retryResponse.error {
                return .unsupported(friendlyMessage: error)
            }
            streamCoordinator.invalidateSessionLoads()

            let lastUserText = retryResponse.lastUserText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !lastUserText.isEmpty else {
                return .unsupported(friendlyMessage: String(localized: "The server did not return a message to retry."))
            }

            // Post-retry reload is NOT treated as a cold load (issue #168 non-goal): the
            // user already has the transcript in view, so keep the raw msg_limit cap and
            // leave expandRenderable at its default false.
            let sessionResponse = try await client.session(
                id: sessionID,
                includeMessages: true,
                messageLimit: Self.messagePageLimit
            )
            if let session = sessionResponse.session {
                messages = session.messages ?? []
                updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
                setCompletedToolCallGroups(ToolCallGroup.groups(
                    persistedToolCalls: session.toolCalls ?? [],
                    messages: messages,
                    messageOffset: messagesOffset
                ))
                completedReasoningGroups = []
            } else {
                await loadMessages()
                if let lastError {
                    return .unsupported(friendlyMessage: lastError.localizedDescription)
                }
            }

            archiveLiveActivityIfNeeded()
            liveAssistantActivity.removeAll()
            toolCallAnchorMessageID = nil
            reasoningAnchorMessageID = nil
            attachmentCoordinator.removeAllLocalPreviews()

            let explicitModelPick = explicitModelPickForChatStart()
            let sentAt = Date()
            let chatResponse = try await client.startChat(
                sessionID: sessionID,
                message: lastUserText,
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName,
                explicitModelPick: explicitModelPick
            )

            guard let streamID = chatResponse.streamId else {
                return .unsupported(friendlyMessage: chatResponse.error ?? String(localized: "The server did not return a stream ID after retrying."))
            }

            completeExplicitModelPickForChatStart(explicitModelPick)
            messages.append(
                ChatMessage(
                    role: "user",
                    content: lastUserText,
                    timestamp: Date().timeIntervalSince1970,
                    messageId: "local-\(UUID().uuidString)"
                )
            )

            streamCoordinator.start(
                streamID: streamID,
                armsAggregateForLocalWork: true,
                runStartedAt: chatResponse.runStartedAt(sentAt: sentAt)
            )
            return .executed(message: nil)
        } catch {
            lastError = error
            return .unsupported(friendlyMessage: error.localizedDescription)
        }
    }

    private func canRunConfigurationSlashCommand(_ actionDescription: String) -> Bool {
        if isViewingCachedData {
            composerConfigurationErrorMessage = String(localized: "Reconnect to the server to \(actionDescription).")
            return false
        }

        if activeStreamID != nil {
            composerConfigurationErrorMessage = String(localized: "Wait for the current response to finish before you \(actionDescription).")
            return false
        }

        return true
    }

    private func modelOption(matching query: String) -> ModelCatalogOption? {
        let normalizedQuery = query.lowercased()
        let options = modelCatalogGroups.flatMap(\.slashAutocompleteModels)

        if let exact = options.first(where: { $0.id.lowercased() == normalizedQuery }) {
            return exact
        }

        return options.first {
            $0.id.lowercased().contains(normalizedQuery) ||
            $0.displayName.lowercased().contains(normalizedQuery)
        }
    }

    private func workspacePath(matching query: String) -> String? {
        let normalizedQuery = query.lowercased()
        let roots = workspaceRoots.compactMap { root -> (path: String, name: String?)? in
            guard let path = root.path, !path.isEmpty else { return nil }
            return (path, root.name)
        }

        if let exact = roots.first(where: { $0.path.lowercased() == normalizedQuery }) {
            return exact.path
        }

        return roots.first {
            $0.path.lowercased().contains(normalizedQuery) ||
            ($0.name?.lowercased().contains(normalizedQuery) == true)
        }?.path
    }

    @discardableResult
    func appendLocalAssistantMessage(_ text: String) -> String? {
        appendLocalMessage(text, role: "local_assistant", idPrefix: "local-slash")
    }

    @discardableResult
    func appendLocalNoticeMessage(_ text: String) -> String? {
        appendLocalMessage(text, role: "local_notice", idPrefix: "local-notice")
    }

    func pinLocalNoticeMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        pinnedLocalNotices.append(trimmed)
    }

    private func appendSteeringHint(
        _ text: String
    ) -> (messageID: String, precedingAssistantMessageID: String?, timestamp: Double) {
        flushPendingStreamingContent()
        archiveLiveActivityIfNeeded()
        liveAssistantActivity.removeAll()
        pendingReasoningTitles = []
        let precedingAssistantMessageID = streamingAssistantMessageID
        streamingAssistantMessageID = nil
        toolCallAnchorMessageID = nil
        reasoningAnchorMessageID = nil

        let messageID = "local-steer-\(UUID().uuidString)"
        let timestamp = Date().timeIntervalSince1970
        messages.append(ChatMessage(
            role: "user",
            content: text,
            timestamp: timestamp,
            messageId: messageID,
            name: SteeringHintState.sending.rawValue
        ))
        scheduleStreamingScrollTrigger()
        return (messageID, precedingAssistantMessageID, timestamp)
    }

    private func finalizeSteeringPhase(assistantMessageID: String?, endingAt timestamp: Double) {
        guard let assistantMessageID,
              let index = messages.firstIndex(where: { $0.messageId == assistantMessageID }),
              let startedAt = messages[index].timestamp
        else { return }

        messages[index] = messages[index].applyingTurnMetrics(
            duration: max(0, timestamp - startedAt)
        )
    }

    private func updateSteeringHint(id: String, state: SteeringHintState) {
        guard let index = messages.firstIndex(where: { $0.messageId == id }),
              let currentState = messages[index].steeringHintState,
              currentState != .consumed
        else { return }

        messages[index] = Self.steeringHintMessage(messages[index], state: state)
    }

    private func removeSteeringHint(id: String) {
        messages.removeAll { $0.messageId == id && $0.isLocalSteeringHint }
    }

    private func settleAcceptedSteeringHints() {
        for index in messages.indices where messages[index].steeringHintState == .waiting {
            messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
        }
    }

    @discardableResult
    private func consumeSteeringHint(id: String?, text: String) -> Bool {
        if let id,
           let index = messages.firstIndex(where: { $0.messageId == id && $0.isLocalSteeringHint }) {
            messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
            return true
        }
        guard let index = messages.firstIndex(where: {
            $0.isLocalSteeringHint && $0.content == text && $0.steeringHintState == .waiting
        }) else { return false }
        messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
        return true
    }

    private func removeUnresolvedSteeringHints() {
        messages.removeAll { message in
            message.steeringHintState == .sending || message.steeringHintState == .waiting
        }
    }

    private func removeLeftoverSteeringHints(matching text: String) {
        let candidates = messages.enumerated().filter { entry in
            entry.element.steeringHintState == .sending || entry.element.steeringHintState == .waiting
        }
        guard !candidates.isEmpty else { return }

        for start in candidates.indices {
            let suffix = candidates[start...]
                .compactMap { $0.element.content }
                .joined(separator: "\n")
            guard suffix == text else { continue }
            let ids = Set(candidates[start...].compactMap { $0.element.messageId })
            messages.removeAll { message in
                message.messageId.map(ids.contains) == true
            }
            return
        }

        if let exactID = candidates.first(where: { $0.element.content == text })?.element.messageId {
            removeSteeringHint(id: exactID)
        }
    }

    nonisolated private static func steeringHintMessage(
        _ message: ChatMessage,
        state: SteeringHintState
    ) -> ChatMessage {
        ChatMessage(
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            messageId: message.messageId,
            name: state.rawValue,
            toolCallId: message.toolCallId,
            toolUseId: message.toolUseId,
            toolCalls: message.toolCalls,
            contentParts: message.contentParts,
            reasoning: message.reasoning,
            reasoningTitles: message.reasoningTitles,
            activityScene: message.activityScene,
            attachments: message.attachments,
            turnDuration: message.turnDuration,
            turnTps: message.turnTps,
            turnId: message.turnId,
            steer: message.steer
        )
    }

    private func appendLocalMessage(_ text: String, role: String, idPrefix: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let messageID = "\(idPrefix)-\(UUID().uuidString)"
        messages.append(
            ChatMessage(
                role: role,
                content: trimmed,
                timestamp: Date().timeIntervalSince1970,
                messageId: messageID
            )
        )
        scheduleStreamingScrollTrigger()
        return messageID
    }

    private func updateLocalMessage(id: String, content: String) {
        guard let index = messages.firstIndex(where: { $0.messageId == id }) else { return }
        let existing = messages[index]
        messages[index] = ChatMessage(
            role: existing.role,
            content: content,
            timestamp: existing.timestamp,
            messageId: existing.messageId,
            name: existing.name,
            toolCallId: existing.toolCallId,
            toolUseId: existing.toolUseId,
            toolCalls: existing.toolCalls,
            contentParts: existing.contentParts,
            reasoning: existing.reasoning,
            reasoningTitles: existing.reasoningTitles,
            activityScene: existing.activityScene,
            attachments: existing.attachments,
            turnDuration: existing.turnDuration,
            turnTps: existing.turnTps,
            turnId: existing.turnId,
            steer: existing.steer
        )
        scheduleStreamingScrollTrigger()
    }

    func setSendErrorMessage(_ message: String?) {
        sendErrorMessage = message
    }

    func forkFromMessage(_ context: MessageActionContext, modelContext: ModelContext? = nil) async -> SessionSummary? {
        guard !isViewingCachedData else {
            messageActionErrorMessage = String(localized: "Reconnect to the server to fork a conversation.")
            return nil
        }

        guard canBranch else {
            messageActionErrorMessage = String(localized: "This conversation can't be forked.")
            return nil
        }

        guard activeStreamID == nil else {
            messageActionErrorMessage = String(localized: "Wait for the current response to finish before forking.")
            return nil
        }

        guard let sessionID else {
            messageActionErrorMessage = String(localized: "The server did not provide a session ID.")
            return nil
        }

        isForkingMessage = true
        messageActionErrorMessage = nil
        lastError = nil
        defer { isForkingMessage = false }

        do {
            let response = try await client.branchSession(
                id: sessionID,
                keepCount: context.keepCountThroughMessage
            )

            guard let forkedSessionID = response.sessionId else {
                messageActionErrorMessage = response.error ?? String(localized: "The server did not return the forked session ID.")
                return nil
            }

            let forkedResponse = try await client.session(
                id: forkedSessionID,
                includeMessages: false,
                messageLimit: nil
            )

            guard let forkedSessionDetail = forkedResponse.session else {
                messageActionErrorMessage = String(localized: "The server did not return the forked session.")
                return nil
            }

            let forkedSession = SessionSummary(from: forkedSessionDetail)
            if let modelContext {
                do {
                    try CacheStore.cacheSession(forkedSession, serverURL: server, in: modelContext)
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }
            return forkedSession
        } catch {
            lastError = error
            messageActionErrorMessage = error.localizedDescription
            return nil
        }
    }

    /// Edit a user message: truncate to just before the selected message, then send the edited text.
    func editMessage(_ context: MessageActionContext, newText: String, modelContext: ModelContext? = nil) async -> Bool {
        guard context.role == .user else {
            messageActionErrorMessage = String(localized: "Only user messages can be edited.")
            return false
        }

        guard !isViewingCachedData else {
            messageActionErrorMessage = String(localized: "Reconnect to the server to edit a message.")
            return false
        }

        guard !isSessionReadOnly else {
            messageActionErrorMessage = String(localized: "This session is view-only and can't be edited.")
            return false
        }

        guard activeStreamID == nil else {
            messageActionErrorMessage = String(localized: "Wait for the current response to finish before editing.")
            return false
        }

        guard let sessionID else {
            messageActionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        let editedText = newText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !editedText.isEmpty else {
            messageActionErrorMessage = String(localized: "The edited message cannot be empty.")
            return false
        }

        isEditingMessage = true
        messageActionErrorMessage = nil
        lastError = nil
        defer { isEditingMessage = false }

        do {
            // Truncate to remove the selected user message and everything after it
            let truncateResponse = try await client.truncateSession(
                id: sessionID,
                keepCount: context.fullHistoryIndex
            )

            // Update local state from the truncated response
            if let session = truncateResponse.session {
                messages = session.messages ?? []
                updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
                setCompletedToolCallGroups(ToolCallGroup.groups(
                    persistedToolCalls: session.toolCalls ?? [],
                    messages: messages,
                    messageOffset: messagesOffset
                ))
                completedReasoningGroups = []
                liveAssistantActivity.removeAll()
                toolCallAnchorMessageID = nil
                reasoningAnchorMessageID = nil

                if let modelContext {
                    do {
                        try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
                    } catch {
                        cacheErrorMessage = error.localizedDescription
                    }
                }
            }

            // Now send the edited text through the normal chat flow
            let explicitModelPick = explicitModelPickForChatStart()
            let sentAt = Date()
            let chatResponse = try await client.startChat(
                sessionID: sessionID,
                message: editedText,
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName,
                explicitModelPick: explicitModelPick
            )

            guard let streamID = chatResponse.streamId else {
                messageActionErrorMessage = chatResponse.error ?? String(localized: "The server did not return a stream ID after editing.")
                return false
            }

            completeExplicitModelPickForChatStart(explicitModelPick)
            // Append the optimistic user message
            messages.append(
                ChatMessage(
                    role: "user",
                    content: editedText,
                    timestamp: Date().timeIntervalSince1970,
                    messageId: "local-\(UUID().uuidString)"
                )
            )

            streamCoordinator.prepareForNewResponse()
            responseCompletionNeedsTranscriptRefresh = false
            streamCoordinator.start(
                streamID: streamID,
                armsAggregateForLocalWork: true,
                runStartedAt: chatResponse.runStartedAt(sentAt: sentAt)
            )
            return true
        } catch {
            lastError = error
            messageActionErrorMessage = error.localizedDescription
            return false
        }
    }

    func regenerateAssistantResponse(
        _ context: MessageActionContext,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        guard context.role == .assistant else {
            messageActionErrorMessage = String(localized: "Only assistant messages can be regenerated.")
            return false
        }

        guard !isViewingCachedData else {
            messageActionErrorMessage = String(localized: "Reconnect to the server to regenerate a response.")
            return false
        }

        guard !isSessionReadOnly else {
            messageActionErrorMessage = String(localized: "This session is view-only and can't be regenerated.")
            return false
        }

        guard activeStreamID == nil else {
            messageActionErrorMessage = String(localized: "Wait for the current response to finish before regenerating.")
            return false
        }

        guard let sessionID else {
            messageActionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }

        guard let userText = Self.precedingUserMessageText(in: messages, beforeVisibleIndex: context.visibleIndex) else {
            messageActionErrorMessage = String(localized: "Load older messages before regenerating this response.")
            return false
        }

        isRegeneratingMessage = true
        messageActionErrorMessage = nil
        lastError = nil
        stopListening()
        defer { isRegeneratingMessage = false }

        do {
            let truncateResponse = try await client.truncateSession(
                id: sessionID,
                keepCount: context.fullHistoryIndex
            )

            if let session = truncateResponse.session {
                messages = session.messages ?? []
                updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
                setCompletedToolCallGroups(ToolCallGroup.groups(
                    persistedToolCalls: session.toolCalls ?? [],
                    messages: messages,
                    messageOffset: messagesOffset
                ))
                completedReasoningGroups = []
                liveAssistantActivity.removeAll()
                toolCallAnchorMessageID = nil
                reasoningAnchorMessageID = nil

                if let modelContext {
                    do {
                        try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
                    } catch {
                        cacheErrorMessage = error.localizedDescription
                    }
                }
            }

            let explicitModelPick = explicitModelPickForChatStart()
            let sentAt = Date()
            let chatResponse = try await client.startChat(
                sessionID: sessionID,
                message: userText,
                workspace: currentWorkspace,
                model: currentModel,
                modelProvider: requestModelProvider,
                profile: requestProfileName,
                explicitModelPick: explicitModelPick
            )

            guard let streamID = chatResponse.streamId else {
                messageActionErrorMessage = chatResponse.error ?? String(localized: "The server did not return a stream ID after regenerating.")
                return false
            }

            completeExplicitModelPickForChatStart(explicitModelPick)
            streamCoordinator.prepareForNewResponse()
            responseCompletionNeedsTranscriptRefresh = false
            streamCoordinator.start(
                streamID: streamID,
                armsAggregateForLocalWork: true,
                runStartedAt: chatResponse.runStartedAt(sentAt: sentAt)
            )
            return true
        } catch {
            lastError = error
            messageActionErrorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func cancelActiveStream() async -> Bool {
        guard activeStreamID != nil else { return false }

        isCancellingStream = true
        sendErrorMessage = nil
        lastError = nil
        defer { isCancellingStream = false }

        do {
            guard let response = try await streamCoordinator.cancelActiveStream() else { return false }
            if response.ok == false {
                sendErrorMessage = response.error ?? String(localized: "The server could not stop the current response.")
                return false
            }

            removeUnresolvedSteeringHints()
            // The server settled the turn before answering; its scene, not the stopped live view, is what stays.
            await loadMessages()
            return true
        } catch {
            lastError = error
            sendErrorMessage = error.localizedDescription
            return false
        }
    }

    func clearMessageActionError() {
        messageActionErrorMessage = nil
    }

    func toggleListening(to context: MessageActionContext) {
        guard context.role == .assistant else { return }

        guard let listenText = context.listenText else {
            messageActionErrorMessage = String(localized: "There is no assistant text to listen to.")
            return
        }

        // Tapping the message that is already listening — fetching server audio or
        // playing on either engine — toggles it off. Matching on `listeningMessageID`
        // alone (not `isSpeaking`) also debounces rapid double-taps: the second tap
        // stops cleanly instead of firing a second `/api/tts` call into the server's
        // ~2 s rate limit or stacking audio (#15).
        if listeningMessageID == context.messageID {
            stopListening()
            return
        }

        stopListening()
        // The audio session is NOT activated here: `/api/tts` can be slow or
        // unreachable, and activating the non-mixable playback session before the
        // fetch would silence other audio while Talaria has nothing to play (review
        // on #35). Activation happens at the two playback-start points instead —
        // `startServerAudioPlayback` and `speakWithOnDeviceSynthesizer`.
        listeningMessageID = context.messageID
        beginListenPlaybackPreparation(for: context)

        guard ServerTTSPolicy.shouldUseServerTTS(for: listenText) else {
            // Over the server's 5000-char request cap: go straight to the on-device
            // path (chunking is a non-goal of #15).
            clearListenPlaybackState()
            speakWithOnDeviceSynthesizer(listenText)
            return
        }

        // Prefer the server's neural TTS; on any failure (offline, 4xx/5xx, rate
        // limit, undecodable audio) fall back silently to the on-device
        // synthesizer — no error alert (#15).
        let requestID = UUID()
        activeListenRequestID = requestID
        listenPreparationTask = Task { [weak self, client] in
            guard !Task.isCancelled else {
                // Stopped before the fetch began (e.g. a rapid second tap): skip
                // the request entirely instead of issuing one whose response
                // would be dropped anyway.
                return
            }
            let audioData: Data?
            do {
                audioData = try await client.synthesizeSpeech(
                    text: listenText,
                    voice: ServerTTSPolicy.defaultVoice
                )
            } catch {
                audioData = nil
            }

            guard let self, !Task.isCancelled, self.activeListenRequestID == requestID else {
                // Stopped or superseded while the fetch was in flight — the user no
                // longer wants this audio; never start playback from a stale response.
                return
            }

            if let audioData, self.startServerAudioPlayback(audioData, title: self.listenPlaybackTitle) {
                return
            }
            self.clearListenPlaybackState()
            self.speakWithOnDeviceSynthesizer(listenText)
        }
    }

    func stopListening() {
        // Cancel any in-flight server-TTS fetch so a late response can't start
        // audio after the user asked to stop (or switched messages).
        listenPreparationTask?.cancel()
        listenPreparationTask = nil
        activeListenRequestID = nil

        // `AVAudioPlayer.stop()` does not fire the finish delegate, so no stale
        // callback follows; state is torn down synchronously in `finishListening()`.
        listenAudioPlayer?.stop()

        if let speechSynthesizer, speechSynthesizer.isSpeaking || speechSynthesizer.isPaused {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        finishListening()
    }

    func toggleListenPlaybackPlayPause() {
        switch listenPlaybackPhase {
        case .playing:
            pauseListenPlayback()
        case .paused:
            resumeListenPlayback()
        case .idle, .loading:
            break
        }
    }

    func setListenPlaybackSpeed(_ speed: ListenPlaybackSpeed) {
        guard listenPlaybackSpeed != speed else { return }
        listenPlaybackSpeed = speed
        userDefaults.set(speed.rawValue, forKey: ListenPlaybackSpeed.storageKey)
        listenAudioPlayer?.rate = Float(speed.rawValue)
        updateListenNowPlaying()
    }

    func scrubListenPlayback(to time: TimeInterval) {
        listenPlaybackScrubTime = boundedListenPlaybackTime(time)
    }

    func setListenPlaybackScrubbing(_ scrubbing: Bool) {
        if scrubbing {
            listenPlaybackScrubTime = listenPlaybackElapsedTime
        } else if let target = listenPlaybackScrubTime {
            seekListenPlayback(to: target)
            listenPlaybackScrubTime = nil
        }
    }

    func refreshListenPlaybackProgressAfterSceneActivation() {
        guard listenPlaybackPhase == .playing || listenPlaybackPhase == .paused else { return }

        updateListenPlaybackProgressFromPlayer()
        if listenPlaybackPhase == .playing {
            startListenPlaybackTicker()
        }
    }

    func suspendStreamForBackground() {
        suspendActiveStreamConnection()
    }

    func suspendStreamForNavigation() {
        suspendActiveStreamConnection()
    }

    func cleanupPollingTasks() {
        stopBackgroundPolling(clearTrackedPrompts: true)
        pendingActionCoordinator.stopMonitoring(clearPrompt: true)
    }

    private func suspendActiveStreamConnection() {
        streamCoordinator.suspendActiveStreamConnection()
    }

    func reconnectStreamIfNeeded(modelContext: ModelContext? = nil) async {
        await streamCoordinator.reconnectIfNeeded(modelContext: modelContext)
    }

    func refreshTranscriptIfActiveStreamCompleted(
        streamID expectedStreamID: String,
        modelContext: ModelContext? = nil
    ) async {
        await streamCoordinator.refreshTranscriptIfCompleted(
            streamID: expectedStreamID,
            modelContext: modelContext
        )
    }

    func recoverStaleActiveStreamIfNeeded(
        now: Date = Date(),
        modelContext: ModelContext? = nil
    ) async {
        await streamCoordinator.recoverStaleStreamIfNeeded(now: now, modelContext: modelContext)
    }

    private var hasRunningLiveToolCall: Bool {
        liveToolCalls.contains { !$0.isCompleted }
    }

    private func saveActiveStreamSnapshotIfNeeded() {
        guard let sessionID,
              let activeStreamID,
              !hasCompletedCurrentResponse
        else { return }

        ActiveChatStreamSnapshotStore.shared.save(
            ActiveChatStreamSnapshot(
                messages: messages,
                messagesOffset: messagesOffset,
                displayTitle: displayTitle,
                completedToolCallGroups: completedToolCallGroups,
                completedReasoningGroups: completedReasoningGroups,
                liveAssistantActivity: liveAssistantActivity,
                activeStreamLastEventID: streamCoordinator.lastEventID,
                streamingAssistantMessageID: streamingAssistantMessageID,
                toolCallAnchorMessageID: toolCallAnchorMessageID,
                reasoningAnchorMessageID: reasoningAnchorMessageID,
                contextWindowSnapshot: contextWindowSnapshot,
                localAttachmentPreviews: attachmentCoordinator.localAttachmentPreviews,
                pinnedLocalNotices: pinnedLocalNotices
            ),
            server: server,
            sessionID: sessionID,
            streamID: activeStreamID
        )
    }

    @discardableResult
    private func restoreActiveStreamSnapshotIfAvailable(streamID: String) -> String? {
        guard let sessionID,
              let snapshot = ActiveChatStreamSnapshotStore.shared.snapshot(
                server: server,
                sessionID: sessionID,
                streamID: streamID
              )
        else { return nil }

        let merge = Self.mergingLoadedMessages(messages, withActiveStreamSnapshot: snapshot)
        messages = merge.messages
        if merge.usedSnapshotMessagesOffset {
            messagesOffset = snapshot.messagesOffset
            hasOlderMessages = snapshot.messagesOffset > 0
        }
        displayTitle = displayTitle.isEmpty ? snapshot.displayTitle : displayTitle
        setCompletedToolCallGroups(snapshot.completedToolCallGroups)
        completedReasoningGroups = snapshot.completedReasoningGroups
        liveAssistantActivity = snapshot.liveAssistantActivity
        // A snapshot taken before the run streamed anything names no live message; the
        // caller then picks the target from the load (TAL-316), not the merge's guess.
        streamingAssistantMessageID = snapshot.streamingAssistantMessageID == nil
            ? nil
            : merge.streamingAssistantMessageID ?? snapshot.streamingAssistantMessageID
        toolCallAnchorMessageID = Self.remappedAnchorMessageID(
            snapshot.toolCallAnchorMessageID,
            from: snapshot.streamingAssistantMessageID,
            to: streamingAssistantMessageID
        )
        reasoningAnchorMessageID = Self.remappedAnchorMessageID(
            snapshot.reasoningAnchorMessageID,
            from: snapshot.streamingAssistantMessageID,
            to: streamingAssistantMessageID
        )
        contextWindowSnapshot = contextWindowSnapshot ?? snapshot.contextWindowSnapshot
        attachmentCoordinator.mergeLocalAttachmentPreviews(snapshot.localAttachmentPreviews)
        pinnedLocalNotices = snapshot.pinnedLocalNotices
        scheduleStreamingScrollTrigger()
        return snapshot.activeStreamLastEventID
    }

    private func removeActiveStreamSnapshot(streamID: String?) {
        guard let sessionID,
              let streamID
        else { return }

        ActiveChatStreamSnapshotStore.shared.remove(
            server: server,
            sessionID: sessionID,
            streamID: streamID
        )
    }

    @discardableResult
    func respondToApproval(_ choice: ApprovalChoice) async -> Bool {
        await pendingActionCoordinator.respondToApproval(choice)
    }

    @discardableResult
    func skipApprovalsForCurrentSession() async -> Bool {
        await pendingActionCoordinator.skipApprovalsForCurrentSession()
    }

    func applyApprovalUpdate(_ update: ApprovalPendingResponse, sessionID: String) {
        pendingActionCoordinator.applyApprovalUpdate(update, sessionID: sessionID)
    }

    @discardableResult
    func respondToClarification(_ responseText: String) async -> Bool {
        await pendingActionCoordinator.respondToClarification(responseText)
    }

    func applyClarificationUpdate(_ update: ClarificationPendingResponse, sessionID: String) {
        pendingActionCoordinator.applyClarificationUpdate(update, sessionID: sessionID)
    }

    private func startBtwStream(streamID: String, question: String) {
        activeBtwStreamID = streamID
        activeBtwQuestion = question
        activeBtwAnswer = ""
        activeBtwMessageID = appendLocalAssistantMessage(Self.btwMessageText(question: question, answer: nil, isLoading: true))

        btwStreamClient.start(url: client.chatStreamURL(streamID: streamID)) { [weak self] event in
            self?.handleBtwStreamEvent(event)
        }
    }

    private func handleBtwStreamEvent(_ event: SSEEvent) {
        switch event {
        case .token(let text):
            activeBtwAnswer += text
            updateActiveBtwMessage(isLoading: true)
        case .interimAssistant(let payload):
            guard payload.alreadyStreamed != true else { break }
            let text = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { break }
            if activeBtwAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                activeBtwAnswer = text
            } else {
                activeBtwAnswer += "\n\n\(text)"
            }
            updateActiveBtwMessage(isLoading: true)
        case .done:
            updateActiveBtwMessage(isLoading: false)
        case .approvalPending, .clarificationPending, .settledSession:
            break
        case .streamEnd, .cancelled:
            finishBtwStream()
        case .error(let message, _):
            activeBtwAnswer = "Error: \(message)"
            updateActiveBtwMessage(isLoading: false)
            finishBtwStream()
        case .transportError(let message):
            activeBtwAnswer = "Error: \(message)"
            updateActiveBtwMessage(isLoading: false)
            finishBtwStream()
        case .heartbeat, .ignored, .reasoning, .toolStarted, .toolCompleted, .title, .metering, .steerConsumed, .pendingSteerLeftover:
            break
        }
    }

    private func updateActiveBtwMessage(isLoading: Bool) {
        guard let activeBtwMessageID, let activeBtwQuestion else { return }
        updateLocalMessage(
            id: activeBtwMessageID,
            content: Self.btwMessageText(
                question: activeBtwQuestion,
                answer: activeBtwAnswer,
                isLoading: isLoading
            )
        )
    }

    private func finishBtwStream() {
        btwStreamClient.stop()
        activeBtwStreamID = nil
        activeBtwMessageID = nil
        activeBtwQuestion = nil
        activeBtwAnswer = ""
    }

    private func stopBackgroundPolling(clearTrackedPrompts: Bool) {
        backgroundPollTask?.cancel()
        backgroundPollTask = nil
        if clearTrackedPrompts {
            backgroundPromptsByTaskID.removeAll()
        }
    }

    private func startBackgroundPollingIfNeeded(parentSessionID: String) {
        guard backgroundPollTask == nil else { return }

        let pollingInterval = pollingIntervals.backgroundNanoseconds
        backgroundPollTask = Task { @MainActor [weak self] in
            pollingLoop: while !Task.isCancelled {
                do {
                    guard let self,
                          !self.backgroundPromptsByTaskID.isEmpty
                    else { break pollingLoop }

                    do {
                        let response = try await self.client.backgroundStatus(sessionID: parentSessionID)
                        self.handleBackgroundResults(response.results ?? [])
                    } catch {
                        self.lastError = error
                    }

                    guard !Task.isCancelled, !self.backgroundPromptsByTaskID.isEmpty else {
                        break pollingLoop
                    }
                }

                try? await Task.sleep(nanoseconds: pollingInterval)
            }

            if !Task.isCancelled {
                self?.backgroundPollTask = nil
            }
        }
    }

    private func handleBackgroundResults(_ results: [BackgroundResult]) {
        for result in results {
            let prompt: String
            if let taskID = result.taskId,
               let trackedPrompt = backgroundPromptsByTaskID.removeValue(forKey: taskID) {
                prompt = trackedPrompt
            } else if let resultPrompt = result.prompt, !resultPrompt.isEmpty {
                prompt = resultPrompt
            } else {
                prompt = "Background task"
            }

            appendLocalAssistantMessage(
                Self.backgroundResultText(
                    prompt: prompt,
                    answer: result.answer
                )
            )
        }
    }

    @discardableResult
    private func appendInterimAssistant(_ payload: InterimAssistantStreamEvent) -> Bool {
        guard payload.alreadyStreamed != true else { return false }

        let text = payload.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return false }

        flushPendingStreamingContent()
        pendingReasoningTitles = []

        if let streamingAssistantMessageID,
           let index = messages.firstIndex(where: { $0.messageId == streamingAssistantMessageID }) {
            let existing = messages[index]
            let currentContent = existing.content ?? ""
            let shouldUseSeparator = currentContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            let separator = shouldUseSeparator ? "\n\n" : ""
            messages[index] = ChatMessage(
                role: existing.role,
                content: currentContent + separator + text,
                timestamp: existing.timestamp,
                messageId: existing.messageId,
                name: existing.name,
                toolCallId: existing.toolCallId,
                toolUseId: existing.toolUseId,
                toolCalls: existing.toolCalls,
                contentParts: existing.contentParts,
                reasoning: existing.reasoning,
                reasoningTitles: existing.reasoningTitles,
                activityScene: existing.activityScene,
                attachments: existing.attachments,
                turnDuration: existing.turnDuration,
                turnTps: existing.turnTps,
                turnId: existing.turnId,
                steer: existing.steer
            )
            liveAssistantActivity.appendProse(separator + text)
            scheduleStreamingScrollTrigger()
            return true
        }

        return appendAssistantToken(text)
    }

    private func applyCompletedStreamSession(_ completedSession: SessionDetail) {
        if let completedSessionID = completedSession.sessionId,
           let sessionID,
           completedSessionID != sessionID {
            return
        }

        applyReadOnlyState(from: completedSession)
        applyCompressionAnchorMetadata(from: completedSession)

        var didApplyCompletedTranscript = false
        if let completedMessages = completedSession.messages,
           !completedMessages.isEmpty {
            let currentTurnStart = messages.lastIndex(where: Self.isOrdinaryUserTurnBoundary) ?? -1
            let currentTurn = messages.dropFirst(currentTurnStart + 1)
            let preservesSteeringTurn = currentTurn.contains(where: \.isLocalSteeringHint)
                && !currentTurn.contains { $0.activityScene?.hasConsumedSteering == true }
            if preservesSteeringTurn {
                archiveLiveActivityIfNeeded()
            }
            let previousMessages = messages
            let previousMessagesOffset = messagesOffset
            let reloadedMessages = Self.mergingLoadedMessages(
                completedMessages,
                withCachedLocalOptimisticMessages: messages
            )
            applyReloadedMessages(
                reloadedMessages,
                from: completedSession,
                previousMessages: previousMessages,
                previousMessagesOffset: previousMessagesOffset
            )
            if !preservesSteeringTurn {
                archiveLiveActivityIfNeeded()
            }
            didApplyCompletedTranscript = true
        }

        if let title = completedSession.title {
            applyLiveActivitySessionTitle(title)
        }

        currentWorkspace = completedSession.workspace ?? currentWorkspace
        currentModel = completedSession.model ?? currentModel
        currentModelProvider = completedSession.modelProvider ?? currentModelProvider
        currentProfile = completedSession.profile ?? currentProfile

        contextWindowSnapshot = ContextWindowSnapshot(
            contextLength: completedSession.contextLength,
            thresholdTokens: completedSession.thresholdTokens,
            lastPromptTokens: completedSession.lastPromptTokens,
            inputTokens: completedSession.inputTokens,
            outputTokens: completedSession.outputTokens,
            estimatedCost: completedSession.estimatedCost
        )
        if didApplyCompletedTranscript || completedSession.toolCalls != nil {
            let rebuiltToolCallGroups = ToolCallGroup.groups(
                persistedToolCalls: completedSession.toolCalls ?? [],
                messages: messages,
                messageOffset: messagesOffset
            )
            if !liveToolCalls.isEmpty {
                let fallbackAnchorMessageID = currentTurnToolCallFallbackAnchorMessageID()
                setCompletedToolCallGroups(ToolCallGroup.merging(
                    primaryGroups: rebuiltToolCallGroups,
                    fallbackGroups: [
                        ToolCallGroup(
                            id: "completed-live-tools-\(fallbackAnchorMessageID ?? "unanchored")",
                            anchorMessageID: fallbackAnchorMessageID,
                            toolCalls: liveToolCalls
                        )
                    ]
                ))
            } else {
                setCompletedToolCallGroups(rebuiltToolCallGroups)
            }
            liveAssistantActivity.removeAll()
        }

        if didApplyCompletedTranscript {
            completedReasoningGroups = []
            toolCallAnchorMessageID = nil
            reasoningAnchorMessageID = nil
            attachmentCoordinator.removeAllLocalPreviews()
            scheduleStreamingScrollTrigger()
        }
    }

    private func setCompletedToolCallGroups(_ groups: [ToolCallGroup]) {
        let lookup = ToolCallGroupAnchorLookup(groups: groups)
        guard completedToolCallGroups != groups else { return }

        completedToolCallGroups = groups
        completedToolCallGroupLookup = lookup
    }

    private func archiveLiveActivityIfNeeded() {
        guard !liveActivityRows.isEmpty else { return }
        archiveLiveReasoningIfNeeded()
        archiveLiveToolCallsIfNeeded()

        let currentAnchors = TranscriptTurnClassifier.currentTurnAssistantAnchorIDs(
            in: messages,
            messageOffset: messagesOffset
        )
        let currentAnchorSet = Set(currentAnchors)
        let anchorMessageID = [
            streamingAssistantMessageID,
            reasoningAnchorMessageID,
            toolCallAnchorMessageID
        ]
            .compactMap { $0 }
            .first(where: currentAnchorSet.contains)
            ?? currentAnchors.last
            ?? Self.latestAssistantAnchorID(in: messages, messageOffset: messagesOffset)
        if let anchorMessageID {
            archivedAssistantActivity[anchorMessageID] = liveActivityRows

            guard let messageIndex = messages.indices.last(where: {
                TranscriptTurnClassifier.anchorID(
                    for: messages[$0],
                    at: $0,
                    messageOffset: messagesOffset
                ) == anchorMessageID
            }) else { return }
            let message = messages[messageIndex]
            guard message.activityScene == nil, message.contentParts == nil else { return }
            messages[messageIndex] = ChatMessage(
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
                messageId: message.messageId,
                name: message.name,
                toolCallId: message.toolCallId,
                toolUseId: message.toolUseId,
                toolCalls: message.toolCalls,
                contentParts: liveAssistantActivity.persistedContentParts,
                reasoning: message.reasoning,
                reasoningTitles: message.reasoningTitles,
                attachments: message.attachments,
                turnDuration: message.turnDuration,
                turnTps: message.turnTps,
                turnId: message.turnId,
                steer: message.steer
            )
        }
    }

    private func appendCompletedToolCallGroup(_ group: ToolCallGroup) {
        setCompletedToolCallGroups(completedToolCallGroups + [group])
    }

    private func archiveLiveToolCallsIfNeeded() {
        guard !liveToolCalls.isEmpty else { return }

        appendCompletedToolCallGroup(
            ToolCallGroup(
                anchorMessageID: toolCallAnchorMessageID,
                toolCalls: liveToolCalls
            )
        )
    }

    private func currentTurnToolCallFallbackAnchorMessageID() -> String? {
        if let toolCallAnchorMessageID,
           messages.enumerated().contains(where: { index, message in
               TranscriptTurnClassifier.anchorID(for: message, at: index, messageOffset: messagesOffset) == toolCallAnchorMessageID
           }) {
            return toolCallAnchorMessageID
        }

        return TranscriptTurnClassifier.currentTurnAssistantAnchorIDs(in: messages, messageOffset: messagesOffset).first
            ?? Self.latestAssistantAnchorID(in: messages, messageOffset: messagesOffset)
    }

    private func archiveLiveReasoningIfNeeded() {
        guard !liveReasoningText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        completedReasoningGroups.append(
            ReasoningGroup(
                anchorMessageID: reasoningAnchorMessageID,
                text: liveReasoningText,
                titles: liveAssistantActivity.latestReasoningTitles
            )
        )
    }

    @discardableResult
    private func ensureStreamingAssistantMessage() -> String {
        if let streamingAssistantMessageID {
            return streamingAssistantMessageID
        }

        let messageID = "stream-\(UUID().uuidString)"
        streamingAssistantMessageID = messageID
        messages.append(
            ChatMessage(
                role: "assistant",
                content: "",
                timestamp: Date().timeIntervalSince1970,
                messageId: messageID
            )
        )
        return messageID
    }

    @discardableResult
    private func appendReasoning(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }

        if !pendingAssistantTokenText.isEmpty {
            flushPendingStreamingContent()
        }

        // Mutate only via the coalesced flush.
        _ = ensureStreamingAssistantMessage()
        pendingReasoningText.append(contentsOf: text)
        scheduleStreamingContentFlush()
        return true
    }

    @discardableResult
    private func appendReasoning(_ payload: ReasoningStreamEvent) -> Bool {
        let titlesChanged = !payload.titles.isEmpty && payload.titles != pendingReasoningTitles
        if !payload.titles.isEmpty {
            pendingReasoningTitles = payload.titles
        }
        if payload.text.isEmpty, !payload.titles.isEmpty {
            if !pendingReasoningText.isEmpty {
                flushPendingStreamingContent()
            }
            return liveAssistantActivity.updateLatestReasoningTitles(payload.titles) || titlesChanged
        }
        return appendReasoning(payload.text) || titlesChanged
    }

    @discardableResult
    private func flushReasoningChunks() -> Bool {
        guard !pendingReasoningText.isEmpty else { return false }

        let appendedText = pendingReasoningText
        pendingReasoningText = ""

        let messageID = ensureStreamingAssistantMessage()
        if reasoningAnchorMessageID == nil {
            reasoningAnchorMessageID = messageID
        }

        liveAssistantActivity.appendReasoning(appendedText, titles: pendingReasoningTitles)
        return true
    }

    @discardableResult
    private func appendToolCall(_ payload: ToolStreamEvent) -> Bool {
        flushPendingStreamingContent()
        pendingReasoningTitles = []

        let messageID = ensureStreamingAssistantMessage()
        if toolCallAnchorMessageID == nil {
            toolCallAnchorMessageID = messageID
        }

        liveAssistantActivity.appendTool(
            ToolCall(
                id: payload.stableID ?? "live-tool-\(UUID().uuidString)",
                name: payload.name,
                preview: payload.preview,
                args: payload.args,
                kind: payload.kind,
                target: payload.target
            )
        )
        scheduleStreamingScrollTrigger()
        return true
    }

    @discardableResult
    private func completeToolCall(_ payload: ToolStreamEvent) -> Bool {
        let messageID = ensureStreamingAssistantMessage()
        if toolCallAnchorMessageID == nil {
            toolCallAnchorMessageID = messageID
        }

        guard let index = liveToolCallCompletionIndex(for: payload) else {
            flushPendingStreamingContent()
            liveAssistantActivity.appendTool(
                ToolCall(
                    id: payload.stableID ?? "live-tool-\(UUID().uuidString)",
                    name: payload.name,
                    preview: payload.preview,
                    args: payload.args,
                    kind: payload.kind,
                    target: payload.target,
                    duration: payload.duration,
                    isError: payload.isError,
                    isCompleted: true
                )
            )
            scheduleStreamingScrollTrigger()
            return true
        }

        _ = liveAssistantActivity.updateTool(at: index) {
            $0.applyingCompletionPayload(payload)
        }
        scheduleStreamingScrollTrigger()
        return true
    }

    private func liveToolCallCompletionIndex(for payload: ToolStreamEvent) -> Int? {
        if let stableID = payload.stableID?.nonEmptyReplayMatchText,
           let stableIndex = liveToolCalls.lastIndex(where: { toolCall in
               !toolCall.isCompleted && toolCall.matchesStableToolID(stableID)
           }) {
            return stableIndex
        }

        return liveToolCalls.lastIndex { toolCall in
            !toolCall.isCompleted && (payload.name == nil || toolCall.name == payload.name)
        }
    }

    @discardableResult
    private func appendAssistantToken(_ token: String) -> Bool {
        guard !token.isEmpty else { return false }

        if !pendingReasoningText.isEmpty {
            flushPendingStreamingContent()
            pendingReasoningTitles = []
        }

        _ = ensureStreamingAssistantMessage()
        pendingAssistantTokenText.append(contentsOf: token)
        scheduleStreamingContentFlush()
        return true
    }

    @discardableResult
    private func flushAssistantTokens(maxWordUnits: Int? = nil) -> Bool {
        guard !pendingAssistantTokenText.isEmpty else { return false }

        // A word-unit limit moves only the head of the buffer into the visible
        // message; the tail stays pending.
        let pendingText = pendingAssistantTokenText
        let appendedContent: String
        if let maxWordUnits {
            let (head, tail) = StreamingWordDrain.splitAtUnitBoundary(pendingText, unitCount: maxWordUnits)
            guard !head.isEmpty else { return false }
            appendedContent = head
            pendingAssistantTokenText = tail
        } else {
            appendedContent = pendingText
            pendingAssistantTokenText = ""
        }

        let messageID = ensureStreamingAssistantMessage()
        if !liveReasoningText.isEmpty && reasoningAnchorMessageID == nil {
            reasoningAnchorMessageID = messageID
        }
        if !liveToolCalls.isEmpty && toolCallAnchorMessageID == nil {
            toolCallAnchorMessageID = messageID
        }

        if let index = messages.firstIndex(where: { $0.messageId == messageID }) {
            let existing = messages[index]
            let updatedMessage = ChatMessage(
                role: existing.role,
                content: (existing.content ?? "") + appendedContent,
                timestamp: existing.timestamp,
                messageId: existing.messageId,
                name: existing.name,
                toolCallId: existing.toolCallId,
                toolUseId: existing.toolUseId,
                toolCalls: existing.toolCalls,
                contentParts: existing.contentParts,
                reasoning: existing.reasoning,
                reasoningTitles: existing.reasoningTitles,
                activityScene: existing.activityScene,
                attachments: existing.attachments,
                turnDuration: existing.turnDuration,
                turnTps: existing.turnTps,
                turnId: existing.turnId,
                steer: existing.steer
            )
            updateStreamingAssistantMessage(at: index, with: updatedMessage)
            liveAssistantActivity.appendProse(appendedContent)
            return true
        }

        messages.append(
            ChatMessage(
                role: "assistant",
                content: appendedContent,
                timestamp: Date().timeIntervalSince1970,
                messageId: messageID
            )
        )
        liveAssistantActivity.appendProse(appendedContent)
        return true
    }

    private func updateStreamingAssistantMessage(at messageIndex: Int, with message: ChatMessage) {
        isUpdatingStreamingAssistantContent = true
        messages[messageIndex] = message
        isUpdatingStreamingAssistantContent = false

        guard let transcriptIndex = displayedTranscriptMessages.lastIndex(where: { transcriptMessage in
            transcriptMessage.assistantSegments.contains { $0.message.messageId == message.messageId }
        }) else {
            recomputeDisplayedTranscriptMessages()
            return
        }

        let existingTranscriptMessage = displayedTranscriptMessages[transcriptIndex]
        let updatedSegments = existingTranscriptMessage.assistantSegments.map { segment in
            guard segment.message.messageId == message.messageId else { return segment }
            return TranscriptAssistantSegment(anchorID: segment.anchorID, message: message)
        }
        guard let lastSegment = updatedSegments.last else {
            recomputeDisplayedTranscriptMessages()
            return
        }

        displayedTranscriptMessages[transcriptIndex] = TranscriptMessage(
            loadedIndex: existingTranscriptMessage.loadedIndex,
            renderID: existingTranscriptMessage.renderID,
            anchorID: lastSegment.anchorID,
            message: lastSegment.message,
            assistantSegments: updatedSegments
        )
    }

    private func flushPinnedLocalNoticesToTranscript() {
        let notices = pinnedLocalNotices
        pinnedLocalNotices.removeAll()
        for notice in notices {
            appendLocalNoticeMessage(notice)
        }
    }

    @discardableResult
    private func enqueueQueuedSlashMessage(
        _ text: String,
        attachments: [PendingAttachment],
        atFront: Bool = false
    ) -> Int {
        let message = QueuedSlashMessage(text: text, attachments: attachments)
        if atFront {
            queuedSlashMessages.insert(message, at: 0)
        } else {
            queuedSlashMessages.append(message)
        }
        return queuedSlashMessages.count
    }

    private func drainQueuedSlashMessageIfIdle() {
        // `isSendingVoiceNote` belongs here alongside `isStartingChat`: `sendMessage`
        // rejects while a voice note owns the pipeline, so draining then would only
        // dequeue and immediately requeue. `sendVoiceNote` re-triggers the drain when
        // it releases the pipeline, including when it fails without starting a stream.
        guard activeStreamID == nil,
              !isStartingChat,
              !isSendingVoiceNote,
              !isDrainingQueuedSlashMessage,
              !queuedSlashMessages.isEmpty
        else { return }

        let next = queuedSlashMessages.removeFirst()
        isDrainingQueuedSlashMessage = true

        Task { @MainActor in
            let savedAttachments = attachmentCoordinator.pendingAttachments
            attachmentCoordinator.replacePendingAttachments(next.attachments)
            let sent = await sendMessage(next.text)
            if !sent {
                queuedSlashMessages.insert(next, at: 0)
            }
            attachmentCoordinator.replacePendingAttachments(savedAttachments)
            isDrainingQueuedSlashMessage = false
            // Only chain-drain after a *successful* send. A failed send requeues the message and
            // waits for the next natural trigger (a queue append, stream completion, or an explicit
            // user send) instead of immediately re-firing the drain — which, with a persistently
            // failing send, was a tight retry loop hammering the network and CPU (issue #202).
            if sent, activeStreamID == nil {
                drainQueuedSlashMessageIfIdle()
            }
        }
    }

    @discardableResult
    private func updateTitle(_ payload: TitleStreamEvent) -> Bool {
        if let payloadSessionID = payload.sessionId, payloadSessionID != sessionID {
            return false
        }

        guard let title = payload.title else { return false }
        applyLiveActivitySessionTitle(title)
        return true
    }

    private func refreshCompletedResponseTitleIfNeeded() {
        guard !isRefreshingCompletedResponseTitle else { return }
        guard let sessionID else { return }

        isRefreshingCompletedResponseTitle = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { isRefreshingCompletedResponseTitle = false }

            do {
                let response = try await client.session(id: sessionID, includeMessages: false, messageLimit: nil)
                if let title = response.session?.title {
                    applyLiveActivitySessionTitle(title)
                }
            } catch {
                // Title refresh is opportunistic; the transcript has already completed successfully.
            }
        }
    }

    private func applyLiveActivitySessionTitle(_ title: String) {
        displayTitle = Self.displayTitle(from: title)
        liveActivityManager.update(.sessionTitle(displayTitle))
    }

    private func finishListening() {
        activeListeningUtteranceID = nil
        activeListenPlayerID = nil
        activeListenRequestID = nil
        listenAudioPlayer = nil
        listeningMessageID = nil
        clearListenPlaybackState()
        // Release the shared session so any audio we interrupted can resume. Safe to
        // call when nothing was speaking: `setActive(false)` no-ops via `try?`.
        listenAudioSession.deactivate()
    }

    private func beginListenPlaybackPreparation(for context: MessageActionContext) {
        listenPlaybackTitle = String(localized: "Talaria response \(context.visibleIndex + 1)")
        listenPlaybackPhase = .loading
        listenPlaybackElapsedTime = 0
        listenPlaybackDuration = 0
        listenPlaybackScrubTime = nil
        stopListenPlaybackTicker()
        listenRemoteControlCenter.clear()
    }

    private func clearListenPlaybackState() {
        listenPlaybackPhase = .idle
        listenPlaybackElapsedTime = 0
        listenPlaybackDuration = 0
        listenPlaybackScrubTime = nil
        stopListenPlaybackTicker()
        listenRemoteControlCenter.clear()
    }

    /// Speaks `text` with the on-device `AVSpeechSynthesizer` — the pre-#15 Listen
    /// path, kept as the offline/failure fallback for server TTS.
    private func speakWithOnDeviceSynthesizer(_ text: String) {
        // Route speech to the speaker (not the receiver/earpiece) immediately before
        // speech starts — not when the Listen tap lands — so a slow `/api/tts` fetch
        // never interrupts other audio while Talaria is silent (review on #35).
        // Released again in `finishListening()` once playback ends. See #252.
        listenAudioSession.activate()
        let speechSynthesizer = speechSynthesizerForListening()
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        activeListeningUtteranceID = ObjectIdentifier(utterance)
        speechSynthesizer.speak(utterance)
    }

    /// Attempts to start playback of server-synthesized audio bytes. Returns
    /// `false` when the bytes can't be decoded into a player or playback fails to
    /// start, so the caller can fall back to the on-device synthesizer.
    private func startServerAudioPlayback(_ audioData: Data, title: String) -> Bool {
        guard let player = try? serverTTSAudioPlayerFactory(audioData) else {
            return false
        }

        let playerID = ObjectIdentifier(player)
        player.onFinish = { [weak self] in
            self?.handleListenPlayerCompletion(for: playerID)
        }
        player.prepareToPlay()
        player.rate = Float(listenPlaybackSpeed.rawValue)
        listenPlaybackTitle = title
        listenPlaybackElapsedTime = player.currentTime
        listenPlaybackDuration = player.duration
        listenPlaybackScrubTime = nil
        configureListenRemoteControls()

        // Activate the session only once decodable audio is in hand, immediately
        // before playback, so the network wait never held it (review on #35). If
        // `play()` still fails, the on-device fallback re-activates for itself —
        // `activate()` is idempotent, and `finishListening()` releases it either way.
        listenAudioSession.activate()
        guard player.play() else {
            return false
        }

        listenAudioPlayer = player
        activeListenPlayerID = playerID
        listenPlaybackPhase = .playing
        startListenPlaybackTicker()
        updateListenPlaybackProgressFromPlayer()
        updateListenNowPlaying()
        return true
    }

    private func pauseListenPlayback() {
        guard listenPlaybackPhase == .playing, let player = listenAudioPlayer else { return }
        player.pause()
        updateListenPlaybackProgressFromPlayer()
        listenPlaybackPhase = .paused
        stopListenPlaybackTicker()
        updateListenNowPlaying()
    }

    private func resumeListenPlayback() {
        guard listenPlaybackPhase == .paused, let player = listenAudioPlayer else { return }
        player.rate = Float(listenPlaybackSpeed.rawValue)
        listenAudioSession.activate()
        guard player.play() else { return }
        listenPlaybackPhase = .playing
        startListenPlaybackTicker()
        updateListenPlaybackProgressFromPlayer()
        updateListenNowPlaying()
    }

    private func seekListenPlayback(to time: TimeInterval) {
        guard let player = listenAudioPlayer else { return }
        let boundedTime = boundedListenPlaybackTime(time)
        player.currentTime = boundedTime
        listenPlaybackElapsedTime = boundedTime
        updateListenNowPlaying()
    }

    private func boundedListenPlaybackTime(_ time: TimeInterval) -> TimeInterval {
        guard time.isFinite else { return 0 }
        let upperBound = listenPlaybackDuration > 0 ? listenPlaybackDuration : max(time, 0)
        return min(max(0, time), upperBound)
    }

    private func startListenPlaybackTicker() {
        stopListenPlaybackTicker()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateListenPlaybackProgressFromPlayer()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        listenPlaybackTicker = timer
    }

    private func stopListenPlaybackTicker() {
        listenPlaybackTicker?.invalidate()
        listenPlaybackTicker = nil
    }

    private func updateListenPlaybackProgressFromPlayer() {
        guard listenPlaybackScrubTime == nil, let player = listenAudioPlayer else { return }
        listenPlaybackElapsedTime = boundedListenPlaybackTime(player.currentTime)
        listenPlaybackDuration = max(0, player.duration)
    }

    private func configureListenRemoteControls() {
        listenRemoteControlCenter.configure(
            play: { [weak self] in self?.resumeListenPlayback() },
            pause: { [weak self] in self?.pauseListenPlayback() },
            togglePlayPause: { [weak self] in self?.toggleListenPlaybackPlayPause() },
            changePlaybackPosition: { [weak self] position in self?.seekListenPlayback(to: position) }
        )
    }

    private func updateListenNowPlaying() {
        guard listenPlaybackPhase == .playing || listenPlaybackPhase == .paused else { return }
        listenRemoteControlCenter.update(ListenNowPlayingSnapshot(
            title: listenPlaybackTitle,
            duration: listenPlaybackDuration,
            elapsedTime: listenPlaybackElapsedTime,
            speed: listenPlaybackSpeed,
            isPlaying: listenPlaybackPhase == .playing
        ))
    }

    /// Completion routed from the server-TTS audio player. Mirrors
    /// `handleListenCompletion(for:)`: a stale callback from a superseded player
    /// must not clear the new listen state or deactivate the session.
    private func handleListenPlayerCompletion(for playerID: ObjectIdentifier) {
        guard playerID == activeListenPlayerID else { return }
        finishListening()
    }

    /// Completion routed from the speech-synthesizer delegate. Switching messages mid-
    /// playback cancels the previous utterance, whose `didCancel` arrives asynchronously
    /// *after* the next utterance has started — ignore that stale callback so we don't
    /// clear the new listen state or deactivate the session under live speech. See #252.
    private func handleListenCompletion(for utteranceID: ObjectIdentifier) {
        guard utteranceID == activeListeningUtteranceID else { return }
        finishListening()
    }

    private func speechSynthesizerForListening() -> any ChatSpeechSynthesizing {
        if let speechSynthesizer {
            return speechSynthesizer
        }

        let speechSynthesizer = speechSynthesizerFactory()
        if speechDelegate == nil {
            speechDelegate = SpeechSynthesizerDelegate { [weak self] finishedUtteranceID in
                self?.handleListenCompletion(for: finishedUtteranceID)
            }
        }
        speechSynthesizer.delegate = speechDelegate
        self.speechSynthesizer = speechSynthesizer
        return speechSynthesizer
    }

    private func statusTokenLine() -> String {
        guard let contextWindowSnapshot else {
            return String(localized: "Unavailable")
        }

        let input = contextWindowSnapshot.inputTokens ?? 0
        let output = contextWindowSnapshot.outputTokens ?? 0
        let total = input + output
        let cost = contextWindowSnapshot.estimatedCost ?? 0

        if total == 0 && cost == 0 {
            return String(localized: "No token usage available")
        }

        let inputText = Self.formatTokenCount(input)
        let outputText = Self.formatTokenCount(output)
        guard cost > 0 else {
            return String(localized: "\(inputText) in / \(outputText) out")
        }

        return String(localized: "\(inputText) in / \(outputText) out (~\(cost.formattedCost()))")
    }

    private func providerFromModel(_ model: String) -> String? {
        let parts = model.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count > 1 else { return nil }
        return parts[0]
    }

    private static func formatTokenCount(_ value: Int) -> String {
        value.formatted(.number)
    }

    private static func displayTitle(from title: String?) -> String {
        let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmedTitle, !trimmedTitle.isEmpty else {
            return String(localized: "Untitled Session")
        }
        return trimmedTitle
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func compactModelTitle(_ modelID: String) -> String {
        let raw = modelID.split(separator: ":").last.map(String.init) ?? modelID
        let suffix = raw.split(separator: "/").last.map(String.init) ?? raw
        return suffix.replacingOccurrences(of: "gpt-", with: "GPT-", options: [.caseInsensitive])
    }

    private static let reasoningDisplayArgs: Set<String> = ["show", "hide", "on", "off"]
    private static let reasoningEffortArgs: Set<String> = ["none", "minimal", "low", "medium", "high", "xhigh"]
    private static let personalityClearArgs: Set<String> = ["none", "default", "clear"]

    private static func btwMessageText(question: String, answer: String?, isLoading: Bool) -> String {
        let trimmedAnswer = answer?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body: String
        if trimmedAnswer.isEmpty {
            body = isLoading ? "..." : String(localized: "No answer produced.")
        } else {
            body = trimmedAnswer
        }

        return """
        **BTW** \(question)

        \(body)
        """
    }

    private static func backgroundResultText(prompt: String, answer: String?) -> String {
        let trimmedAnswer = answer?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body = trimmedAnswer.isEmpty ? String(localized: "No answer produced.") : trimmedAnswer
        let summary = prompt.count > 80 ? "\(prompt.prefix(80))..." : prompt

        return """
        **Background** \(summary)

        \(body)
        """
    }

    private static let slashCommandHelpText = String(localized: """
    Available mobile commands:

    `/help` - Show this command list.
    `/clear` - Clear the local transcript.
    `/stop` - Stop the current response.
    `/new` - Open a fresh session.
    `/model <id>` - Switch this session's model.
    `/workspace <path>` - Switch this session's workspace.
    `/reasoning <level>` - Set reasoning display or effort.
    `/title <text>` - Rename this session.
    `/personality <name>` - Set or clear this session's personality.
    `/skills [query]` - Search available skills.
    `/queue <message>` - Queue a message for the next turn.
    `/steer <message>` - Steer the active response.
    `/interrupt <message>` - Stop the active response and send a new message.
    `/status` - Show session status.
    `/btw <question>` - Ask a side question without changing this chat.
    `/background <prompt>` - Run a parallel task and post the result here.
    `/bg <prompt>` - Alias for `/background`.
    `/branch [name]` - Fork this conversation.
    `/fork [name]` - Alias for `/branch`.
    `/compress [focus]` - Compress this session's context.
    `/compact [focus]` - Alias for `/compress`.
    `/undo` - Undo the last exchange.
    `/retry` - Retry the last turn.
    """)
}

extension ChatViewModel: ChatPendingActionCoordinatorDelegate {
    var pendingActionSessionID: String? { sessionID }
    var pendingActionHasActiveStream: Bool { activeStreamID != nil }
    var pendingActionHasRunningClarificationTool: Bool {
        liveToolCalls.contains {
            !$0.isCompleted && ($0.name?.lowercased() == "clarify" || $0.args?["questions"] != nil)
        }
    }
    var pendingActionIsStreamConnectionSuspended: Bool { isStreamConnectionSuspended }

    func pendingActionCoordinatorWillSubmitAction() {
        sendErrorMessage = nil
        lastError = nil
    }

    func pendingActionCoordinatorDidFailAction(_ error: Error) {
        lastError = error
        sendErrorMessage = error.localizedDescription
    }
}

extension ChatViewModel: ChatAttachmentCoordinatorDelegate {
    var attachmentSessionID: String? { sessionID }
    var attachmentIsViewingCachedData: Bool { isViewingCachedData }

    func attachmentCoordinatorWillUpload() {
        lastError = nil
    }

    func attachmentCoordinatorDidFail(_ error: Error) {
        lastError = error
    }
}

extension ChatViewModel: ChatStreamCoordinatorDelegate {
    var streamCoordinatorSessionID: String? { sessionID }
    var streamCoordinatorDisplayTitle: String { displayTitle }
    var streamCoordinatorHasRunningLiveToolCall: Bool { hasRunningLiveToolCall }
    var streamCoordinatorHasPendingPrompt: Bool {
        pendingActionCoordinator.hasPendingPrompt
    }
    var streamCoordinatorStreamingAssistantMessageID: String? {
        get { streamingAssistantMessageID }
        set {
            if newValue == nil {
                flushPendingStreamingContent()
            }
            streamingAssistantMessageID = newValue
        }
    }

    func streamCoordinatorLoadMessages(modelContext: ModelContext?) async {
        await loadMessages(modelContext: modelContext)
    }

    func streamCoordinatorLatestAssistantMessageID() -> String? {
        Self.latestAssistantMessageIDAfterLatestSteeringHint(in: messages)
    }

    func streamCoordinatorServerTerminalState(turnID: String) -> String? {
        messages.last { $0.turnId == turnID && $0.activityScene != nil }?.activityScene?.terminalState
    }

    func streamCoordinatorOmitLoadedRunningTurn() -> Bool {
        // Only the running turn's own prompt (sent at or after its start) marks where to trim; an
        // earlier prompt means the load does not hold this turn yet, and its settled answer stays.
        guard let prompt = messages.lastIndex(where: Self.isOrdinaryUserTurnBoundary),
              let startedAt = loadedPendingStartedAt,
              let promptSentAt = messages[prompt].timestamp,
              promptSentAt >= startedAt - 1
        else { return false }

        // Steers are the user's own rows; replayed `steer_consumed` frames only update them.
        let steers = messages[messages.index(after: prompt)...].filter { $0.isLocalSteeringHint || $0.steer != nil }
        messages.replaceSubrange(messages.index(after: prompt)..., with: steers)
        liveAssistantActivity.removeAll()
        streamingAssistantMessageID = nil
        toolCallAnchorMessageID = nil
        reasoningAnchorMessageID = nil
        return true
    }

    func streamCoordinatorStartAuxiliaryMonitoring() {
        pendingActionCoordinator.startMonitoring()
    }

    func streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: Bool) {
        pendingActionCoordinator.stopMonitoring(clearPrompt: clearPrompt)
    }

    func streamCoordinatorSaveSnapshotIfNeeded() {
        flushPendingStreamingContent()
        saveActiveStreamSnapshotIfNeeded()
    }

    @discardableResult
    func streamCoordinatorRestoreSnapshotIfAvailable(streamID: String) -> String? {
        restoreActiveStreamSnapshotIfAvailable(streamID: streamID)
    }

    func streamCoordinatorRemoveSnapshot(streamID: String?) {
        removeActiveStreamSnapshot(streamID: streamID)
    }

    func streamCoordinatorFlushPinnedLocalNoticesToTranscript() {
        flushPinnedLocalNoticesToTranscript()
    }

    func streamCoordinatorDrainQueuedSlashMessageIfIdle() {
        drainQueuedSlashMessageIfIdle()
    }

    func streamCoordinatorRefreshCompletedResponseTitleIfNeeded() {
        refreshCompletedResponseTitleIfNeeded()
    }

    func streamCoordinatorDidCompleteCurrentResponse(needsTranscriptRefresh: Bool) {
        responseCompletionNeedsTranscriptRefresh = needsTranscriptRefresh
        responseCompletionHapticTrigger += 1
    }

    func streamCoordinatorDidFinishStream() {
        flushPendingStreamingContent()
        responseCompletionNeedsTranscriptRefresh = false
    }

    func streamCoordinatorDidReceiveErrorMessage(_ message: String) {
        sendErrorMessage = message
    }

    func streamCoordinatorDidReceiveRecoveryError(_ error: Error) {
        lastError = error
        sendErrorMessage = error.localizedDescription
        ownsSendErrorForRecovery = true
    }

    func streamCoordinatorDidConfirmRecovery() {
        // Stream activity proved recovery, so retract the warning this coordinator
        // raised — but only while it still owns the banner. A composer or send
        // error that landed since then belongs on screen.
        guard ownsSendErrorForRecovery else { return }

        sendErrorMessage = nil
        lastError = nil
    }

    @discardableResult
    func streamCoordinatorAppendToken(_ text: String) -> Bool {
        appendAssistantToken(text)
    }

    @discardableResult
    func streamCoordinatorAppendInterimAssistant(_ payload: InterimAssistantStreamEvent) -> Bool {
        appendInterimAssistant(payload)
    }

    @discardableResult
    func streamCoordinatorAppendReasoning(_ payload: ReasoningStreamEvent) -> Bool {
        appendReasoning(payload)
    }

    @discardableResult
    func streamCoordinatorAppendToolCall(_ payload: ToolStreamEvent) -> Bool {
        appendToolCall(payload)
    }

    @discardableResult
    func streamCoordinatorCompleteToolCall(_ payload: ToolStreamEvent) -> Bool {
        completeToolCall(payload)
    }

    @discardableResult
    func streamCoordinatorUpdateTitle(_ payload: TitleStreamEvent) -> Bool {
        updateTitle(payload)
    }

    func streamCoordinatorApplySettledSession(_ session: SessionDetail) {
        applyCompletedStreamSession(session)
    }

    @discardableResult
    func streamCoordinatorApplyDone(_ payload: DoneStreamEvent) -> Bool {
        flushPendingStreamingContent()
        let currentStreamingAssistantID = streamingAssistantMessageID
        let hasCompletedTranscript = payload.session?.messages?.isEmpty == false
        if let completedSession = payload.session {
            applyCompletedStreamSession(completedSession)
        }
        if payload.session?.messages?.contains(where: { $0.activityScene?.hasConsumedSteering == true }) == true {
            // The finished scene renders its steers, even ones outside the loaded window; a steer the Agent never took
            // returns as a leftover event and is queued from there, so no local hint stays behind.
            removeUnresolvedSteeringHints()
        } else {
            settleAcceptedSteeringHints()
        }
        if let usage = payload.usage {
            contextWindowSnapshot = usage
        }
        let finalTokensPerSecond = payload.usage?.tokensPerSecond.flatMap {
            $0.isFinite && $0 > 0 ? $0 : nil
        }
        let finalDuration = payload.usage?.durationSeconds.flatMap {
            $0.isFinite && $0 >= 0 ? $0 : nil
        }
        if let currentStreamingAssistantID {
            let currentAssistantIndex = messages.firstIndex(where: { $0.messageId == currentStreamingAssistantID })
                ?? TranscriptTurnClassifier
                    .currentTurnAssistantAnchorIDs(in: messages, messageOffset: messagesOffset)
                    .last
                    .flatMap { currentAssistantAnchorID in
                        messages.indices.first { index in
                            TranscriptTurnClassifier.anchorID(
                                for: messages[index],
                                at: index,
                                messageOffset: messagesOffset
                            ) == currentAssistantAnchorID
                        }
                    }
            if let index = currentAssistantIndex {
                let totalDuration = finalDuration ?? messages[index].turnDuration
                let remainingDuration = totalDuration.map {
                    max(0, $0 - completedSteeringPhaseDuration(before: index))
                }
                messages[index] = messages[index].applyingTurnMetrics(
                    duration: remainingDuration,
                    tokensPerSecond: finalTokensPerSecond
                )
            }
        }
        return hasCompletedTranscript
    }

    private func completedSteeringPhaseDuration(before currentAssistantIndex: Int) -> Double {
        let precedingMessages = messages[..<currentAssistantIndex]
        let startIndex = precedingMessages.lastIndex(where: { message in
            Self.isOrdinaryUserTurnBoundary(message)
        }).map { $0 + 1 } ?? messages.startIndex

        return messages[startIndex..<currentAssistantIndex]
            .filter { $0.role == "assistant" }
            .compactMap(\.turnDuration)
            .reduce(0, +)
    }

    func streamCoordinatorApplyApprovalUpdate(_ update: ApprovalPendingResponse) {
        guard let sessionID else { return }
        applyApprovalUpdate(update, sessionID: sessionID)
    }

    func streamCoordinatorApplyClarificationUpdate(_ update: ClarificationPendingResponse) {
        guard let sessionID else { return }
        applyClarificationUpdate(update, sessionID: sessionID)
    }

    @discardableResult
    func streamCoordinatorConsumeSteeringHint(_ event: SteeringStreamEvent) -> Bool {
        consumeSteeringHint(id: event.steerId, text: event.text)
    }

    func streamCoordinatorEnqueuePendingSteerLeftover(_ event: SteeringStreamEvent) -> Bool {
        let message = event.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return false }

        if let steerID = event.steerId {
            removeSteeringHint(id: steerID)
        } else {
            removeLeftoverSteeringHints(matching: message)
        }
        _ = enqueueQueuedSlashMessage(message, attachments: [])
        appendLocalNoticeMessage(String(localized: "Steering hint was not consumed before the response ended, so it was queued for the next turn."))
        return true
    }
}
