import SwiftUI
import UIKit
import PhotosUI
import TalariaKit


struct MessageComposerView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex
    @AppStorage(PrimaryActionTintSettings.isEnabledKey) private var tintsPrimaryActions = false
    @ScaledMetric(relativeTo: .footnote) private var actionIconSize: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var actionButtonSize: CGFloat = 30
    @ScaledMetric(relativeTo: .title3) private var plusIconSize: CGFloat = 24
    @ScaledMetric(relativeTo: .title3) private var plusButtonSize: CGFloat = 28

    @Binding var draftMessage: String
    let draftWriteRevision: Int
    @Binding var clarificationPanelHeight: CGFloat
    let availableHeight: CGFloat
    @Binding var isFocused: Bool
    let isSending: Bool
    let isCompressingSession: Bool
    let isWaitingForStream: Bool
    let isCancellingStream: Bool
    let isOfflineReadOnly: Bool
    /// The server reports this session as view-only (a delegated subagent
    /// transcript, or an external source the server imported read-only), so the
    /// composer stays disabled even while online.
    let isSessionReadOnly: Bool
    let isChromeCompact: Bool
    let errorMessage: String?
    let configurationErrorMessage: String?
    let contextWindowSnapshot: ContextWindowSnapshot?
    let gitViewModel: GitWorkspaceAvailabilityViewModel
    let modelGroups: [ModelCatalogGroup]
    let selectedModelID: String?
    let selectedModelProviderID: String?
    let selectedModelOptionID: String?
    let selectedModelTitle: String
    let workspaceRoots: [WorkspaceRoot]
    let selectedWorkspacePath: String?
    /// The server's label for `selectedWorkspacePath` (TAL-303).
    let selectedWorkspaceName: String?
    let workspaceSuggestions: [String]
    /// Server base URL for the workspace-registry manager; nil hides the
    /// Manage affordance in the workspace picker.
    let workspaceManagementServer: URL?
    let personalitySuggestions: [String]
    let skillSuggestions: [SkillSlashSuggestion]
    let agentCommands: [AgentCommand]
    let profileOptions: [ProfileSummary]
    let isSingleProfileMode: Bool
    let selectedProfileName: String?
    let selectedProfileTitle: String
    let isLoadingModels: Bool
    let selectedReasoningEffort: String?
    /// Model-aware effort vocabulary; `nil` → full static list (issue #18).
    let supportedReasoningEfforts: [String]?
    /// When false the model has no effort control — hide the reasoning menu.
    let showsReasoningControl: Bool
    let isUpdatingConfiguration: Bool
    let pendingAttachments: [PendingAttachment]
    let isUploadingAttachment: Bool
    let attachmentUploadCount: Int
    let attachmentUploadGeneration: Int
    let isSendingVoiceNote: Bool
    /// When true, dictation auto-starts once this composer appears with the app active —
    /// the "New Chat with Voice" App Intent (#338). Defaults to false for normal composers.
    let autoStartsVoiceInput: Bool
    let voiceInputRequestID: Int
    let apiClient: APIClient?
    let uploadAttachmentErrorMessage: String?
    let onSend: () -> Void
    let onSendAs: (String) -> Void
    let onSendVoiceNote: (Data, String) -> Void
    let onCancel: () -> Void
    let onSelectModel: (ModelCatalogOption) -> Void
    let onModelPickerOpen: () async -> Void
    let onLoadWorkspaceSuggestions: (String) async -> Void
    let onWorkspaceRegistryChanged: () async -> Void
    let onLoadPersonalitySuggestions: () async -> Void
    let onLoadSkillSuggestions: () async -> Void
    let onSelectWorkspace: (String) async -> Void
    let onSelectProfile: (ProfileSummary) -> Void
    let onSelectReasoningEffort: (String) -> Void
    let onHeightChange: (CGFloat) -> Void
    let onPhotoItemSelected: (PhotosPickerItem) -> Void
    let onFileURLsSelected: ([URL]) -> Void
    let onPasteFileProviders: ([NSItemProvider]) -> Void
    let onPasteFileURLs: ([URL]) -> Void
    let onPasteImageProviders: ([NSItemProvider]) -> Void
    let onPasteImages: ([UIImage]) -> Void
    let onRemoveAttachment: (UUID) -> Void
    let onPreviewAttachment: (PendingAttachment) -> Void
    let onDismissUploadAttachmentError: () -> Void
    let onSelectGitBranch: (GitCheckoutTarget) -> Void
    let onCreateGitBranch: (GitCheckoutTarget) -> Void
    let onRefreshGitBranches: () -> Void
    let onVoiceInputRequestHandled: () -> Void
    let onExpandedPresentationRequirementChange: (Bool) -> Void

    var clarificationPrompt: ClarificationPromptState? = nil
    var clarificationErrorMessage: String? = nil
    var clarificationSelectedChoices: [String] = []
    var onToggleClarificationChoice: (String) -> Void = { _ in }
    var onSelectClarificationQuestion: (Int) -> Void = { _ in }
    var onSubmitClarification: (String) -> Void = { _ in }
    /// Set while a new chat's session is being created, or failed to be (TAL-636): the strip shows
    /// it in place of the controls, and nothing that needs the session can be used yet.
    var sessionStart: ComposerSessionStart? = nil
    var onRetrySessionStart: () -> Void = {}
    /// The session's toolset override (TAL-631); nil, before a session reports it, hides the control.
    var sessionToolsets: SessionToolsets? = nil
    var onSaveToolsets: ([String]?) async -> Void = { _ in }

    private var isAnsweringClarification: Bool { clarificationPrompt != nil }

    @State private var textFieldHeight: CGFloat = 0
    @State private var composerSurfaceHeight: CGFloat = 110
    @GestureState private var clarificationResizeTranslation: CGFloat = 0
    @State private var textInputHeight: CGFloat = 22
    @State private var noticeMessage: String?
    @State private var showsAllModelsSheet = false
    @State private var showsWorkspaceSheet = false
    @State private var showsToolsetsSheet = false
    @State private var optimisticWorkspacePath: String?
    @State private var favoriteModelKeys = ModelFavoritesStore.shared.favoriteKeys
    @State private var recentModelKeys = ModelRecentsStore.shared.recentKeys
    @State private var keyboardIsVisible = false
    @State private var shouldRestoreFocusAfterPresentation = false
    @State private var deferredUploadFocusPhase: DeferredUploadFocusPhase = .none
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCameraPicker = false
    @State private var showFileImporter = false
    @State private var voiceInput = ComposerVoiceInputController()
    @State private var voiceNoteRecorder = ComposerVoiceNoteRecorder()
    @State private var voiceNoteCancelArmed = false
    @State private var didAutoStartVoiceInput = false
    @AppStorage(ComposerSTTProviderPreference.storageKey) private var sttProviderPreferenceRawValue = ComposerSTTProviderPreference.defaultValue.rawValue
    @AppStorage(SectionVisibilitySettings.chatGitKey) private var showsGitControls = true
    @AppStorage(ComposerVisibilitySettings.workspaceKey) private var showsWorkspaceControl = true
    @AppStorage(ComposerVisibilitySettings.profileKey) private var showsProfileControl = true
    @AppStorage(ComposerVisibilitySettings.gitBranchKey) private var showsGitBranchControl = true
    @AppStorage(ComposerVisibilitySettings.contextUsageKey) private var showsContextUsageControl = true
    @AppStorage(ComposerVisibilitySettings.controlStripKey) private var isControlStripExpanded = true

    private enum DeferredUploadFocusPhase: Equatable {
        case none
        case waitingForUploadStart(afterGeneration: Int)
        case waitingForUploadsToFinish
    }

    private var showsSlashAutocomplete: Bool {
        guard !isAnsweringClarification else { return false }
        let query = draftMessage.drop(while: { $0.isWhitespace })
        guard query.hasPrefix("/") else { return false }

        let parsed = ParsedSlashQuery(query: draftMessage, catalog: agentCommands)
        if let command = parsed.command,
           command.subArgs == .none,
           hasWhitespaceAfterSlashCommand(parsed.commandName, in: String(query)) {
            return false
        }

        if SlashSkillFormatter.skill(named: parsed.commandName, in: skillSuggestions) != nil,
           hasWhitespaceAfterSlashCommand(parsed.commandName, in: String(query)) {
            return false
        }

        if AgentSlashCommandSuggestion.command(named: parsed.commandName, in: agentCommands) != nil,
           hasWhitespaceAfterSlashCommand(parsed.commandName, in: String(query)) {
            return false
        }

        if parsed.commandName.lowercased() == "skills",
           SlashSkillFormatter.invocation(from: parsed.argQuery, suggestions: skillSuggestions) != nil {
            return false
        }

        if parsed.command?.subArgs == .goalActions,
           parsed.isSubArgMode,
           !parsed.argQuery.isEmpty,
           !SlashCommandCatalog.goalActions.contains(where: {
               $0.hasPrefix(parsed.argQuery.lowercased())
           }) {
            return false
        }

        return true
    }

    private func hasWhitespaceAfterSlashCommand(_ commandName: String, in query: String) -> Bool {
        let prefix = "/\(commandName)"
        guard query.lowercased().hasPrefix(prefix.lowercased()) else { return false }
        let afterCommand = query.dropFirst(prefix.count)
        return afterCommand.first?.isWhitespace == true
    }

    private var parsedSlashQuery: ParsedSlashQuery {
        ParsedSlashQuery(query: draftMessage, catalog: agentCommands)
    }

    private var slashAutocompleteLoadKey: String {
        guard showsSlashAutocomplete,
              let command = parsedSlashQuery.command
        else {
            return showsSlashAutocomplete ? "skills" : ""
        }

        guard parsedSlashQuery.isSubArgMode else {
            return "skills"
        }

        switch command.subArgs {
        case .workspaces:
            return "workspace:\(parsedSlashQuery.argQuery)"
        case .personalities:
            return "personalities"
        case .skills:
            return "skills"
        case .models, .reasoningLevels, .goalActions, .none:
            return ""
        }
    }

    var body: some View {
        AdaptiveGlassContainer(spacing: 6) {
            VStack(spacing: 6) {
                if voiceNoteRecorder.isRecording {
                    ComposerVoiceRecordingBar(
                        elapsed: voiceNoteRecorder.elapsed,
                        isCancelArmed: voiceNoteCancelArmed,
                        onStop: { finishVoiceNote(translationHeight: 0) },
                        onCancel: cancelVoiceNote
                    )
                    .padding(.horizontal, 16)
                } else if let voiceNoteStatus {
                    ComposerVoiceStatusView(status: voiceNoteStatus)
                } else if let voiceStatus {
                    ComposerVoiceStatusView(status: voiceStatus)
                } else if let composerStatus {
                    ComposerStatusView(
                        text: composerStatus.text,
                        isError: composerStatus.isError,
                        isDismissible: composerStatus.isDismissible,
                        onDismiss: onDismissUploadAttachmentError
                    )
                }

                Group {
                    if showsSlashAutocomplete {
                        SlashCommandAutocompleteView(
                            query: draftMessage,
                            selectedModelID: selectedModelID,
                            modelGroups: modelGroups,
                            workspaceRoots: workspaceRoots,
                            workspaceSuggestions: workspaceSuggestions,
                            personalitySuggestions: personalitySuggestions,
                            skillSuggestions: skillSuggestions,
                            agentCommands: agentCommands,
                            selectedReasoningEffort: selectedReasoningEffort,
                            onSelectCommand: { command in
                                draftMessage = "/\(command.name) "
                            },
                            onSelectSkillCommand: { skill in
                                draftMessage = "/\(skill.slashName) "
                            },
                            onSelectAgentCommand: { command in
                                draftMessage = "/\(command.name) "
                            },
                            onSelectSkillSubArg: { skill in
                                draftMessage = "/skills \(skill.slashName) "
                            },
                            onSelectSubArg: { subArg in
                                let parsed = ParsedSlashQuery(query: draftMessage, catalog: agentCommands)
                                draftMessage = "/\(parsed.commandName) \(subArg)"
                            },
                            onDismiss: {
                                draftMessage = ""
                            }
                        )
                        .padding(.horizontal)
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                    }
                }
                .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: showsSlashAutocomplete)

                // The control strip hangs from the card's bottom edge (Web's `.composer-strip`); the
                // card's outline runs across its top.
                VStack(spacing: 0) {
                    // Pending photos hang from the card's top edge, the mirror of the control strip (TAL-634);
                    // inset the same way so the strip's sides meet the card where its corners end.
                    if !isAnsweringClarification && !pendingPhotos.isEmpty {
                        ComposerAttachmentStripView(
                            photos: pendingPhotos,
                            onRemove: onRemoveAttachment,
                            onPreview: onPreviewAttachment
                        )
                        .padding(.horizontal, composerCornerRadius)
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                    }

                    composerChrome
                    .adaptiveGlass(
                        .regular,
                        isInteractive: true,
                        fallbackMaterial: .ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous))
                    // Web's card: a low-contrast outline all round, a soft shadow in light mode only.
                    .overlay {
                        RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
                            .strokeBorder(ComposerControlStrip.borderColor(for: colorScheme), lineWidth: 1)
                    }
                    .shadow(color: Color.black.opacity(colorScheme == .dark ? 0 : 0.14), radius: 12, y: 8)
                    .zIndex(1)

                    // Inset by the card's corner radius, so the strip's sides drop straight from where the
                    // card's rounded corners end instead of meeting them mid-curve.
                    controlStrip
                        .padding(.horizontal, composerCornerRadius)
                }
                .padding(.horizontal)
                .padding(.bottom, showsStripUnderCard ? 4 : 0)
                .animation(ChatMotion.composerChrome(reduceMotion: reduceMotion), value: usesSingleLineShell)
                .animation(ChatMotion.composerChrome(reduceMotion: reduceMotion), value: showsStripUnderCard)
                .animation(ChatMotion.composerChrome(reduceMotion: reduceMotion), value: pendingPhotos.isEmpty)
            }
        }
        .background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear {
                        onHeightChange(proxy.size.height)
                    }
                    .onChange(of: proxy.size.height) { _, newHeight in
                        onHeightChange(newHeight)
                    }
            }
        )
        .task(id: slashAutocompleteLoadKey) {
            await loadSlashAutocompleteSubArgsIfNeeded()
        }
        .task {
            // Cold path: the composer appears already active (the usual case for the
            // "New Chat with Voice" intent once its session is created) — start here.
            autoStartVoiceInputIfNeeded()
        }
        .task(id: voiceInputRequestID) {
            guard voiceInputRequestID > 0 else { return }
            await performVoiceInputToggle()
            onVoiceInputRequestHandled()
        }
        .onAppear {
            onExpandedPresentationRequirementChange(requiresExpandedPresentation)
        }
        .onChange(of: requiresExpandedPresentation) { _, isRequired in
            onExpandedPresentationRequirementChange(isRequired)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase != .active {
                voiceInput.stopBeforeSubmittingDraft()
                // Backgrounding stops the recorder's run-loop ticker, so cancel
                // the in-flight recording rather than leave it silently stalled.
                cancelVoiceNote()
            } else {
                // An intent that opened this composer may have foregrounded the app
                // a beat after it appeared; auto-start once we're active (#338).
                autoStartVoiceInputIfNeeded()
            }
        }
        .onChange(of: voiceNoteRecorder.elapsed) { _, elapsed in
            // Enforce the max-duration cap: auto-stop and send (not cancel) once
            // the clip hits the limit, mirroring a finger release.
            if voiceNoteRecorder.isRecording, elapsed >= ComposerVoiceNoteRecorder.maximumDuration {
                finishVoiceNote(translationHeight: 0)
            }
        }
        .sheet(isPresented: $showsAllModelsSheet, onDismiss: restoreFocusAfterPresentationIfNeeded) {
            ComposerModelPickerSheet(
                modelGroups: modelGroups,
                selectedModelID: selectedModelID,
                selectedModelProviderID: selectedModelProviderID,
                selectedModelOptionID: selectedModelOptionID,
                favoriteModelKeys: favoriteModelKeys,
                recentModelKeys: recentModelKeys,
                onSelect: { option in
                    selectModel(option)
                    showsAllModelsSheet = false
                },
                onToggleFavorite: { option in
                    favoriteModelKeys = ModelFavoritesStore.shared.toggleFavorite(for: option)
                },
                onDeleteSavedCustom: { option in
                    favoriteModelKeys = ModelFavoritesStore.shared.removeFavorite(for: option)
                    recentModelKeys = ModelRecentsStore.shared.removeRecent(for: option)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
            .task {
                await onModelPickerOpen()
            }
        }
        .sheet(isPresented: $showsWorkspaceSheet, onDismiss: restoreFocusAfterPresentationIfNeeded) {
            ComposerWorkspacePickerSheet(
                workspaceRoots: workspaceRoots,
                selectedWorkspacePath: displayedWorkspacePath,
                suggestions: workspaceSuggestions,
                managementServer: isReadOnly ? nil : workspaceManagementServer,
                onLoadSuggestions: onLoadWorkspaceSuggestions,
                onSelect: { path in
                    optimisticWorkspacePath = path
                    showsWorkspaceSheet = false
                    await onSelectWorkspace(path)
                },
                onRegistryChanged: onWorkspaceRegistryChanged
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showsToolsetsSheet, onDismiss: restoreFocusAfterPresentationIfNeeded) {
            ComposerToolsetsSheet(toolsets: sessionToolsets ?? SessionToolsets(names: nil)) { names in
                showsToolsetsSheet = false
                await onSaveToolsets(names)
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        // The pickers hang off the composer root, not the `+` button: opening one expands the
        // one-line composer, which replaces the `+` button mid-presentation and dropped the
        // picked photo with it (TAL-633).
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhotoItems, matching: .images)
        .onChange(of: selectedPhotoItems) {
            let items = selectedPhotoItems
            guard !items.isEmpty else { return }
            deferFocusRestoreUntilUploadCompletes()
            selectedPhotoItems.removeAll()
            for item in items {
                onPhotoItemSelected(item)
            }
        }
        .fullScreenCover(isPresented: $showCameraPicker) {
            CameraPickerView { image in
                deferFocusRestoreUntilUploadCompletes()
                onPasteImages([image])
            }
            .ignoresSafeArea()
        }
        .onChange(of: showCameraPicker) { _, isPresented in
            if !isPresented {
                restoreFocusAfterPresentationDismissalSettles()
            }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                if !urls.isEmpty {
                    deferFocusRestoreUntilUploadCompletes()
                }
                onFileURLsSelected(urls)
            case let .failure(error):
                if isFileImporterCancellation(error) {
                    restoreFocusAfterPresentationDismissalSettles()
                    return
                }

                shouldRestoreFocusAfterPresentation = false
                deferredUploadFocusPhase = .none
                noticeMessage = error.localizedDescription
            }
        }
        .alert(
            "Composer Option",
            isPresented: Binding(
                get: { noticeMessage != nil },
                set: { isPresented in
                    if !isPresented {
                        noticeMessage = nil
                    }
                }
            )
        ) {
            Button("OK") {
                noticeMessage = nil
            }
        } message: {
            Text(noticeMessage ?? "")
        }
        .onChange(of: selectedWorkspacePath) { _, newValue in
            if optimisticWorkspacePath == newValue {
                optimisticWorkspacePath = nil
            }
        }
        .onChange(of: isUpdatingConfiguration) { _, isUpdating in
            if !isUpdating {
                optimisticWorkspacePath = nil
            }
        }
        .onChange(of: configurationErrorMessage) { _, newValue in
            if newValue != nil {
                optimisticWorkspacePath = nil
            }
        }
        .onChange(of: showPhotoPicker) { _, isPresented in
            if !isPresented, selectedPhotoItems.isEmpty {
                restoreFocusAfterPresentationDismissalSettles()
            }
        }
        .onChange(of: showFileImporter) { _, isPresented in
            if !isPresented {
                restoreFocusAfterPresentationDismissalSettles()
            }
        }
        .onChange(of: attachmentUploadGeneration) { _, newGeneration in
            handleDeferredUploadStart(newGeneration)
        }
        .onChange(of: attachmentUploadCount) { _, newCount in
            handleDeferredUploadCountChange(newCount)
        }
        .onChange(of: uploadAttachmentErrorMessage) { _, newValue in
            if newValue != nil {
                deferredUploadFocusPhase = .none
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardIsVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardIsVisible = false
        }
        .onDisappear {
            voiceInput.stopBeforeSubmittingDraft()
            cancelVoiceNote()
            onExpandedPresentationRequirementChange(false)
        }
        .padding(.bottom, keyboardIsVisible ? 10 : 0)
    }

    @ViewBuilder
    private var composerChrome: some View {
        VStack(spacing: 0) {
            if let clarificationPrompt {
                clarificationResizeHandle
                ClarificationRequestContent(
                    prompt: clarificationPrompt,
                    isResponding: isSending || isReadOnly,
                    errorMessage: clarificationErrorMessage,
                    onSubmit: onSubmitClarification,
                    selectedChoices: clarificationSelectedChoices,
                    onToggleChoice: onToggleClarificationChoice,
                    onSelectQuestion: onSelectClarificationQuestion
                )
                .frame(height: displayedClarificationHeight)
                .clipped()
                .id(clarificationPrompt.id)
                Divider()
                    .padding(.horizontal, 16)
            }

            composerSurface
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerSurfaceHeight = $0 }
        }
    }

    private var maximumClarificationHeight: CGFloat {
        // Leave the answer field, send controls, and resize handle on screen.
        availableHeight > 0 ? max(0, availableHeight - composerSurfaceHeight - 64) : 420
    }

    private func clampedClarificationHeight(_ height: CGFloat) -> CGFloat {
        min(max(min(140, maximumClarificationHeight), height), maximumClarificationHeight)
    }

    private var displayedClarificationHeight: CGFloat {
        clampedClarificationHeight(clampedClarificationHeight(clarificationPanelHeight) - clarificationResizeTranslation)
    }

    private var clarificationResizeHandle: some View {
        Capsule()
            .fill(.secondary.opacity(0.5))
            .frame(width: 36, height: 5)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 4, coordinateSpace: .global)
                    .onChanged { _ in
                        // Reading a larger question takes the keyboard's space.
                        if isFocused { isFocused = false }
                    }
                    .updating($clarificationResizeTranslation) { value, translation, _ in
                        translation = value.translation.height
                    }
                    .onEnded { value in
                        clarificationPanelHeight = clampedClarificationHeight(
                            clampedClarificationHeight(clarificationPanelHeight) - value.translation.height
                        )
                    }
            )
            .accessibilityLabel("Resize question area")
            .accessibilityValue("\(Int(displayedClarificationHeight / max(1, maximumClarificationHeight) * 100))%")
            .accessibilityHint("Swipe up or down to resize the question area.")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment:
                    clarificationPanelHeight = clampedClarificationHeight(displayedClarificationHeight + 60)
                case .decrement:
                    clarificationPanelHeight = clampedClarificationHeight(displayedClarificationHeight - 60)
                @unknown default:
                    break
                }
            }
    }

    @ViewBuilder
    private var composerSurface: some View {
        if usesSingleLineShell {
            HStack(spacing: 10) {
                leadingComposerControls

                Button {
                    requestTextViewFocusIfPossible()
                } label: {
                    Text("Ask anything... /commands")
                        .font(AppFont.body())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canFocusTextView)
                .accessibilityLabel("Message")

                voiceButton
                contextIndicator
                actionButton
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        } else {
            VStack(spacing: 0) {
                // Files sit in the card above the text as links, like T3 Code's (TAL-634). Past three
                // they scroll, so a long list never pushes the composer off screen.
                if !isAnsweringClarification && !pendingFiles.isEmpty {
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(pendingFiles) { file in
                                ComposerFileLinkView(
                                    attachment: file,
                                    onRemove: { onRemoveAttachment(file.id) },
                                    onOpen: { onPreviewAttachment(file) }
                                )
                            }
                        }
                        .padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: fileLinkListHeight)
                    .padding(.top, 6)
                }

                ComposerTextInputView(
                    text: $draftMessage,
                    revision: draftWriteRevision,
                    isFocused: $isFocused,
                    inputHeight: $textInputHeight,
                    measuredHeight: $textFieldHeight,
                    isDisabled: isReadOnly || (isAnsweringClarification && isSending),
                    isKeyboardSendEnabled: !showsStopButton && !isActionButtonDisabled,
                    verticalPadding: textFieldVerticalPadding,
                    onKeyboardSend: actionButtonTapped,
                    onPasteFileProviders: onPasteFileProviders,
                    onPasteFileURLs: onPasteFileURLs,
                    onPasteImageProviders: onPasteImageProviders,
                    onPasteImages: onPasteImages,
                    placeholder: isAnsweringClarification ? "Type a response" : "Ask anything... /commands"
                )

                HStack(alignment: .center, spacing: 12) {
                    leadingComposerControls

                    Spacer(minLength: 0)
                    if !isAnsweringClarification {
                        voiceButton
                        contextIndicator
                    }
                    actionButton
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
                .padding(.bottom, 8)
            }
        }
    }

    private var voiceButton: some View {
        ComposerVoiceControlButton(
            isListening: voiceInput.isListening,
            isDisabled: isVoiceInputDisabled,
            color: metaControlColor,
            isRecordingVoiceNote: voiceNoteRecorder.isRecording,
            onTap: toggleVoiceInput,
            onRecordingStart: startVoiceNoteRecording,
            onRecordingDragChanged: { height in
                voiceNoteCancelArmed = ComposerVoiceNoteGesture.isCancelArmed(dragTranslationHeight: height)
            },
            onRecordingEnd: { height in
                finishVoiceNote(translationHeight: height)
            }
        )
    }

    private var actionButton: some View {
        ComposerSendButton(
            glyph: actionButtonGlyph,
            background: actionButtonBackground,
            foreground: actionButtonForeground,
            size: actionButtonSize,
            iconSize: actionIconSize,
            accessibilityLabel: isAnsweringClarification
                ? (clarificationPrompt?.isLastQuestion == false ? "Next" : "Submit clarification")
                : (showsStopButton ? "Stop response" : "Send"),
            options: sendOptions,
            isDisabled: isActionButtonDisabled,
            onTap: actionButtonTapped,
            onOption: { submitDraft(as: $0) }
        )
        .equatable()
    }

    private var actionButtonGlyph: ComposerSendButton.Glyph {
        if isSending || isCancellingStream || isCompressingSession { return .progress }
        if showsStopButton { return .symbol("stop.fill") }
        return .symbol(clarificationPrompt?.isLastQuestion == false ? "arrow.right" : "arrow.up")
    }

    private func loadSlashAutocompleteSubArgsIfNeeded() async {
        guard showsSlashAutocomplete else {
            return
        }

        guard parsedSlashQuery.isSubArgMode,
              let command = parsedSlashQuery.command
        else {
            await onLoadSkillSuggestions()
            return
        }

        switch command.subArgs {
        case .workspaces:
            await onLoadWorkspaceSuggestions(parsedSlashQuery.argQuery)
        case .personalities:
            await onLoadPersonalitySuggestions()
        case .skills:
            await onLoadSkillSuggestions()
        case .models, .reasoningLevels, .goalActions, .none:
            break
        }
    }

    private var composerPlusMenu: some View {
        ChatUIKitMenuButton(horizontalPadding: 8, verticalPadding: 8) {
            Image(systemName: "plus")
                .font(.system(size: plusIconSize, weight: .regular))
                .foregroundStyle(metaControlColor)
                .frame(width: plusButtonSize, height: plusButtonSize)
                .chatMinimumHitTarget(in: Circle())
        } menu: {
            composerOptionsMenu()
        }
        .tint(metaControlColor)
        .disabled(isConfigurationControlDisabled)
        .accessibilityLabel("Composer options")
    }

    private func composerOptionsMenu() -> UIMenu {
        UIMenu(title: "", children: [
            UIMenu(
                title: String(localized: "Attach"),
                options: [.displayInline],
                children: [
                    UIAction(
                        title: String(localized: "Attach File"),
                        image: UIImage(systemName: "paperclip")
                    ) { _ in
                        Task { @MainActor in
                            prepareForComposerPresentation()
                            showFileImporter = true
                        }
                    },
                    UIAction(
                        title: String(localized: "Photos"),
                        image: UIImage(systemName: "photo.on.rectangle")
                    ) { _ in
                        Task { @MainActor in
                            prepareForComposerPresentation()
                            showPhotoPicker = true
                        }
                    },
                    UIAction(
                        title: String(localized: "Camera"),
                        image: UIImage(systemName: "camera"),
                        attributes: UIImagePickerController.isSourceTypeAvailable(.camera) ? [] : .disabled
                    ) { _ in
                        Task { @MainActor in
                            prepareForComposerPresentation()
                            showCameraPicker = true
                        }
                    }
                ]
            )
        ])
    }

    /// Every configuration control, one tap away in the strip under the card (TAL-629). It stays up
    /// with the keyboard and in the one-line shell; a clarification or a read-only session hides it, and
    /// so does the chevron beside +, until it is tapped again (TAL-630). A new chat's start status shows
    /// either way.
    @ViewBuilder
    private var controlStrip: some View {
        if showsControlStrip, let sessionStart {
            ComposerSessionStartStrip(state: sessionStart, onRetry: onRetrySessionStart)
                .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
        } else if showsControlStrip {
            ComposerSecondaryControlsView(
                state: secondaryControlsState,
                onChooseWorkspace: {
                    prepareForComposerPresentation()
                    showsWorkspaceSheet = true
                },
                onChooseToolsets: {
                    prepareForComposerPresentation()
                    showsToolsetsSheet = true
                },
                onSelectProfile: onSelectProfile,
                onSelectGitBranch: onSelectGitBranch,
                onCreateGitBranch: onCreateGitBranch,
                onRefreshGitBranches: onRefreshGitBranches
            ) {
                modelMenu
                if showsReasoningControl {
                    reasoningMenu
                }
            }
            // The chevron folds it away in place: taking it out of the layout re-hosts the card's text
            // view, which drops the keyboard.
            .frame(height: isControlStripExpanded ? nil : 0, alignment: .top)
            .clipped()
            .opacity(isControlStripExpanded ? 1 : 0)
            .allowsHitTesting(isControlStripExpanded)
            .accessibilityHidden(!isControlStripExpanded)
            .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
        }
    }

    /// Pending photos go in the strip above the card; every other attachment is a file link in it.
    private var pendingPhotos: [PendingAttachment] {
        pendingAttachments.filter(\.isImage)
    }

    private var pendingFiles: [PendingAttachment] {
        pendingAttachments.filter { !$0.isImage }
    }

    /// One 44 pt row per file, up to three; more scroll.
    private var fileLinkListHeight: CGFloat {
        CGFloat(min(pendingFiles.count, 3)) * 44
    }

    private var showsControlStrip: Bool {
        !isAnsweringClarification && !isReadOnly
    }

    private var showsStripUnderCard: Bool {
        showsControlStrip && (sessionStart != nil || isControlStripExpanded)
    }

    /// + and, beside it, the chevron that shows or hides the control strip.
    @ViewBuilder
    private var leadingComposerControls: some View {
        if !isAnsweringClarification {
            composerPlusMenu
        }
        if showsControlStrip, sessionStart == nil {
            controlStripToggle
        }
    }

    /// Shows or hides the control strip; the choice holds for every chat until it is changed.
    private var controlStripToggle: some View {
        Button {
            isControlStripExpanded.toggle()
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: plusIconSize * 0.62, weight: .semibold))
                .rotationEffect(.degrees(isControlStripExpanded ? 0 : 180))
                .foregroundStyle(metaControlColor)
                .frame(width: plusButtonSize, height: plusButtonSize)
                .chatMinimumHitTarget(in: Circle())
        }
        .buttonStyle(.chatTactile(.icon))
        .accessibilityLabel(isControlStripExpanded ? "Hide composer controls" : "Show composer controls")
    }

    @ViewBuilder
    private var contextIndicator: some View {
        if showsContextUsageControl {
            ContextWindowIndicatorView(snapshot: contextWindowSnapshot)
        }
    }

    private var metaControlFont: Font {
        AppFont.footnote()
    }

    private var metaChevronFont: Font {
        AppFont.caption2()
    }

    private var usesAccessibilityLayout: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var modelControlMaxWidth: CGFloat {
        usesAccessibilityLayout ? 156 : 120
    }

    private var secondaryControlsState: ComposerSecondaryControlsState {
        ComposerSecondaryControlsState(
            workspaceTitle: showsWorkspaceControl ? workspaceTitle : nil,
            profileOptions: profileOptions,
            selectedProfileName: selectedProfileName,
            selectedProfileTitle: showsProfileControl && !isSingleProfileMode ? selectedProfileTitle : nil,
            gitBranch: showsGitBranchControl && showsGitControls && gitViewModel.hasRepository
                ? ComposerSecondaryControlsState.GitBranch(
                    currentName: gitViewModel.currentBranchName,
                    branches: gitViewModel.branches,
                    isLoading: gitViewModel.isLoadingBranches,
                    isSwitching: gitViewModel.isSwitchingBranch
                )
                : nil,
            toolsetsTitle: sessionToolsets?.title,
            isDisabled: isConfigurationControlDisabled
        )
    }

    private var modelMenu: some View {
        ComposerModelMenu(
            modelGroups: modelGroups,
            selectedModelID: selectedModelID,
            selectedModelProviderID: selectedModelProviderID,
            selectedModelOptionID: selectedModelOptionID,
            selectedModelTitle: selectedModelTitle,
            isLoadingModels: isLoadingModels,
            favoriteModelKeys: favoriteModelKeys,
            recentModelKeys: recentModelKeys,
            isDisabled: isConfigurationControlDisabled,
            maxWidth: modelControlMaxWidth,
            color: metaControlColor,
            controlFont: metaControlFont,
            chevronFont: metaChevronFont,
            onSelectModel: selectModel
        ) {
            prepareForComposerPresentation()
            showsAllModelsSheet = true
        }
    }

    private var reasoningMenu: some View {
        ComposerReasoningMenu(
            selectedReasoningEffort: selectedReasoningEffort,
            supportedEfforts: supportedReasoningEfforts,
            reasoningTitle: reasoningTitle,
            isDisabled: isConfigurationControlDisabled,
            width: ComposerControlStrip.titleMaxWidth,
            color: metaControlColor,
            controlFont: metaControlFont,
            chevronFont: metaChevronFont,
            onSelectReasoningEffort: onSelectReasoningEffort
        )
    }

    private func selectModel(_ option: ModelCatalogOption) {
        recentModelKeys = ModelRecentsStore.shared.recordRecent(option)
        onSelectModel(option)
    }

    /// Either reason the composer cannot send: offline cache browsing, or a
    /// session the server owns as view-only.
    private var isReadOnly: Bool {
        isOfflineReadOnly || isSessionReadOnly
    }

    private var composerStatus: (text: String, isError: Bool, isDismissible: Bool)? {
        if isOfflineReadOnly {
            return (String(localized: "Reconnect to send messages."), false, false)
        } else if isSessionReadOnly {
            return (String(localized: "This session is read-only."), false, false)
        } else if isWaitingForStream && isCancellingStream {
            return (String(localized: "Stopping response..."), false, false)
        } else if isCompressingSession {
            return (String(localized: "Compressing context..."), false, false)
        } else if let uploadAttachmentErrorMessage {
            return (uploadAttachmentErrorMessage, true, true)
        } else if isSendingVoiceNote {
            return (String(localized: "Sending voice note..."), false, false)
        } else if isUploadingAttachment {
            return (String(localized: "Uploading attachment..."), false, false)
        } else if let errorMessage {
            return (errorMessage, true, false)
        } else if let configurationErrorMessage {
            return (configurationErrorMessage, true, false)
        } else if isUpdatingConfiguration {
            return (String(localized: "Updating composer settings..."), false, false)
        }

        return nil
    }

    private var voiceStatus: ComposerVoiceStatus? {
        switch voiceInput.state {
        case .listening:
            return ComposerVoiceStatus(text: String(localized: "Listening..."), systemImage: "waveform", isError: false)
        case .serverListening:
            return ComposerVoiceStatus(text: String(localized: "Recording..."), systemImage: "mic.fill", isError: false)
        case .transcribing:
            return ComposerVoiceStatus(text: String(localized: "Transcribing..."), systemImage: "waveform", isError: false)
        case .requestingPermission:
            return ComposerVoiceStatus(
                text: String(localized: "Requesting voice permissions..."),
                systemImage: "mic.badge.plus",
                isError: false
            )
        case .idle:
            break
        }

        if let errorMessage = voiceInput.errorMessage {
            return ComposerVoiceStatus(
                text: errorMessage,
                systemImage: "exclamationmark.triangle",
                isError: true
            )
        }

        return nil
    }

    /// Voice-note status shown above the composer when *not* actively recording
    /// (the recording bar covers that case): the permission prompt and recorder
    /// errors like a denied microphone.
    private var voiceNoteStatus: ComposerVoiceStatus? {
        if voiceNoteRecorder.isRequestingPermission {
            return ComposerVoiceStatus(
                text: String(localized: "Requesting microphone access..."),
                systemImage: "mic.badge.plus",
                isError: false
            )
        }

        if let errorMessage = voiceNoteRecorder.errorMessage {
            return ComposerVoiceStatus(
                text: errorMessage,
                systemImage: "exclamationmark.triangle",
                isError: true
            )
        }

        return nil
    }

    private var metaControlColor: Color {
        Color(.secondaryLabel)
    }

    private var workspaceTitle: String {
        let name: String?
        if let optimisticWorkspacePath {
            // An unsent pick shows its registry entry's name until the server reports the session's.
            name = workspaceRoots.first(where: { $0.path == optimisticWorkspacePath })?.name
        } else {
            name = selectedWorkspaceName
        }
        guard let name, !name.isEmpty else {
            return String(localized: "Workspace")
        }

        return name
    }

    private var displayedWorkspacePath: String? {
        optimisticWorkspacePath ?? selectedWorkspacePath
    }

    private var isConfigurationControlDisabled: Bool {
        isAnsweringClarification || isReadOnly || isSending || isCompressingSession || isWaitingForStream || isUpdatingConfiguration
            || sessionStart != nil
    }

    private var isVoiceInputDisabled: Bool {
        guard !isAnsweringClarification else { return true }
        if voiceInput.isListening {
            return false
        }

        return isReadOnly
            || isSending
            || isCompressingSession
            || isWaitingForStream
            || isUploadingAttachment
            || isUpdatingConfiguration
            || voiceInput.isRequestingPermission
    }

    /// Whether a hold-to-record gesture is allowed to start a new voice note.
    /// Recording mid-stream is fine (it queues like any send), so unlike dictation
    /// this does not block on `isWaitingForStream`.
    private var isVoiceNoteRecordingDisabled: Bool {
        isAnsweringClarification || isReadOnly || sessionStart != nil
            || isSending
            || isSendingVoiceNote
            || isCompressingSession
            || isUploadingAttachment
            || isUpdatingConfiguration
    }

    private var actionButtonBackground: Color {
        if PrimaryActionTintSettings.usesThemeColor(
            isEnabled: tintsPrimaryActions,
            controlIsEnabled: !isActionButtonDisabled
        ) {
            return HeaderLogoColor.color(for: headerLogoColorHex)
        }

        if isActionButtonDisabled {
            return colorScheme == .dark ? Color.white.opacity(0.18) : Color.black.opacity(0.12)
        }

        return colorScheme == .dark ? .white : .black
    }

    private var actionButtonForeground: Color {
        if PrimaryActionTintSettings.usesThemeColor(
            isEnabled: tintsPrimaryActions,
            controlIsEnabled: !isActionButtonDisabled
        ) {
            return HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
        }

        if isActionButtonDisabled {
            return Color(.secondaryLabel)
        }

        return colorScheme == .dark ? .black : .white
    }

    private var isComposerExpanded: Bool {
        draftMessage.contains("\n") || textFieldHeight > 44
    }

    private var composerCornerRadius: CGFloat {
        usesSingleLineShell ? 28 : (isComposerExpanded ? 26 : 22)
    }

    private var usesSingleLineShell: Bool {
        !isAnsweringClarification && (isChromeCompact || (
            !isFocused
                && draftMessage.isEmpty
                && pendingAttachments.isEmpty
                && !requiresExpandedPresentation
        ))
    }

    private var requiresExpandedPresentation: Bool {
        isAnsweringClarification || composerStatus != nil
            || voiceStatus != nil
            || voiceNoteStatus != nil
            || voiceNoteRecorder.isRecording
            || showsSlashAutocomplete
            || showsAllModelsSheet
            || showsWorkspaceSheet
            || showPhotoPicker
            || showCameraPicker
            || showFileImporter
            || noticeMessage != nil
    }

    private var textFieldVerticalPadding: CGFloat {
        isComposerExpanded ? 12 : 14
    }

    private var reasoningTitle: String {
        guard let selectedReasoningEffort else {
            return String(localized: "Reasoning")
        }

        return ReasoningEffortOption.title(for: selectedReasoningEffort)
    }

    private var trimmedDraftMessage: String {
        draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var showsStopButton: Bool {
        !isAnsweringClarification && isWaitingForStream && trimmedDraftMessage.isEmpty && pendingAttachments.isEmpty
    }

    private var isActionButtonDisabled: Bool {
        // A new chat cannot send until its session exists (TAL-636); typing still works.
        if isReadOnly || sessionStart != nil {
            return true
        }

        if isAnsweringClarification {
            return (trimmedDraftMessage.isEmpty && clarificationSelectedChoices.isEmpty) || isSending
        }

        if showsStopButton {
            return isCancellingStream
        }

        return (trimmedDraftMessage.isEmpty && pendingAttachments.isEmpty)
            || isSending
            || isCompressingSession
            || isUploadingAttachment
            || isUpdatingConfiguration
    }

    private func actionButtonTapped() {
        guard !isActionButtonDisabled else { return }
        if showsStopButton {
            onCancel()
        } else {
            submitDraft(as: nil)
        }
    }

    private func submitDraft(as command: String?) {
        if voiceInput.isListening {
            voiceInput.stopBeforeSubmittingDraft()
        }
        if let command {
            onSendAs(command)
        } else {
            onSend()
        }
    }

    /// Long-pressing Send offers the other ways to send the draft, so no one types `/queue` (TAL-630).
    /// Steer, side questions and background tasks cannot carry files, so staged files hide them; a side
    /// question waits for the running reply, so it shows only between replies.
    private var sendOptions: [ComposerSendButton.Option] {
        guard !isAnsweringClarification, !showsStopButton, !isActionButtonDisabled else { return [] }
        let carriesFiles = !pendingAttachments.isEmpty
        var options: [ComposerSendButton.Option] = []
        if isWaitingForStream {
            options.append((.init(title: String(localized: "Queue"), systemImage: "text.badge.plus", command: "queue")))
            if !carriesFiles { options.append((.init(title: String(localized: "Steer"), systemImage: "arrow.turn.down.right", command: "steer"))) }
            options.append((.init(title: String(localized: "Stop and send"), systemImage: "stop.circle", command: "interrupt")))
        } else if !carriesFiles {
            options.append((.init(title: String(localized: "Side question"), systemImage: "bubble.left.and.text.bubble.right", command: "btw")))
        }
        if !carriesFiles {
            options.append((.init(title: String(localized: "Run in background"), systemImage: "square.stack.3d.down.right", command: "background")))
        }
        return options
    }

    /// Starts dictation once for a composer opened by the "New Chat with Voice" intent (#338),
    /// mirroring a mic tap. Gated so it fires a single time, only while the app is active and
    /// the mic is free; the reused tap path handles the mic/speech permission prompt and surfaces
    /// a clear error if access is denied, so a denied/undetermined mic degrades gracefully.
    @MainActor
    private func autoStartVoiceInputIfNeeded() {
        guard autoStartsVoiceInput, !didAutoStartVoiceInput else { return }
        guard scenePhase == .active else { return }
        didAutoStartVoiceInput = true
        guard !voiceInput.isListening, !isVoiceInputDisabled else { return }
        toggleVoiceInput()
    }

    @MainActor
    private func toggleVoiceInput() {
        Task { await performVoiceInputToggle() }
    }

    @MainActor
    private func performVoiceInputToggle() async {
        guard !isVoiceInputDisabled else { return }
        voiceInput.apiClient = apiClient
        voiceInput.providerPreference = ComposerSTTProviderPreference.storedValue(sttProviderPreferenceRawValue)
        voiceInput.locale = .current
        await voiceInput.toggle(currentDraft: draftMessage) { newDraft in
            draftMessage = newDraft
        }
    }

    /// Hold recognized → start recording a voice note. Gated by the recording
    /// disabled conditions; stops dictation first if it's running.
    @MainActor
    private func startVoiceNoteRecording() {
        guard !isVoiceNoteRecordingDisabled, !voiceNoteRecorder.isRecording else { return }

        if voiceInput.isListening {
            voiceInput.stopKeepingTranscript()
        }
        voiceNoteCancelArmed = false
        Task { await voiceNoteRecorder.begin() }
    }

    /// Finger lifted (or max duration hit). Cancels if slid up past the threshold,
    /// otherwise stops and sends the clip.
    @MainActor
    private func finishVoiceNote(translationHeight: CGFloat) {
        let shouldCancel = ComposerVoiceNoteGesture.isCancelArmed(dragTranslationHeight: translationHeight)
        voiceNoteCancelArmed = false

        guard !shouldCancel else {
            voiceNoteRecorder.cancel()
            return
        }

        guard let note = voiceNoteRecorder.finish() else { return }
        onSendVoiceNote(note.data, note.filename)
    }

    @MainActor
    private func cancelVoiceNote() {
        voiceNoteCancelArmed = false
        voiceNoteRecorder.cancel()
    }

    private var canFocusTextView: Bool {
        !isReadOnly && !isUploadingAttachment && uploadAttachmentErrorMessage == nil
    }

    private func prepareForComposerPresentation() {
        shouldRestoreFocusAfterPresentation = isFocused
        if isFocused {
            isFocused = false
        }
    }

    private func restoreFocusAfterPresentationIfNeeded() {
        guard shouldRestoreFocusAfterPresentation else { return }
        shouldRestoreFocusAfterPresentation = false
        requestTextViewFocusIfPossible()
    }

    private func restoreFocusAfterPresentationDismissalSettles() {
        guard shouldRestoreFocusAfterPresentation else { return }

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard shouldRestoreFocusAfterPresentation else { return }
            restoreFocusAfterPresentationIfNeeded()
        }
    }

    private func deferFocusRestoreUntilUploadCompletes() {
        guard shouldRestoreFocusAfterPresentation else { return }
        shouldRestoreFocusAfterPresentation = false
        deferredUploadFocusPhase = .waitingForUploadStart(afterGeneration: attachmentUploadGeneration)
    }

    private func handleDeferredUploadStart(_ newGeneration: Int) {
        guard case let .waitingForUploadStart(afterGeneration) = deferredUploadFocusPhase,
              newGeneration > afterGeneration
        else { return }

        if attachmentUploadCount == 0 {
            restoreFocusAfterDeferredUploadIfNeeded()
        } else {
            deferredUploadFocusPhase = .waitingForUploadsToFinish
        }
    }

    private func handleDeferredUploadCountChange(_ newCount: Int) {
        guard case .waitingForUploadsToFinish = deferredUploadFocusPhase else { return }
        if newCount == 0 {
            restoreFocusAfterDeferredUploadIfNeeded()
        }
    }

    private func restoreFocusAfterDeferredUploadIfNeeded() {
        guard deferredUploadFocusPhase != .none else { return }
        deferredUploadFocusPhase = .none
        requestTextViewFocusIfPossible()
    }

    private func requestTextViewFocusIfPossible() {
        guard canFocusTextView else { return }

        Task { @MainActor in
            await Task.yield()
            guard canFocusTextView else { return }
            isFocused = true
        }
    }

    private func isFileImporterCancellation(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == NSCocoaErrorDomain
            && nsError.code == CocoaError.Code.userCancelled.rawValue
    }
}

/// The send button (TAL-630): a tap sends, a long press lists the other ways to send the draft. A menu, unlike
/// `contextMenu`, leaves the keyboard up. SwiftUI rebuilds an open menu on every redraw, which cancels a tap on
/// its items, and a streaming reply redraws the composer constantly; so this redraws only when its look or its
/// options change.
struct ComposerSendButton: View, Equatable {
    enum Glyph: Equatable {
        case progress
        case symbol(String)
    }

    struct Option: Equatable {
        let title: String
        let systemImage: String
        let command: String
    }

    let glyph: Glyph
    let background: Color
    let foreground: Color
    let size: CGFloat
    let iconSize: CGFloat
    let accessibilityLabel: String
    let options: [Option]
    let isDisabled: Bool
    let onTap: () -> Void
    let onOption: (String) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.glyph == rhs.glyph && lhs.background == rhs.background && lhs.foreground == rhs.foreground
            && lhs.size == rhs.size && lhs.iconSize == rhs.iconSize && lhs.accessibilityLabel == rhs.accessibilityLabel
            && lhs.options == rhs.options && lhs.isDisabled == rhs.isDisabled
    }

    var body: some View {
        Menu {
            ForEach(options, id: \.command) { option in
                Button(option.title, systemImage: option.systemImage) { onOption(option.command) }
            }
        } label: {
            Group {
                switch glyph {
                case .progress:
                    ProgressView()
                        .tint(foreground)
                        .scaleEffect(0.82)
                case .symbol(let name):
                    Image(systemName: name)
                        .font(.system(size: iconSize, weight: .semibold))
                }
            }
            .frame(width: size, height: size)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(Circle())
            .chatMinimumHitTarget(in: Circle())
        } primaryAction: {
            onTap()
        }
        .menuStyle(.button)
        .buttonStyle(.chatTactile(.icon))
        .disabled(isDisabled)
        .accessibilityLabel(accessibilityLabel)
    }
}
