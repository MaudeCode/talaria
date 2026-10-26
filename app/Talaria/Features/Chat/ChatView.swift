import SwiftUI
import SwiftData
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import TalariaKit

#if DEBUG
/// A non-observable reference keeps measuring a body from invalidating that body's
/// environment. Like the message-menu registry, its identity survives environment updates.
@MainActor
final class ChatBodyEvaluationRecorder {
    private(set) var counts: [String: Int] = [:]
    private(set) var transcriptFrame: CGRect = .null

    func recordTranscriptFrame(_ frame: CGRect) { transcriptFrame = frame }

    func callAsFunction(_ body: String) {
        counts[body, default: 0] += 1
    }

    func reset() {
        counts.removeAll(keepingCapacity: true)
    }
}

private struct ChatBodyEvaluationKey: EnvironmentKey {
    static let defaultValue: ChatBodyEvaluationRecorder? = nil
}

extension EnvironmentValues {
    var chatBodyEvaluation: ChatBodyEvaluationRecorder? {
        get { self[ChatBodyEvaluationKey.self] }
        set { self[ChatBodyEvaluationKey.self] = newValue }
    }
}
#endif

private enum GitChatAlert: Identifiable {
    case confirmRemote(GitRemoteAction)
    case dirtyCheckout(GitCheckoutTarget)
    case error(String)

    var id: String {
        switch self {
        case .confirmRemote(let action): "remote:\(action.rawValue)"
        case .dirtyCheckout(let target): "checkout:\(target.id)"
        case .error(let message): "error:\(message)"
        }
    }
}

private enum ActiveGitSheet: Identifiable {
    case changes
    case commit

    var id: Self { self }
}

/// What the per-turn diff sheet shows (issue #316): every changed file in the turn, or a
/// single file's diff (a recap-card row tap).
private enum TurnDiffPresentation: Identifiable {
    case turnFiles([GitFile])
    case file(GitFile)

    var id: String {
        switch self {
        case .turnFiles(let files): return "turn:" + files.map(\.id).joined(separator: "|")
        case .file(let file): return "file:" + file.id
        }
    }
}

/// The window owns the chat's explicit Files presentation and makes room for it (TAL-1453). Its chat reports the
/// current session and whether Files or a companion page needs that room (TAL-1458).
struct SplitFilesInspector {
    let isPresented: Binding<Bool>
    let widensChat: Bool
    let reportShown: (Bool) -> Void
    var reportSession: (SessionSummary) -> Void = { _ in }
    var offersCompanionPage = false
    var reportCompanionPage: (Bool) -> Void = { _ in }
    var reportEmptyTranscript: (Bool) -> Void = { _ in }
}

struct ChatView: View {
#if DEBUG
    @Environment(\.chatBodyEvaluation) private var recordBodyEvaluation
#endif
    @Environment(\.chatDivisionFramesForTesting) private var divisionFramesForTesting
    private var bottomAnchorID: String {
        latestTranscriptMessageID ?? ChatTranscriptView.emptyContainerID
    }
    private let transcriptMessageSpacing: CGFloat = 10
    private let transcriptBlockSpacing: CGFloat = 6
    private let composerAccessoryVerticalSpacing: CGFloat = 8

    @State private var modelSwitchAlert: ModelSwitchConfirmation?
    @State private var completionAcknowledgementTask: Task<Void, Never>?
    @State private var completionAcknowledgementGeneration = 0
    @State private var viewedCompletionsThrough: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    /// The chat's frame, bars included: the size the companion page's split rule reads (TAL-1458).
    @State private var arrangementSize: CGSize = .zero
    @Environment(\.holdsForegroundLayout) private var holdsForegroundLayout
    @Environment(\.targetChatLayoutWidth) private var targetChatLayoutWidth
    @State private var lastActiveLayoutSize: CGSize = .zero
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true
    @AppStorage(StreamingSendBehavior.storageKey) private var streamingSendBehaviorRawValue = StreamingSendBehavior.steer.rawValue
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var isResponseCompletionNotificationsEnabled = false
    @AppStorage(AgentRunLiveActivityPrivacy.showsResponseExcerptsKey) private var showsLiveActivityResponseExcerpts = false
    @AppStorage(ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey) private var showsThinkingAndToolCards = true
    @AppStorage(ChatTranscriptDisplaySettings.rtlChatLayoutEnabledKey) private var rtlChatLayoutEnabled = ChatTranscriptDisplaySettings.rtlChatLayoutDefaultEnabled
    @AppStorage(ChatScrollToBottomButtonSide.storageKey) private var scrollToBottomButtonSideRawValue = ChatScrollToBottomButtonSide.right.rawValue
    @AppStorage(SectionVisibilitySettings.chatFilesKey) private var showsFilesButton = true
    @AppStorage(SectionVisibilitySettings.chatGitKey) private var showsGitControls = true

    /// The chat's session. A new chat starts with a provisional one, without an ID, and takes on
    /// the session the server creates in place (TAL-636).
    @State private var session: SessionSummary
    /// Creates a new chat's session; nil for a chat that already has one.
    let startSession: (() async -> ChatSessionStartResult)?
    let server: URL
    let onAPIError: (Error) -> Void
    let loadsInitialMessages: Bool
    /// When true, the composer auto-starts voice dictation on appear — set by the
    /// "New Chat with Voice" App Intent (#338). Defaults to false for normal opens.
    let autoStartsVoiceInput: Bool
    let isExplicitNewChat: Bool
    let draftStore: ChatDraftStore
    /// Store holding the durable app-owned copies of staged attachments.
    let draftAttachmentStore: any ChatDraftAttachmentStoring
    /// True only for the pending-new-chat flow: after the composer configuration
    /// loads, the restored draft's settings snapshot is applied (each value
    /// revalidated against the live server configuration). Existing sessions
    /// load their configuration from the server and never re-apply a snapshot.
    let restoresDraftSettings: Bool
    let onConversationStarted: () -> Void
    let splitFilesInspector: SplitFilesInspector?
    /// What the session list keeps of this chat while its navigation is rebuilt (TAL-1477); nil for a chat it doesn't.
    @State private var retained: RetainedChat?
    /// True while this view carries on a chat a replaced view was showing, which is still loaded and running.
    @State private var takesOverLiveChat: Bool
    /// The row a taken-over transcript reopens at, when its reader had scrolled away from the latest message.
    @State private var restoredReadingRowID: String?

    @State private var draftMessageStorage = ""
    @State private var draftWriteRevision = 0
    @State private var draftRevision = 0
    @State private var draftTextWriteID: UUID?

    /// Every write bumps `draftWriteRevision`, so the composer can order the updates
    /// it receives and ignore one a newer write has already superseded. Without that
    /// order it cannot tell a deliberate replacement from a superseded snapshot, and
    /// applying the wrong one destroys in-progress IME composition (TAL-159).
    private var draftMessage: String {
        get { draftMessageStorage }
        nonmutating set {
            draftMessageStorage = newValue
            draftWriteRevision &+= 1
        }
    }
    @State private var isScrolledNearBottom = true
    /// Debounced "Syncing messages" pill (TAL-436); each chat's view starts it hidden.
    @State private var showsSyncingPill = false
    @State private var isReadingOlderTranscript = false
    @State private var followLatch = ChatScrollPolicy.FollowLatch()
    @State private var followScrollGeneration = 0
    /// While settling, the transcript's bottom size-change anchor and follow-driven
    /// scrolls are suspended so a disclosure toggle grows or shrinks in place.
    @State private var disclosureSettle = ChatScrollPolicy.DisclosureSettle()
    /// Bumped when a follow the settling suspension blocked is due (TAL-151).
    @State private var followReplayRequest = 0
    /// While set and in the future, auto-follow scrolls snap instead of animating, so
    /// the cache-first → network reconcile re-pins to the bottom without a jump (#289).
    @State private var cacheFirstSnapUntil: Date?
    @State private var forkedSession: SessionSummary?
    @State private var editContext: MessageActionContext?
    @State private var editDraft = ""
    @State private var showEditSheet = false
    /// True until the edit sheet's dismissal finishes, so a confirmation the send brings back presents after it (TAL-929).
    @State private var isEditSheetOnScreen = false
    @State private var showApprovalBypassOffConfirmation = false
    /// The Agent's notices dismissed on this device (TAL-831); a notice whose text changes shows again.
    @State private var dismissedSessionNotices: Set<SessionNotice> = []
    /// The measured height of compact entries that reserve transcript space.
    @State private var compactStatusHeight: CGFloat = 0
    @State private var noticeChipHeight: CGFloat = 0
    @State private var showsQueuedMessagesSheet = false
    @State private var showsBackgroundWorkSheet = false
    @State private var selectableResponseText: SelectableTextPresentation?
    @State private var attachmentPreviewItem: ChatAttachmentPreviewItem?
    @State private var transcriptMediaPreviewItem: TranscriptMediaPreviewItem?
    /// A workspace file a chat link named; shown in the source viewer at its line.
    @State private var openedFileLink: WorkspaceFileLink?
    @State private var openedWebPage: InAppSafariPage?
    @State private var pendingProfileSelection: ProfileSummary?
    @State private var showProfileNewSessionConfirmation = false
    @State private var goalDraft = ""
    @State private var showsGoalSheet = false
    @State private var activeGitSheet: ActiveGitSheet?
    @State private var turnDiffPresentation: TurnDiffPresentation?
    @State private var viewModel: ChatViewModel
    @State private var gitAvailabilityViewModel: GitWorkspaceAvailabilityViewModel
    @State private var gitToastState = GitActionToastState()
    @State private var gitAlert: GitChatAlert?
    @State private var composerHeight: CGFloat = 52
    @State private var hasMeasuredComposer = false
    /// Bumped by the scroll-to-latest chip; the transcript scrolls on each change.
    @State private var scrollToBottomRequest = 0
    @State private var clarificationPanelHeight: CGFloat = 320
    @State private var composerAvailableHeight: CGFloat = 0
    @State private var tabletopIsActive = false
    @State private var composerAccessoriesHeight: CGFloat = 0
    @State private var keyboardIsVisible = false
    @Environment(\.divisionRegionGeometry) private var divisionGeometry
    @State private var composerIsFocused = false
    @State private var composerRequiresExpandedPresentation = false
    @State private var stagingAttachmentBatches = 0
    @State private var didHydrateDraft = false
    /// True from the moment hydration finds persisted attachment records until
    /// their restore pass finishes. It gates `syncDraftAttachments` across the
    /// whole window, so the not-yet-rebuilt composer strip can never overwrite
    /// the persisted set.
    @State private var isRestoringDraftAttachments = false
    /// Records hydration found, handed to the restore pass that runs alongside
    /// the transcript load rather than in front of it.
    @State private var draftAttachmentsAwaitingRestore: [ChatDraftAttachment] = []
    /// Saved records without a visible pending owner stay here for a later restore.
    /// Visible failed uploads own their retry and durable copy in the coordinator.
    @State private var draftAttachmentsPendingRetry: [ChatDraftAttachment] = []
    @State private var lastSyncedDraftAttachments: [ChatDraftAttachment] = []
    @State private var restoredDraftSettings: ChatDraftSettings?
    @State private var didApplyRestoredDraftSettings = false
    @Environment(\.sessionActions) private var sessionActions
    @State private var hasVerticalToolbar = false

    @State private var didCompleteInitialAppearance = false
    @State private var isInitialComposerFocusContentReady = false
    @State private var didApplyInitialComposerFocusPolicy = false
    @State private var shouldRestoreComposerFocusAfterPreview = false
    @State private var responseCompletionNotificationTracker = ResponseCompletionNotificationTracker()
    @State private var responseCompletionBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    @State private var activeStreamStatusRefreshTask: Task<Void, Never>?
    @State private var initialAttachments: [SharedAttachmentImport]
    @State private var didUploadInitialAttachments = false
    @State private var initialImportedAttachmentIDs = Set<UUID>()
    /// While a new chat's session is being created, or after creating it failed (TAL-636).
    @State private var sessionStart: ComposerSessionStart?
    @State private var sessionStartTask: Task<Bool, Never>?
    @State private var pendingCreationSettings: ChatDraftSettings?
    @State private var pendingCreationInteractionGeneration: Int?
    @State private var isOpeningFiles = false
    @State private var showsFilesBrowser = false
    @State private var sessionStartGeneration = 0
    @State private var pendingFirstDraft: String?
    @State private var pendingSubmissionAttachmentIDs = Set<UUID>()

    init(
        session: SessionSummary,
        server: URL,
        onAPIError: @escaping (Error) -> Void,
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        loadsInitialMessages: Bool = true,
        autoStartsVoiceInput: Bool = false,
        isExplicitNewChat: Bool = false,
        draftStore: ChatDraftStore? = nil,
        draftAttachmentStore: (any ChatDraftAttachmentStoring)? = nil,
        restoresDraftSettings: Bool = false,
        startSession: (() async -> ChatSessionStartResult)? = nil,
        viewModel: ChatViewModel? = nil,
        onConversationStarted: @escaping () -> Void = {},
        sessionListOwner: SessionListViewModel? = nil,
        splitFilesInspector: SplitFilesInspector? = nil,
        retained: RetainedChat? = nil
    ) {
        _session = State(initialValue: session)
        self.startSession = startSession
        self.server = server
        self.onAPIError = onAPIError
        self.loadsInitialMessages = loadsInitialMessages
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.isExplicitNewChat = isExplicitNewChat
        self.draftStore = draftStore ?? .shared
        let resolvedDraftAttachmentStore = draftAttachmentStore ?? ChatDraftAttachmentStore.shared
        self.draftAttachmentStore = resolvedDraftAttachmentStore
        self.restoresDraftSettings = restoresDraftSettings
        self.onConversationStarted = onConversationStarted
        self.splitFilesInspector = splitFilesInspector
        _draftMessageStorage = State(initialValue: initialDraft)
        _initialAttachments = State(initialValue: initialAttachments)
        _viewModel = State(initialValue: retained?.viewModel ?? viewModel ?? Self.makeViewModel(
            session: session,
            server: server,
            draftAttachmentStore: resolvedDraftAttachmentStore,
            sessionListOwner: sessionListOwner
        ))
        _gitAvailabilityViewModel = State(initialValue: retained?.gitAvailability ?? GitWorkspaceAvailabilityViewModel(
            session: session,
            server: server
        ))
        _retained = State(initialValue: retained)
        _takesOverLiveChat = State(initialValue: retained?.isLive ?? false)
        _restoredReadingRowID = State(initialValue: retained?.readingRowID)
        _followLatch = State(initialValue: ChatScrollPolicy.FollowLatch(isFollowing: retained?.readingRowID == nil))
    }

    static func makeViewModel(
        session: SessionSummary,
        server: URL,
        draftAttachmentStore: any ChatDraftAttachmentStoring = ChatDraftAttachmentStore.shared,
        sessionListOwner: SessionListViewModel? = nil
    ) -> ChatViewModel {
        ChatViewModel(
            session: session,
            server: server,
            showsLiveActivityResponseExcerpts: UserDefaults.standard.bool(
                forKey: AgentRunLiveActivityPrivacy.showsResponseExcerptsKey
            ),
            draftAttachmentStore: draftAttachmentStore,
            responseCache: .app(server: server),
            networkPath: NetworkPathObserver.shared,
            sessionListOwner: sessionListOwner
        )
    }

    // Extracted from `body` so the type-checker doesn't have to solve the whole composer
    // call alongside the rest of the screen in one expression (#316 pushed it over the
    // "unable to type-check in reasonable time" limit).
    private func messageComposer(availableHeight: CGFloat) -> some View {
        let prompt = viewModel.clarificationPrompt
        return messageComposerInput(prompt: prompt, availableHeight: availableHeight)
            // Replacing the input also cancels picker presentation; dictation, which the chat owns, stops with it.
            .id(prompt?.id ?? "message")
            .onChange(of: prompt?.id) { viewModel.voiceInput.stopBeforeSubmittingDraft() }
            .adaptiveReadableContent(maxWidth: AdaptiveReadableContentWidth.chat)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
            composerHeight = $0
            if $0 > 0 { hasMeasuredComposer = true }
        }
        .environment(\.layoutDirection, chatLayoutDirection)
        .background(
            NavigationAppearanceCompletionObserver(action: handleInitialAppearanceCompletion)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        )
    }

    private func messageComposerInput(prompt: ClarificationPromptState?, availableHeight: CGFloat) -> some View {
        MessageComposerView(
            draftMessage: composerDraftBinding(promptID: prompt?.id),
            draftWriteRevision: draftWriteRevision,
            clarificationPanelHeight: $clarificationPanelHeight,
            availableHeight: availableHeight,
            isFocused: $composerIsFocused,
            isSending: prompt != nil ? viewModel.isRespondingToClarification : viewModel.isSubmittingMessage,
            isCompressingSession: prompt == nil && viewModel.isCompressingSession,
            isWaitingForStream: prompt == nil && viewModel.activeStreamID != nil,
            isCancellingStream: prompt == nil && viewModel.isCancellingStream,
            isOfflineReadOnly: viewModel.isViewingCachedData,
            isSessionReadOnly: viewModel.isComposerReadOnly,
            ownerAttachment: viewModel.ownerAttachment,
            isChromeCompact: isComposerChromeCompact,
            errorMessage: prompt == nil ? viewModel.sendErrorMessage : nil,
            warningMessage: prompt == nil ? viewModel.streamWarningMessage : nil,
            configurationErrorMessage: prompt == nil ? (viewModel.composerConfigurationErrorMessage ?? viewModel.ownerModelChangeMessage) : nil,
            contextWindowSnapshot: viewModel.contextWindowSnapshot,
            gitViewModel: gitAvailabilityViewModel,
            modelGroups: viewModel.modelCatalogGroups,
            selectedModelID: viewModel.selectedModelID,
            selectedModelProviderID: viewModel.selectedModelProviderID,
            selectedModelOptionID: viewModel.selectedModelOptionID,
            selectedModelTitle: viewModel.selectedModelTitle,
            workspaceRoots: viewModel.workspaceRoots,
            selectedWorkspacePath: viewModel.selectedWorkspacePath,
            selectedWorkspaceName: viewModel.selectedWorkspaceName,
            workspaceSuggestions: viewModel.workspaceSuggestions,
            workspaceManagementServer: server,
            personalitySuggestions: viewModel.personalitySuggestions,
            skillSuggestions: viewModel.skillSlashSuggestions,
            agentCommands: viewModel.agentCommands,
            profileOptions: viewModel.profileOptions,
            isSingleProfileMode: viewModel.isSingleProfileMode,
            selectedProfileName: viewModel.selectedProfileName,
            selectedProfileTitle: viewModel.selectedProfileTitle,
            isLoadingModels: viewModel.isLoadingComposerConfiguration,
            selectedReasoningEffort: viewModel.selectedReasoningEffort,
            supportedReasoningEfforts: viewModel.supportedReasoningEfforts,
            showsReasoningControl: viewModel.showsReasoningEffortControl,
            isUpdatingConfiguration: viewModel.isUpdatingComposerConfiguration,
            pendingAttachments: viewModel.pendingAttachments,
            // An in-flight draft restore counts as an upload in progress: until
            // it finishes, the composer does not yet hold the attachments the
            // user expects this message to carry.
            isUploadingAttachment: prompt == nil && (viewModel.isUploadingAttachment || isRestoringDraftAttachments || stagingAttachmentBatches > 0),
            attachmentUploadCount: viewModel.attachmentUploadCount,
            attachmentUploadGeneration: viewModel.attachmentUploadGeneration,
            isSendingVoiceNote: viewModel.isSendingVoiceNote,
            hasUnsentVoiceNote: viewModel.pendingVoiceDraft != nil,
            autoStartsVoiceInput: prompt == nil && autoStartsVoiceInput,
            voiceInputRequestID: 0,
            voiceInput: viewModel.voiceInput,
            apiClient: viewModel.client,
            uploadAttachmentErrorMessage: prompt == nil ? viewModel.uploadAttachmentErrorMessage : nil,
            onSend: { behavior in
                Task {
                    guard prompt?.id == viewModel.clarificationPrompt?.id else { return }
                    if let prompt {
                        await submitClarification(promptID: prompt.id)
                    } else {
                        await sendDraftMessage(behavior: behavior)
                    }
                }
            },
            onSendAs: { command in
                Task { await sendDraftMessage(as: command) }
            },
            onSendVoiceNote: { data, filename in
                Task { await sendVoiceNote(audioData: data, filename: filename) }
            },
            onCancel: {
                Task { await cancelStream() }
            },
            onSelectModel: { option in
                Task {
                    guard viewModel.clarificationPrompt == nil else { return }
                    let didSelect = await viewModel.selectComposerModel(option)
                    if didSelect {
                        ChatHaptics.configurationSelected(isEnabled: isHapticsEnabled)
                    }
                }
            },
            onModelPickerOpen: {
                await viewModel.refreshModelCatalogForPickerOpen()
            },
            onLoadWorkspaceSuggestions: { prefix in
                await viewModel.loadWorkspaceSuggestions(prefix: prefix)
            },
            onWorkspaceRegistryChanged: {
                await viewModel.refreshWorkspaceRoots()
            },
            onLoadPersonalitySuggestions: {
                await viewModel.loadPersonalitySuggestions()
            },
            onLoadSkillSuggestions: {
                await viewModel.loadSkillSlashSuggestions()
            },
            onSelectWorkspace: { path in
                guard viewModel.clarificationPrompt == nil else { return }
                let didSelect = await viewModel.selectWorkspacePath(path)
                if didSelect {
                    ChatHaptics.configurationSelected(isEnabled: isHapticsEnabled)
                }
            },
            onSelectProfile: { profile in
                handleProfileSelection(profile)
            },
            onSelectReasoningEffort: { effort in
                Task {
                    guard viewModel.clarificationPrompt == nil else { return }
                    let didSelect = await viewModel.selectReasoningEffort(effort)
                    if didSelect {
                        ChatHaptics.configurationSelected(isEnabled: isHapticsEnabled)
                    }
                }
            },
            onHeightChange: { _ in },
            onPhotoItemSelected: { item in
                Task { await handlePhotoSelection(item) }
            },
            onFileURLsSelected: { urls in
                Task { await handleSelectedFileURLs(urls) }
            },
            onPasteFileProviders: { providers in
                Task { await handlePastedFileProviders(providers) }
            },
            onPasteFileURLs: { urls in
                Task { await handlePastedFileURLs(urls) }
            },
            onPasteImageProviders: { providers in
                Task { await handlePastedImageProviders(providers) }
            },
            onPasteImages: { images in
                Task { await handlePastedImages(images) }
            },
            onDropAttachmentProviders: { providers in
                Task { await handleDroppedAttachmentProviders(providers) }
            },
            onRemoveAttachment: { id in
                // The receipt also fences a restore response that is still in flight.
                lastSyncedDraftAttachments.removeAll { $0.id == id }
                draftAttachmentsPendingRetry.removeAll { $0.id == id }
                viewModel.removePendingAttachment(id: id)
                if lastSyncedDraftAttachments.isEmpty { isRestoringDraftAttachments = false }
                syncDraftAttachments()
            },
            onPreviewAttachment: { attachment in
                presentPreviewRestoringComposerFocusIfNeeded {
                    attachmentPreviewItem = ChatAttachmentPreviewItem(pending: attachment)
                }
            },
            onDismissUploadAttachmentError: {
                viewModel.setUploadAttachmentError(nil)
            },
            onSelectGitBranch: { target in
                Task { await performGitCheckout(target) }
            },
            onCreateGitBranch: { target in
                Task { await performGitCheckout(target) }
            },
            onRefreshGitBranches: {
                Task { await gitAvailabilityViewModel.loadBranches() }
            },
            onVoiceInputRequestHandled: {},
            onExpandedPresentationRequirementChange: { isRequired in
                composerRequiresExpandedPresentation = isRequired
            },
            clarificationPrompt: prompt,
            clarificationErrorMessage: viewModel.clarificationErrorMessage,
            clarificationSelectedChoices: viewModel.clarificationSelectedChoices,
            onToggleClarificationChoice: { choice in
                guard let prompt else { return }
                viewModel.toggleClarificationChoice(choice, promptID: prompt.id)
            },
            onSelectClarificationQuestion: { index in
                guard let prompt else { return }
                viewModel.selectClarificationStep(index, promptID: prompt.id)
            },
            onSubmitClarification: { response in
                guard let prompt else { return }
                Task { await submitClarification(response, promptID: prompt.id) }
            },
            sessionStart: isOpeningFiles && !viewModel.isSubmittingMessage ? nil : sessionStart,
            hasSession: viewModel.hasSession,
            onRetrySessionStart: retrySessionStart,
            sessionToolsets: viewModel.sessionToolsets,
            onLoadToolsets: { try await viewModel.loadToolsetsCatalog() },
            onSaveToolsets: { names in
                await viewModel.saveSessionToolsets(names)
            }
        )
    }

    private func transcriptMediaPreviewView(for item: TranscriptMediaPreviewItem) -> some View {
        TranscriptMediaPreviewView(
            server: server,
            item: item,
            onAPIError: onAPIError
        )
    }

    private var transcriptMediaSessionID: String? {
        guard let sessionID = session.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionID.isEmpty
        else {
            return nil
        }
        return sessionID
    }

    private var transcriptMediaCacheNamespace: String {
        "\(server.absoluteString)|\(transcriptMediaSessionID ?? "local:\(session.id)")"
    }

    private var chatLayout: some View {
        GeometryReader { geometry in
            let layoutSize = chatLayoutSize(in: geometry, width: targetChatLayoutWidth)
            let viewportSize = chatLayoutSize(in: geometry)
            let blockSize = hasVerticalDivision && targetChatLayoutWidth == nil ? viewportSize : layoutSize
            let frames = chatFrames(in: geometry, width: targetChatLayoutWidth)
            // Both transcript and composer take their destination width before the column moves.
            let composerFrame = frames.composer
            ZStack(alignment: .bottom) {
                VStack(spacing: 0) {
                    if viewModel.isViewingCachedData {
                        ChatOfflineCacheBanner()
                    }

                    listenPlaybackBar

                    ChatMessageListView(chat: self, viewModel: viewModel)
                        // Scope RTL to the chat transcript only (#259): the offline
                        // banner above stays in the app's default direction.
                        .environment(\.layoutDirection, chatLayoutDirection)
                }
                .frame(width: hasVerticalDivision ? frames.transcript.width : nil,
                       height: hasVerticalDivision || frames.isTabletop ? frames.transcript.height : nil, alignment: .top)
#if DEBUG
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { recordBodyEvaluation?.recordTranscriptFrame($0) }
#endif
                .frame(maxHeight: .infinity, alignment: .top)
                .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: viewModel.showsListenPlaybackBar)
                .frame(width: layoutSize.width, height: layoutSize.height)
                // Its leading edge rides the moving pane edge, so the column never covers it or leaves a gap.
                .padding(.leading, frames.transcript.minX)
                .frame(width: blockSize.width, height: blockSize.height, alignment: .leading)

                ZStack(alignment: .bottom) {
                    BottomComposerMaterialFade(composerHeight: composerHeight)
                    composerAccessoryStack
                        .onGeometryChange(for: CGFloat.self) { max(0, $0.size.height - composerHeight - 8) } action: {
                            composerAccessoriesHeight = $0
                        }
                    messageComposer(availableHeight: composerFrame.height)
                }
                .environment(\.tabletopComposerHeight, frames.isTabletop ? max(0, composerFrame.height - composerAccessoriesHeight - 8) : nil)
                .frame(width: composerFrame.width, height: frames.isTabletop ? composerFrame.height : nil, alignment: .bottom)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                // Measure the live pane and composer before its first visible layout; never fade in a provisional size.
                .opacity(didCompleteInitialAppearance && hasMeasuredComposer && composerFrame.width > 0 && composerFrame.height > 0 ? 1 : 0)
                .animation(nil, value: didCompleteInitialAppearance && hasMeasuredComposer)

                if let approvalPrompt = viewModel.approvalPrompt {
                    ApprovalRequestOverlay(
                        prompt: approvalPrompt,
                        isResponding: viewModel.isRespondingToApproval,
                        errorMessage: viewModel.approvalErrorMessage,
                        onChoice: { choice in
                            Task {
                                let didRespond = await viewModel.respondToApproval(choice)
                                if didRespond {
                                    ChatHaptics.approvalSubmitted(choice, isEnabled: isHapticsEnabled)
                                }
                            }
                        },
                        onSkipAll: {
                            Task {
                                let didSkip = await viewModel.skipApprovalsForCurrentSession()
                                if didSkip {
                                    ChatHaptics.approvalBypassEnabled(isEnabled: isHapticsEnabled)
                                }
                            }
                        }
                    )
                    .zIndex(10)
                }
            }
            // A fixed destination layout anchored to the pane's trailing edge, which is the screen edge and never
            // moves: the chat snaps to its final wrap and place once, and the column slides over or into the
            // space it leaves, as the ChatGPT app does. Animating this inner width would re-wrap text every frame.
            .frame(width: blockSize.width, height: blockSize.height)
            .transaction(value: blockSize.width) {
                $0.animation = nil
                $0.disablesAnimations = true
            }
            .transaction { transaction in
                if transaction.animation == SessionListMotion.foldAnimation(reduceMotion: false) {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }
            .frame(width: viewportSize.width, height: viewportSize.height, alignment: .trailing)
            .clipShape(PaneEdgeClip())
        }
        .onGeometryChange(for: CGSize.self, of: { chatLayoutSize(in: $0, width: targetChatLayoutWidth) }) { size in
            guard !holdsForegroundLayout, size.width > 0, size.height > 0 else { return }
            lastActiveLayoutSize = size
        }
        .onGeometryChange(for: DivisionRegionLayout.ChatFrames.self, of: { chatFrames(in: $0, width: targetChatLayoutWidth) }) { frames in
            guard !holdsForegroundLayout, frames.composer.width > 0, frames.composer.height > 0 else { return }
            composerAvailableHeight = frames.composer.height
            tabletopIsActive = frames.isTabletop
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardIsVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardIsVisible = false
        }
        .overlay(alignment: .top) {
            GitActionToastOverlay(state: gitToastState)
        }
        .accessibilityIdentifier("chat-detail:\(displayTitle)")
        .onChange(of: viewModel.pendingResourceChange) { previous, current in
            if previous?.title != nil && current == nil { viewModel.reconcileResourceTitle() }
        }
    }

    /// The live pane size, or `width` in place of its width while the split moves toward it.
    private func chatLayoutSize(in geometry: GeometryProxy, width: CGFloat? = nil) -> CGSize {
        if (holdsForegroundLayout || geometry.size.width <= 0 || geometry.size.height <= 0),
           lastActiveLayoutSize.width > 0, lastActiveLayoutSize.height > 0 {
            return lastActiveLayoutSize
        }
        var size = geometry.size
        if let width { size.width = width }
        return size
    }

    /// Chat frames in the live pane; a split width starts them at the pane's live leading edge.
    private func chatFrames(in geometry: GeometryProxy, width: CGFloat? = nil) -> DivisionRegionLayout.ChatFrames {
        let divisions: [CGRect]
        if let divisionGeometry {
            divisions = divisionGeometry.localDivisions(in: geometry)
        } else {
            divisions = DivisionRegionGeometry(geometry, divisions: divisionFramesForTesting).localDivisions(in: geometry)
        }
        let bounds = CGRect(origin: .zero, size: chatLayoutSize(in: geometry))
        guard let width else {
            return DivisionRegionLayout.chatFrames(in: bounds, divisions: divisions,
                layoutDirection: layoutDirection, keyboardIsVisible: keyboardIsVisible)
        }
        // A split width already excludes the vertical division, even while the native origin is moving.
        let pane = CGRect(origin: .zero, size: CGSize(width: width, height: bounds.height))
        return DivisionRegionLayout.chatFrames(in: pane, divisions: divisions.filter { $0.height <= $0.width },
            layoutDirection: layoutDirection, keyboardIsVisible: keyboardIsVisible)
    }

    private var hasVerticalDivision: Bool {
        divisionGeometry?.divisions.contains { $0.height > $0.width } == true
    }

    private var chatWithLifecycle: some View {
        chatLayout
        .onChange(of: viewModel.clarificationPrompt?.requestID, initial: true) { _, requestID in
            guard requestID != nil else { return }
            clarificationPanelHeight = 320
            dismissKeyboard()
        }
        .task(id: didCompleteInitialAppearance) {
            await handleInitialAppearanceTask()
        }
        .delayedStatus(viewModel.isSyncingTranscript, isVisible: $showsSyncingPill,
                       resetGeneration: viewModel.transcriptSyncPresentationGeneration)
        .onChange(of: scenePhase) {
                handleScenePhaseChange(scenePhase)
            }
            .onChange(of: viewModel.activeStreamID) {
                handleActiveStreamChange()
            }
            .onChange(of: viewModel.cacheFirstReconcileScrollToken) {
                // Open a brief snap window so the cache-first reconcile re-pin (and any
                // message-count auto-follow racing it) lands without an animated jump (#289).
                cacheFirstSnapUntil = Date().addingTimeInterval(0.35)
            }
            .onChange(of: viewModel.isUploadingAttachment) { _, isUploading in
                if !isUploading {
                    applyInitialComposerFocusPolicyIfNeeded()
                }
            }
            .onChange(of: viewModel.uploadAttachmentErrorMessage) { _, newValue in
                if newValue == nil {
                    applyInitialComposerFocusPolicyIfNeeded()
                }
            }
            .modifier(
                ChatDraftSyncModifier(
                    pendingAttachments: viewModel.pendingAttachments,
                    composerSettings: currentComposerSettings,
                    voiceNote: viewModel.pendingVoiceDraft,
                    onAttachmentsChange: { syncDraftAttachments() },
                    onSettingsChange: syncDraftSettings,
                    onVoiceNoteChange: { note in
                        guard didHydrateDraft else { return }
                        draftStore.setVoiceNote(note, for: draftKey)
                    }
                )
            )
            .onReceive(NotificationCenter.default.publisher(for: .talariaReauthenticated)) { notification in
                guard notification.object as? URL == server else { return }
                Task { await loadMessages(appliesInitialFocus: false) }
            }
            .modifier(ChatLiveSync(viewModel: viewModel, server: server, sessionID: session.sessionId, onAPIError: onAPIError))
            .onChange(of: showsLiveActivityResponseExcerpts) {
                viewModel.setShowsLiveActivityResponseExcerpts(showsLiveActivityResponseExcerpts)
            }
            .onChange(of: viewModel.isViewingCachedData) {
                if !viewModel.isViewingCachedData {
                    viewedCompletionsThrough = Date()
                    scheduleCompletionAcknowledgement()
                }
            }
            .onChange(of: TalariaCompletionStore.shared.completions) {
                scheduleCompletionAcknowledgement()
            }
    }

    private var chatWithVisibility: some View {
        chatWithLifecycle
            .onDisappear {
                sessionStartGeneration &+= 1
                sessionStartTask?.cancel()
                sessionStartTask = nil
                viewedCompletionsThrough = nil
                completionAcknowledgementGeneration += 1
                completionAcknowledgementTask?.cancel()
                completionAcknowledgementTask = nil
                if didHydrateDraft { draftStore.setVoiceNote(viewModel.pendingVoiceDraft, for: draftKey) }
                flushDraftsBestEffort()
                activeStreamStatusRefreshTask?.cancel()
                activeStreamStatusRefreshTask = nil
                let chat = viewModel
                let modelContext = modelContext
                let release = {
                    chat.stopListening()
                    chat.voiceInput.stopBeforeSubmittingDraft()
                    chat.persistTranscript(modelContext: modelContext)
                    chat.suspendStreamForNavigation()
                    chat.cleanupPollingTasks()
                }
                // A view the navigation rebuilt for this chat takes it over without stopping it (TAL-1477).
                if let retained { retained.viewDidDisappear(release: release) } else { release() }
            }
            .onAppear {
                viewModel.showCachedComposerChoices()
                if let retained {
                    takesOverLiveChat = retained.viewDidAppear()
                }
                guard !takesOverLiveChat else {
                    // Its stream, polling and Listen never stopped; only this view's own stall check restarts.
                    if viewModel.activeStreamID != nil { handleActiveStreamChange() }
                    return
                }
                Task {
                    await viewModel.reconnectStreamIfNeeded(modelContext: modelContext)

                    if viewModel.activeStreamID != nil {
                        handleActiveStreamChange()
                    }

                    if let lastError = viewModel.lastError {
                        onAPIError(lastError)
                    }
                }
            }
            .onChange(of: viewModel.responseCompletionHapticTrigger) {
                guard viewModel.responseCompletionHapticTrigger > 0 else { return }
                handleResponseCompletionSideEffects()
            }
    }

    private var chatWithToolbar: some View {
        let sessionMenu: SessionRowContextMenu? = if viewModel.hasSession, let sessionActions {
            SessionRowContextMenu(viewModel: sessionActions.viewModel, session: sessionActions.session, actions: sessionActions.actions)
        } else { nil }
        return chatWithVisibility
            .onChange(of: !viewModel.hasMessages && viewModel.clarificationPrompt == nil && viewModel.activeStreamID == nil,
                      initial: true) { _, isEmpty in splitFilesInspector?.reportEmptyTranscript(isEmpty) }
            .onChange(of: showsFilesInspector, initial: true) { splitFilesInspector?.reportShown(showsFilesInspector) }
            .onChange(of: showsCompanionPage, initial: true) { splitFilesInspector?.reportCompanionPage(showsCompanionPage) }
            .onAppear {
                splitFilesInspector?.reportSession(session)
                splitFilesInspector?.reportShown(showsFilesInspector)
            }
            .onChange(of: session) { _, session in splitFilesInspector?.reportSession(session) }
            .navigationDestination(isPresented: $showsFilesBrowser) {
                FileBrowserView(session: session, server: server, onAPIError: onAPIError)
            }
            .navigationTitle(displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .onToolbarVerticalEdgeChange { hasVerticalToolbar = $0 }
            .toolbarTitleMenu { sessionMenu }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    let title = ChatToolbarTitleLabel(title: displayTitle, subtitle: headerSubtitle)
                    if let sessionMenu {
                        // A custom principal title replaces UIKit's title button; keep it actionable too.
                        Menu { sessionMenu } label: { title }
                            .accessibilityIdentifier("chat-session-actions-title")
                    } else {
                        title
                    }
                }

                if hasVerticalToolbar, let sessionMenu {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu { sessionMenu } label: {
                            Label("More", systemImage: "ellipsis.circle")
                        }
                        .accessibilityIdentifier("chat-session-actions-more")
                    }
                    .overflowPriority(.chatMore)
                }

                // One item per action so each bridges to a system bar button: iOS 26+ groups
                // adjacent trailing items in one glass pill, and iPhone Duo can move them to its
                // vertical bar, which a single custom-view item prevents.
                if viewModel.hasSession, viewModel.hasActivatedGoalCommand {
                    ToolbarItem(placement: .topBarTrailing) {
                        goalControlMenu
                    }
                    .overflowPriority(.chatGoal)
                }

                // Files creates an idle chat on demand; companion pages keep their own browser action.
                if showsFilesButton, !companionPageIsBeside {
                    ToolbarItem(placement: .topBarTrailing) {
                        filesButton
                            .disabled(viewModel.isViewingCachedData)
                            .accessibilityLabel("Files")
                    }
                    .overflowPriority(.chatFiles)
                }

                if showsGitControls, viewModel.hasSession, gitAvailabilityViewModel.hasRepository {
                    ToolbarItem(placement: .topBarTrailing) {
                        gitActionsMenu
                    }
                }
            }
    }

    /// A wide chat, or one the split view widens for it, toggles the Files inspector beside it; a narrower one
    /// pushes the browser.
    private var filesButton: some View {
        Button {
            Task { await openFiles() }
        } label: {
            if isOpeningFiles {
                ProgressView().accessibilityLabel("Opening Files")
            } else {
                Label("Files", systemImage: "folder")
            }
        }
        .disabled(isOpeningFiles || stagingAttachmentBatches > 0)
    }

    private func openFiles() async {
        guard !isOpeningFiles else { return }
        isOpeningFiles = true
        defer { isOpeningFiles = false }
        guard await startPendingSession() else {
            if case .failed(let message, _) = sessionStart {
                viewModel.setSendErrorMessage(message)
                sessionStart = nil
            }
            return
        }
        splitFilesInspector?.reportSession(session)
        dismissKeyboard()
        if splitFilesInspector?.widensChat == true {
            isFilesInspectorPresented.toggle()
        } else {
            showsFilesBrowser = true
        }
    }

    private var isFilesInspectorPresented: Bool {
        get { splitFilesInspector?.isPresented.wrappedValue ?? false }
        nonmutating set { splitFilesInspector?.isPresented.wrappedValue = newValue }
    }

    /// Whether this chat shows Files beside it once it has the width. The companion page takes its place.
    private var showsFilesInspector: Bool {
        isFilesInspectorPresented && showsFilesButton && viewModel.hasSession && !companionPageIsBeside
    }

    /// Whether the chat has a companion page to show beside it (TAL-1458): an iOS 27.1 arrangement at regular width,
    /// a session with a workspace, and a file the agent named.
    private var showsCompanionPage: Bool {
        guard #available(iOS 27.1, *), splitFilesInspector?.offersCompanionPage == true else { return false }
        return viewModel.hasSession && viewModel.selectedWorkspacePath != nil && viewModel.companionFocus.path != nil
    }

    /// Whether the companion page shows beside the chat: where the arrangement splits, as wide as tall. A page it could
    /// not split for would still narrow the chat's column, so it shows only there.
    private var companionPageIsBeside: Bool {
        showsCompanionPage && RegularSplitLayout.splitsCompanionPage(width: arrangementSize.width, height: arrangementSize.height)
    }

    /// The chat with its companion page beside it where the arrangement can split, and alone where it cannot (portrait,
    /// or closed to the iPhone Duo's outer display). The arrangement wraps the chat only while it splits: one in a split
    /// view's column, even one allowing no split, reloads the keyboard on every layout pass once the composer has focus.
    @ViewBuilder
    private func withCompanionPage(_ chat: some View) -> some View {
        if #available(iOS 27.1, *), splitFilesInspector?.offersCompanionPage == true {
            Group {
                if companionPageIsBeside {
                    ArrangementView {
                        chat
                    } secondary: {
                        ChatCompanionPage(viewModel: viewModel, session: session, server: server, onAPIError: onAPIError)
                    }
                    .arrangementViewStyle(.split.axes(.horizontal))
                } else {
                    chat
                }
            }
            .onGeometryChange(for: CGSize.self, of: {
                holdsForegroundLayout && arrangementSize != .zero ? arrangementSize : $0.sizeIncludingSafeArea
            }) { size in
                guard !holdsForegroundLayout, size.width > 0, size.height > 0 else { return }
                arrangementSize = size
            }
        } else {
            chat
        }
    }

    var body: some View {
#if DEBUG
        let _ = recordBodyEvaluation?("chat")
        // Keep invalidation reasons in XCTest's console when this test-only probe is installed.
        let _ = recordBodyEvaluation == nil ? () : Self._printChanges()
#endif
        withCompanionPage(chatWithToolbar)
            .environment(\.retryPendingAttachment) { id in Task { await viewModel.retryAttachment(id: id) } }
            .navigationDestination(item: $forkedSession) { session in
                // A fork opens in the same column, so the same split view makes room for its Files.
                ChatView(session: session, server: server, onAPIError: onAPIError, splitFilesInspector: splitFilesInspector)
            }
            .fullScreenCover(item: $selectableResponseText) { selectableText in
                SelectableTextPresentationView(selection: selectableText)
            }
            .sheet(item: $attachmentPreviewItem) { item in
                ChatAttachmentPreviewView(
                    session: session,
                    server: server,
                    item: item,
                    onAPIError: onAPIError
                )
            }
            .onChange(of: attachmentPreviewItem == nil) { _, isDismissed in
                if isDismissed {
                    restoreComposerFocusAfterPreviewIfNeeded()
                }
            }
            .sheet(item: $transcriptMediaPreviewItem, content: transcriptMediaPreviewView)
            .sheet(item: $openedFileLink, content: fileLinkSheet)
            .sheet(item: $openedWebPage) { page in
                InAppSafariView(url: page.url).ignoresSafeArea()
            }
            .sheet(item: $activeGitSheet, content: gitSheet)
            .sheet(isPresented: $showsQueuedMessagesSheet) {
                QueuedMessagesSheet(
                    previews: viewModel.queuedMessagePreviews,
                    admissions: viewModel.ownerAttachment?.admissions ?? [],
                    canActOnAdmissions: !viewModel.isViewingCachedData && viewModel.ownerActionAdmissionID == nil,
                    onSendNow: { id in Task { await viewModel.sendQueuedMessageNow(id: id) } },
                    onEdit: { id in
                        showsQueuedMessagesSheet = false
                        viewModel.editQueuedMessage(id: id)
                    },
                    onRemove: { id in Task { await viewModel.removeQueuedMessage(id: id) } },
                    onAdmissionAction: { action, admission in
                        // Retry's text returns to the composer, so the sheet steps aside for it.
                        if action == .retry { showsQueuedMessagesSheet = false }
                        Task { await viewModel.performOwnerAction(action, on: admission, modelContext: modelContext) }
                    }
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showsBackgroundWorkSheet) {
                BackgroundWorkSheet(
                    tasks: viewModel.pinnedBackgroundTasks,
                    loadResult: { await viewModel.backgroundResult(taskID: $0) },
                    dismiss: { await viewModel.dismissBackgroundTask(taskID: $0) }
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(item: $turnDiffPresentation, content: turnDiffSheet)
            // TAL-887: the Agent's password-manager prompt; it closes when the server's queue moves on.
            .sheet(item: Binding(get: { viewModel.vaultPrompt }, set: { _ in })) { prompt in
                if let vault = prompt.pending.vault {
                    VaultPromptSheet(
                        vault: vault,
                        isResponding: viewModel.isRespondingToClarification,
                        errorMessage: viewModel.clarificationErrorMessage
                    ) { values in
                        Task { await viewModel.respondToVaultPrompt(values, promptID: prompt.id) }
                    }
                }
            }
            .alert(item: $gitAlert, content: gitAlertPresentation)
            .sheet(isPresented: $showsGoalSheet) {
                GoalSubmissionSheet(
                    goalDraft: $goalDraft,
                    isSubmitting: viewModel.isSubmittingGoal,
                    onSubmit: { submittedGoal in
                        Task { await submitGoalDraft(submittedGoal) }
                    }
                )
            }
            .sheet(isPresented: $showEditSheet, onDismiss: { isEditSheetOnScreen = false }) {
                EditMessageSheet(
                    originalText: editContext?.copyText ?? "",
                    editDraft: $editDraft,
                    onSubmit: {
                        if let context = editContext {
                            Task { await submitEdit(context) }
                        }
                    }
                )
            }
            .onChange(of: viewModel.modelSwitchConfirmation?.id, initial: true) {
                modelSwitchAlert = viewModel.modelSwitchConfirmation
            }
            .background {
                // A warning's identity can change during dismissal. Keep its item presenter separate from Git's.
                Color.clear
                    .frame(width: 0, height: 0)
                    .alert(item: $modelSwitchAlert, content: modelSwitchAlertPresentation)
            }
            .alert(
                "Discard Later Messages?",
                isPresented: Binding(
                    get: { viewModel.deepTruncateConfirmation != nil && !isEditSheetOnScreen },
                    set: { if !$0 { viewModel.cancelDeepTruncate() } }
                ),
                presenting: viewModel.deepTruncateConfirmation
            ) { confirmation in
                Button("Cancel", role: .cancel) {
                    viewModel.cancelDeepTruncate()
                }
                Button(
                    confirmation.action == .regenerate
                        ? String(localized: "Discard & Regenerate")
                        : String(localized: "Discard & Edit"),
                    role: .destructive
                ) {
                    ChatHaptics.destructiveConfirmationAccepted(isEnabled: isHapticsEnabled)
                    Task { await submitDeepTruncate(confirmation) }
                }
            } message: { confirmation in
                Text(deepTruncateWarningMessage(confirmation))
            }
            .alert(
                "Start New Session?",
                isPresented: $showProfileNewSessionConfirmation
            ) {
                Button("Cancel", role: .cancel) {
                    pendingProfileSelection = nil
                }
                Button("Start New Session", action: openPendingProfileChat)
            } message: {
                Text(profileSwitchWarningMessage)
            }
            .alert(
                "Message Action Failed",
                isPresented: messageActionErrorIsPresented
            ) {
                Button("OK") {
                    viewModel.clearMessageActionError()
                }
            } message: {
                Text(viewModel.messageActionErrorMessage ?? "")
            }
    }

    @ViewBuilder
    private var listenPlaybackBar: some View {
        if viewModel.showsListenPlaybackBar {
            ListenPlaybackBar(
                phase: viewModel.listenPlaybackPhase,
                displayTime: viewModel.listenPlaybackDisplayTime,
                duration: viewModel.listenPlaybackDuration,
                speed: viewModel.listenPlaybackSpeed,
                onTogglePlayPause: {
                    viewModel.toggleListenPlaybackPlayPause()
                },
                onStop: {
                    viewModel.stopListening()
                },
                onScrub: { time in
                    viewModel.scrubListenPlayback(to: time)
                },
                onScrubbingChanged: { isScrubbing in
                    viewModel.setListenPlaybackScrubbing(isScrubbing)
                },
                onSpeedChange: { speed in
                    viewModel.setListenPlaybackSpeed(speed)
                }
            )
            .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
        }
    }

    private var gitWriteAvailability: GitWriteAvailability {
        GitWriteAvailability(
            isStreaming: viewModel.activeStreamID != nil,
            isViewingCachedData: viewModel.isViewingCachedData
        )
    }

    @ViewBuilder
    private func gitSheet(_ sheet: ActiveGitSheet) -> some View {
        switch sheet {
        case .changes:
            GitWorkspaceView(session: session, server: server, onAPIError: onAPIError)
        case .commit:
            GitCommitView(
                session: session,
                server: server,
                writesDisabled: gitWriteAvailability.writesDisabled,
                onAPIError: onAPIError,
                onCommitted: {
                    Task { await gitAvailabilityViewModel.refreshAfterExternalMutation() }
                }
            )
        }
    }

    @ViewBuilder
    private func turnDiffSheet(_ presentation: TurnDiffPresentation) -> some View {
        switch presentation {
        case .turnFiles(let files):
            GitTurnDiffSheet(session: session, server: server, files: files, onAPIError: onAPIError)
        case .file(let file):
            GitDiffView(session: session, server: server, file: file, onAPIError: onAPIError)
        }
    }

    private var gitActionsMenu: some View {
        GitActionsMenuButton(
            presentation: GitToolbarPresentation(
                hasRepository: gitAvailabilityViewModel.hasRepository,
                isLoading: gitAvailabilityViewModel.isLoading || gitAvailabilityViewModel.isStatusLoading,
                info: gitAvailabilityViewModel.gitInfo,
                status: gitAvailabilityViewModel.status,
                statusFailed: gitAvailabilityViewModel.statusError != nil
            ),
            isEnabled: !viewModel.isViewingCachedData,
            fetchDisabled: gitWriteAvailability.fetchDisabled,
            writesDisabled: gitWriteAvailability.writesDisabled,
            isRunningAction: gitAvailabilityViewModel.isRunningGitAction,
            onTap: {
                HapticButtonHaptics.tap(isEnabled: isHapticsEnabled)
            },
            onChanges: {
                activeGitSheet = .changes
            },
            onStageEdit: {
                activeGitSheet = .commit
            },
            onCommit: {
                Task { await performQuickCommit(push: false) }
            },
            onCommitAndPush: {
                Task { await performQuickCommit(push: true) }
            },
            onFetch: {
                Task { await performGitRemoteAction(.fetch) }
            },
            onPull: {
                gitAlert = .confirmRemote(.pull)
            },
            onPush: {
                gitAlert = .confirmRemote(.push)
            }
        )
    }

    /// Whether the turn-end git surfaces may show at all: the Git Actions setting is on, this
    /// is a git workspace, and the latest message is a finished assistant turn.
    private var turnGitSurfaceVisibility: ChatTurnGitSurfaceVisibility {
        ChatTurnGitSurfaceVisibility(
            settingEnabled: showsGitControls,
            hasRepository: gitAvailabilityViewModel.hasRepository,
            isStreaming: viewModel.activeStreamID != nil,
            latestMessageRole: latestTranscriptMessageRole
        )
    }

    /// Inputs for the inline "Commit & Push" button shown under the latest assistant turn.
    /// Shown only when the turn-end git surfaces are visible and there is something to commit
    /// (or a commit is in flight).
    private var inlineCommitContext: ChatInlineCommitContext? {
        guard turnGitSurfaceVisibility.isVisible,
              gitAvailabilityViewModel.hasCommittableChanges || gitAvailabilityViewModel.isCommitting
        else { return nil }
        return ChatInlineCommitContext(
            runningPhase: gitAvailabilityViewModel.commitPhase,
            isDisabled: gitWriteAvailability.writesDisabled
        )
    }

    /// Turn-end "File changes" recap card for the latest assistant turn (#316). Shown only
    /// when the turn-end git surfaces are visible (status has refreshed) and the server says
    /// the latest turn changed files; its scene sits on the turn's last assistant row.
    private var turnChangesRecapSummary: TurnFileChangeSummary? {
        guard turnGitSurfaceVisibility.isVisible else { return nil }
        let summary = TurnFileChangeAggregator.summarize(
            changes: transcriptMessages.last?.message.activityScene?.fileChanges ?? [],
            status: gitAvailabilityViewModel.status
        )
        return summary.hasChanges ? summary : nil
    }

    /// Present the per-turn diff sheet for every changed file the turn has a status match
    /// for. No-op when there is nothing diffable yet (e.g. status still refreshing).
    private func presentTurnDiff(for summary: TurnFileChangeSummary?) {
        let files = summary?.diffFiles ?? []
        guard !files.isEmpty else { return }
        turnDiffPresentation = .turnFiles(files)
    }

    @MainActor
    private func performQuickCommit(push: Bool) async {
        guard !gitAvailabilityViewModel.isCommitting else { return }

        let branch = gitAvailabilityViewModel.currentBranchName
        gitToastState.showProgress(GitActionProgress(
            title: GitCommitPhase.generatingMessage.progressTitle,
            subtitle: branch
        ))

        let outcome = await gitAvailabilityViewModel.quickCommit(push: push) { phase in
            gitToastState.showProgress(GitActionProgress(
                title: phase.progressTitle,
                subtitle: gitAvailabilityViewModel.currentBranchName
            ))
        }

        switch outcome {
        case .success(let result):
            var detailLines: [String] = []
            if let sha = result.shortSHA { detailLines.append(String(localized: "Commit \(sha)")) }
            if result.truncatedMessage { detailLines.append(String(localized: "Diff was large; message may be partial.")) }
            if let pushError = result.pushFailureMessage {
                // The commit landed but the requested push failed — report partial success
                // so the user knows the local commit is safe and only the push needs retrying.
                detailLines.append(String(localized: "Push failed: \(pushError)"))
            }
            gitToastState.showSuccess(GitActionSuccess(
                title: result.pushFailureMessage != nil
                    ? String(localized: "Committed — push failed")
                    : (result.didPush ? String(localized: "Commit & push complete") : String(localized: "Commit complete")),
                subtitle: result.branch,
                detailLines: detailLines
            ))
        case .nothingToCommit:
            gitToastState.dismissProgress()
            gitAlert = .error(String(localized: "There are no changes to commit."))
        case .tooManyChanges:
            // Status was truncated (>500 files): the commit was blocked to avoid silently
            // dropping files 501+. Always surface a message — falling back to a hardcoded
            // string if the view model ever leaves actionErrorMessage unset — because a
            // blocked commit with no feedback would be the very silent failure this guards
            // against. (Kept separate from .failure, which intentionally stays quiet when its
            // busy/no-session guard returns with no message.) No success toast/SHA.
            gitToastState.dismissProgress()
            gitAlert = .error(gitAvailabilityViewModel.actionErrorMessage
                ?? String(localized: "Too many changes to quick-commit. Commit in smaller batches, or use git directly."))
        case .failure:
            gitToastState.dismissProgress()
            if let message = gitAvailabilityViewModel.actionErrorMessage {
                gitAlert = .error(message)
            }
        }
    }

    @MainActor
    private func performGitCheckout(_ target: GitCheckoutTarget, stashingChanges: Bool = false) async {
        let outcome = await gitAvailabilityViewModel.checkout(target, stashingChanges: stashingChanges)
        if outcome == .requiresStash {
            gitAlert = .dirtyCheckout(target)
        } else if let message = gitAvailabilityViewModel.actionErrorMessage {
            // Surface real failures and partial successes (branch switched but the
            // stashed changes could not be restored) — the view model sets
            // actionErrorMessage in both cases and clears it on every new checkout.
            gitAlert = .error(message)
        }
    }

    @MainActor
    private func performGitRemoteAction(_ action: GitRemoteAction) async {
        gitToastState.showProgress(GitActionProgress(
            title: action.progressTitle,
            subtitle: gitAvailabilityViewModel.currentBranchName
        ))

        if await gitAvailabilityViewModel.performRemoteAction(action) {
            gitToastState.showSuccess(GitActionSuccess(
                title: action.successTitle,
                subtitle: gitAvailabilityViewModel.currentBranchName,
                detailLines: [gitAvailabilityViewModel.lastActionMessage]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            ))
        } else {
            gitToastState.dismissProgress()
            if let message = gitAvailabilityViewModel.actionErrorMessage {
                gitAlert = .error(message)
            }
        }
    }

    private func modelSwitchAlertPresentation(_ confirmation: ModelSwitchConfirmation) -> Alert {
        Alert(
            title: Text("Change Model?"),
            message: Text(confirmation.message ?? confirmation.warnings.map { "\($0.title)\n\n\($0.message)" }.joined(separator: "\n\n")),
            primaryButton: .default(Text("Change Model")) {
                Task { await viewModel.confirmModelSwitch(confirmation) }
            },
            secondaryButton: .cancel(Text("Cancel")) { viewModel.cancelModelSwitch() }
        )
    }

    private func gitAlertPresentation(_ alert: GitChatAlert) -> Alert {
        switch alert {
        case .confirmRemote(let action):
            return Alert(
                title: Text(action == .pull ? "Pull Remote Changes?" : "Push Local Commits?"),
                message: Text(action == .pull
                    ? "Pull uses fast-forward only and will not create a merge commit."
                    : "Push the current branch to its configured upstream remote?"),
                primaryButton: .default(Text(action == .pull ? "Pull" : "Push")) {
                    Task { await performGitRemoteAction(action) }
                },
                secondaryButton: .cancel()
            )
        case .dirtyCheckout(let target):
            return Alert(
                title: Text("Uncommitted Changes"),
                message: Text("This workspace has uncommitted changes. Save them temporarily, switch branches, then restore any saved changes for the destination branch."),
                primaryButton: .default(Text("Stash & Switch")) {
                    Task { await performGitCheckout(target, stashingChanges: true) }
                },
                secondaryButton: .cancel()
            )
        case .error(let message):
            return Alert(
                title: Text("Git Action Failed"),
                message: Text(message),
                dismissButton: .default(Text("OK")) {
                    gitAvailabilityViewModel.clearActionError()
                }
            )
        }
    }

    @ViewBuilder
    private var composerAccessoryStack: some View {
        if composerAccessoryVisibleItemCount > 0 {
            VStack(spacing: composerAccessoryVerticalSpacing) {
                // With no run status to sit beside, the scroll chip tops the stack on its own.
                if showsScrollToBottomButton, activeRunStatusPresentation == nil {
                    scrollToBottomChip(isVisible: true)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                }

                if let notice = viewModel.currentNotice {
                    NoticeChip(text: notice.text, level: notice.level, dismiss: viewModel.dismissNotice)
                        // A two-line notice is taller than one status row.
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { noticeChipHeight = $0 }
                        // Once per notice: the same notice shown again keeps its id.
                        .onChange(of: notice.id, initial: true) {
                            AccessibilityNotification.Announcement(notice.text).post()
                        }
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                }

                if hasCompactStatusItems {
                    compactStatusRow
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                }
            }
            .padding(.horizontal)
            .adaptiveReadableContent(maxWidth: AdaptiveReadableContentWidth.chat)
            .padding(.bottom, composerHeight + 8)
            .zIndex(8)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: showsScrollToBottomButton)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: composerAccessoryVisibleItemCount)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: activeRunStatusPresentation)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: viewModel.currentNotice)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: visibleSessionNotices)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: showsApprovalBypassStatus)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: goalChipPresentation)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: viewModel.pinnedBackgroundTasks)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: viewModel.queuedMessagePreviews)
            .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: ownerAdmissions)
        }
    }

    private var ownerAdmissions: [OwnerAdmission] { viewModel.ownerAttachment?.admissions ?? [] }

    private var hasCompactStatusItems: Bool {
        activeRunStatusPresentation != nil || hasReservedCompactStatusItems
    }

    private var hasReservedCompactStatusItems: Bool {
        activeRunStatusPresentation?.reservesTranscriptSpace == true || !visibleSessionNotices.isEmpty
            || showsSheetChipRow || goalChipPresentation != nil || showsApprovalBypassStatus
    }

    private var compactStatusItems: some View {
        StatusChipGroup(
            reservesFirstSegment: activeRunStatusPresentation?.reservesTranscriptSpace ?? true,
            onReservedHeightChange: { compactStatusHeight = $0 }
        ) {
            if let activeRunStatusPresentation {
                RunStatusChip(activeRunStatusPresentation, agentName: viewModel.assistantName)
                    .layoutPriority(-1)
            }
            ForEach(visibleSessionNotices, id: \.self) { notice in
                NoticeChip(text: notice.text, level: notice.level) { dismissedSessionNotices.insert(notice) }
            }
            if !viewModel.pinnedBackgroundTasks.isEmpty {
                backgroundTasksChip(viewModel.pinnedBackgroundTasks)
            }
            if let goalChipPresentation {
                StatusChip(label: goalChipPresentation.label, icon: .symbol(goalChipPresentation.symbol))
            }
            if showsApprovalBypassStatus {
                Button {
                    showApprovalBypassOffConfirmation = true
                } label: {
                    StatusChip(
                        label: String(localized: "Approval bypass active"),
                        icon: .symbol("bolt.slash.fill"),
                        emphasis: .warning
                    )
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isRespondingToApproval)
                .accessibilityHint(String(localized: "Turn off approval bypass"))
                .alert(String(localized: "Turn off approval bypass"), isPresented: $showApprovalBypassOffConfirmation) {
                    Button(String(localized: "Turn off approval bypass"), role: .destructive) {
                        Task { await viewModel.disableApprovalBypassForCurrentSession() }
                    }
                    Button(String(localized: "Cancel"), role: .cancel) {}
                }
                .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
            }
            if !viewModel.queuedMessagePreviews.isEmpty || !ownerAdmissions.isEmpty {
                queuedMessagesChip
            }
        }
    }

    /// What waits to send after this response (TAL-630); tapping opens the queue sheet.
    private var showsSheetChipRow: Bool {
        !viewModel.pinnedBackgroundTasks.isEmpty || !viewModel.queuedMessagePreviews.isEmpty || !ownerAdmissions.isEmpty
    }

    private func backgroundTasksChip(_ tasks: [BackgroundWorkTask]) -> some View {
        Button {
            showsBackgroundWorkSheet = true
        } label: {
            StatusChip(label: String(localized: "Background tasks · \(tasks.count)"), icon: .symbol("square.stack.3d.up"))
                .frame(minHeight: 44)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(String(localized: "Shows the background tasks"))
    }

    /// An owner input with an unknown outcome blocks sending until it is retried or discarded, so it says so (TAL-1043).
    private var queuedMessagesChip: some View {
        let unknown = ownerAdmissions.contains(where: \.isOutcomeUnknown)
        let count = viewModel.queuedMessagePreviews.count + ownerAdmissions.count
        return Button {
            showsQueuedMessagesSheet = true
        } label: {
            StatusChip(
                label: unknown ? String(localized: "Outcome unknown") : String(localized: "\(count) queued"),
                icon: .symbol(unknown ? "questionmark.circle" : "text.badge.plus"),
                emphasis: unknown ? .prominent : .standard
            )
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(String(localized: "Shows the queued messages"))
    }

    /// Compact statuses share one surface; the separate scroll chip keeps its configured side.
    /// A hidden twin keeps the status group centred.
    private var compactStatusRow: some View {
        let scrollChipLeads = ChatScrollToBottomButtonSide
            .storedValue(scrollToBottomButtonSideRawValue)
            .leads(in: layoutDirection)
        return HStack(spacing: composerAccessoryVerticalSpacing) {
            if showsScrollToBottomButton, activeRunStatusPresentation != nil {
                scrollToBottomChip(isVisible: scrollChipLeads)
            }
            compactStatusItems
            if showsScrollToBottomButton, activeRunStatusPresentation != nil {
                scrollToBottomChip(isVisible: !scrollChipLeads)
            }
        }
        // Let the fallback stack set the height without stretching the separate scroll chip.
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The scroll-to-latest chip; an invisible one only holds its place.
    private func scrollToBottomChip(isVisible: Bool) -> some View {
        StatusChipButton(
            systemImage: "arrow.down",
            accessibilityLabel: String(localized: "Scroll to latest message")
        ) {
            scrollToBottomRequest += 1
        }
        .fixedSize()
        .opacity(isVisible ? 1 : 0)
        .disabled(!isVisible)
        .accessibilityHidden(!isVisible)
    }

    /// Observes reveal updates here while reusing ChatTranscriptView's renderer and the chat's state-backed actions.
    private struct ChatMessageListView: View {
        let chat: ChatView
        let viewModel: ChatViewModel
#if DEBUG
        @Environment(\.chatBodyEvaluation) private var recordBodyEvaluation
#endif

        var body: some View {
#if DEBUG
            let _ = recordBodyEvaluation?("messages")
#endif
            ChatTranscriptView(
                isLoading: viewModel.isLoading,
                errorMessage: viewModel.errorMessage,
                messages: viewModel.messages,
                displayedTranscriptMessages: chat.displayedTranscriptMessages,
                compressionReferenceCard: viewModel.compressionReferenceCard,
                branchedFrom: viewModel.branchedFrom,
                reasoningGroups: viewModel.displayedReasoningGroups,
                completedToolCallGroupsForAnchor: { anchorMessageID in
                    viewModel.completedToolCallGroupsForAnchor(anchorMessageID)
                },
                archivedActivityRowsForAnchor: { anchorMessageID in
                    viewModel.archivedActivityRowsForAnchor(anchorMessageID)
                },
                earlierSceneRowsForTurn: { transcriptMessage in
                    viewModel.earlierSceneRows(for: transcriptMessage)
                },
                onLoadEarlierSceneRows: { transcriptMessage in
                    Task { await viewModel.loadEarlierSceneRows(for: transcriptMessage) }
                },
                liveReasoningText: viewModel.liveReasoningText,
                liveActivityRows: viewModel.liveActivityRows,
                reasoningAnchorMessageID: viewModel.reasoningAnchorMessageID,
                liveToolCalls: viewModel.liveToolCalls,
                toolCallAnchorMessageID: viewModel.toolCallAnchorMessageID,
                streamingAssistantMessageID: viewModel.streamingAssistantMessageID,
                liveTokensPerSecond: viewModel.liveTokensPerSecond,
                showsRunStateCheck: viewModel.showsRunStateCheck,
                clarificationPrompt: viewModel.clarificationPrompt,
                showsThinkingAndToolCards: chat.showsThinkingAndToolCards,
                shouldFollowLatestMessage: chat.shouldFollowLatestMessage,
                isDisclosureSettling: chat.isDisclosureSettling,
                latestTranscriptMessageRole: chat.latestTranscriptMessageRole,
                isScrolledNearBottom: chat.isScrolledNearBottom,
                activeStreamID: viewModel.activeStreamID,
                streamingScrollTrigger: viewModel.streamingScrollTrigger,
                cacheFirstReconcileScrollToken: viewModel.cacheFirstReconcileScrollToken,
                transcriptMessageSpacing: chat.transcriptMessageSpacing,
                transcriptBlockSpacing: chat.transcriptBlockSpacing,
                transcriptBottomInsetHeight: chat.transcriptBottomInsetHeight,
                confinesToDivisionPane: chat.hasVerticalDivision || chat.tabletopIsActive,
                scrollToBottomRequest: chat.scrollToBottomRequest,
                followReplayRequest: chat.followReplayRequest,
                assistantName: viewModel.assistantName,
                localAttachmentPreviews: viewModel.localAttachmentPreviews,
                listeningMessageID: viewModel.listeningMessageID,
                isViewingCachedData: viewModel.isViewingCachedData,
                isSessionReadOnly: viewModel.isSessionReadOnly,
                canBranch: viewModel.canBranch,
                hasOlderMessages: viewModel.hasOlderMessages,
                isLoadingOlderMessages: viewModel.isLoadingOlderMessages,
                isRegeneratingMessage: viewModel.isRegeneratingMessage,
                isEditingMessage: viewModel.isEditingMessage,
                isForkingMessage: viewModel.isForkingMessage,
                loadAttachmentImage: { path in
                    await viewModel.attachmentImageData(path: path)
                },
                loadAttachmentData: { path in
                    await viewModel.attachmentRawData(path: path)
                },
                loadTranscriptMediaImage: { reference in
                    await viewModel.transcriptMediaThumbnailData(for: reference)
                },
                loadTranscriptMediaData: { reference in
                    await viewModel.transcriptMediaData(for: reference)
                },
                transcriptMediaCacheNamespace: chat.transcriptMediaCacheNamespace,
                actionContext: { message, visibleIndex in
                    viewModel.actionContext(for: message, visibleIndex: visibleIndex)
                },
                shouldRenderMessageRow: chat.shouldRenderMessageRow,
                onLoadMessages: {
                    await chat.loadMessages(isUserRefresh: true, joinsLoadInFlight: true)
                },
                onLoadOlderMessages: { beforePrepend in
                    await chat.loadOlderMessages(beforePrepend: beforePrepend)
                },
                onUpdateScrollMetrics: chat.updateScrollMetrics,
                onFollowEvent: chat.handleFollowEvent,
                onDisclosureToggle: chat.suspendBottomAnchorForDisclosure,
                onFollowSuppressed: chat.recordSuppressedFollow,
                onDismissKeyboard: chat.dismissKeyboard,
                onScrollToBottom: chat.scrollToBottom,
                onScrollToLatestTranscriptMessage: { proxy in
                    chat.scrollToLatestTranscriptMessage(proxy)
                },
                onScrollToLatestContent: { proxy, animated in
                    chat.scrollToLatestContent(proxy, animated: animated)
                },
                onPreviewAttachment: { attachment, localData in
                    chat.presentPreviewRestoringComposerFocusIfNeeded {
                        chat.attachmentPreviewItem = ChatAttachmentPreviewItem(message: attachment, localData: localData)
                    }
                },
                onPreviewTranscriptMedia: { reference in
                    chat.transcriptMediaPreviewItem = TranscriptMediaPreviewItem(reference: reference)
                },
                onToggleListening: { context in
                    viewModel.toggleListening(to: context)
                },
                onSelectText: { context in
                    chat.selectableResponseText = SelectableTextPresentation(context: context)
                },
                onRegenerate: chat.beginRegenerateResponse,
                onEdit: chat.beginEditMessage,
                onFork: { context in
                    Task { await chat.forkFromMessage(context) }
                },
                onCopy: { context in
                    UIPasteboard.general.string = context.copyText
                },
                inlineCommitContext: chat.inlineCommitContext,
                onInlineCommit: {
                    Task { await chat.performQuickCommit(push: true) }
                },
                turnChangesSummary: chat.turnChangesRecapSummary,
                onOpenTurnDiff: {
                    chat.presentTurnDiff(for: chat.turnChangesRecapSummary)
                },
                onOpenTurnFileDiff: { file in
                    chat.turnDiffPresentation = .file(file)
                },
                retainedRowCache: chat.retained?.rows,
                retainedChat: chat.retained,
                restoredReadingRowID: chat.restoredReadingRowID,
                onReaderMoved: chat.recordReadingRow
            )
            .environment(\.openURL, OpenURLAction(handler: chat.handleTranscriptLink))
            .environment(\.chatFullToolResultLoader) { toolCallID in
                try await viewModel.fullToolResult(toolCallID: toolCallID)
            }
            .environment(\.voiceNoteControls, VoiceNoteControls(
                retry: { id in Task {
                    if chat.needsSessionStart {
                        guard await chat.startPendingSession() else { return }
                    }
                    await viewModel.retryVoiceNote(messageID: id, modelContext: chat.modelContext)
                } },
                remove: { viewModel.removeVoiceNote(messageID: $0) }
            ))
            .environment(\.pendingSteerControls, PendingSteerControls(
                actions: viewModel.pendingSteerActions,
                inFlight: viewModel.steerActionsInFlight,
                perform: { id, action in
                    Task {
                        switch action {
                        case .sendNow: await viewModel.sendPendingSteerNow(id: id)
                        case .edit: await viewModel.withdrawPendingSteer(id: id, reason: .edit)
                        case .cancel: await viewModel.withdrawPendingSteer(id: id, reason: .cancel)
                        }
                    }
                }
            ))
            // TAL-426: a steer taken back (Edit, or a Stop of this device's steer) returns after the draft, blank line between.
            .onChange(of: viewModel.returnedComposerTexts) { _, texts in
                guard !texts.isEmpty else { return }
                let returned = viewModel.takeReturnedComposerTexts().joined(separator: "\n\n")
                chat.appendReturnedComposerText(returned)
                chat.composerIsFocused = true
            }
        }
    }

    /// A link that names a workspace file opens the source viewer at its line,
    /// a web page opens in the in-app Safari sheet, and every other link keeps
    /// the system behaviour. The viewer's own error state covers a file the
    /// server refuses or no longer has.
    private func handleTranscriptLink(_ url: URL) -> OpenURLAction.Result {
        // The live workspace: `/workspace` and the composer can change it after the session loads.
        switch TranscriptLinkRoute.route(url, workspaceRoot: viewModel.selectedWorkspacePath) {
        case .workspaceFile(let link):
            openedFileLink = link
        case .inAppBrowser(let url):
            openedWebPage = InAppSafariPage(url: url)
        case .system:
            return .systemAction
        }
        return .handled
    }

    private func fileLinkSheet(for link: WorkspaceFileLink) -> some View {
        NavigationStack {
            FilePreviewView(
                session: session,
                server: server,
                entry: WorkspaceEntry(name: link.name, path: link.path),
                initialLine: link.line,
                onAPIError: onAPIError
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { openedFileLink = nil }
                }
            }
        }
    }

    /// The chat-canvas layout direction. Driven by the manual Settings → Chat
    /// RTL toggle (#259); applied only to the transcript + composer so the
    /// sidebar, settings, and navigation chrome stay in the default direction.
    private var chatLayoutDirection: LayoutDirection {
        ChatTranscriptDisplaySettings.chatLayoutDirection(rtlEnabled: rtlChatLayoutEnabled)
    }

    private var shouldFollowLatestMessage: Bool {
        followLatch.isFollowing
    }

    /// Automatic follows run only while the latch is on and no disclosure
    /// toggle is mid-animation.
    private var isFollowingLatestContent: Bool {
        shouldFollowLatestMessage && !isDisclosureSettling
    }

    private var isDisclosureSettling: Bool {
        disclosureSettle.isSettling
    }

    private var showsScrollToBottomButton: Bool {
        !isScrolledNearBottom && (viewModel.activeStreamID == nil || !shouldFollowLatestMessage)
    }

    private var isComposerChromeCompact: Bool {
        usesCompactComposer
    }

    private var usesCompactComposer: Bool {
        ChatScrollPolicy.shouldUseCompactComposer(
            isReadingOlderTranscript: isReadingOlderTranscript,
            hasMessages: viewModel.hasMessages,
            isFocused: composerIsFocused,
            hasDraft: !draftMessage.isEmpty,
            hasPendingAttachments: !viewModel.pendingAttachments.isEmpty,
            isLoadingComposerConfiguration: viewModel.isLoadingComposerConfiguration,
            isBusyOrUnavailable: isComposerBusyOrUnavailable,
            requiresExpandedPresentation: composerRequiresExpandedPresentation || viewModel.clarificationPrompt != nil
        )
    }

    private var transcriptBottomInsetHeight: CGFloat {
        if tabletopIsActive { return 8 }
        let inset = max(96, composerHeight + 44 + composerAccessorySpacerHeight())
        guard composerAvailableHeight > 0 else { return inset }
        // A short pane, as on an iPhone in landscape with the keyboard up, keeps the transcript's minimum in view
        // above the composer instead of scrolling it all out of the viewport (TAL-680).
        return min(inset, max(composerHeight, composerAvailableHeight - MessageComposerView.minimumTranscriptHeight))
    }

    private var isComposerBusyOrUnavailable: Bool {
        viewModel.isViewingCachedData
            || viewModel.isSubmittingMessage
            || viewModel.isCompressingSession
            || viewModel.isUploadingAttachment
            || viewModel.isUpdatingComposerConfiguration
            || viewModel.isCancellingStream
            || viewModel.sendErrorMessage != nil
            || viewModel.streamWarningMessage != nil
            || viewModel.composerConfigurationErrorMessage != nil
            || viewModel.uploadAttachmentErrorMessage != nil
    }

    private var activeRunStatusPresentation: ChatActiveRunStatusPresentation? {
        ChatActiveRunStatusPolicy.presentation(
            isStartingChat: viewModel.isSubmittingMessage,
            hasActiveStream: viewModel.activeStreamID != nil,
            activeStreamRecoveryState: viewModel.activeStreamRecoveryState,
            isCancellingStream: viewModel.isCancellingStream,
            isSyncingTranscript: showsSyncingPill,
            isBackgroundTurn: viewModel.isBackgroundTurnActive,
            activeRunStartedAt: viewModel.activeRunStartedAt,
            isCompressing: viewModel.isCompressingSession,
            compressionStartedAt: viewModel.compressionStartedAt,
            serverRunStatus: viewModel.runStatus,
            hasServerRunStatus: viewModel.hasServerRunStatus
        )
    }

    private var visibleSessionNotices: [SessionNotice] {
        viewModel.sessionNotices.filter { !dismissedSessionNotices.contains($0) }
    }

    private var showsApprovalBypassStatus: Bool {
        viewModel.isSessionApprovalBypassEnabled && viewModel.approvalPrompt == nil
    }

    private var goalChipPresentation: SessionGoalChipPresentation? {
        SessionGoalChipPresentation(goal: viewModel.sessionGoal)
    }

    /// Reserve measured compact entries and the transient notice, excluding syncing and the scroll chip.
    private func composerAccessorySpacerHeight() -> CGFloat {
        var height: CGFloat = viewModel.currentNotice == nil ? 0 : noticeChipHeight
        var itemCount = viewModel.currentNotice == nil ? 0 : 1
        if hasReservedCompactStatusItems {
            height += compactStatusHeight
            itemCount += 1
        }

        if itemCount > 1 {
            height += CGFloat(itemCount - 1) * composerAccessoryVerticalSpacing
        }
        return height
    }

    private var composerAccessoryVisibleItemCount: Int {
        var count = 0
        if viewModel.currentNotice != nil {
            count += 1
        }
        if !visibleSessionNotices.isEmpty {
            count += 1
        }
        if activeRunStatusPresentation != nil || showsScrollToBottomButton {
            count += 1
        }
        if goalChipPresentation != nil {
            count += 1
        }
        if showsApprovalBypassStatus {
            count += 1
        }
        if showsSheetChipRow {
            count += 1
        }
        return count
    }

    private var displayTitle: String {
        viewModel.pendingResourceChange?.title ?? viewModel.displayTitle
    }

    private var headerSubtitle: String? {
        if let pending = viewModel.pendingResourceChange { return pending.status }
        return ChatToolbarSubtitleResolver.subtitle(
            workspaceName: viewModel.selectedWorkspaceName,
            profileTitle: viewModel.selectedProfileTitle,
            executionMode: viewModel.executionMode
        )
    }

    private func shouldRenderMessageRow(_ message: ChatMessage) -> Bool {
        if message.content?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }

        return message.role == "user" && message.attachments?.isEmpty == false
    }

    private var transcriptMessages: [TranscriptMessage] {
        viewModel.displayedTranscriptMessages
    }

    private var displayedTranscriptMessages: [TranscriptMessage] {
        transcriptMessages
    }

    private var latestTranscriptMessageID: String? {
        transcriptMessages.last.map { ChatTranscriptView.containerID(for: $0.id) }
    }

    private var latestTranscriptMessageRole: String? {
        transcriptMessages.last?.message.role
    }

    private func prepareInitialAppearance() {
        viewModel.setShowsLiveActivityResponseExcerpts(showsLiveActivityResponseExcerpts)
        if loadsInitialMessages {
            viewModel.prepareInitialMessageLoad(modelContext: modelContext)
        }
    }

    /// A taken-over chat whose first load finished: everything it shows is loaded and running already.
    private var resumesLoadedChat: Bool {
        takesOverLiveChat && retained?.hasLoaded == true
    }

    private func handleInitialAppearanceTask() async {
        await hydrateDraftIfNeeded()
        guard !resumesLoadedChat else {
            // The chat is loaded and its work runs already; nothing is fetched again (TAL-1477).
            viewedCompletionsThrough = Date()
            scheduleCompletionAcknowledgement()
            isInitialComposerFocusContentReady = true
            applyInitialComposerFocusPolicyIfNeeded()
            return
        }
        prepareInitialAppearance()

        // The appearance flip cancels this task and starts a fresh one; a cancelled task that
        // went on would replace that task's Git probe with one whose load fails as cancelled.
        guard !Task.isCancelled, ChatInitialAppearancePolicy.shouldBeginAsyncWork(
            hasCompletedAppearance: didCompleteInitialAppearance
        ) else {
            return
        }

        await beginSessionWork()
    }

    private func beginSessionWork() async {
        async let chatStartup: Void = performInitialAsyncWork()
        async let gitAvailability: Void = loadInitialGitAvailability()
        async let draftAttachments: Void = restoreDraftAttachmentsIfNeeded()
        _ = await (chatStartup, gitAvailability, draftAttachments)
        if !Task.isCancelled { retained?.hasLoaded = true }
    }

    /// Creates a new chat's session and takes it on in place, so the composer the user is already
    /// typing in stays put (TAL-636). Returns whether the chat now has its session.
    private func startPendingSession() async -> Bool {
        if let task = sessionStartTask { return await task.value }
        if viewModel.hasSession, sessionStart == nil { return true }
        guard let startSession else { return false }
        sessionStart = .starting
        let generation = sessionStartGeneration
        let task = Task { @MainActor in
            let result = viewModel.hasSession ? ChatSessionStartResult.started(session) : await startSession()
            guard !Task.isCancelled, generation == sessionStartGeneration else { return false }
            switch result {
            case .started(let created, let detail):
                if !viewModel.hasSession {
                    pendingCreationSettings = viewModel.newSessionSettings
                    pendingCreationInteractionGeneration = viewModel.composerConfigurationInteractionGeneration
                    let newChatKey = ChatDraftKey.newChat(server: server)
                    persistComposerDraft()
                    let moved = draftStore.moveDraft(from: newChatKey, to: .session(server: server, session: created))
                    if pendingFirstDraft == nil, moved.text != draftMessage { draftMessage = moved.text }
                    viewModel.adoptCreatedSession(created, detail: detail)
                    session = created
                }
                // The first send joins this task, including restored configuration and file imports.
                if !draftAttachmentsPendingRetry.isEmpty {
                    draftAttachmentsAwaitingRestore = draftAttachmentsPendingRetry
                    isRestoringDraftAttachments = true
                }
                await beginSessionWork()
                await viewModel.uploadStagedAttachments()
                guard !Task.isCancelled, generation == sessionStartGeneration else { return false }
                if let settings = pendingCreationSettings {
                    await viewModel.restoreDraftSettings(settings,
                        expectedInteractionGeneration: pendingCreationInteractionGeneration ?? viewModel.composerConfigurationInteractionGeneration)
                    guard !Task.isCancelled, generation == sessionStartGeneration else { return false }
                    if let error = viewModel.composerConfigurationErrorMessage {
                        sessionStart = .failed(error)
                        return false
                    }
                    pendingCreationSettings = nil
                    pendingCreationInteractionGeneration = nil
                }
                let importFailure = initialAttachments.isEmpty && (viewModel.sessionStartupAttachments + viewModel.pendingAttachments).allSatisfy(\.isReadyToSend) ? nil
                    : String(localized: "Couldn't upload every attachment. Retry before sending.")
                if let error = viewModel.uploadAttachmentErrorMessage ?? importFailure ?? (!draftAttachmentsPendingRetry.isEmpty
                    ? draftRestoreFailureMessage(retryCount: draftAttachmentsPendingRetry.count, droppedCount: 0) : nil) {
                    sessionStart = .failed(error)
                    return false
                }
                sessionStart = nil
                return true
            case .failed(let message, let canRetry, _):
                sessionStart = .failed(message, canRetry: canRetry)
                return false
            }
        }
        sessionStartTask = task
        let started = await task.value
        if generation == sessionStartGeneration { sessionStartTask = nil }
        return started
    }

    private func retrySessionStart() {
        Task {
            guard await startPendingSession() else { return }
            if let note = viewModel.pendingVoiceDraft {
                await viewModel.retryVoiceNote(messageID: note.id, modelContext: modelContext)
            }
            // Recovery keeps the text draft ready for Send, including any typing added after the refusal.
        }
    }

    private var needsSessionStart: Bool {
        startSession != nil && (!viewModel.hasSession || sessionStart != nil || sessionStartTask != nil)
    }

    private func performInitialAsyncWork() async {
        guard !Task.isCancelled else { return }
        let draftSettingsInteractionGeneration = viewModel.composerConfigurationInteractionGeneration

        if loadsInitialMessages {
            await loadMessages(appliesInitialFocus: false, joinsLoadInFlight: true)
            guard !Task.isCancelled else { return }
        }
        viewedCompletionsThrough = Date()
        scheduleCompletionAcknowledgement()
        if initialAttachments.isEmpty {
            isInitialComposerFocusContentReady = true
            applyInitialComposerFocusPolicyIfNeeded()
        }
        await viewModel.loadComposerConfiguration()
        guard !Task.isCancelled else { return }

        await applyRestoredDraftSettingsIfNeeded(
            expectedInteractionGeneration: draftSettingsInteractionGeneration
        )
        guard !Task.isCancelled else { return }

        await viewModel.refreshApprovalBypassState()
        guard !Task.isCancelled else { return }

        await uploadInitialAttachmentsIfNeeded()
        guard !Task.isCancelled else { return }

        isInitialComposerFocusContentReady = true
        applyInitialComposerFocusPolicyIfNeeded()
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func loadInitialGitAvailability() async {
        let availabilityViewModel = GitWorkspaceAvailabilityViewModel(session: session, server: server)
        gitAvailabilityViewModel = availabilityViewModel
        retained?.gitAvailability = availabilityViewModel
        await availabilityViewModel.loadIfNeeded()
    }

    private var goalControlMenu: some View {
        GoalControlsMenu(
            currentGoal: viewModel.currentGoal,
            isViewingCachedData: viewModel.isViewingCachedData,
            isActionDisabled: isGoalActionDisabled,
            onSetGoal: {
                showsGoalSheet = true
            },
            onSubmitCommand: { command in
                Task { await submitGoalCommand(command) }
            }
        )
    }

    private var isGoalActionDisabled: Bool {
        viewModel.isViewingCachedData || viewModel.activeStreamID != nil || viewModel.isSubmittingGoal
    }

    private func loadMessages(
        appliesInitialFocus: Bool = true,
        isUserRefresh: Bool = false,
        joinsLoadInFlight: Bool = false,
        isRoutineReconciliation: Bool = false
    ) async {
        // A new chat has nothing to load until its session exists (TAL-636).
        guard viewModel.hasSession else { return }
        if joinsLoadInFlight {
            await viewModel.refreshSession(modelContext: modelContext, isUserRefresh: isUserRefresh)
        } else {
            await viewModel.loadMessages(modelContext: modelContext, isUserRefresh: isUserRefresh,
                                         isRoutineReconciliation: isRoutineReconciliation)
        }
        // The chat closed meanwhile; its cleanup already suspended the stream and polling.
        guard !Task.isCancelled else { return }
        await viewModel.reconnectStreamIfNeeded(modelContext: modelContext)
        await viewModel.refreshBackgroundTasks()
        if appliesInitialFocus {
            applyInitialComposerFocusPolicyIfNeeded()
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func loadOlderMessages(beforePrepend: @MainActor () -> Void) async -> Bool {
        followLatch.isFollowing = false
        if !isReadingOlderTranscript {
            withAnimation(ChatMotion.quickState(reduceMotion: reduceMotion)) {
                isReadingOlderTranscript = true
            }
        }

        let didLoad = await viewModel.loadOlderMessages(modelContext: modelContext, beforePrepend: beforePrepend)
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }

        return didLoad
    }

    private func submitGoalDraft(_ submittedGoal: String) async {
        await submitGoal(submittedGoal, clearsDraftOnSuccess: true)
    }

    private func submitGoalCommand(_ command: String) async {
        await submitGoal(command, clearsDraftOnSuccess: false)
    }

    private func submitGoal(_ args: String, clearsDraftOnSuccess: Bool) async {
        prepareTranscriptForExplicitSend()

        let didSubmit = await viewModel.submitGoal(args: args, modelContext: modelContext)
        if didSubmit, clearsDraftOnSuccess {
            goalDraft = ""
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func submitClarification(_ response: String? = nil, promptID: String) async {
        guard viewModel.clarificationPrompt?.id == promptID,
              !viewModel.isViewingCachedData, !viewModel.isComposerReadOnly else { return }
        let didRespond: Bool
        if let response {
            didRespond = await viewModel.respondToClarification(response)
        } else {
            didRespond = await viewModel.submitClarificationDraft(promptID: promptID)
        }
        if didRespond {
            ChatHaptics.clarificationSubmitted(isEnabled: isHapticsEnabled)
        }
    }

    /// Sends the draft; `command` (a side question or background task from Send's long-press menu) sends it
    /// as that slash command. During a reply it sends with `behavior` (Ctrl+Return's alternate or the menu's
    /// choice), or else the stored setting; a chosen behavior sends a slash-led draft as text rather than running it.
    private func sendDraftMessage(as command: String? = nil, behavior: StreamingSendBehavior? = nil) async {
        guard viewModel.clarificationPrompt == nil, !viewModel.isSubmittingMessage else { return }
        let submittedDraft = draftMessage
        let submittedDraftRevision = draftRevision
        let submissionGeneration = sessionStartGeneration
        let shouldRestoreFocusAfterSend = composerIsFocused
        let commandText = command.map { "/\($0) \(submittedDraft)" } ?? submittedDraft
        let sendsWithChosenBehavior = behavior != nil && viewModel.activeStreamID != nil
        let parsedSlash = commandText.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
            ? SlashCommandExecutor.parse(commandText, catalog: viewModel.agentCommands) : nil

        if !sendsWithChosenBehavior, viewModel.ownerAttachment == nil,
           parsedSlash?.command?.handler == .clientSide(.new),
           let url = TalariaDeepLink.newChatURL {
            reconcileConsumedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
            openURL(url)
            return
        }

        var pendingSlash: ParsedSlashCommand?
        if needsSessionStart, commandText.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") {
            if parsedSlash?.messageForIdleSend != nil {
                pendingSlash = parsedSlash
            } else {
                guard await startPendingSession(), submissionGeneration == sessionStartGeneration else { return }
            }
        }

        // An owner chat's slash text goes to its owner as typed (TAL-1043).
        if pendingSlash == nil, !sendsWithChosenBehavior, viewModel.ownerAttachment == nil,
           commandText.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") {
            let parsed = parsedSlash
            let parsedCommand = parsed?.command
            // A typed command leaves the composer whatever its result, so it leaves as it is sent, like a message,
            // rather than after a long one (/compress, a server-run /refine) finishes.
            if command != nil || parsedCommand != nil || parsed?.runsOnServer == true {
                reconcileConsumedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
            }
            let result = await SlashCommandExecutor.execute(text: commandText, viewModel: viewModel)
            guard submissionGeneration == sessionStartGeneration else { return }
            if command != nil, !result.isSuccessfulSubmission, result != .sendAsMessage {
                restoreUnacceptedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
            }
            handleSlashExecutionResult(
                result,
                parsedCommand: parsedCommand,
                submittedDraft: submittedDraft,
                submittedDraftRevision: submittedDraftRevision,
                // A typed command leaves the composer either way; a menu send that fails keeps the draft to retry.
                consumesDraft: command == nil || result.isSuccessfulSubmission
            )

            if result != .sendAsMessage {
                if let lastError = viewModel.lastError {
                    onAPIError(lastError)
                }
                return
            }
        }

        let didStart: Bool
        if viewModel.activeStreamID != nil {
            prepareTranscriptForExplicitSend()
            let behavior = behavior ?? StreamingSendBehavior.storedValue(streamingSendBehaviorRawValue)
            reconcileConsumedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
            let result = await viewModel.submitStreamingMessage(submittedDraft, behavior: behavior)
            guard submissionGeneration == sessionStartGeneration else { return }
            if !result.isSuccessfulSubmission {
                restoreUnacceptedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
            }
            handleSlashExecutionResult(
                result,
                // Each behavior's raw value names its slash command.
                parsedCommand: SlashCommandCatalog.command(named: behavior.rawValue),
                submittedDraft: submittedDraft,
                submittedDraftRevision: submittedDraftRevision,
                consumesDraft: result.isSuccessfulSubmission
            )
            didStart = result.isSuccessfulSubmission
        } else {
            didStart = await sendStandardMessage(
                submittedDraft,
                submittedDraftRevision: submittedDraftRevision,
                pendingSlash: pendingSlash
            )
        }

        guard submissionGeneration == sessionStartGeneration else { return }
        if didStart {
            ChatHaptics.messageSent(isEnabled: isHapticsEnabled)
            if shouldRestoreFocusAfterSend {
                requestComposerFocusIfPossible()
            } else {
                composerIsFocused = false
            }
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func sendVoiceNote(audioData: Data, filename: String) async {
        guard viewModel.clarificationPrompt == nil else { return }
        prepareTranscriptForExplicitSend()

        let waitForSession: (@MainActor () async -> Bool)?
        if needsSessionStart { waitForSession = { await startPendingSession() } }
        else { waitForSession = nil }
        let outcome = await viewModel.sendVoiceNote(
            audioData: audioData,
            filename: filename,
            modelContext: modelContext,
            waitForSession: waitForSession
        )

        if outcome.didStart {
            onConversationStarted()
            ChatHaptics.messageSent(isEnabled: isHapticsEnabled)
        }

        if let error = outcome.error {
            onAPIError(error)
        }
    }

    private func sendStandardMessage(
        _ submittedDraft: String,
        submittedDraftRevision: Int,
        pendingSlash: ParsedSlashCommand? = nil
    ) async -> Bool {
        guard !viewModel.isSubmittingMessage else { return false }
        let message = pendingSlash?.messageForIdleSend ?? submittedDraft
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !viewModel.pendingAttachments.isEmpty
        else {
            return false
        }

        prepareTranscriptForExplicitSend()

        // Reconcile against what the composer actually staged, not against the
        // draft's whole record set. A record that is not staged — awaiting a
        // re-upload retry, or not yet reached by an in-flight restore — was
        // never carried by this send, so its durable copy must survive.
        let stagedIDs = Set(viewModel.pendingAttachments.map(\.id))
        pendingSubmissionAttachmentIDs = stagedIDs
        syncDraftAttachments()
        let submittedRecords = lastSyncedDraftAttachments
        let restoredIDs = Set(submittedRecords.map(\.id))
        var sessionFileIDs = Set<UUID>()
        writeComposerDraft(submittedDraft)
        draftMessage = ""

        let generation = sessionStartGeneration
        let isFirstSend = startSession != nil && retained?.didStartConversation != true
        let awaitedSession = needsSessionStart
        if awaitedSession {
            pendingFirstDraft = submittedDraft
        }
        let waitForSession: (@MainActor () async -> Bool)?
        if awaitedSession {
            waitForSession = {
                guard await startPendingSession() else { return false }
                // Startup loads the current catalog; do not execute a command that it no longer supports.
                if pendingSlash != nil,
                   SlashCommandExecutor.parse(submittedDraft, catalog: viewModel.agentCommands)?.messageForIdleSend != message {
                    viewModel.setSendErrorMessage(String(localized: "Check the command and try again."))
                    return false
                }
                return true
            }
        } else {
            waitForSession = nil
        }
        let didStart = await viewModel.sendMessage(
            message,
            modelContext: modelContext,
            waitForSession: waitForSession,
            sessionAttachments: {
                let files = (viewModel.sessionStartupAttachments + viewModel.pendingAttachments).filter {
                    restoredIDs.contains($0.id) || initialImportedAttachmentIDs.contains($0.id)
                }
                sessionFileIDs = Set(files.map(\.id))
                if awaitedSession {
                    pendingSubmissionAttachmentIDs.formUnion(sessionFileIDs)
                    syncDraftAttachments()
                }
                return files
            }
        )
        if didStart {
            if let draftTextWriteID {
                draftStore.consumeAcceptedSubmission(
                    textWriteID: draftTextWriteID,
                    currentText: draftMessage,
                    attachmentIDs: stagedIDs.union(sessionFileIDs)
                )
            }
            onConversationStarted()
        }
        if awaitedSession { pendingFirstDraft = nil }
        if !didStart, isFirstSend, sessionStart == nil {
            sessionStart = .failed(viewModel.sendErrorMessage ?? String(localized: "Couldn't send the message. Try again."))
        }
        pendingSubmissionAttachmentIDs = []
        guard generation == sessionStartGeneration else { return didStart }
        if !didStart, awaitedSession, draftRevision != submittedDraftRevision {
            // Keep the failed first prompt retryable after newer typing, using the existing returned-text path.
            restoreUnacceptedDraft(submittedDraft, submittedDraftRevision: submittedDraftRevision)
        }
        if didStart {
            draftAttachmentsPendingRetry = ChatDraftSendReconciliation.outcome(
                draftRecords: submittedRecords,
                stagedAttachmentIDs: stagedIDs.union(sessionFileIDs)
            ).retained
            // The write receipt owns persistence; this view must not overwrite a moved or newer draft.
            syncDraftAttachments(persists: false)
            return true
        }
        draftMessage = draftStore.resolveSubmission(
            submittedText: submittedDraft,
            currentText: draftMessage,
            didStart: didStart,
            draftWasEdited: draftRevision != submittedDraftRevision,
            for: draftKey
        )
        writeComposerDraft(draftMessage)
        return didStart
    }

    private func writeComposerDraft(_ text: String) {
        draftTextWriteID = draftStore.setDraft(text, for: draftKey)
    }

    private func draftText(appending text: String) -> String {
        let draft = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        return draft.isEmpty ? text
            : "\(draftMessage.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression))\n\n\(text)"
    }

    private func persistComposerDraft() {
        let text: String
        if let pendingFirstDraft, !pendingFirstDraft.isEmpty { text = draftText(appending: pendingFirstDraft) }
        else { text = draftMessage }
        writeComposerDraft(text)
    }

    private func appendReturnedComposerText(_ text: String) {
        draftMessage = draftText(appending: text)
        writeComposerDraft(draftMessage)
    }

    private func restoreUnacceptedDraft(_ submittedDraft: String, submittedDraftRevision: Int) {
        let current = draftMessage
        draftMessage = draftStore.resolveSubmission(
            submittedText: submittedDraft,
            currentText: current,
            didStart: false,
            draftWasEdited: draftRevision != submittedDraftRevision,
            for: draftKey
        )
        if draftRevision != submittedDraftRevision, !submittedDraft.isEmpty {
            appendReturnedComposerText(submittedDraft)
        }
    }

    private func handleSlashExecutionResult(
        _ result: SlashCommandExecutionResult,
        parsedCommand: SlashCommand?,
        submittedDraft: String,
        submittedDraftRevision: Int,
        consumesDraft: Bool = true
    ) {
        switch result {
        case .executed(let message):
            if let message {
                if shouldRenderAsLocalNotice(parsedCommand) {
                    viewModel.showNotice(message)
                } else {
                    viewModel.appendLocalAssistantMessage(message)
                }
            }
            if consumesDraft {
                reconcileConsumedDraft(
                    submittedDraft,
                    submittedDraftRevision: submittedDraftRevision
                )
            }
        case .openedSession(let session):
            forkedSession = session
            if consumesDraft {
                reconcileConsumedDraft(
                    submittedDraft,
                    submittedDraftRevision: submittedDraftRevision
                )
            }
        case .unsupported(let friendlyMessage):
            viewModel.setSendErrorMessage(friendlyMessage)
            if consumesDraft {
                reconcileConsumedDraft(
                    submittedDraft,
                    submittedDraftRevision: submittedDraftRevision
                )
            }
        case .needsSubArg:
            viewModel.setSendErrorMessage(String(localized: "Choose a slash command or continue typing."))
        case .sendAsMessage:
            break
        }
    }

    private func shouldRenderAsLocalNotice(_ command: SlashCommand?) -> Bool {
        command?.handler == .serverSide(.compress) ||
            command?.handler == .serverSide(.queue) ||
            command?.handler == .serverSide(.steer) ||
            command?.handler == .serverSide(.interrupt) ||
            command?.handler == .serverSide(.background)
    }

    private var draftKey: ChatDraftKey {
        // A new chat's draft lives under the new-chat key until its session exists (TAL-636).
        session.sessionId == nil ? .newChat(server: server) : .session(server: server, session: session)
    }

    private var messageActionErrorIsPresented: Binding<Bool> {
        Binding(
            get: { viewModel.messageActionErrorMessage != nil },
            set: { isPresented in
                if !isPresented { viewModel.clearMessageActionError() }
            }
        )
    }

    private func composerDraftBinding(promptID: String?) -> Binding<String> {
        Binding(
            get: { promptID == nil ? draftMessage : viewModel.clarificationDraftResponse },
            set: { newValue in
                // UIKit and voice callbacks can outlive the input they belong to.
                guard promptID == viewModel.clarificationPrompt?.id else { return }
                if let promptID {
                    viewModel.setClarificationDraftResponse(newValue, promptID: promptID)
                    draftWriteRevision &+= 1
                } else {
                    draftMessage = newValue
                    draftRevision &+= 1
                    persistComposerDraft()
                }
            }
        )
    }

    private func hydrateDraftIfNeeded() async {
        guard !didHydrateDraft else { return }
        let textBeforeHydration = draftMessage
        let persistedDraft = await draftStore.draft(for: draftKey)
        guard !Task.isCancelled, draftMessage == textBeforeHydration else { return }

        if textBeforeHydration.isEmpty {
            if let persistedDraft, !persistedDraft.text.isEmpty {
                draftMessage = persistedDraft.text
            }
        } else {
            writeComposerDraft(textBeforeHydration)
        }
        didHydrateDraft = true
        lastSyncedDraftAttachments = persistedDraft?.attachments ?? []
        // A taken-over chat still holds its voice note and attachments.
        guard !resumesLoadedChat else { return }

        if let voiceNote = persistedDraft?.voiceNote { await viewModel.restoreVoiceNote(voiceNote) }
        restoredDraftSettings = persistedDraft?.settings
        if let persistedDraft, !persistedDraft.attachments.isEmpty {
            // Hold the sync gate now and restore later: re-uploading staged
            // files is network work and must not delay the transcript.
            isRestoringDraftAttachments = true
            draftAttachmentsAwaitingRestore = persistedDraft.attachments
        }
    }

    private func restoreDraftAttachmentsIfNeeded() async {
        let records = draftAttachmentsAwaitingRestore
        guard !records.isEmpty else { return }
        draftAttachmentsAwaitingRestore = []
        await restoreDraftAttachments(records)
    }

    /// Rebuilds the composer's staged attachments from a persisted draft by
    /// re-uploading each record's durable local copy against this session. The
    /// persisted server path is never trusted: uploads live in a per-session
    /// inbox the server deletes with the session, so only the app-owned copy
    /// is a sound restore source. Records whose copy is missing are dropped
    /// (with a notice); records whose re-upload fails stay in the draft and
    /// retry on a later open. The rest of the draft loads either way.
    private func restoreDraftAttachments(_ records: [ChatDraftAttachment]) async {
        var pendingRetry: [ChatDraftAttachment] = []
        var unrecoverableCount = 0
        var wasCancelled = false

        for (offset, record) in records.enumerated() {
            guard lastSyncedDraftAttachments.contains(where: { $0.id == record.id }) else { continue }
            if Task.isCancelled {
                // Leaving the chat mid-restore is not a restore failure. Every
                // record from here on is untried, so carry the whole remainder
                // into the retry set: the sync below is authoritative, and
                // anything missing from it would be dropped from the draft and
                // later swept from disk.
                wasCancelled = true
                pendingRetry.append(contentsOf: records[offset...].filter { record in
                    lastSyncedDraftAttachments.contains { $0.id == record.id }
                })
                break
            }
            guard let fileName = record.file else {
                // Tolerate an older or partially corrupt record that predates
                // the durable-staging invariant.
                unrecoverableCount += 1
                continue
            }

            let data: Data
            do {
                data = try await draftAttachmentStore.data(named: fileName)
            } catch {
                // Only a copy that is genuinely gone is dropped. Any other
                // read failure keeps the record so a later open can retry it.
                switch ChatDraftAttachmentReadFailure.classify(error) {
                case .unrecoverable:
                    unrecoverableCount += 1
                case .transient:
                    pendingRetry.append(record)
                }
                continue
            }

            let uploaded = await viewModel.reuploadDraftAttachment(record, data: data)
            guard lastSyncedDraftAttachments.contains(where: { $0.id == record.id }) else { continue }
            // A visible failed row already owns its durable copy and retry action.
            if uploaded == nil, !viewModel.pendingAttachments.contains(where: { $0.id == record.id }) {
                pendingRetry.append(record)
            }
        }

        isRestoringDraftAttachments = false
        draftAttachmentsPendingRetry = pendingRetry
        // Authoritative sync after restore: persists the restored set plus the
        // retry union, and drops unrecoverable records from the draft.
        syncDraftAttachments()

        // Report only a real restore outcome. A cancelled pass has nothing to
        // say, and its view is going away regardless.
        guard !wasCancelled else { return }
        if !pendingRetry.isEmpty || unrecoverableCount > 0 {
            viewModel.setUploadAttachmentError(
                draftRestoreFailureMessage(retryCount: pendingRetry.count, droppedCount: unrecoverableCount)
            )
        }
    }

    /// Copy uses catalog plural variations rather than a hand-branched
    /// singular/plural, so languages whose plural rules differ from English
    /// still read correctly. The mixed case avoids a two-number sentence.
    private func draftRestoreFailureMessage(retryCount: Int, droppedCount: Int) -> String {
        switch (retryCount > 0, droppedCount > 0) {
        case (true, false):
            return String(localized: "Couldn't restore \(retryCount) saved attachments yet. They're still saved in this draft.")
        case (false, true):
            return String(localized: "\(droppedCount) saved attachments are no longer available and were removed from this draft.")
        default:
            return String(localized: "Some saved attachments couldn't be restored. Check this draft's attachments before sending.")
        }
    }

    /// Mirrors the composer's staged attachments into the persisted draft.
    /// Saved records that could not be staged are unioned back in so a
    /// mid-restore or post-restore sync can't silently drop them. Gated during
    /// hydration/restore so an empty or partial composer never overwrites the
    /// persisted set.
    private func syncDraftAttachments(persists: Bool = true) {
        guard didHydrateDraft, !isRestoringDraftAttachments else { return }
        // Only records backed by a durable copy are persisted. Without one the
        // record could never be restored, and keeping it would hold the draft
        // alive just to report the attachment as lost on the next open.
        let pendingRecords = viewModel.pendingAttachments
            .map(ChatDraftAttachment.init(pending:))
            .filter { $0.file != nil }
        let retryRecords = draftAttachmentsPendingRetry.filter { retry in
            !pendingRecords.contains(where: { $0.id == retry.id })
        }
        let stagedAndRetryIDs = Set((pendingRecords + retryRecords).map(\.id))
        let heldRecords = lastSyncedDraftAttachments.filter {
            pendingSubmissionAttachmentIDs.contains($0.id) && !stagedAndRetryIDs.contains($0.id)
        }
        let records = pendingRecords + retryRecords + heldRecords
        lastSyncedDraftAttachments = records
        if persists { draftStore.setAttachments(records, for: draftKey) }
    }

    /// Snapshots the effective composer settings into the draft whenever they
    /// change. Only new-chat contexts snapshot: an existing session's
    /// configuration is owned by the server and is never re-applied from a
    /// draft, so persisting it would just store choices at rest that nothing
    /// reads. Snapshotting here is what lets an abandoned new chat carry its
    /// model/workspace/profile/reasoning picks to the next new chat.
    private func syncDraftSettings(_ settings: ChatDraftSettings) {
        guard didHydrateDraft, restoresDraftSettings else { return }
        draftStore.setSettings(settings, for: draftKey)
    }

    /// The composer choices that make up a draft's settings snapshot, as one
    /// Equatable value so a single `onChange` covers all five.
    private var currentComposerSettings: ChatDraftSettings {
        ChatDraftSettings(
            modelID: viewModel.selectedModelID,
            modelProviderID: viewModel.selectedModelProviderID,
            modelOptionID: viewModel.selectedModelOptionID,
            reasoningEffort: viewModel.selectedReasoningEffort,
            profileName: viewModel.selectedProfileName,
            workspacePath: viewModel.selectedWorkspacePath
        )
    }

    /// New-chat only. The view owns the one-shot restore trigger while the
    /// model owns validation, interaction fencing, and profile ordering.
    private func applyRestoredDraftSettingsIfNeeded(
        expectedInteractionGeneration: Int
    ) async {
        guard restoresDraftSettings, !didApplyRestoredDraftSettings else { return }
        didApplyRestoredDraftSettings = true
        guard let settings = restoredDraftSettings, !Task.isCancelled else { return }
        await viewModel.restoreDraftSettings(
            settings,
            expectedInteractionGeneration: expectedInteractionGeneration
        )
    }

    private func reconcileConsumedDraft(
        _ submittedDraft: String,
        submittedDraftRevision: Int
    ) {
        draftMessage = draftStore.resolveConsumedInput(
            submittedText: submittedDraft,
            currentText: draftMessage,
            draftWasEdited: draftRevision != submittedDraftRevision,
            for: draftKey
        )
    }

    private func flushDraftsBestEffort() {
        Task {
            try? await draftStore.flush()
        }
    }

    private func cancelStream() async {
        guard viewModel.clarificationPrompt == nil else { return }
        let didCancel = await viewModel.cancelActiveStream()
        if didCancel {
            ChatHaptics.streamCancelled(isEnabled: isHapticsEnabled)
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func forkFromMessage(_ context: MessageActionContext) async {
        let session = await viewModel.forkFromMessage(context, modelContext: modelContext)

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }

        if let session {
            forkedSession = session
        }
    }

    private func openPendingProfileChat() {
        guard let name = pendingProfileSelection?.normalizedName,
              let url = TalariaDeepLink.newChatInProfileURL(profileName: name) else { return }
        pendingProfileSelection = nil
        openURL(url)
    }

    private func handleProfileSelection(_ profile: ProfileSummary) {
        guard viewModel.clarificationPrompt == nil else { return }
        viewModel.markComposerConfigurationInteraction()
        if viewModel.isSelectedProfile(profile) {
            return
        }

        if !viewModel.hasSession || viewModel.messages.isEmpty {
            Task { await switchProfile(profile, startNewSession: false) }
        } else {
            pendingProfileSelection = profile
            showProfileNewSessionConfirmation = true
        }
    }

    private func switchProfile(_ profile: ProfileSummary, startNewSession: Bool) async {
        let outcome = await viewModel.switchProfile(
            profile,
            startNewSession: startNewSession,
            recordsInteraction: false
        )
        pendingProfileSelection = nil

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }

        if outcome != nil {
            ChatHaptics.configurationSelected(isEnabled: isHapticsEnabled)
        }

        if let session = outcome?.session {
            forkedSession = session
        }
    }

    /// All imports stage their complete selection before this one sequential network drain.
    private func stageAttachments<Item>(
        _ items: [Item],
        onStaged: (Int, PendingAttachment) -> Void = { _, _ in },
        load: (Item) async throws -> (data: Data, filename: String, preview: Data?)
    ) async {
        guard viewModel.clarificationPrompt == nil else { return }
        let context = viewModel.attachmentStagingContext
        stagingAttachmentBatches += 1
        defer { stagingAttachmentBatches -= 1 }
        var ids: [UUID] = []
        for (index, item) in items.enumerated() {
            guard !Task.isCancelled, context == viewModel.attachmentStagingContext else { return }
            do {
                let file = try await load(item)
                guard !Task.isCancelled, context == viewModel.attachmentStagingContext else { return }
                if let attachment = await viewModel.stageAttachment(data: file.data, filename: file.filename, previewData: file.preview) {
                    ids.append(attachment.id)
                    onStaged(index, attachment)
                }
            } catch { viewModel.setUploadAttachmentError(error.localizedDescription) }
        }
        guard context == viewModel.attachmentStagingContext else { return }
        await viewModel.uploadStagedAttachments(ids: ids)
    }

    private func uploadInitialAttachmentsIfNeeded() async {
        // Once staged, imports live in the coordinator rather than the raw import buffer.
        // Startup Retry must reuse that durable owner and its sequential upload drain.
        let failedImports = viewModel.pendingAttachments.filter {
            guard initialImportedAttachmentIDs.contains($0.id), case .failed = $0.uploadPhase else { return false }
            return true
        }
        for attachment in failedImports {
            guard !Task.isCancelled else { return }
            await viewModel.retryAttachment(id: attachment.id)
        }
        guard !didUploadInitialAttachments, !initialAttachments.isEmpty else { return }
        viewModel.setUploadAttachmentError(nil)
        let imports = initialAttachments
        var stagedIndices = Set<Int>()
        await stageAttachments(imports, onStaged: { index, attachment in
            stagedIndices.insert(index)
            initialImportedAttachmentIDs.insert(attachment.id)
        }) { ($0.data, $0.filename, previewData(for: $0)) }
        initialAttachments = imports.enumerated().compactMap { stagedIndices.contains($0.offset) ? nil : $0.element }
        didUploadInitialAttachments = initialAttachments.isEmpty
    }

    private func previewData(for attachment: SharedAttachmentImport) -> Data? {
        if let typeIdentifier = attachment.typeIdentifier,
           UTType(typeIdentifier)?.conforms(to: .image) == true {
            return attachment.data
        }

        let imageExtensions = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"]
        let fileExtension = URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
        return imageExtensions.contains(fileExtension) ? attachment.data : nil
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem) async {
        await stageAttachments([item]) { item in
            guard let data = try await item.loadTransferable(type: Data.self) else { throw PastedFileError.unreadableURL }
            return (data, "image_\(UUID().uuidString.prefix(8)).jpg", data)
        }
    }

    private func handleSelectedFileURLs(_ urls: [URL]) async {
        await handlePastedFileURLs(urls)
    }

    private func isFileImporterCancellation(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == NSCocoaErrorDomain
            && nsError.code == CocoaError.Code.userCancelled.rawValue
    }

    private func handlePastedFileProviders(_ providers: [NSItemProvider]) async {
        guard viewModel.clarificationPrompt == nil else { return }
        let fileProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        }

        guard !fileProviders.isEmpty else {
            viewModel.setUploadAttachmentError(String(localized: "Paste a copied file to attach it."))
            return
        }

        await stageAttachments(fileProviders) { provider in
            let file = try await loadPastedFile(from: provider)
            return (file.data, file.filename, nil)
        }
    }

    private func handlePastedImageProviders(_ providers: [NSItemProvider]) async {
        guard viewModel.clarificationPrompt == nil else { return }
        let imageProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }

        guard !imageProviders.isEmpty else {
            viewModel.setUploadAttachmentError(String(localized: "Paste a copied image to attach it."))
            return
        }

        await stageAttachments(imageProviders, load: loadAttachment)
    }

    /// Dropped images stage like pasted ones, and everything else like a pasted file, in the drop's order (TAL-1461).
    private func handleDroppedAttachmentProviders(_ providers: [NSItemProvider]) async {
        await stageAttachments(providers, load: loadAttachment)
    }

    /// An image provider loads as a pasted image. Any other loads its contents when it carries them, as Files hands a
    /// dragged file over, and otherwise the file at its URL.
    private func loadAttachment(from provider: NSItemProvider) async throws -> (data: Data, filename: String, preview: Data?) {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let image = try await loadPastedImage(from: provider)
            return (image.data, image.filename, image.data)
        }
        let contentType = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .url) != true }
        let file = if let contentType {
            try await loadFileRepresentation(from: provider, typeIdentifier: contentType)
        } else {
            try await loadPastedFile(from: provider)
        }
        return (file.data, file.filename, nil)
    }

    private func handlePastedImages(_ images: [UIImage]) async {
        guard viewModel.clarificationPrompt == nil else { return }
        guard !images.isEmpty else {
            viewModel.setUploadAttachmentError(String(localized: "Paste a copied image to attach it."))
            return
        }

        await stageAttachments(images) { image in
            guard let data = image.jpegData(compressionQuality: 0.92) ?? image.pngData() else { throw PastedFileError.unreadableURL }
            return (data, pastedImageFilename(), data)
        }
    }

    private func loadPastedFile(from provider: NSItemProvider) async throws -> PastedFile {
        let suggestedName = provider.suggestedName

        return try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                guard let url = pastedFileURL(from: item) else {
                    continuation.resume(throwing: PastedFileError.unreadableURL)
                    return
                }

                do {
                    let file = try loadPastedFile(from: url, suggestedName: suggestedName)
                    continuation.resume(returning: file)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// A copy of the provider's file, read before the provider removes it (TAL-1461).
    private func loadFileRepresentation(from provider: NSItemProvider, typeIdentifier: String) async throws -> PastedFile {
        let suggestedName = provider.suggestedName

        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? PastedFileError.unreadableURL)
                    return
                }
                // The copy has a generic name; the item's own is its suggested name, which may lack the extension.
                continuation.resume(with: Result {
                    let file = try loadPastedFile(from: url, suggestedName: nil)
                    guard let suggestedName, !suggestedName.isEmpty else { return file }
                    let filename = URL(fileURLWithPath: suggestedName).pathExtension.isEmpty && !url.pathExtension.isEmpty
                        ? "\(suggestedName).\(url.pathExtension)"
                        : suggestedName
                    return PastedFile(data: file.data, filename: filename)
                })
            }
        }
    }

    private func handlePastedFileURLs(_ urls: [URL]) async {
        guard viewModel.clarificationPrompt == nil else { return }
        let fileURLs = urls.filter(\.isFileURL)

        guard !fileURLs.isEmpty else {
            viewModel.setUploadAttachmentError(String(localized: "Paste a copied file to attach it."))
            return
        }

        await stageAttachments(fileURLs) { url in
            let file = try loadPastedFile(from: url, suggestedName: nil)
            return (file.data, file.filename, nil)
        }
    }

    private func loadPastedFile(from url: URL, suggestedName: String?) throws -> PastedFile {
        let didStartAccessing = url.startAccessingSecurityScopedResource()
        defer {
            if didStartAccessing {
                url.stopAccessingSecurityScopedResource()
            }
        }

        try validateAttachmentSize(for: url)
        let data = try Data(contentsOf: url)
        let filename = url.lastPathComponent.isEmpty
            ? suggestedName ?? "pasted-file"
            : url.lastPathComponent
        return PastedFile(data: data, filename: filename)
    }

    private func validateAttachmentSize(for url: URL) throws {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = values.fileSize,
              size > PendingAttachment.maximumUploadBytes
        else {
            return
        }

        let filename = url.lastPathComponent.isEmpty ? String(localized: "Selected file") : url.lastPathComponent
        throw PastedFileError.fileTooLarge(filename: filename)
    }

    private func loadPastedImage(from provider: NSItemProvider) async throws -> PastedFile {
        let suggestedName = provider.suggestedName
        let typeIdentifier = provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .image)
        } ?? UTType.image.identifier

        return try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                guard let data else {
                    continuation.resume(throwing: PastedFileError.unreadableImage)
                    return
                }

                continuation.resume(
                    returning: PastedFile(
                        data: data,
                        filename: pastedImageFilename(suggestedName: suggestedName)
                    )
                )
            }
        }
    }

    private func pastedImageFilename(suggestedName: String? = nil) -> String {
        if let suggestedName,
           !suggestedName.isEmpty,
           !URL(fileURLWithPath: suggestedName).pathExtension.isEmpty {
            return suggestedName
        }

        return "image_\(Int(Date().timeIntervalSince1970))_\(UUID().uuidString.prefix(4)).jpg"
    }

    private func pastedFileURL(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL {
            return url
        }

        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }

        if let string = item as? String {
            return URL(string: string) ?? URL(fileURLWithPath: string)
        }

        return nil
    }

    private func scheduleCompletionAcknowledgement() {
        guard completionAcknowledgementTask == nil, scenePhase == .active,
              didCompleteInitialAppearance, viewModel.errorMessage == nil,
              !viewModel.isViewingCachedData,
              let viewedAt = viewedCompletionsThrough, let sessionID = session.sessionId,
              let credentials = TalariaRelayConfigurationStore.load() else { return }
        completionAcknowledgementGeneration += 1
        let generation = completionAcknowledgementGeneration
        completionAcknowledgementTask = Task {
            defer {
                if generation == completionAcknowledgementGeneration { completionAcknowledgementTask = nil }
            }
            guard let acknowledged = await TalariaCompletionStore.shared.acknowledgeViewedSession(
                publisherURL: server, sessionID: sessionID, through: viewedAt
            ) else { return }
            guard !Task.isCancelled, TalariaRelayConfigurationStore.load() == credentials else { return }
            // Retry aggregate cleanup on later thread opens even when an earlier
            // acknowledgement succeeded but its snapshot request failed.
            await AgentLiveActivityManager.shared.reconcileAcknowledgedCompletions(
                acknowledged, credentials: credentials, viewedPublisherURL: server,
                viewedSessionID: sessionID, through: viewedAt
            )
            try? await TalariaAggregateLiveActivityManager.shared.reconcileAfterAcknowledgement(credentials: credentials)
        }
    }

    private func handleScenePhaseChange(_ phase: ScenePhase) {
        if phase != .active {
            completionAcknowledgementGeneration += 1
            completionAcknowledgementTask?.cancel()
            completionAcknowledgementTask = nil
            flushDraftsBestEffort()
        }

        switch phase {
        case .background:
            viewModel.persistTranscript(modelContext: modelContext)
            if viewModel.activeStreamID != nil {
                beginResponseCompletionBackgroundTask()
            }
        case .active:
            viewModel.refreshListenPlaybackProgressAfterSceneActivation()
            endResponseCompletionBackgroundTask()
            Task {
                await viewModel.reconnectStreamIfNeeded(modelContext: modelContext)
                if viewedCompletionsThrough != nil {
                    viewedCompletionsThrough = Date()
                    scheduleCompletionAcknowledgement()
                }

                if let lastError = viewModel.lastError {
                    onAPIError(lastError)
                }
            }
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    private func handleActiveStreamChange() {
        guard let activeStreamID = viewModel.activeStreamID else {
            activeStreamStatusRefreshTask?.cancel()
            activeStreamStatusRefreshTask = nil

            if responseCompletionNotificationTracker.shouldEndBackgroundTaskOnStreamInactive(
                completionTrigger: viewModel.responseCompletionHapticTrigger
            ) {
                endResponseCompletionBackgroundTask()
            }

            // The agent may have edited files this turn, so refresh git state (status,
            // ahead/behind, branch) once the response finishes — keeps the toolbar badge,
            // Changes row, and commit surfaces in sync without re-entering the chat.
            // Run unconditionally: refreshAfterExternalMutation re-checks /api/git-info first,
            // so it also detects a repo the agent just created (git init/clone) mid-turn.
            Task { await gitAvailabilityViewModel.refreshAfterExternalMutation() }
            return
        }

        startActiveStreamStatusRefreshTask(streamID: activeStreamID)
    }

    private func startActiveStreamStatusRefreshTask(streamID: String) {
        activeStreamStatusRefreshTask?.cancel()
        activeStreamStatusRefreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                guard viewModel.activeStreamID == streamID else { return }

                if viewModel.isActiveStreamConnectionSuspended {
                    continue
                }

                await viewModel.recoverStaleActiveStreamIfNeeded(modelContext: modelContext)

                guard viewModel.activeStreamID == streamID else { return }
            }
        }
    }

    private func handleResponseCompletionSideEffects() {
        let outcome = viewModel.responseCompletionOutcome
        if outcome == .completed, !viewModel.responseCompletionNeedsTranscriptRefresh {
            viewModel.cacheCompletedResponse(modelContext: modelContext)
        }

        guard let completionContext = responseCompletionNotificationTracker.completionContext(
            completionTrigger: viewModel.responseCompletionHapticTrigger,
            sceneIsActive: scenePhase == .active
        ) else {
            return
        }

        if outcome == .completed {
            ChatHaptics.assistantResponseCompleted(isEnabled: isHapticsEnabled)
        }

        Task { @MainActor in
            defer { endResponseCompletionBackgroundTask() }

            if viewModel.responseCompletionNeedsTranscriptRefresh {
                await loadMessages(isRoutineReconciliation: true)
            }

            await ResponseCompletionNotificationService.scheduleResponseCompletedIfAllowed(
                sessionID: session.sessionId,
                chatTitle: viewModel.displayTitle,
                outcome: outcome,
                preferenceEnabled: isResponseCompletionNotificationsEnabled
                    && !TalariaRelayConfigurationStore.ownsCompletionAlerts(for: server),
                sceneIsActive: completionContext.sceneIsActive
            )
        }
    }

    private func beginResponseCompletionBackgroundTask() {
        guard responseCompletionBackgroundTask == .invalid else { return }

        let taskIdentifier = UIApplication.shared.beginBackgroundTask(withName: "Talaria response completion") {
            Task { @MainActor in
                endResponseCompletionBackgroundTask()
                viewModel.suspendStreamForBackground()
            }
        }

        responseCompletionBackgroundTask = taskIdentifier
        if taskIdentifier == .invalid {
            viewModel.suspendStreamForBackground()
        }
    }

    private func endResponseCompletionBackgroundTask() {
        guard responseCompletionBackgroundTask != .invalid else { return }

        UIApplication.shared.endBackgroundTask(responseCompletionBackgroundTask)
        responseCompletionBackgroundTask = .invalid
    }

    private func scrollToBottom(_ position: ChatTranscriptScrollProxy) {
        // Deliberate jump to the latest content. Snap without animation while a
        // response is streaming so the tap lands immediately instead of racing
        // the short follow animations already chasing incoming tokens.
        scrollToLatestContent(
            position,
            animated: viewModel.activeStreamID == nil,
            isUserInitiated: true
        )
    }

    private func scrollToLatestTranscriptMessage(
        _ position: ChatTranscriptScrollProxy,
        animated: Bool = true,
        isUserInitiated: Bool = false
    ) {
        guard let latestTranscriptMessageID else { return }

        scheduleFollowScroll(
            position,
            targetID: latestTranscriptMessageID,
            anchor: .bottom,
            animated: animated,
            isUserInitiated: isUserInitiated
        )
    }

    private func scrollToLatestContent(
        _ position: ChatTranscriptScrollProxy,
        animated: Bool = true,
        isUserInitiated: Bool = false
    ) {
        guard !viewModel.messages.isEmpty else { return }

        scheduleFollowScroll(
            position,
            targetID: bottomAnchorID,
            anchor: .bottom,
            animated: animated,
            isUserInitiated: isUserInitiated
        )
    }

    private func scheduleFollowScroll(
        _ position: ChatTranscriptScrollProxy,
        targetID: String,
        anchor: UnitPoint,
        animated: Bool,
        isUserInitiated: Bool
    ) {
        // Explicit jumps re-arm the follow latch; automatic follows (streaming
        // tokens, new rows) only run while the latch is already on and no
        // disclosure toggle is settling.
        if isUserInitiated {
            handleFollowEvent(.reset)
        } else if !isFollowingLatestContent {
            recordSuppressedFollow()
            return
        }

        isReadingOlderTranscript = false
        followScrollGeneration += 1
        let generation = followScrollGeneration

        Task { @MainActor in
            await Task.yield()
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard !Task.isCancelled, generation == followScrollGeneration else { return }
            // Re-check at fire time: a drag or a disclosure toggle may have
            // begun during the delay.
            if !isUserInitiated, !isFollowingLatestContent {
                recordSuppressedFollow()
                return
            }

            // Snap (no animation) while inside the cache-first reconcile window so the
            // taller server transcript replacing the cached one doesn't animate a jump
            // (#289). Evaluated at fire time so it's robust to onChange ordering.
            let isCacheFirstSnapWindow = cacheFirstSnapUntil.map { Date() < $0 } ?? false
            let animation: Animation?
            if animated, !isCacheFirstSnapWindow {
                animation = viewModel.activeStreamID != nil
                    ? ChatMotion.streamingFollow(reduceMotion: reduceMotion)
                    : ChatMotion.scrollToLatest(reduceMotion: reduceMotion)
            } else {
                animation = nil
            }
            position.scrollTo(id: targetID, anchor: anchor, animation: animation)
        }
    }

    private func dismissKeyboard() {
        composerIsFocused = false
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private var canFocusComposer: Bool {
        !viewModel.isViewingCachedData
            && !viewModel.isUploadingAttachment
            && viewModel.uploadAttachmentErrorMessage == nil
    }

    private func handleInitialAppearanceCompletion() {
        didCompleteInitialAppearance = true
        applyInitialComposerFocusPolicyIfNeeded()
    }

    private func applyInitialComposerFocusPolicyIfNeeded() {
        guard isExplicitNewChat else { return }
        guard !didApplyInitialComposerFocusPolicy else { return }
        guard didCompleteInitialAppearance, isInitialComposerFocusContentReady else { return }

        if viewModel.clarificationPrompt != nil || !viewModel.messages.isEmpty {
            didApplyInitialComposerFocusPolicy = true
            return
        }

        guard viewModel.errorMessage == nil, canFocusComposer else { return }
        didApplyInitialComposerFocusPolicy = true
        requestComposerFocusIfPossible()
    }

    private func presentPreviewRestoringComposerFocusIfNeeded(_ present: () -> Void) {
        shouldRestoreComposerFocusAfterPreview = composerIsFocused
        if composerIsFocused {
            composerIsFocused = false
        }
        present()
    }

    private func restoreComposerFocusAfterPreviewIfNeeded() {
        guard shouldRestoreComposerFocusAfterPreview else { return }
        shouldRestoreComposerFocusAfterPreview = false
        requestComposerFocusIfPossible()
    }

    private func requestComposerFocusIfPossible() {
        guard canFocusComposer else { return }
        let promptID = viewModel.clarificationPrompt?.id

        Task { @MainActor in
            await Task.yield()
            guard canFocusComposer, viewModel.clarificationPrompt?.id == promptID else { return }
            composerIsFocused = true
        }
    }

    private func handleFollowEvent(_ event: ChatScrollPolicy.FollowEvent) {
        viewModel.handleTranscriptScroll(event)
        // An explicit jump to the live edge — a send or a scroll-to-bottom tap —
        // overrides a disclosure toggle that is still settling. The suspension
        // exists to protect the position the reader just left, and they have now
        // asked to leave it; without this, the edge-triggered follow that the
        // send's own message fires is swallowed and never replayed.
        if event == .reset {
            updateDisclosureSettle { $0.end() }
        }

        let resolved = ChatScrollPolicy.resolveFollow(current: followLatch, event: event)
        if resolved != followLatch {
            followLatch = resolved
        }
        if !resolved.isFollowing {
            updateDisclosureSettle { $0.cancelOwedFollow() }
        } else {
            retained?.readingRowID = nil
        }
    }

    /// Keeps where the reader is, for the view the navigation may rebuild around it (TAL-1477).
    private func recordReadingRow(_ rowID: () -> String?) {
        guard let retained else { return }
        retained.readingRowID = followLatch.isFollowing ? nil : rowID()
    }

    /// The transcript ends this suspension when its position hold actually
    /// settles or is cancelled. A fixed timer can expire during lazy measurement.
    /// The latch stays intact, and any suppressed final follow replays afterward.
    private func suspendBottomAnchorForDisclosure() -> () -> Void {
        let generation = disclosureSettle.begin()
        return {
            if disclosureSettle.expire(generation: generation, isFollowing: shouldFollowLatestMessage) {
                followReplayRequest += 1
            }
        }
    }

    private func recordSuppressedFollow() {
        let isFollowing = shouldFollowLatestMessage
        updateDisclosureSettle { $0.recordSuppressedFollow(isFollowing: isFollowing) }
    }

    /// Writes only real changes: scroll reports and stream triggers call in
    /// here continuously, and every state write re-renders the chat.
    private func updateDisclosureSettle(_ change: (inout ChatScrollPolicy.DisclosureSettle) -> Void) {
        var settle = disclosureSettle
        change(&settle)
        if settle != disclosureSettle {
            disclosureSettle = settle
        }
    }

    private func updateScrollMetrics(_ metrics: ChatScrollMetrics) {
        let isStreaming = viewModel.activeStreamID != nil
        let isNearBottom = ChatScrollPolicy.isNearBottom(
            distanceFromBottom: metrics.distanceFromBottom,
            isStreaming: isStreaming
        )
        let wasNearBottom = isScrolledNearBottom
        isScrolledNearBottom = isNearBottom
        handleFollowEvent(.contentScrolled(
            isAtBottom: ChatScrollPolicy.isAtBottom(distanceFromBottom: metrics.distanceFromBottom),
            isUserScrolling: metrics.isUserInteracting,
            movedAwayFromBottom: metrics.movedAwayFromBottom,
            wasNearBottom: wasNearBottom
        ))

        if isNearBottom {
            if isReadingOlderTranscript {
                withAnimation(ChatMotion.quickState(reduceMotion: reduceMotion)) {
                    isReadingOlderTranscript = false
                }
            }
        } else if metrics.isUserInteracting || metrics.movedAwayFromBottom {
            // A status-bar tap, VoiceOver, or hardware-keyboard scroll carries the
            // reader away without a touch. It already opts them out of follow, so
            // the composer must collapse with it rather than wait for a drag.
            if !isReadingOlderTranscript,
               ChatScrollPolicy.shouldEnterReadingOlder(
                   distanceFromBottom: metrics.distanceFromBottom,
                   isStreaming: isStreaming
               ) {
                withAnimation(ChatMotion.quickState(reduceMotion: reduceMotion)) {
                    isReadingOlderTranscript = true
                }
            }
        }
    }

    private func prepareTranscriptForExplicitSend() {
        handleFollowEvent(.reset)
        if isReadingOlderTranscript {
            withAnimation(ChatMotion.quickState(reduceMotion: reduceMotion)) {
                isReadingOlderTranscript = false
            }
        }
    }

    private func beginEditMessage(_ context: MessageActionContext) {
        editDraft = context.copyText
        editContext = context
        isEditSheetOnScreen = true
        showEditSheet = true
    }

    private func submitEdit(_ context: MessageActionContext) async {
        editContext = nil

        let success = await viewModel.editMessage(context, newText: editDraft, modelContext: modelContext)

        if success {
            editDraft = ""
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func beginRegenerateResponse(_ context: MessageActionContext) {
        Task { await submitRegenerate(context) }
    }

    private func submitRegenerate(_ context: MessageActionContext) async {
        _ = await viewModel.regenerateAssistantResponse(context, modelContext: modelContext)

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    /// TAL-929: the server held the cut; confirming resends it with the flag.
    private func submitDeepTruncate(_ confirmation: DeepTruncateConfirmation) async {
        let success = await viewModel.confirmDeepTruncate(confirmation, modelContext: modelContext)

        if success, case .edit = confirmation.action {
            editDraft = ""
        }

        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }

    private func deepTruncateWarningMessage(_ confirmation: DeepTruncateConfirmation) -> String {
        let count = confirmation.discardMessages
        return confirmation.action == .regenerate
            ? String(localized: "Regenerating this response will discard \(count) later messages.")
            : String(localized: "Editing this message will discard \(count) later messages.")
    }

    private var profileSwitchWarningMessage: String {
        guard let profile = pendingProfileSelection else {
            return String(localized: "Switching profiles starts a separate session so this transcript is not retagged.")
        }

        return String(localized: "Switch to \(profile.displayName) and start a new session. This keeps the current transcript on its original profile.")
    }
}

private struct PastedFile {
    let data: Data
    let filename: String
}

private enum PastedFileError: LocalizedError {
    case unreadableURL
    case unreadableImage
    case fileTooLarge(filename: String)

    var errorDescription: String? {
        switch self {
        case .unreadableURL:
            String(localized: "Could not read the pasted file.")
        case .unreadableImage:
            String(localized: "Could not read the pasted image.")
        case .fileTooLarge(let filename):
            PendingAttachment.uploadTooLargeMessage(filename: filename)
        }
    }
}

private extension SlashCommandExecutionResult {
    var isSuccessfulSubmission: Bool {
        switch self {
        case .executed, .openedSession:
            true
        case .sendAsMessage, .unsupported, .needsSubArg:
            false
        }
    }
}

/// Mirrors composer state into the persisted draft. Extracted from `ChatView`'s
/// modifier chain: folding these two observers into one modifier keeps the
/// chain within the Swift type-checker's budget.
private struct ChatDraftSyncModifier: ViewModifier {
    let pendingAttachments: [PendingAttachment]
    let composerSettings: ChatDraftSettings
    var voiceNote: ChatDraftVoiceNote? = nil
    let onAttachmentsChange: () -> Void
    let onSettingsChange: (ChatDraftSettings) -> Void
    var onVoiceNoteChange: (ChatDraftVoiceNote?) -> Void = { _ in }

    func body(content: Content) -> some View {
        content
            .onChange(of: voiceNote) { _, note in onVoiceNoteChange(note) }
            .onChange(of: pendingAttachments) { _, _ in
                onAttachmentsChange()
            }
            .onChange(of: composerSettings) { _, newSettings in
                onSettingsChange(newSettings)
            }
    }
}

/// Keeps an open chat current (TAL-434): it catches up after the app was away and whenever the
/// server announces a change to this chat; a run the chat is already streaming is left alone.
private struct ChatLiveSync: ViewModifier {
    let viewModel: ChatViewModel
    let server: URL
    let sessionID: String?
    let onAPIError: (Error) -> Void
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task(id: [scenePhase == .active ? "active" : "inactive", server.absoluteString, viewModel.selectedProfileName ?? "", sessionID ?? ""]) {
                guard scenePhase == .active, let sessionID, !sessionID.isEmpty else { return }
                await SessionEventsMonitor.run(
                    url: Endpoint.sessionStream(sessionID: sessionID).url(relativeTo: server),
                    client: SessionEventStreamClient()
                ) { change in
                    await viewModel.handleSessionsChange(change, modelContext: modelContext)
                    reportLastError()
                }
            }
            .task(id: scenePhase == .active) {
                guard scenePhase == .active else { return }
                await viewModel.recoverWhenServerReturns(modelContext: modelContext, afterAttempt: reportLastError)
            }
            .onReceive(NotificationCenter.default.publisher(for: .talariaReturnedToForeground)) { _ in
                Task {
                    await viewModel.syncWithServer(modelContext: modelContext)
                    reportLastError()
                    await viewModel.refreshBackgroundTasks()
                    await viewModel.loadComposerConfiguration()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .talariaSessionsChanged)) { notification in
                guard let change = notification.userInfo?[SessionsChange.userInfoKey] as? SessionsChange else { return }
                Task {
                    await viewModel.handleSessionsChange(change, modelContext: modelContext)
                    reportLastError()
                }
            }
            .onChange(of: viewModel.queuedSendFailure?.id) {
                if let failure = viewModel.queuedSendFailure {
                    onAPIError(failure.error)
                }
            }
    }

    private func reportLastError() {
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }
    }
}

/// Clips the pane's side edges, where a wider destination layout overflows under the sliding column, while content
/// still scrolls beneath the bars.
struct PaneEdgeClip: Shape {
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY - rect.height, width: rect.width, height: rect.height * 3))
    }
}
