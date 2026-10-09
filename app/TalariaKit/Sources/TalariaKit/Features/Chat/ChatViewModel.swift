import Foundation
import AVFoundation
import Observation
import SwiftData

@MainActor
@Observable
public final class ChatViewModel {
    static let messagePageLimit = 50

    private struct SessionLoadWaiter {
        let requestGeneration: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    public private(set) var messages: [ChatMessage] = [] {
        didSet {
            if !isUpdatingStreamingAssistantContent {
                recomputeDisplayedTranscriptMessages()
            }
        }
    }
    /// Memoized transcript mapping. Structural changes rebuild it; paced content
    /// flushes replace only the active transcript row.
    public private(set) var displayedTranscriptMessages: [TranscriptMessage] = []
#if DEBUG
    @ObservationIgnored private(set) var displayedTranscriptRecomputeCount = 0
    /// Loads parked until the pending send finishes; tests wait on it instead of draining the main actor.
    var messageSendWaiterCount: Int { messageSendWaiters.count }
#endif
    public private(set) var isLoading = false
    public private(set) var isLoadingOlderMessages = false
    public private(set) var isStartingChat = false
    @ObservationIgnored private var isStartingMessageSend = false
    @ObservationIgnored private var messageSendWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var sessionLoadRequestGeneration = 0
    @ObservationIgnored private var latestSettledSessionLoadRequestGeneration = 0
    @ObservationIgnored private var latestHandledSessionLoadFailureGeneration = 0
    @ObservationIgnored private var activeSessionLoadRequestGenerations: Set<Int> = []
    @ObservationIgnored private var sessionLoadWaiters: [SessionLoadWaiter] = []
    @ObservationIgnored private var joinableSessionLoad: Task<Void, Never>?
    /// True while a recorded voice note is being transcribed, uploaded, and sent.
    /// Spans all three steps so the composer can show progress and disable input.
    public private(set) var isSendingVoiceNote = false
    public private(set) var isForkingMessage = false
    public private(set) var isEditingMessage = false
    public private(set) var isRegeneratingMessage = false
    public private(set) var isCompressingSession = false
    public private(set) var isCancellingStream = false
    public private(set) var isViewingCachedData = false
    public var activeStreamID: String? { streamCoordinator.activeStreamID }
    /// TAL-426: the actions the server allows for each pending steer, by steer id (its hint row's message id).
    public private(set) var pendingSteerActions: [String: PendingSteer.Actions] = [:]
    /// Pending steers with an Edit, Cancel or Send now request in flight: their actions wait for it.
    public private(set) var steerActionsInFlight = Set<String>()
    /// Text a steer gave back to the composer (Edit, or a Stop of this device's steer); the view appends and takes it.
    public private(set) var returnedComposerTexts: [String] = []
    /// Steers taken or withdrawn: a replayed frame or an older session load never brings one back.
    private var closedSteerIDs = Set<String>()
    /// This device's steers whose POST has not answered yet: the server cannot list them, so a reload keeps their rows.
    private var steerRequestsInFlight = Set<String>()
    /// Counts each change to a pending row here; a session load fetched before a change never undoes it.
    private var steerChangeCount = 0
    private var steerChangedAt: [String: Int] = [:]
    /// The last session load listed `pending_steers`, so a snapshot merge adds no pending row of its own.
    private var serverListsPendingSteers = false
    private var ownSteers: OwnSteerStore { OwnSteerStore(defaults: userDefaults) }
    /// The stream the server last reported a background result started (`active_turn_origin`, TAL-460).
    private var backgroundTurnStreamID: String?
    /// The running turn was started by a background result, not by the user.
    public var isBackgroundTurnActive: Bool { backgroundTurnStreamID != nil && backgroundTurnStreamID == activeStreamID }
    public var activeStreamRecoveryState: ActiveStreamRecoveryState { streamCoordinator.recoveryState }
    public var liveTokensPerSecond: Double? { streamCoordinator.liveTokensPerSecond }
    public private(set) var errorMessage: String?
    public private(set) var sendErrorMessage: String? {
        didSet {
            // Every other writer takes ownership of the banner, so stream recovery
            // can no longer retract it. Identity, not matching text: a send that
            // fails the same way as the recovery attempt is still its own error.
            ownsSendErrorForRecovery = false
        }
    }
    private var ownsSendErrorForRecovery = false
    public private(set) var messageActionErrorMessage: String?
    private(set) var cacheErrorMessage: String?
    public private(set) var lastError: Error?
    /// The latest queued send that failed; ChatView forwards its error to `onAPIError` (TAL-150).
    public private(set) var queuedSendFailure: ChatSendFailure?
    public private(set) var displayTitle: String
    public private(set) var listeningMessageID: String?
    public private(set) var streamingScrollTrigger = 0
    /// Bumped when a cache-first cold open (#289) finishes reconciling the network
    /// transcript over the instantly-rendered cached one. The richer server content
    /// (tool-call / reasoning cards, content parts) is taller than the lighter cached
    /// render, so the view re-pins to the bottom on this token *without* animation —
    /// otherwise the height growth produces a visible scroll jump.
    public private(set) var cacheFirstReconcileScrollToken = 0
    private var hasPrimedInitialCachedMessages = false
    /// The selected list row's server run state (TAL-250): a provisional hint for
    /// the first paint, never authority to adopt, resend or settle a run.
    private let selectedRowIsStreaming: Bool?
    private let selectedRowActiveStreamID: String?
    /// True from the first paint until the first session load answers, unless the
    /// selected row reported the session idle.
    private var isConfirmingRunState = false
    /// Shows that the run state is still being confirmed while no run is adopted. Over a populated
    /// transcript the "Syncing messages" pill already says the server is being checked (TAL-436).
    public var showsRunStateCheck: Bool { isConfirmingRunState && activeStreamID == nil && !isSyncingTranscript }
    /// Loads started by pull-to-refresh; the system refresh spinner covers them.
    private var userRefreshLoadGenerations: Set<Int> = []
    /// True while a populated transcript is being reconciled with the server (TAL-436).
    public var isSyncingTranscript: Bool { isLoading && userRefreshLoadGenerations.isEmpty && !messages.isEmpty }
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
    public private(set) var earlierSceneRows: [String: [AssistantActivitySceneRow]] = [:]
    private var loadingEarlierSceneRows = Set<String>()
    public var displayedReasoningGroups: [ReasoningGroup] {
        Self.reasoningDisplayGroups(
            messages: messages,
            messageOffset: messagesOffset,
            archivedGroups: completedReasoningGroups
        )
    }
    public func completedToolCallGroupsForAnchor(_ anchorMessageID: String?) -> [ToolCallGroup] {
        completedToolCallGroupLookup.groups(anchorMessageID: anchorMessageID)
    }
    public func archivedActivityRowsForAnchor(_ anchorMessageID: String?) -> [AssistantActivityRow] {
        anchorMessageID.flatMap { archivedAssistantActivity[$0] } ?? []
    }

    public func earlierSceneRows(for transcriptMessage: TranscriptMessage) -> [AssistantActivitySceneRow] {
        earlierSceneRows[Self.earlierSceneRowsKey(transcriptMessage)] ?? []
    }

    /// Paged rows belong to one server turn: a regenerated reply at the same position is a new turn id, so it never
    /// picks up the previous answer's rows. Only an unstamped (older-server) row falls back to its anchor.
    private static func earlierSceneRowsKey(_ transcriptMessage: TranscriptMessage) -> String {
        transcriptMessage.message.turnId.map { "turn:\($0)" } ?? transcriptMessage.anchorID
    }

    /// Pages a completed turn's omitted scene rows (the server sends only the tail) until the scene is complete.
    public func loadEarlierSceneRows(for transcriptMessage: TranscriptMessage) async {
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

    /// TAL-331: the whole result of a scene tool row the server clipped (`ToolCall.resultTruncated`).
    public func fullToolResult(toolCallID: String) async throws -> ToolResultView {
        // A clipped row only comes from a loaded session; without one there is no result to fetch.
        guard let sessionID else { throw APIError.http(statusCode: 404, body: nil) }
        let response = try await client.toolResult(sessionID: sessionID, toolCallID: toolCallID)
        return response.resultView ?? ToolResultView(text: response.result)
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
    /// The "Context compaction · Reference only" card the server placed (TAL-560); nil shows none.
    public private(set) var compressionReferenceCard: CompressionReferenceCard?
    @ObservationIgnored private var compressionReference: CompressionReference?
    private func applyCompressionReference(from session: SessionDetail?) {
        compressionReference = session?.compressionReference
        recomputeCompressionReferenceCard()
    }
    /// Mirrors the list-row merge rule: the server's `read_only` replaces the
    /// seeded flag; a detail that omits it keeps it.
    private func applyReadOnlyState(from session: SessionDetail?) {
        if let readOnly = session?.readOnly { isSessionReadOnly = readOnly }
        if let canBranch = session?.canBranch { self.canBranch = canBranch }
        if let assistantName = session?.assistantName { self.assistantName = assistantName }
        if let session, session.statesEnabledToolsets { sessionToolsets = SessionToolsets(names: session.enabledToolsets) }
        // A detail relabels the workspace it reports, so a registry rename shows on the next load (TAL-303).
        if let workspace = session?.workspace, workspace == serverWorkspacePath {
            serverWorkspaceName = session?.workspaceName
        }
    }
    /// The chat this one was branched from (TAL-454); nil shows no link.
    public private(set) var branchedFrom: SessionBranchLink?
    private func applyBranchedFrom(from session: SessionDetail?, sessionID: String, modelContext: ModelContext?) {
        branchedFrom = session?.branchedFrom
        guard let modelContext, ownsCurrentCache else { return }
        do {
            try CacheStore.cacheBranchedFrom(branchedFrom, serverURL: server, sessionID: sessionID, in: modelContext)
        } catch {
            cacheErrorMessage = error.localizedDescription
        }
    }
    /// The cached link paints with the cached transcript; a failed read shows none.
    private func restoreCachedBranchedFrom(sessionID: String, modelContext: ModelContext) {
        branchedFrom = try? CacheStore.cachedBranchedFrom(serverURL: server, sessionID: sessionID, in: modelContext)
    }
    private func clearCompressionReference() {
        compressionReference = nil
        compressionReferenceCard = nil
    }
    private func recomputeCompressionReferenceCard() {
        // Not folded into the messages/messagesOffset observers alone:
        // applyCompletedStreamSession can update the reference without
        // reassigning messages, so reference changes recompute here too. The
        // equality guard keeps the overlapping triggers observer-silent.
        let card = Self.compressionReferenceCard(
            reference: compressionReference,
            messagesOffset: messagesOffset,
            transcriptMessages: displayedTranscriptMessages
        )
        guard compressionReferenceCard != card else { return }

        compressionReferenceCard = card
    }
    private(set) var liveAssistantActivity = AssistantActivityTimeline()
    public var liveActivityRows: [AssistantActivityRow] { liveAssistantActivity.rows }
    public var liveToolCalls: [ToolCall] { liveAssistantActivity.toolCalls }
    public var liveReasoningText: String { liveAssistantActivity.reasoningText }
    public private(set) var streamingAssistantMessageID: String?
    public private(set) var toolCallAnchorMessageID: String?
    public private(set) var reasoningAnchorMessageID: String?
    private(set) var messagesOffset = 0 {
        didSet { recomputeDisplayedTranscriptMessages() }
    }
    public private(set) var hasOlderMessages = false
    public private(set) var contextWindowSnapshot: ContextWindowSnapshot?
    public private(set) var responseCompletionHapticTrigger = 0
    public private(set) var responseCompletionNeedsTranscriptRefresh = false
    public private(set) var responseCompletionOutcome: ResponseCompletionOutcome = .completed
    public private(set) var modelCatalogGroups: [ModelCatalogGroup] = []
    public private(set) var agentCommands: [AgentCommand] = []
    public private(set) var workspaceRoots: [WorkspaceRoot] = []
    public private(set) var workspaceSuggestions: [String] = []
    public private(set) var personalitySuggestions: [String] = ["none"]
    public private(set) var skillSlashSuggestions: [SkillSlashSuggestion] = []
    public private(set) var profileOptions: [ProfileSummary] = []
    public private(set) var isSingleProfileMode = false
    public private(set) var selectedProfileName: String?
    public private(set) var selectedReasoningEffort: String?
    /// Model-aware effort vocabulary (`supported_efforts` from `GET /api/reasoning`).
    /// `nil` on older servers → the composer falls back to the static list (issue #18).
    public private(set) var supportedReasoningEfforts: [String]?
    /// `supports_reasoning_effort`; `false` hides the composer effort control.
    private(set) var supportsReasoningEffort: Bool?
    /// Drops out-of-order `GET /api/reasoning` responses after rapid model switches
    /// so the gating never reflects a stale model (upstream #3750 class of bug).
    private var reasoningGatingFetchToken = 0
    public var showsReasoningEffortControl: Bool {
        ReasoningEffortOption.showsEffortControl(
            supportsReasoningEffort: supportsReasoningEffort,
            supportedEfforts: supportedReasoningEfforts
        )
    }
    public private(set) var isLoadingComposerConfiguration = false
    public private(set) var isUpdatingComposerConfiguration = false
    public private(set) var composerConfigurationErrorMessage: String?
    public var pendingAttachments: [PendingAttachment] { attachmentCoordinator.pendingAttachments }
    public var isUploadingAttachment: Bool { attachmentCoordinator.isUploadingAttachment }
    public var attachmentUploadCount: Int { attachmentCoordinator.uploadInFlightCount }
    public var attachmentUploadGeneration: Int { attachmentCoordinator.uploadStartGeneration }
    public var uploadAttachmentErrorMessage: String? { attachmentCoordinator.uploadAttachmentErrorMessage }
    public var localAttachmentPreviews: [String: [String: Data]] { attachmentCoordinator.localAttachmentPreviews }
    public private(set) var pinnedLocalNotices: [String] = []
    public var approvalPrompt: ApprovalPromptState? { pendingActionCoordinator.approvalPrompt }
    public var isRespondingToApproval: Bool { pendingActionCoordinator.isRespondingToApproval }
    public var approvalErrorMessage: String? { pendingActionCoordinator.approvalErrorMessage }
    public var isSessionApprovalBypassEnabled: Bool { pendingActionCoordinator.isSessionApprovalBypassEnabled }
    public var clarificationPrompt: ClarificationPromptState? { pendingActionCoordinator.clarificationPrompt }
    public var clarificationDraftResponse: String { pendingActionCoordinator.clarificationDraftResponse }
    public var clarificationSelectedChoices: [String] { pendingActionCoordinator.clarificationSelectedChoices }

    public func selectClarificationQuestion(_ index: Int, promptID: String) {
        pendingActionCoordinator.selectClarificationQuestion(index, promptID: promptID)
    }

    public func toggleClarificationChoice(_ choice: String, promptID: String) {
        pendingActionCoordinator.toggleClarificationChoice(choice, promptID: promptID)
    }

    public func setClarificationDraftResponse(_ text: String, promptID: String) {
        pendingActionCoordinator.setClarificationDraftResponse(text, promptID: promptID)
    }

    public func submitClarificationDraft(promptID: String) async -> Bool {
        await pendingActionCoordinator.submitClarificationDraft(promptID: promptID)
    }

    /// True once the chat has a server session to load from and send to.
    public var hasSession: Bool { sessionID != nil }

    /// A new chat starts with no session so its screen, and the composer the user is already typing
    /// in, can appear before the server answers; this takes on the session the server created, in
    /// place, so nothing is rebuilt (TAL-636). Only the first adoption counts.
    public func adoptCreatedSession(_ session: SessionSummary) {
        guard sessionID == nil, let id = Self.nonEmpty(session.sessionId) else { return }
        sessionID = id
        currentWorkspace = session.workspace
        serverWorkspacePath = session.workspace
        serverWorkspaceName = session.workspaceName
        currentModel = session.model
        currentModelProvider = session.modelProvider
        currentModelOptionID = session.modelOptionID
        currentProfile = session.profile
        isCLISession = session.isCliSession == true
        isSessionReadOnly = session.isSessionReadOnly
        canBranch = session.canBranch != false
        displayTitle = Self.displayTitle(from: session.title)
    }

    public var isRespondingToClarification: Bool { pendingActionCoordinator.isRespondingToClarification }
    public var clarificationErrorMessage: String? { pendingActionCoordinator.clarificationErrorMessage }
    public private(set) var currentGoal: SubmittedGoal?
    public private(set) var isSubmittingGoal = false
    private(set) var goalErrorMessage: String?
    public private(set) var hasActivatedGoalCommand = false

    /// Nil for a new chat until the server creates it; `adoptCreatedSession` sets it once (TAL-636).
    private var sessionID: String?
    private var currentWorkspace: String?
    /// The workspace the server last reported for this session, with its label (TAL-303).
    private var serverWorkspacePath: String?
    private var serverWorkspaceName: String?
    private var currentModel: String?
    private var currentModelProvider: String?
    /// TAL-301: the catalog entry the server says `currentModel` selects.
    private var currentModelOptionID: String?
    private var currentProfile: String?
    private var isCLISession: Bool
    /// Server-owned view-only state (TAL-152). Seeded from the list row and
    /// refreshed from every applied `SessionDetail`, which is authoritative.
    public private(set) var isSessionReadOnly: Bool
    /// The server's branch gate (TAL-312), seeded and refreshed like `isSessionReadOnly`;
    /// an older server that omits it allowed branching.
    public private(set) var canBranch: Bool
    /// The server's `assistant_name` (TAL-458), refreshed like `canBranch`; an older server that
    /// omits it gets the stock agent name.
    public private(set) var assistantName = "Hermes"
    private let server: URL
    /// The server's `ServerCacheGeneration` when this chat opened; the chat writes its cache only
    /// while it is unchanged.
    private let cacheGeneration: Int
    public let client: APIClient
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
    public private(set) var listenPlaybackPhase: ListenPlaybackPhase = .idle
    private(set) var listenPlaybackElapsedTime: TimeInterval = 0
    public private(set) var listenPlaybackDuration: TimeInterval = 0
    private(set) var listenPlaybackScrubTime: TimeInterval?
    public private(set) var listenPlaybackSpeed: ListenPlaybackSpeed
    @ObservationIgnored private var listenPlaybackTicker: Timer?
    private var showsLiveActivityResponseExcerpts: Bool
    private var hasCompletedCurrentResponse: Bool { streamCoordinator.hasCompletedCurrentResponse }
    private var isStreamConnectionSuspended: Bool { streamCoordinator.isConnectionSuspended }
    public var isActiveStreamConnectionSuspended: Bool { streamCoordinator.isConnectionSuspended }
    /// One owned fetch per autocomplete catalog. Concurrent callers await the same
    /// task, so a cancelled composer `.task(id:)` neither cancels the request nor
    /// lets a later caller see an empty catalog as loaded. A finished handle is the
    /// cache; a failed load clears it so the next caller retries (TAL-160).
    @ObservationIgnored private var personalitySuggestionsLoad: Task<Void, Error>?
    @ObservationIgnored private var skillSlashSuggestionsLoad: Task<Void, Error>?
    private var queuedSlashMessages: [QueuedSlashMessage] = []
    /// What waits to send after the running response, in send order (TAL-630).
    public var queuedMessagePreviews: [QueuedMessagePreview] {
        queuedSlashMessages.map { QueuedMessagePreview(id: $0.id, text: $0.text, attachmentNames: $0.attachments.map(\.name), mayBeOnServer: $0.steerID != nil) }
    }
    /// The session's toolset override (TAL-631); nil until a session detail reports it.
    public private(set) var sessionToolsets: SessionToolsets?
    /// One queued message sends at a time, by the drain or by Send now.
    private var isSendingQueuedMessage = false
    private var activeBtwStreamID: String?
    private var activeBtwMessageID: String?
    private var activeBtwQuestion: String?
    private var activeBtwAnswer = ""
    /// TAL-372: the session's background work, as the server records it for every client.
    public private(set) var backgroundTasks: [BackgroundWorkTask] = []
    /// What the card above the composer shows: the records the server pins.
    public var pinnedBackgroundTasks: [BackgroundWorkTask] { backgroundTasks.filter(\.pinned) }
    @ObservationIgnored private var backgroundPollTask: Task<Void, Never>?
    /// ponytail: old-server fallback (TAL-372); a Web without `/api/background/tasks` only reports finished `/background`
    /// tasks through its status route, so their answers come back as local messages, as before. Delete with that route.
    @ObservationIgnored private var serverHasBackgroundTasks = true
    @ObservationIgnored private var legacyBackgroundPrompts: [String: String] = [:]
    private var isRefreshingCompletedResponseTitle = false
    private var latestServerLoadHadAssistantResponseAfterLatestUser = false
    // The latest applied load's `pending_started_at`: when its running turn began.
    private var loadedPendingStartedAt: Double?
    private var needsComposerConfigurationReload = false
    private var pendingExplicitModelPick = false
    public private(set) var composerConfigurationInteractionGeneration = 0
    /// Last composer catalogs per server, so a chat's choices show before they load (TAL-437).
    private let responseCache: ResponseCache?

    public init(
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
        userDefaults: UserDefaults = .standard,
        responseCache: ResponseCache? = nil,
        networkPath: (any NetworkPathObserving)? = nil
    ) {
        self.responseCache = responseCache
        sessionID = session.sessionId
        currentWorkspace = session.workspace
        serverWorkspacePath = session.workspace
        serverWorkspaceName = session.workspaceName
        currentModel = session.model
        currentModelProvider = session.modelProvider
        currentModelOptionID = session.modelOptionID
        currentProfile = session.profile
        isCLISession = session.isCliSession == true
        isSessionReadOnly = session.isSessionReadOnly
        canBranch = session.canBranch != false
        selectedRowIsStreaming = session.isStreaming
        selectedRowActiveStreamID = Self.nonEmpty(session.activeStreamId)
        self.server = server
        cacheGeneration = ServerCacheGeneration.current(for: server)
        let resolvedClient = client ?? APIClient(baseURL: server)
        let resolvedStreamClient = streamClient ?? SSEClient()
        let resolvedLiveActivityManager = liveActivityManager ?? PlatformHooks.liveActivityManager()
        self.client = resolvedClient
        self.streamCoordinator = ChatStreamCoordinator(
            client: resolvedClient,
            streamClient: resolvedStreamClient,
            liveActivityManager: resolvedLiveActivityManager,
            showsLiveActivityResponseExcerpts: showsLiveActivityResponseExcerpts,
            networkPath: networkPath
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
        self.pendingActionCoordinator.approvalHeadDidBecomeVisible = { prompt in
            ApprovalNotificationService.shared.observe(prompt, server: server)
        }
        self.attachmentCoordinator.delegate = self
    }

    /// Fills the composer's empty catalogs from the last responses (TAL-437). Called when the chat
    /// appears rather than in `init`, because SwiftUI builds a view model on every `ChatView` init
    /// and this reads files. Runs once; the live load replaces what it shows.
    public func showCachedComposerChoices() {
        guard let responseCache, !didShowCachedComposerChoices else { return }
        didShowCachedComposerChoices = true
        let initialProfileName = selectedProfileName
        applyComposerConfigurationState(
            ChatComposerConfigLoader.cachedState(from: composerConfigurationState, cache: responseCache)
        )
        if selectedProfileName != initialProfileName {
            isProfileSelectionFromCache = true
        }
    }

    deinit {
        backgroundPollTask?.cancel()
        pendingStreamingScrollTriggerTask?.cancel()
        pendingStreamingContentFlushTask?.cancel()
        listenPreparationTask?.cancel()
        listenPlaybackTicker?.invalidate()
    }

    public func setShowsLiveActivityResponseExcerpts(_ shows: Bool) {
        guard showsLiveActivityResponseExcerpts != shows else { return }

        showsLiveActivityResponseExcerpts = shows
        streamCoordinator.setShowsLiveActivityResponseExcerpts(shows)
    }

    public var showsListenPlaybackBar: Bool {
        listenPlaybackPhase != .idle
    }

    public var listenPlaybackDisplayTime: TimeInterval {
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

    public var selectedModelID: String? {
        currentModel
    }

    public var selectedModelProviderID: String? {
        currentModelProvider
    }

    public var selectedModelOptionID: String? {
        currentModelOptionID
    }

    /// The catalog entry a draft picked. A draft saved before drafts kept the
    /// entry id (TAL-301) holds only the server's bare pair, which the stamped
    /// entry carries as `bareID`/`providerID`.
    private func draftModelOption(_ settings: ChatDraftSettings, modelID: String) -> ModelCatalogOption? {
        let options = modelCatalogGroups.flatMap(\.slashAutocompleteModels)
        guard settings.modelOptionID == nil else {
            return options.firstSelected(optionID: settings.modelOptionID, modelID: modelID, providerID: settings.modelProviderID)
        }
        return options.first { $0.bareID == modelID && $0.providerID == settings.modelProviderID }
            ?? options.firstSelected(optionID: nil, modelID: modelID, providerID: settings.modelProviderID)
    }

    public var selectedWorkspacePath: String? {
        currentWorkspace
    }

    /// The server's label for the selected workspace: the session's own, else the picked root's (TAL-303).
    public var selectedWorkspaceName: String? {
        guard let currentWorkspace else { return nil }
        if currentWorkspace == serverWorkspacePath {
            return serverWorkspaceName
        }
        return workspaceRoots.first(where: { $0.path == currentWorkspace })?.name
    }

    /// Adopts the workspace a server session payload reports, with its label (TAL-303).
    private func applyServerWorkspace(_ path: String?, name: String?) {
        guard let path else { return }
        currentWorkspace = path
        serverWorkspacePath = path
        serverWorkspaceName = name
    }

    public var selectedProfileTitle: String {
        let profileName = selectedProfileName ?? currentProfile
        guard let profileName, !profileName.isEmpty else {
            return String(localized: "Profile")
        }

        if let option = profileOptions.first(where: { $0.name == profileName }) {
            return option.displayName
        }

        return profileName == "default" ? String(localized: "Default") : profileName
    }

    public var selectedModelTitle: String {
        guard let currentModel, !currentModel.isEmpty else {
            return String(localized: "Model")
        }

        let catalogName = modelCatalogGroups
            .flatMap(\.models)
            .firstSelected(optionID: currentModelOptionID, modelID: currentModel, providerID: currentModelProvider)?
            .displayName

        return catalogName ?? Self.compactModelTitle(currentModel)
    }

    public func isSelectedProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }
        return profileName == (Self.nonEmpty(selectedProfileName) ?? Self.nonEmpty(currentProfile))
    }

    public var hasStreamingAssistantMessageContent: Bool {
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

    /// A profile name seeded from the last response (TAL-437) only shows; requests wait for the
    /// live load or the user's pick, since another device may have switched profiles since.
    private var isProfileSelectionFromCache = false
    private var didShowCachedComposerChoices = false

    private var requestProfileName: String? {
        (isProfileSelectionFromCache ? nil : Self.nonEmpty(selectedProfileName)) ?? Self.nonEmpty(currentProfile)
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

    public func loadComposerConfiguration() async {
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
            let result = await ChatComposerConfigLoader(client: client, cache: responseCache)
                .loadConfiguration(from: initialState)

            guard composerConfigurationState == initialState else {
                needsComposerConfigurationReload = true
                continue
            }

            applyComposerConfigurationState(result.state)
            if result.configurationError == nil {
                isProfileSelectionFromCache = false
            }

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
    public func refreshModelCatalogForPickerOpen() async {
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
            currentModelOptionID: currentModelOptionID,
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
        currentModelOptionID = state.currentModelOptionID
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

    public func refreshApprovalBypassState() async {
        await pendingActionCoordinator.refreshApprovalBypassState()
    }

    @discardableResult
    public func selectComposerModel(
        _ option: ModelCatalogOption,
        recordsInteraction: Bool = true
    ) async -> Bool {
        if recordsInteraction {
            composerConfigurationInteractionGeneration &+= 1
        }
        guard !option.isSelected(optionID: currentModelOptionID, modelID: currentModel, providerID: currentModelProvider) else {
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

            currentModelOptionID = response.session?.model != nil ? response.session?.modelOptionID : option.id
            currentModel = response.session?.model ?? option.id
            currentModelProvider = response.session?.modelProvider ?? option.providerID
            applyServerWorkspace(response.session?.workspace, name: response.session?.workspaceName)
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
    public func refreshWorkspaceRoots() async {
        guard !isViewingCachedData else { return }

        do {
            let response = try await client.workspaces()
            workspaceRoots = response.workspaces ?? []
            workspaceSuggestions = workspaceRoots.compactMap(\.path)
        } catch {
            lastError = error
        }
    }

    public func loadWorkspaceSuggestions(prefix: String) async {
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

    public func loadPersonalitySuggestions() async {
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

    public func loadSkillSlashSuggestions() async {
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
    public func selectWorkspacePath(
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

            currentWorkspace = workspace
            applyServerWorkspace(response.session?.workspace, name: response.session?.workspaceName)
            if let session = response.session, session.model != nil { currentModelOptionID = session.modelOptionID }
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

    public func switchProfile(
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

        if !startNewSession, !isProfileSelectionFromCache, isSelectedProfile(profile) {
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
            isProfileSelectionFromCache = false

            if let defaultWorkspace = response.defaultWorkspace, !defaultWorkspace.isEmpty {
                currentWorkspace = defaultWorkspace
            }

            if let defaultModel = response.defaultModel, !defaultModel.isEmpty {
                currentModel = defaultModel
                currentModelProvider = Self.nonEmpty(profile.provider)
                currentModelOptionID = nil
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
    public func selectReasoningEffort(
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
    public func restoreDraftSettings(
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
           let option = draftModelOption(settings, modelID: modelID),
           !option.isSelected(optionID: currentModelOptionID, modelID: currentModel, providerID: currentModelProvider) {
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

    public func markComposerConfigurationInteraction() {
        composerConfigurationInteractionGeneration &+= 1
    }

    private func canContinueDraftSettingsRestore(_ expectedInteractionGeneration: Int) -> Bool {
        !Task.isCancelled
            && composerConfigurationInteractionGeneration == expectedInteractionGeneration
    }

    /// Saves and uploads a freshly staged file into the pending strip. Returns
    /// nil unless both the durable draft copy and server upload succeed.
    @discardableResult
    public func uploadAttachment(data: Data, filename: String, previewData: Data? = nil) async -> PendingAttachment? {
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
    public func reuploadDraftAttachment(_ draftAttachment: ChatDraftAttachment, data: Data) async -> PendingAttachment? {
        await attachmentCoordinator.reuploadDraftAttachment(data: data, draftAttachment: draftAttachment)
    }

    func clearPendingAttachments() {
        attachmentCoordinator.clearPendingAttachments()
    }

    public func removePendingAttachment(id: UUID) {
        attachmentCoordinator.removePendingAttachment(id: id)
    }

    public func setUploadAttachmentError(_ message: String?) {
        attachmentCoordinator.setUploadAttachmentError(message)
    }

    public func attachmentImageData(path: String) async -> Data? {
        await attachmentCoordinator.attachmentImageData(path: path)
    }

    public func attachmentRawData(path: String) async -> Data? {
        await attachmentCoordinator.attachmentRawData(path: path)
    }

    public func transcriptMediaThumbnailData(for reference: TranscriptMediaReference) async -> Data? {
        await attachmentCoordinator.transcriptMediaThumbnailData(for: reference)
    }

    public func transcriptMediaData(for reference: TranscriptMediaReference) async -> Data? {
        await attachmentCoordinator.transcriptMediaData(for: reference)
    }

    public func loadMessages(
        modelContext: ModelContext? = nil,
        waitsForPendingMessageSend: Bool = true,
        isUserRefresh: Bool = false
    ) async {
        guard let sessionID else {
            errorMessage = String(localized: "The server did not provide a session ID.")
            return
        }

        resetPendingStreamingContentBuffers()
        latestServerLoadHadAssistantResponseAfterLatestUser = false
        let streamLoadPreparation = streamCoordinator.prepareForSessionLoad()
        sessionLoadRequestGeneration &+= 1
        let loadRequestGeneration = sessionLoadRequestGeneration
        activeSessionLoadRequestGenerations.insert(loadRequestGeneration)
        isLoading = true
        if isUserRefresh {
            userRefreshLoadGenerations.insert(loadRequestGeneration)
        }
        errorMessage = nil
        cacheErrorMessage = nil
        lastError = nil
        defer {
            userRefreshLoadGenerations.remove(loadRequestGeneration)
            finishSessionLoadRequest(loadRequestGeneration)
            // An older load can still apply after a newer one fails, so loading lasts until the last ends.
            isLoading = !activeSessionLoadRequestGenerations.isEmpty
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
        let steerChangesAtFetch = steerChangeCount

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
                // A different (or finished) run owns the transcript, so its rows win
                // instead.
                reloadedMessages = Self.insertingUnconfirmedLocalUserMessages(
                    from: previousMessages,
                    into: loadedMessages,
                    runningTurnID: activeStreamIDBeforeLoad
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
            guard loadRequestGeneration > latestSettledSessionLoadRequestGeneration else { return }
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
                let newerSteerRows = pendingSteerRows(changedAfter: steerChangesAtFetch)
                applyReloadedMessages(
                    mergedMessages,
                    from: session,
                    previousMessages: currentMessages,
                    previousMessagesOffset: currentMessagesOffset
                )
                restoreActiveStreamSnapshotIfAvailable(streamID: currentActiveStreamID)
                applyServerPendingSteers(session?.pendingSteers, changedAfter: steerChangesAtFetch, newerRows: newerSteerRows)
                isViewingCachedData = false
                lastError = nil
                errorMessage = nil
                cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
                if renderedCacheFirst {
                    cacheFirstReconcileScrollToken += 1
                }
                latestSettledSessionLoadRequestGeneration = loadRequestGeneration
                isConfirmingRunState = false
                return
            }
            guard streamCoordinator.canApplySessionLoad(streamLoadPreparation) else {
                // The run moved past this response, and every older response is staler still:
                // settle it so an older load parked on the send cannot apply afterwards.
                // It still answered, so it ends the first load's run-state check.
                latestSettledSessionLoadRequestGeneration = loadRequestGeneration
                isConfirmingRunState = false
                return
            }
            // After load arbitration only: a superseded response must not leave its
            // read-only flag behind once its transcript has been rejected.
            applyReadOnlyState(from: session)
            applyCompressionReference(from: session)
            applyBranchedFrom(from: session, sessionID: sessionID, modelContext: modelContext)
            let newerSteerRows = pendingSteerRows(changedAfter: steerChangesAtFetch)
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
            latestServerLoadHadAssistantResponseAfterLatestUser = Self.hasAssistantResponseAfterLatestUser(
                in: messages
            )
            responseCompletionNeedsTranscriptRefresh = false
            isViewingCachedData = false
            lastError = nil
            errorMessage = nil
            contextWindowSnapshot = session.map(ContextWindowSnapshot.init(session:))
            if let modelContext {
                do {
                    try cacheMessagesIfCurrent(messages, sessionID: sessionID, in: modelContext)
                } catch {
                    cacheErrorMessage = error.localizedDescription
                }
            }
            if let title = session?.title {
                displayTitle = Self.displayTitle(from: title)
            }
            setCompletedToolCallGroups(ToolCallGroup.groups(
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
            backgroundTurnStreamID = session?.activeTurnOrigin == "background" ? loadedActiveStreamID : nil
            streamCoordinator.reconcileSessionLoad(
                loadedActiveStreamID: loadedActiveStreamID,
                preparation: streamLoadPreparation,
                usedCacheFallback: false,
                runStartedAt: Self.activeRunStartDate(pendingStartedAt: session?.pendingStartedAt, messages: messages),
                transcriptSeq: session?.transcriptSeq,
                statesTranscriptSeq: session?.statesTranscriptSeq ?? true
            )
            applyServerPendingSteers(session?.pendingSteers, changedAfter: steerChangesAtFetch, newerRows: newerSteerRows)
            latestSettledSessionLoadRequestGeneration = loadRequestGeneration
            isConfirmingRunState = false
        } catch {
            if waitsForPendingMessageSend {
                await waitForMessageSendToFinish()
            }
            await waitForNewerSessionLoadRequests(after: loadRequestGeneration)
            guard loadRequestGeneration > latestSettledSessionLoadRequestGeneration else { return }
            guard loadRequestGeneration > latestHandledSessionLoadFailureGeneration else { return }
            guard streamCoordinator.canApplySessionLoad(streamLoadPreparation) else { return }
            lastError = error
            latestServerLoadHadAssistantResponseAfterLatestUser = false
            if CacheFallbackPolicy.shouldUseCache(for: error), let modelContext {
                do {
                    let cachedMessages = try CacheStore.cachedMessages(
                        serverURL: server,
                        sessionID: sessionID,
                        in: modelContext,
                        limit: Self.messagePageLimit
                    )
                    if !cachedMessages.isEmpty {
                        clearCompressionReference()
                        restoreCachedBranchedFrom(sessionID: sessionID, modelContext: modelContext)
                        messages = cachedMessages
                        latestServerLoadHadAssistantResponseAfterLatestUser = Self.hasAssistantResponseAfterLatestUser(
                            in: messages
                        )
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
    public func prepareInitialMessageLoad(modelContext: ModelContext) {
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

        restoreCachedBranchedFrom(sessionID: sessionID, modelContext: modelContext)
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
    public func loadOlderMessages(modelContext: ModelContext? = nil) async -> Bool {
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
            applyCompressionReference(from: session)
            messages = mergedMessages
            latestServerLoadHadAssistantResponseAfterLatestUser = Self.hasAssistantResponseAfterLatestUser(
                in: messages
            )
            responseCompletionNeedsTranscriptRefresh = false
            updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
            isViewingCachedData = false
            contextWindowSnapshot = ContextWindowSnapshot(session: session)
            if let title = session.title {
                displayTitle = Self.displayTitle(from: title)
            }
            applyServerWorkspace(session.workspace, name: session.workspaceName)
            if session.model != nil { currentModelOptionID = session.modelOptionID }
            currentModel = session.model ?? currentModel
            currentModelProvider = session.modelProvider ?? currentModelProvider
            currentProfile = session.profile ?? currentProfile
            setCompletedToolCallGroups(ToolCallGroup.groups(
                messages: messages,
                messageOffset: messagesOffset
            ))
            completedReasoningGroups = []

            if let modelContext {
                do {
                    try cacheMessagesIfCurrent(messages, sessionID: sessionID, in: modelContext)
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

    public func actionContext(for message: ChatMessage, visibleIndex: Int) -> MessageActionContext? {
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

            var merged = loadedMessage
            merged.toolCalls = loadedMessage.toolCalls ?? cachedMessage.toolCalls
            merged.contentParts = loadedMessage.contentParts ?? cachedMessage.contentParts
            merged.reasoning = loadedMessage.reasoning ?? cachedMessage.reasoning
            merged.reasoningTitles = loadedMessage.reasoningTitles ?? cachedMessage.reasoningTitles
            merged.activityScene = loadedMessage.activityScene ?? cachedMessage.activityScene
            merged.turnDuration = loadedMessage.turnDuration ?? cachedMessage.turnDuration
            merged.turnTps = loadedMessage.turnTps ?? cachedMessage.turnTps
            merged.turnId = loadedMessage.turnId ?? cachedMessage.turnId
            merged.steer = loadedMessage.steer ?? cachedMessage.steer
            return merged
        }
        let mergedMessages = preservingLocalSteeringTurns(
            serverMergedMessages,
            cachedMessages: cachedMessages
        )
        return insertingUnconfirmedLocalUserMessages(
            from: cachedMessages,
            into: mergedMessages
        )
    }

    /// Re-inserts the local optimistic user rows the reloaded transcript has not
    /// confirmed yet, so a prompt in flight renders exactly once.
    ///
    /// A contextless reload passes the `runningTurnID` its newest prompt started. Current Web stamps that
    /// prompt's row with it as `_turn_id`, so identity decides. For an older server, rows the device showed
    /// before a prompt cannot confirm it, so a just-answered identical turn ("continue", then "continue"
    /// again) cannot stand in for it.
    nonisolated private static func insertingUnconfirmedLocalUserMessages(
        from localMessages: [ChatMessage],
        into loadedMessages: [ChatMessage],
        runningTurnID: String? = nil
    ) -> [ChatMessage] {
        let isPrompt = { (message: ChatMessage) in
            isLocalOptimisticUserMessage(message) && !message.isLocalSteeringHint
        }
        let runningPromptIndex = localMessages.lastIndex(where: isPrompt)
        // Contextless only: a loaded row confirms one prompt, so an earlier prompt that is still optimistic
        // claims its own persisted copy before a repeat can match it.
        var claimedLoadedIndices = Set<Int>()
        var unconfirmedMessages: [ChatMessage] = []
        for index in localMessages.indices where isPrompt(localMessages[index]) {
            var excludedLoadedIndices = claimedLoadedIndices
            // The newest loaded row the device showed before the prompt: every row after it is newer.
            var shownBoundary: Int?
            if runningTurnID != nil {
                // Each shown row claims the oldest loaded row with its key, so keyless rows match by place.
                var unclaimedShownRows = Dictionary(
                    localMessages[..<index].compactMap(shownRowKey).map { ($0, 1) },
                    uniquingKeysWith: +
                )
                for (loadedIndex, loadedMessage) in loadedMessages.enumerated()
                where !claimedLoadedIndices.contains(loadedIndex) {
                    guard let key = shownRowKey(loadedMessage), let count = unclaimedShownRows[key], count > 0
                    else { continue }
                    unclaimedShownRows[key] = count - 1
                    shownBoundary = loadedIndex
                }
                if let shownBoundary { excludedLoadedIndices.formUnion(0...shownBoundary) }
            }
            if let confirmingIndex = equivalentUserMessageIndex(
                in: loadedMessages,
                excluding: excludedLoadedIndices,
                localMessage: localMessages[index],
                turnID: index == runningPromptIndex ? runningTurnID : nil,
                comparesClocks: shownBoundary == nil
            ) {
                if runningTurnID != nil { claimedLoadedIndices.insert(confirmingIndex) }
            } else {
                unconfirmedMessages.append(localMessages[index])
            }
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
            var merged = loadedAssistant
            merged.content = reconciledActiveStreamContent(
                loadedContent: loadedAssistant.content,
                snapshotContent: snapshotAssistant.content
            )
            merged.timestamp = loadedAssistant.timestamp ?? snapshotAssistant.timestamp
            merged.messageId = loadedAssistant.messageId ?? snapshotAssistant.messageId
            merged.name = loadedAssistant.name ?? snapshotAssistant.name
            merged.toolCallId = loadedAssistant.toolCallId ?? snapshotAssistant.toolCallId
            merged.toolUseId = loadedAssistant.toolUseId ?? snapshotAssistant.toolUseId
            merged.toolCalls = loadedAssistant.toolCalls ?? snapshotAssistant.toolCalls
            merged.contentParts = loadedAssistant.contentParts ?? snapshotAssistant.contentParts
            merged.reasoning = loadedAssistant.reasoning ?? snapshotAssistant.reasoning
            merged.reasoningTitles = loadedAssistant.reasoningTitles ?? snapshotAssistant.reasoningTitles
            merged.activityScene = loadedAssistant.activityScene ?? snapshotAssistant.activityScene
            merged.attachments = loadedAssistant.attachments ?? snapshotAssistant.attachments
            merged.turnDuration = loadedAssistant.turnDuration ?? snapshotAssistant.turnDuration
            merged.turnTps = loadedAssistant.turnTps ?? snapshotAssistant.turnTps
            merged.turnId = loadedAssistant.turnId ?? snapshotAssistant.turnId
            merged.steer = loadedAssistant.steer ?? snapshotAssistant.steer
            mergedMessages[assistantIndex] = merged
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

    nonisolated private static func hasAssistantResponseAfterLatestUser(in messages: [ChatMessage]) -> Bool {
        guard !messages.isEmpty else { return false }

        let searchRange: Range<Int>
        if let latestUserIndex = messages.lastIndex(where: { $0.role == "user" }) {
            searchRange = messages.index(after: latestUserIndex)..<messages.endIndex
        } else {
            searchRange = messages.startIndex..<messages.endIndex
        }

        return messages[searchRange].contains { message in
            guard message.role == "assistant" else { return false }
            return hasAssistantResponseContent(message)
        }
    }

    nonisolated private static func hasAssistantResponseContent(_ message: ChatMessage) -> Bool {
        if message.content?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }

        if message.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }

        if message.toolCalls?.isEmpty == false {
            return true
        }

        return hasAssistantContentParts(message.contentParts)
    }

    nonisolated private static func hasAssistantContentParts(_ parts: [JSONValue]?) -> Bool {
        guard let parts else { return false }

        return parts.contains { part in
            switch part {
            case .string(let value):
                return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            case .object(let object):
                if case .string(let type)? = object["type"] {
                    switch type {
                    case "tool_use", "thinking", "reasoning", "redacted_thinking":
                        return true
                    case "text":
                        if case .string(let text)? = object["text"] {
                            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                        }
                    default:
                        break
                    }
                }

                return false
            case .number, .bool, .array, .null:
                return false
            }
        }
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

    /// A server row's identity across reloads: its `message_id`, else its role, server timestamp and content.
    nonisolated private static func shownRowKey(_ message: ChatMessage) -> String? {
        if let messageID = message.messageId {
            return messageID.hasPrefix("local-") ? nil : messageID
        }
        return "\(message.role ?? "")|\(message.timestamp.map { "\($0)" } ?? "")|\(message.content ?? "")"
    }

    nonisolated private static func equivalentUserMessageIndex(
        in loadedMessages: [ChatMessage],
        excluding excludedIndices: Set<Int>,
        localMessage: ChatMessage,
        turnID: String?,
        comparesClocks: Bool
    ) -> Int? {
        let localContent = normalizedUserMessageContent(localMessage)
        let localAttachmentKeys = attachmentKeys(for: localMessage)

        return loadedMessages.indices.first { loadedIndex in
            let loadedMessage = loadedMessages[loadedIndex]
            // The running turn's own stamped row stays eligible wherever the server placed it.
            let isRunningTurnRow = turnID != nil && loadedMessage.turnId == turnID
            guard isRunningTurnRow || !excludedIndices.contains(loadedIndex), loadedMessage.role == "user"
            else { return false }

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

            // The running prompt's stamped turn, not the two clocks, decides on current Web.
            if let turnID, let loadedTurnID = loadedMessage.turnId {
                return loadedTurnID == turnID
            }

            // An older identical prompt ("continue") must not confirm a newer one. Past a shown boundary every
            // candidate is newer than the prompt's history, so the phone's and server's clocks are not compared.
            guard comparesClocks,
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

    /// `queuedAttachments` sends a queued message's own files; nil sends the composer's staged ones.
    public func sendMessage(
        _ draft: String,
        queuedAttachments: [PendingAttachment]? = nil,
        modelContext: ModelContext? = nil
    ) async -> Bool {
        await performMessageSend(draft, queuedAttachments: queuedAttachments, modelContext: modelContext).didStart
    }

    private func performMessageSend(
        _ draft: String,
        queuedAttachments: [PendingAttachment]?,
        modelContext: ModelContext?
    ) async -> ChatSendOutcome {
        // Reentrancy guard, mirroring `sendVoiceNote`. It must run before
        // `prepareForSend` so a rejected send never consumes the composer's
        // staged attachments, and before `performChatSend` so a rejected caller
        // never reaches that method's `defer { isStartingChat = false }`.
        guard !isStartingChat, !isSendingVoiceNote else { return ChatSendOutcome(didStart: false) }
        guard !isViewingCachedData else {
            sendErrorMessage = String(localized: "Reconnect to the server to send a message.")
            return ChatSendOutcome(didStart: false)
        }

        // A server that names attached files in the prompt (TAL-276) gets the bare draft, as Web
        // sends it; adding an `[Attached files: …]` line there sent it to the agent twice
        // (TAL-635). An older server still gets the files named in the text. A textless send is
        // valid when it carries staged files: compose before `prepareForSend` consumes them.
        let draftText = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentsToSend = queuedAttachments ?? attachmentCoordinator.pendingAttachments
        let message = PendingAttachment.chatMessageText(draft: draftText, attachments: attachmentsToSend)
        let hasSendableAttachments = attachmentsToSend.contains {
            !$0.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !message.isEmpty || hasSendableAttachments else { return ChatSendOutcome(didStart: false) }

        guard let sessionID else {
            sendErrorMessage = String(localized: "The server did not provide a session ID.")
            return ChatSendOutcome(didStart: false)
        }

        let localMessageID = "local-\(UUID().uuidString)"
        let attachmentPreparation = attachmentCoordinator.prepareForSend(queuedAttachments, localMessageID: localMessageID)

        let outcome = await performChatSend(
            sessionID: sessionID,
            localMessageID: localMessageID,
            // The optimistic row shows the draft and its attachments, which is what the server
            // replays once it strips its own marker, so the bubble keeps its look across a reload.
            displayContent: message,
            messageForAPI: message,
            messageAttachments: attachmentPreparation.messageAttachments,
            apiPayloads: attachmentPreparation.apiPayloads,
            // A queued message keeps its files in the queue when its send fails, not in the composer.
            attachmentsToRestoreOnFailure: queuedAttachments == nil ? attachmentPreparation.attachments : [],
            modelContext: modelContext
        )
        if outcome.didStart {
            for attachment in attachmentPreparation.attachments {
                guard let fileName = attachment.draftFileName else { continue }
                await attachmentCoordinator.deleteDraftCopy(named: fileName)
            }
        }
        return outcome
    }

    /// Records → transcribes → uploads → sends a server-transcribed voice note
    /// (Telegram-style). The sent message's text is the transcript and its sole
    /// attachment is the audio clip, rendered as a playable note by the inline
    /// audio player. Aborts (toast, no partial send) if transcription fails or
    /// returns nothing. The outcome says whether the chat send started and carries
    /// the error this voice note hit, captured before the `defer` below releases the
    /// pipeline to a queued send that clears `lastError` (TAL-150).
    @discardableResult
    public func sendVoiceNote(audioData: Data, filename: String, modelContext: ModelContext? = nil) async -> ChatSendOutcome {
        // Reentrancy guard: bail if a voice note OR a regular chat send is already
        // in flight. It has to live here rather than only in `performChatSend`,
        // because transcription and upload run before that call and must not start
        // at all while another send owns the pipeline. Without it two overlapping
        // sends would both flip `isStartingChat`/`isSendingVoiceNote` and race their
        // `defer { … = false }` (clearing the flag while the other still runs, and
        // firing two concurrent `startChat`s). The UI already blocks this; the guard
        // keeps a future caller (accessibility shortcut, test harness) safe too.
        guard !isSendingVoiceNote, !isStartingChat else { return ChatSendOutcome(didStart: false) }
        guard !isViewingCachedData else {
            setUploadAttachmentError(String(localized: "Reconnect to the server to send a voice note."))
            return ChatSendOutcome(didStart: false)
        }
        guard !audioData.isEmpty else { return ChatSendOutcome(didStart: false) }
        guard audioData.count <= PendingAttachment.maximumUploadBytes else {
            setUploadAttachmentError(PendingAttachment.uploadTooLargeMessage(filename: filename))
            return ChatSendOutcome(didStart: false)
        }
        guard let sessionID else {
            setUploadAttachmentError(String(localized: "The server did not provide a session ID."))
            return ChatSendOutcome(didStart: false)
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
                return ChatSendOutcome(didStart: false)
            }
            let text = (response.transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                setUploadAttachmentError(String(localized: "Couldn't transcribe that voice note. Try recording again."))
                return ChatSendOutcome(didStart: false)
            }
            transcript = text
        } catch {
            lastError = error
            setUploadAttachmentError(error.localizedDescription)
            return ChatSendOutcome(didStart: false, error: error)
        }

        // 2. Upload the clip as a standalone attachment (kept out of the composer's
        //    pending list). On failure the coordinator already surfaced the error,
        //    reporting its thrown error through `lastError`; no other send can clear
        //    that while this voice note owns the pipeline.
        guard let pending = await attachmentCoordinator.uploadStandaloneAttachment(
            data: audioData,
            filename: filename
        ) else {
            return ChatSendOutcome(didStart: false, error: lastError)
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
    ) async -> ChatSendOutcome {
        // Single-owner backstop for the shared start pipeline: only one caller may
        // own the optimistic row, the `startChat` request, and `isStartingChat` at a
        // time. Deliberately does not test `isSendingVoiceNote` — the voice pipeline
        // sets that flag before calling in, so it would reject itself. `isStartingChat`
        // is set below without an intervening suspension, so a second caller that
        // reaches here while the first is awaiting its request is rejected here
        // instead of racing the append and the `defer`.
        guard !isStartingChat else {
            restorePendingAttachments(attachmentsToRestoreOnFailure)
            return ChatSendOutcome(didStart: false)
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
                return ChatSendOutcome(didStart: false)
            }

            completeExplicitModelPickForChatStart(explicitModelPick)
            streamCoordinator.start(
                streamID: streamID,
                armsAggregateForLocalWork: true,
                runStartedAt: response.runStartedAt(sentAt: sentAt)
            )
            return ChatSendOutcome(didStart: true)
        } catch {
            if let streamID = (error as? APIError)?.activeStreamID {
                rollbackOptimisticMessage(id: localMessageID)
                cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
                restorePendingAttachments(attachmentsToRestoreOnFailure)
                await attachToServerStartedRun(streamID: streamID, modelContext: modelContext)
                // The server kept the earlier run, not this newly submitted text.
                // Report an unaccepted send so ChatView restores the draft while
                // the coordinator reconnects to the existing response.
                return ChatSendOutcome(didStart: false)
            }
            lastError = error
            sendErrorMessage = error.localizedDescription
            rollbackOptimisticMessage(id: localMessageID)
            cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
            restorePendingAttachments(attachmentsToRestoreOnFailure)
            return ChatSendOutcome(didStart: false, error: error)
        }
    }

    /// Follows a run that started outside this view model's own send. The server transcript is reconciled first,
    /// so the SSE tokens attach to the persisted turn instead of creating a second bubble with only the tail.
    private func attachToServerStartedRun(streamID: String, modelContext: ModelContext?) async {
        await loadMessages(modelContext: modelContext, waitsForPendingMessageSend: false)
        _ = restoreActiveStreamSnapshotIfAvailable(streamID: streamID)
        streamingAssistantMessageID = TranscriptTurnClassifier
            .currentTurnAssistantAnchorIDs(in: messages, messageOffset: messagesOffset)
            .first
        streamCoordinator.start(streamID: streamID)
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

    public func submitGoal(args rawArgs: String, modelContext: ModelContext? = nil) async -> Bool {
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
            try cacheMessagesIfCurrent(messages, sessionID: sessionID, in: modelContext)
        } catch {
            cacheErrorMessage = error.localizedDescription
        }
    }

    /// Whether no server-scoped reset ran since this chat opened (`ServerCacheGeneration`).
    private var ownsCurrentCache: Bool {
        ServerCacheGeneration.current(for: server) == cacheGeneration
    }

    private func cacheMessagesIfCurrent(_ messages: [ChatMessage], sessionID: String, in modelContext: ModelContext) throws {
        guard ownsCurrentCache else { return }
        try CacheStore.cacheMessages(messages, serverURL: server, sessionID: sessionID, in: modelContext)
    }

    /// Saves the transcript as it stands, a partial answer included, when the chat leaves the
    /// screen or the app goes to the background (TAL-437), so reopening it or relaunching the app
    /// paints it at once while the server load and replay catch up.
    public func persistTranscript(modelContext: ModelContext) {
        // An empty or offline transcript has nothing newer than the cache, and writing an empty
        // one would delete the saved rows.
        guard let sessionID, !messages.isEmpty, !isViewingCachedData else { return }
        flushPendingStreamingContent()
        cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
    }

    public func cacheCompletedResponse(modelContext: ModelContext) {
        guard let sessionID else { return }
        cacheCurrentMessages(sessionID: sessionID, modelContext: modelContext)
    }

    func clearTranscript() {
        cancelPendingStreamingScrollTrigger()
        resetPendingStreamingContentBuffers()
        clearCompressionReference()
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
                return .executed(message: Self.slashCommandHelpText(catalog: agentCommands))
            }
        case .serverSide(let action):
            return await executeServerSideSlashCommand(action, args: args)
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

    public func submitStreamingMessage(
        _ draft: String,
        behavior: StreamingSendBehavior
    ) async -> SlashCommandExecutionResult {
        switch behavior {
        case .steer:
            // Steering has no attachment channel, so a send with staged files queues
            // them with its text instead of steering the text and leaving them behind.
            if !attachmentCoordinator.pendingAttachments.isEmpty {
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

        // The queued-messages chip shows the queue, so no notice (TAL-630).
        enqueueQueuedSlashMessage(message, attachments: attachmentCoordinator.consumePendingAttachments())
        return .executed(message: nil)
    }

    /// `requeuedAttachments` go with the message if the run cannot take it; by default the composer's pending files do.
    private func steerResponseFromSlashCommand(
        _ args: String,
        requeuedAttachments: [PendingAttachment]? = nil
    ) async -> SlashCommandExecutionResult {
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
        ownSteers.remember(steeringHint.messageID)
        steerRequestsInFlight.insert(steeringHint.messageID)
        defer { steerRequestsInFlight.remove(steeringHint.messageID) }
        var serverHasSteer = false
        var unconfirmedSteerID: String?
        do {
            let response = try await client.steerChat(
                sessionID: sessionID,
                text: message,
                steerID: steeringHint.messageID
            )
            // TAL-460: sent during a background turn, the message started the user's own turn; follow it.
            if let streamID = response.startedTurn?.streamId {
                removeSteeringHint(id: steeringHint.messageID)
                await attachToServerStartedRun(streamID: streamID, modelContext: nil)
                return .executed(message: nil)
            }
            serverHasSteer = response.accepted == true
        } catch {
            lastError = error
            // TAL-441: the request may have reached the server anyway. A steer it already reported is its own; otherwise
            // the queued copy keeps the steer's ID so a later report drops it instead of sending the message twice.
            serverHasSteer = closedSteerIDs.contains(steeringHint.messageID) || pendingSteerActions[steeringHint.messageID] != nil
            unconfirmedSteerID = steeringHint.messageID
        }

        if serverHasSteer {
            updateSteeringHint(id: steeringHint.messageID, state: .waiting)
            finalizeSteeringPhase(
                assistantMessageID: steeringHint.precedingAssistantMessageID,
                endingAt: steeringHint.timestamp
            )
            return .executed(message: nil)
        }
        removeSteeringHint(id: steeringHint.messageID)
        ownSteers.forget(steeringHint.messageID)
        // TAL-441: the run may still be alive, so the message waits for it rather than stopping it.
        _ = enqueueQueuedSlashMessage(
            message,
            attachments: requeuedAttachments ?? attachmentCoordinator.consumePendingAttachments(),
            steerID: unconfirmedSteerID
        )
        return .executed(message: String(localized: "Steer was unavailable, so the message was queued for after this response."))
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
        let backgroundTasks = backgroundTasks.filter(\.active).count
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

            await refreshBackgroundTasks()
            if !serverHasBackgroundTasks {
                legacyBackgroundPrompts[taskID] = prompt
                startLegacyBackgroundPolling(parentSessionID: sessionID)
            }
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

            currentModelOptionID = response.session?.model != nil ? response.session?.modelOptionID : match?.id
            currentModel = response.session?.model ?? match?.id ?? requestedModel
            currentModelProvider = response.session?.modelProvider ?? match?.providerID ?? currentModelProvider
            applyServerWorkspace(response.session?.workspace, name: response.session?.workspaceName)
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

            currentWorkspace = workspace
            applyServerWorkspace(response.session?.workspace, name: response.session?.workspaceName)
            if let session = response.session, session.model != nil { currentModelOptionID = session.modelOptionID }
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
            applyCompressionReference(from: session)
            messages = session.messages ?? []
            updateOlderMessagePagination(from: session, loadedMessageCount: messages.count)
            isViewingCachedData = false
            // The compressed session carries the server's post-compression figures (TAL-299).
            contextWindowSnapshot = ContextWindowSnapshot(session: session)
            if let title = session.title {
                displayTitle = Self.displayTitle(from: title)
            }
            applyServerWorkspace(session.workspace, name: session.workspaceName)
            if session.model != nil { currentModelOptionID = session.modelOptionID }
            currentModel = session.model ?? currentModel
            currentModelProvider = session.modelProvider ?? currentModelProvider
            currentProfile = session.profile ?? currentProfile
            setCompletedToolCallGroups(ToolCallGroup.groups(
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
    public func appendLocalAssistantMessage(_ text: String) -> String? {
        appendLocalMessage(text, role: "local_assistant", idPrefix: "local-slash")
    }

    @discardableResult
    public func appendLocalNoticeMessage(_ text: String) -> String? {
        appendLocalMessage(text, role: "local_notice", idPrefix: "local-notice")
    }

    public func pinLocalNoticeMessage(_ text: String) {
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
        noteSteerChange(messageID)
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

        noteSteerChange(id)
        messages[index] = Self.steeringHintMessage(messages[index], state: state)
    }

    private func removeSteeringHint(id: String) {
        messages.removeAll { $0.messageId == id && $0.isLocalSteeringHint }
    }

    private func settleAcceptedSteeringHints() {
        for index in messages.indices where messages[index].steeringHintState == .waiting {
            messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
            if let id = messages[index].messageId { pendingSteerActions.removeValue(forKey: id) }
        }
    }

    @discardableResult
    private func consumeSteeringHint(id: String?, text: String) -> Bool {
        if let id {
            dropQueuedCopy(ofSteer: id)
            closeSteer(id)
            ownSteers.forget(id)
        }
        if let id,
           let index = messages.firstIndex(where: { $0.messageId == id && $0.isLocalSteeringHint }) {
            messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
            return true
        }
        guard let index = messages.firstIndex(where: {
            $0.isLocalSteeringHint && $0.content == text && $0.steeringHintState == .waiting
        }) else { return false }
        if let rowID = messages[index].messageId { closeSteer(rowID) }
        messages[index] = Self.steeringHintMessage(messages[index], state: .consumed)
        return true
    }

    private func removeUnresolvedSteeringHints() {
        messages.removeAll { message in
            message.steeringHintState == .sending || message.steeringHintState == .waiting
        }
    }

    /// TAL-426: show a pending steer as the server reports it, from any device, once; a closed one never returns.
    private func applyPendingSteer(_ steer: PendingSteer) {
        dropQueuedCopy(ofSteer: steer.steerId)
        guard !closedSteerIDs.contains(steer.steerId) else { return }
        let state: SteeringHintState = steer.state == .pending ? .waiting : .sending
        let index = messages.firstIndex(where: { $0.messageId == steer.steerId })
        // Already taken here: no actions, and the row stays as the Agent saw it.
        if let index, messages[index].steeringHintState == .consumed { return }
        noteSteerChange(steer.steerId)
        pendingSteerActions[steer.steerId] = steer.state == .pending ? steer.actions : PendingSteer.Actions.none
        if let index {
            messages[index] = Self.steeringHintMessage(messages[index], state: state)
            return
        }
        messages.append(ChatMessage(
            role: "user",
            content: steer.text,
            timestamp: steer.submittedAt ?? Date().timeIntervalSince1970,
            messageId: steer.steerId,
            name: state.rawValue
        ))
        scheduleStreamingScrollTrigger()
    }

    /// TAL-426: after a load the server's `pending_steers` are the pending rows: one per steer, in its order, and none it
    /// no longer holds. A row this device sent or changed after the fetch (a steer POST, a `steer_pending` frame) is newer
    /// than the list and stays as it is. A Web older than TAL-424 lists none, so this device's own rows stay as they were.
    private func applyServerPendingSteers(_ steers: [PendingSteer]?, changedAfter fetch: Int, newerRows: [ChatMessage]) {
        serverListsPendingSteers = steers != nil
        // The reload rebuilt the transcript from rows captured before the fetch; rows changed since come back as they were.
        for row in newerRows where !messages.contains(where: { $0.messageId == row.messageId }) { messages.append(row) }
        // ponytail: old-server fallback; delete once every supported Web ships `pending_steers`.
        guard let steers else { return }
        let newer = Set(steerChangedAt.filter { $0.value > fetch }.keys).union(steerRequestsInFlight)
        let kept = Set(steers.map(\.steerId)).union(newer)
        var seen = Set<String>()
        messages.removeAll { message in
            guard message.isLocalSteeringHint, message.steeringHintState != .consumed, let id = message.messageId else { return false }
            return !kept.contains(id) || !seen.insert(id).inserted
        }
        for id in pendingSteerActions.keys where !kept.contains(id) { pendingSteerActions.removeValue(forKey: id) }
        for steer in steers where !newer.contains(steer.steerId) { applyPendingSteer(steer) }
    }

    /// The pending rows changed here after a load's fetch: newer than anything that load carries.
    private func pendingSteerRows(changedAfter fetch: Int) -> [ChatMessage] {
        messages.filter { message in
            guard message.isLocalSteeringHint, message.steeringHintState != .consumed, let id = message.messageId else { return false }
            return (steerChangedAt[id] ?? 0) > fetch
        }
    }

    private func noteSteerChange(_ id: String) {
        steerChangeCount += 1
        steerChangedAt[id] = steerChangeCount
    }

    /// A snapshot merge never brings back a closed steer or shows one twice; once the server lists pending steers, the
    /// pending rows are the ones already shown (its list, its events, this device's request in flight).
    private func withoutRestoredPendingSteers(_ merged: [ChatMessage], shownBefore: [ChatMessage]) -> [ChatMessage] {
        let shown = Set(shownBefore.filter(\.isLocalSteeringHint).compactMap(\.messageId))
        var seen = Set<String>()
        return merged.filter { message in
            guard message.isLocalSteeringHint, message.steeringHintState != .consumed, let id = message.messageId else { return true }
            return !closedSteerIDs.contains(id) && (!serverListsPendingSteers || shown.contains(id)) && seen.insert(id).inserted
        }
    }

    /// The steer is taken or withdrawn: its actions go, and nothing brings its pending row back.
    private func closeSteer(_ id: String) {
        closedSteerIDs.insert(id)
        pendingSteerActions.removeValue(forKey: id)
    }

    private func applyWithdrawnSteer(_ event: SteerWithdrawnEvent) {
        guard let id = event.steerId else { return }
        let wasQueued = dropQueuedCopy(ofSteer: id)
        closeSteer(id)
        // Never taken: whatever state the row reached, it is not a steer the Agent saw.
        messages.removeAll { $0.messageId == id && $0.isLocalSteeringHint }
        if ownSteers.forget(id) || wasQueued, event.reason == .stopped { returnedComposerTexts.append(event.text) }
    }

    /// The view took the returned text into its composer.
    public func takeReturnedComposerTexts() -> [String] {
        defer { returnedComposerTexts = [] }
        return returnedComposerTexts
    }

    /// TAL-426 Edit and Cancel: take a pending steer back. Edit puts its text in the composer; a steer the Agent already
    /// took says so and stays where it is.
    public func withdrawPendingSteer(id: String, reason: PendingSteerWithdrawReason) async {
        guard let sessionID, steerActionsInFlight.insert(id).inserted else { return }
        defer { steerActionsInFlight.remove(id) }
        do {
            let response = try await client.withdrawSteer(sessionID: sessionID, steerID: id, reason: reason)
            guard response.withdrawn else {
                pinLocalNoticeMessage(String(localized: "This steering message can no longer be changed."))
                return
            }
            let shownText = messages.first { $0.messageId == id && $0.isLocalSteeringHint }?.content
            applyWithdrawnSteer(SteerWithdrawnEvent(steerId: id, reason: reason == .edit ? .edit : .cancel, text: ""))
            if reason == .edit, let text = response.text ?? shownText { returnedComposerTexts.append(text) }
        } catch {
            lastError = error
            sendErrorMessage = error.localizedDescription
        }
    }

    /// TAL-426 Send now: deliver a pending steer at once; with nothing running to take it, it stays pending.
    public func sendPendingSteerNow(id: String) async {
        guard let sessionID, steerActionsInFlight.insert(id).inserted else { return }
        defer { steerActionsInFlight.remove(id) }
        do {
            if !(try await client.sendSteerNow(sessionID: sessionID, steerID: id)).redirected {
                pinLocalNoticeMessage(String(localized: "Nothing is running to take it now; it stays pending."))
            }
        } catch {
            lastError = error
            sendErrorMessage = error.localizedDescription
        }
    }

    nonisolated private static func steeringHintMessage(
        _ message: ChatMessage,
        state: SteeringHintState
    ) -> ChatMessage {
        var hint = message
        hint.name = state.rawValue
        return hint
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
        var updated = existing
        updated.content = content
        messages[index] = updated
        scheduleStreamingScrollTrigger()
    }

    public func setSendErrorMessage(_ message: String?) {
        sendErrorMessage = message
    }

    public func forkFromMessage(_ context: MessageActionContext, modelContext: ModelContext? = nil) async -> SessionSummary? {
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
            if let modelContext, ownsCurrentCache {
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
    public func editMessage(_ context: MessageActionContext, newText: String, modelContext: ModelContext? = nil) async -> Bool {
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
                    messages: messages,
                    messageOffset: messagesOffset
                ))
                completedReasoningGroups = []
                liveAssistantActivity.removeAll()
                toolCallAnchorMessageID = nil
                reasoningAnchorMessageID = nil

                if let modelContext {
                    do {
                        try cacheMessagesIfCurrent(messages, sessionID: sessionID, in: modelContext)
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

    public func regenerateAssistantResponse(
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
                    messages: messages,
                    messageOffset: messagesOffset
                ))
                completedReasoningGroups = []
                liveAssistantActivity.removeAll()
                toolCallAnchorMessageID = nil
                reasoningAnchorMessageID = nil

                if let modelContext {
                    do {
                        try cacheMessagesIfCurrent(messages, sessionID: sessionID, in: modelContext)
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
    public func cancelActiveStream() async -> Bool {
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

            // TAL-426: the stream stops reading here, so the Stop's answer is what returns this device's steers.
            for steer in response.withdrawnSteers ?? [] { applyWithdrawnSteer(steer) }
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

    public func clearMessageActionError() {
        messageActionErrorMessage = nil
    }

    public func toggleListening(to context: MessageActionContext) {
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

    public func stopListening() {
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

    public func toggleListenPlaybackPlayPause() {
        switch listenPlaybackPhase {
        case .playing:
            pauseListenPlayback()
        case .paused:
            resumeListenPlayback()
        case .idle, .loading:
            break
        }
    }

    public func setListenPlaybackSpeed(_ speed: ListenPlaybackSpeed) {
        guard listenPlaybackSpeed != speed else { return }
        listenPlaybackSpeed = speed
        userDefaults.set(speed.rawValue, forKey: ListenPlaybackSpeed.storageKey)
        listenAudioPlayer?.rate = Float(speed.rawValue)
        updateListenNowPlaying()
    }

    public func scrubListenPlayback(to time: TimeInterval) {
        listenPlaybackScrubTime = boundedListenPlaybackTime(time)
    }

    public func setListenPlaybackScrubbing(_ scrubbing: Bool) {
        if scrubbing {
            listenPlaybackScrubTime = listenPlaybackElapsedTime
        } else if let target = listenPlaybackScrubTime {
            seekListenPlayback(to: target)
            listenPlaybackScrubTime = nil
        }
    }

    public func refreshListenPlaybackProgressAfterSceneActivation() {
        guard listenPlaybackPhase == .playing || listenPlaybackPhase == .paused else { return }

        updateListenPlaybackProgressFromPlayer()
        if listenPlaybackPhase == .playing {
            startListenPlaybackTicker()
        }
    }

    public func suspendStreamForBackground() {
        suspendActiveStreamConnection()
    }

    public func suspendStreamForNavigation() {
        suspendActiveStreamConnection()
    }

    public func cleanupPollingTasks() {
        stopBackgroundPolling(clearTrackedPrompts: true)
        pendingActionCoordinator.stopMonitoring(clearPrompt: true)
    }

    private func suspendActiveStreamConnection() {
        streamCoordinator.suspendActiveStreamConnection()
    }

    public func reconnectStreamIfNeeded(modelContext: ModelContext? = nil) async {
        await streamCoordinator.reconnectIfNeeded(modelContext: modelContext)
    }

    /// Brings an open chat current with the server (TAL-434): an idle chat reloads, which also
    /// adopts a run started elsewhere; a suspended run reconnects; a run this chat is already
    /// streaming is left alone. The reload joins one already in flight (TAL-184).
    public func syncWithServer(modelContext: ModelContext? = nil) async {
        await syncWithServer(modelContext: modelContext, joinsLoadInFlight: true)
    }

    private func syncWithServer(modelContext: ModelContext?, joinsLoadInFlight: Bool) async {
        if activeStreamID == nil {
            if joinsLoadInFlight {
                await refreshSession(modelContext: modelContext)
            } else {
                await loadMessages(modelContext: modelContext)
            }
        }
        // A joined load outlives a caller that was cancelled (its chat closed or its scene went
        // inactive); that caller leaves the stream as its cleanup left it.
        guard !Task.isCancelled else { return }
        await reconnectStreamIfNeeded(modelContext: modelContext)
    }

    /// Loads the session for a refresh that needs nothing newer than a load already in flight
    /// (opening, pull-to-refresh, foreground return, offline recovery), joining that load instead
    /// of sending an equivalent request alongside it (TAL-184).
    public func refreshSession(modelContext: ModelContext? = nil, isUserRefresh: Bool = false) async {
        if let joinableSessionLoad {
            await joinableSessionLoad.value
            return
        }
        let load = Task { await loadMessages(modelContext: modelContext, isUserRefresh: isUserRefresh) }
        joinableSessionLoad = load
        await load.value
        joinableSessionLoad = nil
    }

    /// Recovers a chat that fell back to its cached transcript once its server answers again
    /// (TAL-184): every `interval` it retries the session load, skipping a tick while another
    /// load is in flight. A failed retry stays silent and offline; success refreshes background
    /// work like a manual refresh. Runs until cancelled, so the caller scopes it to an active
    /// scene and the visible chat. `afterAttempt` reports each attempt's error.
    public func recoverWhenServerReturns(
        modelContext: ModelContext? = nil,
        every interval: Duration = .seconds(30),
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        afterAttempt: () -> Void = {}
    ) async {
        while !Task.isCancelled, (try? await sleep(interval)) != nil {
            guard isViewingCachedData, activeSessionLoadRequestGenerations.isEmpty else { continue }
            await syncWithServer(modelContext: modelContext)
            afterAttempt()
            // A chat closed meanwhile has stopped its polling; leave it stopped.
            if !isViewingCachedData, !Task.isCancelled {
                await refreshBackgroundTasks()
            }
        }
    }

    /// Syncs when a change the server announced concerns this chat. The change may postdate a
    /// load in flight, so this always reads afresh.
    public func handleSessionsChange(_ change: SessionsChange, modelContext: ModelContext? = nil) async {
        guard let sessionID, SessionsChangeTrigger.session(sessionID).matches(change) else { return }
        await syncWithServer(modelContext: modelContext, joinsLoadInFlight: false)
        // TAL-372: a background task that changed announces it the same way.
        await refreshBackgroundTasks()
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

    public func recoverStaleActiveStreamIfNeeded(
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
              !hasCompletedCurrentResponse,
              // A chat closing after its server's reset cannot put the snapshot back (TAL-183).
              ownsCurrentCache
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
        messages = withoutRestoredPendingSteers(merge.messages, shownBefore: messages)
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
    public func respondToApproval(_ choice: ApprovalChoice) async -> Bool {
        await pendingActionCoordinator.respondToApproval(choice)
    }

    @discardableResult
    public func skipApprovalsForCurrentSession() async -> Bool {
        await pendingActionCoordinator.skipApprovalsForCurrentSession()
    }

    @discardableResult
    public func disableApprovalBypassForCurrentSession() async -> Bool {
        await pendingActionCoordinator.disableApprovalBypassForCurrentSession()
    }

    /// Sets the session's toolsets, nil for the profile's defaults; the control then shows what the
    /// server saved. The strip's controls stay disabled until it answers, so saves never overlap. A
    /// failure keeps the old value and reports in the composer (TAL-631).
    @discardableResult
    public func saveSessionToolsets(_ names: [String]?) async -> Bool {
        guard let sessionID, !isUpdatingComposerConfiguration else { return false }
        isUpdatingComposerConfiguration = true
        composerConfigurationErrorMessage = nil
        defer { isUpdatingComposerConfiguration = false }
        do {
            let response = try await client.setSessionToolsets(sessionID: sessionID, toolsets: names)
            sessionToolsets = SessionToolsets(names: response.enabledToolsets)
            return true
        } catch {
            lastError = error
            composerConfigurationErrorMessage = error.localizedDescription
            return false
        }
    }

    func applyApprovalUpdate(_ update: ApprovalPendingResponse, sessionID: String) {
        pendingActionCoordinator.applyApprovalUpdate(update, sessionID: sessionID)
    }

    @discardableResult
    public func respondToClarification(_ responseText: String) async -> Bool {
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
        case .heartbeat, .ignored, .reasoning, .toolStarted, .toolCompleted, .title, .metering, .steerConsumed, .steerPending, .steerWithdrawn:
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
            backgroundTasks = []
            legacyBackgroundPrompts.removeAll()
        }
    }

    /// TAL-372: reload the session's background records. A failed read keeps what is shown; reading consumes nothing.
    public func refreshBackgroundTasks() async {
        guard let sessionID, !isViewingCachedData else { return }
        do {
            let response = try await client.backgroundTasks(sessionID: sessionID)
            guard self.sessionID == sessionID else { return }
            serverHasBackgroundTasks = true
            backgroundTasks = response.tasks
        } catch APIError.http(statusCode: 404, body: _) {
            serverHasBackgroundTasks = false
            return
        } catch {
            return
        }
        if backgroundTasks.contains(where: { $0.active }) {
            startBackgroundPollingIfNeeded()
        }
    }

    /// The full result of a finished task, from the server.
    public func backgroundResult(taskID: String) async -> String? {
        guard let sessionID else { return nil }
        return try? await client.backgroundResult(sessionID: sessionID, taskID: taskID).text
    }

    /// Dismissing is shared read state: the task leaves the card on every device and stays in the history.
    public func dismissBackgroundTask(taskID: String) async {
        guard let sessionID else { return }
        do {
            _ = try await client.dismissBackgroundTask(sessionID: sessionID, taskID: taskID)
        } catch {
            lastError = error
            return
        }
        await refreshBackgroundTasks()
    }

    /// ponytail: old-server fallback (TAL-372); polls the status route until each tracked task's answer arrives. It
    /// replaces any running poll: a Web downgraded mid-session leaves the tasks poll with nothing to read.
    private func startLegacyBackgroundPolling(parentSessionID: String) {
        backgroundPollTask?.cancel()
        backgroundPollTask = nil
        let pollingInterval = pollingIntervals.backgroundNanoseconds
        let sleep = pollingIntervals.sleep
        backgroundPollTask = Task { @MainActor [weak self] in
            pollingLoop: while !Task.isCancelled {
                try? await sleep(pollingInterval)
                guard !Task.isCancelled, let self, !self.legacyBackgroundPrompts.isEmpty else { break pollingLoop }
                guard let response = try? await self.client.backgroundStatus(sessionID: parentSessionID) else { continue }
                for result in response.results ?? [] {
                    guard let taskID = result.taskId, let prompt = self.legacyBackgroundPrompts.removeValue(forKey: taskID) else { continue }
                    let answer = result.answer?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let summary = prompt.count > 80 ? "\(prompt.prefix(80))..." : prompt
                    self.appendLocalAssistantMessage("**Background** \(summary)\n\n\(answer.isEmpty ? String(localized: "No answer produced.") : answer)")
                }
                if self.legacyBackgroundPrompts.isEmpty { break pollingLoop }
            }
            if !Task.isCancelled {
                self?.backgroundPollTask = nil
            }
        }
    }

    /// While work runs, the card refreshes quietly; it stops once nothing is running.
    private func startBackgroundPollingIfNeeded() {
        guard backgroundPollTask == nil else { return }

        let pollingInterval = pollingIntervals.backgroundNanoseconds
        let sleep = pollingIntervals.sleep
        backgroundPollTask = Task { @MainActor [weak self] in
            pollingLoop: while !Task.isCancelled {
                try? await sleep(pollingInterval)
                guard !Task.isCancelled, let self else { break pollingLoop }
                guard let sessionID = self.sessionID else { continue }
                let response: BackgroundTasksResponse
                do {
                    response = try await self.client.backgroundTasks(sessionID: sessionID)
                } catch APIError.http(statusCode: 404, body: _) {
                    // An older Web (TAL-372 fallback): nothing to refresh here.
                    self.serverHasBackgroundTasks = false
                    break pollingLoop
                } catch {
                    continue
                }
                guard !Task.isCancelled, self.sessionID == sessionID else { break pollingLoop }
                self.backgroundTasks = response.tasks
                guard self.backgroundTasks.contains(where: { $0.active }) else { break pollingLoop }
            }

            if !Task.isCancelled {
                self?.backgroundPollTask = nil
            }
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
            var updated = existing
            updated.content = currentContent + separator + text
            messages[index] = updated
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
        applyCompressionReference(from: completedSession)

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

        applyServerWorkspace(completedSession.workspace, name: completedSession.workspaceName)
        if completedSession.model != nil { currentModelOptionID = completedSession.modelOptionID }
        currentModel = completedSession.model ?? currentModel
        currentModelProvider = completedSession.modelProvider ?? currentModelProvider
        currentProfile = completedSession.profile ?? currentProfile

        contextWindowSnapshot = ContextWindowSnapshot(session: completedSession)
        if didApplyCompletedTranscript || completedSession.toolCalls != nil {
            let rebuiltToolCallGroups = ToolCallGroup.groups(
                messages: messages,
                messageOffset: messagesOffset
            )
            // The server's resolved calls are authoritative; the live cards stand in only when the transcript has none
            // for the current turn.
            let currentTurnAnchors = Set(TranscriptTurnClassifier.currentTurnAssistantAnchorIDs(
                in: messages,
                messageOffset: messagesOffset
            ))
            if !liveToolCalls.isEmpty,
               !rebuiltToolCallGroups.contains(where: { $0.anchorMessageID.map(currentTurnAnchors.contains) == true }) {
                let fallbackAnchorMessageID = currentTurnToolCallFallbackAnchorMessageID()
                setCompletedToolCallGroups(rebuiltToolCallGroups + [
                    ToolCallGroup(
                        id: "completed-live-tools-\(fallbackAnchorMessageID ?? "unanchored")",
                        anchorMessageID: fallbackAnchorMessageID,
                        toolCalls: liveToolCalls
                    )
                ])
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
            var archived = message
            archived.contentParts = liveAssistantActivity.persistedContentParts
            messages[messageIndex] = archived
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
                    resultView: payload.resultView,
                    editDiff: payload.editDiff,
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
        guard let stableID = payload.stableID?.nonEmptyReplayMatchText else { return nil }
        return liveToolCalls.lastIndex { toolCall in
            !toolCall.isCompleted && toolCall.matchesStableToolID(stableID)
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
            var updatedMessage = existing
            updatedMessage.content = (existing.content ?? "") + appendedContent
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
        atFront: Bool = false,
        steerID: String? = nil
    ) -> Int {
        let message = QueuedSlashMessage(text: text, attachments: attachments, steerID: steerID)
        if atFront {
            queuedSlashMessages.insert(message, at: 0)
        } else {
            queuedSlashMessages.append(message)
        }
        return queuedSlashMessages.count
    }

    /// Remove: drops a queued message and its files' saved draft copies (TAL-630).
    public func removeQueuedMessage(id: UUID) async {
        guard let message = takeQueuedMessage(id: id)?.message else { return }
        for fileName in message.attachments.compactMap(\.draftFileName) {
            await attachmentCoordinator.deleteDraftCopy(named: fileName)
        }
    }

    /// Edit: takes a queued message out of the queue and puts it back in the composer with its files.
    public func editQueuedMessage(id: UUID) {
        guard let message = takeQueuedMessage(id: id)?.message else { return }
        attachmentCoordinator.restorePendingAttachments(message.attachments)
        if !message.text.isEmpty { returnedComposerTexts.append(message.text) }
    }

    /// Send now: steers a queued text message into the running reply instead of waiting for it to end;
    /// a steer the run cannot take queues it again, as `/steer` does, and a send that cannot start puts it back.
    public func sendQueuedMessageNow(id: UUID) async {
        guard !isSendingQueuedMessage,
              queuedMessagePreviews.first(where: { $0.id == id })?.canSendNow == true,
              let (message, index) = takeQueuedMessage(id: id)
        else { return }
        guard activeStreamID != nil else {
            // Nothing running to steer into: it goes first, and the queue sends it.
            queuedSlashMessages.insert(message, at: 0)
            drainQueuedSlashMessageIfIdle()
            return
        }
        isSendingQueuedMessage = true
        // A steer the run refuses queues again with the message's own files, never the composer's.
        let result = await steerResponseFromSlashCommand(message.text, requeuedAttachments: message.attachments)
        isSendingQueuedMessage = false
        if case .unsupported(let notice) = result {
            // Back in place, with no drain: a send that keeps failing must not retry in a loop (issue #202).
            queuedSlashMessages.insert(message, at: min(index, queuedSlashMessages.count))
            pinLocalNoticeMessage(notice)
            return
        }
        if case .executed(let notice?) = result { pinLocalNoticeMessage(notice) }
        // A reply that ended meanwhile skipped its drain while this one held the queue.
        drainQueuedSlashMessageIfIdle()
    }

    /// TAL-441: a queued copy of a failed steer may be on the server, which cannot say whether it never arrived or the
    /// Agent took it, so it stays as it is until the server reports it or the run ends.
    private func takeQueuedMessage(id: UUID) -> (message: QueuedSlashMessage, index: Int)? {
        guard let index = queuedSlashMessages.firstIndex(where: { $0.id == id }),
              queuedSlashMessages[index].steerID == nil
        else { return nil }
        return (queuedSlashMessages.remove(at: index), index)
    }


    /// TAL-441: the server reported a steer whose request failed, so it owns the message; the queued copy goes.
    @discardableResult
    private func dropQueuedCopy(ofSteer id: String) -> Bool {
        guard let index = queuedSlashMessages.firstIndex(where: { $0.steerID == id }) else { return false }
        attachmentCoordinator.restorePendingAttachments(queuedSlashMessages.remove(at: index).attachments)
        return true
    }

    private func drainQueuedSlashMessageIfIdle() {
        // `isSendingVoiceNote` belongs here alongside `isStartingChat`: `sendMessage`
        // rejects while a voice note owns the pipeline, so draining then would only
        // dequeue and immediately requeue. `sendVoiceNote` re-triggers the drain when
        // it releases the pipeline, including when it fails without starting a stream.
        guard activeStreamID == nil,
              !isStartingChat,
              !isSendingVoiceNote,
              !isSendingQueuedMessage,
              !queuedSlashMessages.isEmpty
        else { return }

        let next = queuedSlashMessages.removeFirst()
        isSendingQueuedMessage = true

        Task { @MainActor in
            let outcome = await performMessageSend(next.text, queuedAttachments: next.attachments, modelContext: nil)
            let sent = outcome.didStart
            if !sent {
                queuedSlashMessages.insert(next, at: 0)
                // No caller awaits a queued send, so its error goes to `queuedSendFailure` for ChatView's
                // `onAPIError` (an expired sign-in reauthenticates), while `sendErrorMessage` already shows
                // it in the chat. The message stays queued for the next natural trigger, never an immediate retry.
                if let error = outcome.error {
                    queuedSendFailure = ChatSendFailure(error: error)
                }
            }
            isSendingQueuedMessage = false
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

        let inputText = formatTokens(input)
        let outputText = formatTokens(output)
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
        let suffix = modelID.split(separator: "/").last.map(String.init) ?? modelID
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

    /// The iOS commands the server catalog lists (TAL-314), in its order, with their aliases.
    static func slashCommandHelpText(catalog: [AgentCommand]) -> String {
        let lines = catalog.filter { $0.isCatalogEntry && $0.isClientHandled && $0.runsOnIOS }.flatMap { entry -> [String] in
            guard let name = entry.name, let command = SlashCommandCatalog.command(named: name) else { return [] }
            let usage = ["/\(name)", command.argHint].compactMap { $0 }.joined(separator: " ")
            let aliases = (entry.aliases ?? []).map { "`/\($0)` - " + String(localized: "Alias for \("`/\(name)`")") }
            return ["`\(usage)` - \(command.description)"] + aliases
        }
        guard !lines.isEmpty else { return String(localized: "Check your connection, then try again.") }
        return ([String(localized: "Available mobile commands:"), ""] + lines).joined(separator: "\n")
    }
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
    public var streamCoordinatorSessionID: String? { sessionID }
    public var streamCoordinatorDisplayTitle: String { displayTitle }
    public var streamCoordinatorHasRunningLiveToolCall: Bool { hasRunningLiveToolCall }
    public var streamCoordinatorHasPendingPrompt: Bool {
        pendingActionCoordinator.hasPendingPrompt
    }
    public var streamCoordinatorStreamingAssistantMessageID: String? {
        get { streamingAssistantMessageID }
        set {
            if newValue == nil {
                flushPendingStreamingContent()
            }
            streamingAssistantMessageID = newValue
        }
    }

    public func streamCoordinatorLoadMessages(modelContext: ModelContext?) async {
        await loadMessages(modelContext: modelContext)
    }

    public func streamCoordinatorLatestAssistantMessageID() -> String? {
        Self.latestAssistantMessageIDAfterLatestSteeringHint(in: messages)
    }

    public func streamCoordinatorServerTerminalState(turnID: String) -> String? {
        if let state = messages.last(where: { $0.turnId == turnID && $0.activityScene != nil })?.activityScene?.terminalState {
            // A running scene (TAL-374) is the turn's persisted work so far: the server states no outcome yet.
            return state == "running" ? nil : state
        }
        // ponytail: old-server fallback — a turn from a Web before settled-turn scenes states no outcome, so the latest
        // load's reply after the prompt counts as completed. Delete once every supported Web ships scene `terminal_state`.
        return latestServerLoadHadAssistantResponseAfterLatestUser ? "completed" : nil
    }

    public func streamCoordinatorOmitLoadedRunningTurn() -> Bool {
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

    public func streamCoordinatorStartAuxiliaryMonitoring() {
        pendingActionCoordinator.startMonitoring()
    }

    public func streamCoordinatorStopAuxiliaryMonitoring(clearPrompt: Bool) {
        pendingActionCoordinator.stopMonitoring(clearPrompt: clearPrompt)
    }

    public func streamCoordinatorSaveSnapshotIfNeeded() {
        flushPendingStreamingContent()
        saveActiveStreamSnapshotIfNeeded()
    }

    @discardableResult
    public func streamCoordinatorRestoreSnapshotIfAvailable(streamID: String) -> String? {
        restoreActiveStreamSnapshotIfAvailable(streamID: streamID)
    }

    public func streamCoordinatorRemoveSnapshot(streamID: String?) {
        removeActiveStreamSnapshot(streamID: streamID)
    }

    public func streamCoordinatorFlushPinnedLocalNoticesToTranscript() {
        flushPinnedLocalNoticesToTranscript()
    }

    public func streamCoordinatorDrainQueuedSlashMessageIfIdle() {
        drainQueuedSlashMessageIfIdle()
    }

    public func streamCoordinatorRefreshCompletedResponseTitleIfNeeded() {
        refreshCompletedResponseTitleIfNeeded()
    }

    public func streamCoordinatorDidCompleteCurrentResponse(needsTranscriptRefresh: Bool, outcome: ResponseCompletionOutcome) {
        responseCompletionNeedsTranscriptRefresh = needsTranscriptRefresh
        responseCompletionOutcome = outcome
        responseCompletionHapticTrigger += 1
    }

    public func streamCoordinatorDidFinishStream() {
        flushPendingStreamingContent()
        responseCompletionNeedsTranscriptRefresh = false
    }

    public func streamCoordinatorDidReceiveErrorMessage(_ message: String) {
        sendErrorMessage = message
    }

    public func streamCoordinatorDidReceiveRecoveryError(_ error: Error) {
        lastError = error
        sendErrorMessage = error.localizedDescription
        ownsSendErrorForRecovery = true
    }

    public func streamCoordinatorDidConfirmRecovery() {
        // Stream activity proved recovery, so retract the warning this coordinator
        // raised — but only while it still owns the banner. A composer or send
        // error that landed since then belongs on screen.
        guard ownsSendErrorForRecovery else { return }

        sendErrorMessage = nil
        lastError = nil
    }

    @discardableResult
    public func streamCoordinatorAppendToken(_ text: String) -> Bool {
        appendAssistantToken(text)
    }

    @discardableResult
    public func streamCoordinatorAppendInterimAssistant(_ payload: InterimAssistantStreamEvent) -> Bool {
        appendInterimAssistant(payload)
    }

    @discardableResult
    public func streamCoordinatorAppendReasoning(_ payload: ReasoningStreamEvent) -> Bool {
        appendReasoning(payload)
    }

    @discardableResult
    public func streamCoordinatorAppendToolCall(_ payload: ToolStreamEvent) -> Bool {
        appendToolCall(payload)
    }

    @discardableResult
    public func streamCoordinatorCompleteToolCall(_ payload: ToolStreamEvent) -> Bool {
        completeToolCall(payload)
    }

    @discardableResult
    public func streamCoordinatorUpdateTitle(_ payload: TitleStreamEvent) -> Bool {
        updateTitle(payload)
    }

    public func streamCoordinatorApplySettledSession(_ session: SessionDetail) {
        applyCompletedStreamSession(session)
    }

    @discardableResult
    public func streamCoordinatorApplyDone(_ payload: DoneStreamEvent) -> Bool {
        flushPendingStreamingContent()
        let currentStreamingAssistantID = streamingAssistantMessageID
        let hasCompletedTranscript = payload.session?.messages?.isEmpty == false
        if let completedSession = payload.session {
            applyCompletedStreamSession(completedSession)
        }
        if payload.session?.messages?.contains(where: { $0.activityScene?.hasConsumedSteering == true }) == true {
            // The finished scene renders its steers, even ones outside the loaded window; a steer the Agent never took
            // is withdrawn by the server (`steer_withdrawn`) and sent as its follow-up turn, so no local hint stays behind.
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

    public func streamCoordinatorApplyApprovalUpdate(_ update: ApprovalPendingResponse) {
        guard let sessionID else { return }
        applyApprovalUpdate(update, sessionID: sessionID)
    }

    public func streamCoordinatorApplyClarificationUpdate(_ update: ClarificationPendingResponse) {
        guard let sessionID else { return }
        applyClarificationUpdate(update, sessionID: sessionID)
    }

    @discardableResult
    public func streamCoordinatorConsumeSteeringHint(_ event: SteeringStreamEvent) -> Bool {
        consumeSteeringHint(id: event.steerId, text: event.text)
    }

    public func streamCoordinatorApplyPendingSteer(_ steer: PendingSteer) {
        applyPendingSteer(steer)
    }

    public func streamCoordinatorWithdrawSteer(_ event: SteerWithdrawnEvent) {
        applyWithdrawnSteer(event)
    }
}
