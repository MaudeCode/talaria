import SwiftUI
import UIKit
import TalariaKit

struct ChatTranscriptView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var scrollPositionController = ChatScrollPositionController()
    /// Owns the transcript's message long press: one handler for every row,
    /// which is what lets a press be resolved against link geometry first.
    @State private var menuRegistry = ChatMessageMenuRegistry()

    let isLoading: Bool
    let errorMessage: String?
    let messages: [ChatMessage]
    let displayedTranscriptMessages: [TranscriptMessage]
    let compressionReferenceCard: CompressionReferenceCard?
    let reasoningGroups: [ReasoningGroup]
    let completedToolCallGroupsForAnchor: (String?) -> [ToolCallGroup]
    let archivedActivityRowsForAnchor: (String?) -> [AssistantActivityRow]
    let earlierSceneRowsForTurn: (TranscriptMessage) -> [AssistantActivitySceneRow]
    let onLoadEarlierSceneRows: (TranscriptMessage) -> Void
    let liveReasoningText: String
    let liveActivityRows: [AssistantActivityRow]
    let reasoningAnchorMessageID: String?
    let liveToolCalls: [ToolCall]
    let toolCallAnchorMessageID: String?
    let streamingAssistantMessageID: String?
    let liveTokensPerSecond: Double?
    /// The run state is still being confirmed by the first session load (TAL-250).
    let showsRunStateCheck: Bool
    let clarificationPrompt: ClarificationPromptState?
    let hidesRunStatusAccessibility: Bool
    let showsThinkingAndToolCards: Bool
    let showsAssistantTypingIndicator: Bool
    let shouldFollowLatestMessage: Bool
    /// True while a disclosure toggle animates; suspends the bottom size-change
    /// anchor and follow-driven scrolls so the tapped row stays stationary.
    let isDisclosureSettling: Bool
    let latestTranscriptMessageRole: String?
    let isScrolledNearBottom: Bool
    let activeStreamID: String?
    let streamingScrollTrigger: Int
    let cacheFirstReconcileScrollToken: Int
    let bottomAnchorID: String
    let transcriptMessageSpacing: CGFloat
    let transcriptBlockSpacing: CGFloat
    let transcriptBottomInsetHeight: CGFloat
    /// Bumped by the scroll-to-latest chip above the composer.
    let scrollToBottomRequest: Int
    let assistantName: String
    let localAttachmentPreviews: [String: [String: Data]]
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let isSessionReadOnly: Bool
    let canBranch: Bool
    let hasOlderMessages: Bool
    let isLoadingOlderMessages: Bool
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let loadAttachmentImage: (String) async -> Data?
    let loadAttachmentData: (String) async -> Data?
    let loadTranscriptMediaImage: (TranscriptMediaReference) async -> Data?
    let loadTranscriptMediaData: (TranscriptMediaReference) async -> Data?
    let transcriptMediaCacheNamespace: String
    let actionContext: (ChatMessage, Int) -> MessageActionContext?
    let shouldRenderMessageRow: (ChatMessage) -> Bool
    let onLoadMessages: () async -> Void
    let onLoadOlderMessages: () async -> Bool
    let onUpdateScrollMetrics: (ChatScrollMetrics) -> Void
    let onFollowEvent: (ChatScrollPolicy.FollowEvent) -> Void
    let onDisclosureToggle: () -> Void
    let onDismissKeyboard: () -> Void
    let onScrollToBottom: (ScrollViewProxy) -> Void
    let onScrollToLatestTranscriptMessage: (ScrollViewProxy) -> Void
    let onScrollToLatestContent: (ScrollViewProxy, Bool) -> Void
    let onPreviewAttachment: (MessageAttachment, Data?) -> Void
    let onPreviewTranscriptMedia: (TranscriptMediaReference) -> Void
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void
    /// Non-nil shows the inline "Commit & Push" button under the latest assistant turn
    /// (issue #315, Slice C, surface B). Nil hides it (non-git chats, no changes, etc.).
    var inlineCommitContext: ChatInlineCommitContext? = nil
    var onInlineCommit: () -> Void = {}
    /// Non-nil shows the turn-end "File changes" recap card under the latest assistant turn
    /// (issue #316, Slice D, surface B). Nil hides it (non-git chats, no changes, streaming).
    var turnChangesSummary: TurnFileChangeSummary? = nil
    var onOpenTurnDiff: () -> Void = {}
    var onOpenTurnFileDiff: (GitFile) -> Void = { _ in }

    var body: some View {
        if isLoading && messages.isEmpty && clarificationPrompt == nil {
            ChatTranscriptLoadingSkeletonView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottomLeading) {
                    // A cold open has nothing to paint yet; the check still says the run state is unconfirmed.
                    if showsRunStateCheck {
                        StatusChip(ChatActiveRunStatusPresentation(kind: .checking), agentName: assistantName)
                            .padding()
                            .padding(.bottom, transcriptBottomInsetHeight)
                    }
                }
                .adaptiveReadableContent(maxWidth: AdaptiveReadableContentWidth.chat)
        } else if let errorMessage, messages.isEmpty, clarificationPrompt == nil {
            ContentUnavailableView {
                Label("Could Not Load Messages", systemImage: "exclamationmark.triangle")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") {
                    Task { await onLoadMessages() }
                }
            }
        } else if messages.isEmpty && clarificationPrompt == nil {
            ContentUnavailableView {
                Image(systemName: "bubble.left.and.bubble.right")
            } description: {
                Text("Send a message to start the conversation.")
            }
            .contentShape(Rectangle())
            .onTapGesture {
                onDismissKeyboard()
            }
        } else {
            transcriptScrollView
        }
    }

    private var transcriptScrollView: some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                let viewportWidth = max(0, viewport.size.width)
                let contentWidth = transcriptContentWidth(for: viewportWidth)

                ZStack(alignment: .bottom) {
                    ScrollView {
                        transcriptScrollContent(
                            proxy: proxy,
                            viewportWidth: viewportWidth,
                            contentWidth: contentWidth
                        )
                    }
                    .defaultScrollAnchor(
                        ChatScrollPolicy.initialTranscriptAnchor,
                        for: .initialOffset
                    )
                    .defaultScrollAnchor(
                        ChatScrollPolicy.sizeChangeAnchor(
                            shouldFollowLatestMessage: shouldFollowLatestMessage,
                            isDisclosureSettling: isDisclosureSettling
                        ),
                        for: .sizeChanges
                    )
                    .frame(width: viewportWidth)
                    .refreshable {
                        if hasOlderMessages {
                            await loadOlderMessagesPreservingPosition(proxy: proxy)
                        } else {
                            await onLoadMessages()
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        Color.clear
                            .frame(height: transcriptBottomInsetHeight)
                            .accessibilityHidden(true)
                    }
                    .adaptiveSoftScrollEdges()
                    .simultaneousGesture(
                        TapGesture().onEnded {
                            guard clarificationPrompt == nil else { return }
                            onDismissKeyboard()
                        }
                    )
                }
                .background(Color(.systemBackground))
                .onChange(of: messages.count) {
                    guard isFollowingLatestContent else { return }

                    if latestTranscriptMessageRole == "user" {
                        releasingHold { onScrollToLatestTranscriptMessage(proxy) }
                    } else {
                        releasingHold { onScrollToLatestContent(proxy, true) }
                    }
                }
                .onChange(of: scrollToBottomRequest) {
                    releasingHold { onScrollToBottom(proxy) }
                }
                .onChange(of: streamingScrollTrigger) {
                    if isFollowingLatestContent {
                        releasingHold { onScrollToLatestContent(proxy, true) }
                    }
                }
                .onChange(of: cacheFirstReconcileScrollToken) {
                    // Cache-first reconcile (#289): the server transcript just replaced
                    // the lighter cached render, so snap back to the bottom (no
                    // animation) unless the reader has scrolled away in the meantime.
                    guard isFollowingLatestContent else { return }
                    releasingHold { onScrollToLatestContent(proxy, false) }
                }
                .onChange(of: clarificationPrompt?.id) {
                    guard clarificationPrompt != nil, isFollowingLatestContent else { return }
                    releasingHold { onScrollToBottom(proxy) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    // The keyboard shrinks the viewport, so keep a following
                    // reader on the latest content. `isScrolledNearBottom` alone
                    // is too loose: its 80/160pt band still covers a reader who
                    // deliberately nudged up, and scrolling for them would reset
                    // the latch they just set.
                    if isFollowingLatestContent, isScrolledNearBottom {
                        releasingHold { onScrollToBottom(proxy) }
                    }
                }
            }
        }
    }

    /// Follow-driven scrolls run only while the latch is on and no disclosure
    /// toggle is mid-animation.
    private var isFollowingLatestContent: Bool {
        shouldFollowLatestMessage && !isDisclosureSettling
    }

    /// Identifies the whole transcript content so a scroll to its top can be
    /// expressed through SwiftUI.
    private var transcriptContentID: String { "chat-transcript-content" }

    /// A tapped row is about to grow or shrink. Pin the reader to that row's top
    /// so a default anchor SwiftUI re-applies on the size change (seen at the
    /// exact top after a status-bar scroll) cannot move them. If the pin had to
    /// undo SwiftUI, finish with a SwiftUI-driven scroll to the same place so
    /// its own offset model, and hit-testing of the visible rows, catch up.
    private func pinReaderForDisclosure(proxy: ScrollViewProxy, anchorRowID: String?) {
        scrollPositionController.holdPosition(anchorRowID: anchorRowID) {
            proxy.scrollTo(transcriptContentID, anchor: .top)
        }
        onDisclosureToggle()
    }

    /// Reports the row's content-space top so position preservation can tell
    /// growth above it from growth below, and pins on this row when one of its
    /// disclosures toggles.
    private func positionAnchoredRow(_ row: some View, id: String, proxy: ScrollViewProxy) -> some View {
        row
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(transcriptContentID)).minY } action: {
                scrollPositionController.recordRowMinY($0, for: id)
            }
            .onDisappear { scrollPositionController.forgetRow(id) }
            .environment(\.chatDisclosureToggled) {
                pinReaderForDisclosure(proxy: proxy, anchorRowID: id)
            }
    }

    /// Deliberate scrolls end a disclosure pin first. The pin exists only to
    /// stop SwiftUI moving the reader on its own after a toggle.
    private func releasingHold(_ scroll: () -> Void) {
        scrollPositionController.releaseHold()
        scroll()
    }

    private func transcriptScrollContent(
        proxy: ScrollViewProxy,
        viewportWidth: CGFloat,
        contentWidth: CGFloat
    ) -> some View {
        VStack(spacing: transcriptMessageSpacing) {
            olderMessagesButton(proxy: proxy)

            if let compressionReferenceCard, compressionReferenceCard.afterRenderID == nil {
                compressionReferenceCardView(compressionReferenceCard, proxy: proxy)
            }

            ForEach(Array(displayedTranscriptMessages.enumerated()), id: \.element.id) { index, transcriptMessage in
                // Scope live-streaming state to the row that actually displays it.
                // Non-anchor / non-streaming rows receive stable empty/nil values so
                // their inputs don't change on every ~16ms flush; combined with the
                // `.equatable()` wrapper below, SwiftUI then skips re-evaluating their
                // (markdown-heavy) bodies while a response streams in.
                let activityAnchorIDs = transcriptMessage.assistantSegments.map(\.anchorID)
                let isReasoningAnchor = reasoningAnchorMessageID.map(activityAnchorIDs.contains) ?? false
                let isToolCallAnchor = toolCallAnchorMessageID.map(activityAnchorIDs.contains) ?? false
                let isStreamingRow = streamingAssistantMessageID != nil
                    && transcriptMessage.message.messageId == streamingAssistantMessageID
                let isSyntheticSteeringNeighbor = transcriptMessage.message.activityScene == nil && (
                    (index > 0 && displayedTranscriptMessages[index - 1].message.isLocalSteeringHint)
                    || (index + 1 < displayedTranscriptMessages.count && displayedTranscriptMessages[index + 1].message.isLocalSteeringHint)
                )

                let row = ChatTranscriptMessageBlock(
                    transcriptMessage: transcriptMessage,
                    transcriptBlockSpacing: transcriptBlockSpacing,
                    showsThinkingAndToolCards: showsThinkingAndToolCards,
                    archivedActivityRows: activityAnchorIDs.flatMap(archivedActivityRowsForAnchor),
                    earlierSceneRows: earlierSceneRowsForTurn(transcriptMessage),
                    liveActivityRows: (isReasoningAnchor || isToolCallAnchor || isStreamingRow) ? liveActivityRows : [],
                    streamingAssistantMessageID: isStreamingRow ? streamingAssistantMessageID : nil,
                    liveTokensPerSecond: isStreamingRow ? liveTokensPerSecond : nil,
                    localAttachmentPreviews: localAttachmentPreviews[transcriptMessage.message.id],
                    listeningMessageID: listeningMessageID,
                    isViewingCachedData: isViewingCachedData,
                    isSessionReadOnly: isSessionReadOnly,
                    canBranch: canBranch,
                    hasActiveStream: activeStreamID != nil,
                    isRegeneratingMessage: isRegeneratingMessage,
                    isEditingMessage: isEditingMessage,
                    isForkingMessage: isForkingMessage,
                    disablesHistoryActions: isSyntheticSteeringNeighbor,
                    loadAttachmentImage: loadAttachmentImage,
                    loadAttachmentData: loadAttachmentData,
                    loadTranscriptMediaImage: loadTranscriptMediaImage,
                    loadTranscriptMediaData: loadTranscriptMediaData,
                    transcriptMediaCacheNamespace: transcriptMediaCacheNamespace,
                    actionContext: actionContext,
                    shouldRenderMessageRow: shouldRenderMessageRow,
                    onPreviewAttachment: onPreviewAttachment,
                    onPreviewTranscriptMedia: onPreviewTranscriptMedia,
                    onToggleListening: onToggleListening,
                    onSelectText: onSelectText,
                    onRegenerate: onRegenerate,
                    onEdit: onEdit,
                    onFork: onFork,
                    onCopy: onCopy,
                    onLoadEarlierSceneRows: { onLoadEarlierSceneRows(transcriptMessage) }
                )
                .equatable()

                positionAnchoredRow(row, id: transcriptMessage.renderID, proxy: proxy)
                    .id(transcriptMessage.renderID)

                if let compressionReferenceCard,
                   compressionReferenceCard.afterRenderID == transcriptMessage.renderID {
                    compressionReferenceCardView(compressionReferenceCard, proxy: proxy)
                }
            }

            transcriptLooseBlocks
            liveResponseBlocks
            typingIndicator
            turnChangesCard
            inlineCommitButton

            Color.clear
                .frame(height: 1)
                .id(bottomAnchorID)
                .allowsHitTesting(false)
        }
        .coordinateSpace(.named(transcriptContentID))
        .padding(.top, 16)
        .frame(width: contentWidth, alignment: .leading)
        .padding(.horizontal, transcriptHorizontalPadding)
        // Centres the readable column; the scroll view stays full width.
        .frame(width: viewportWidth)
        .clipped()
        .environment(\.chatDisclosureToggled) {
            pinReaderForDisclosure(proxy: proxy, anchorRowID: nil)
        }
        .id(transcriptContentID)
        .environment(\.chatMessageMenuRegistry, menuRegistry)
        .background {
            ZStack {
                ChatScrollObserver(
                    isStreaming: activeStreamID != nil,
                    scrollPositionController: scrollPositionController,
                    onFollowEvent: onFollowEvent
                ) { metrics in
                    onUpdateScrollMetrics(metrics)
                }

                ChatVerticalScrollAxisGuard()
                ChatMessageMenuHost(registry: menuRegistry)
            }
            .accessibilityHidden(true)
        }
    }

    private func compressionReferenceCardView(_ card: CompressionReferenceCard, proxy: ScrollViewProxy) -> some View {
        positionAnchoredRow(
            MarkerMessageCardView(kind: .compressionReference, content: card.referenceText),
            id: "compression-reference",
            proxy: proxy
        )
    }

    private var transcriptHorizontalPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 16
    }

    private func transcriptContentWidth(for viewportWidth: CGFloat) -> CGFloat {
        let columnWidth = min(viewportWidth, AdaptiveReadableContentWidth.chat)
        return max(0, columnWidth - (transcriptHorizontalPadding * 2))
    }

    @ViewBuilder
    private func olderMessagesButton(proxy: ScrollViewProxy) -> some View {
        if hasOlderMessages {
            LoadOlderMessagesButton(isLoading: isLoadingOlderMessages) {
                Task { await loadOlderMessagesPreservingPosition(proxy: proxy) }
            }
        }
    }

    private func loadOlderMessagesPreservingPosition(proxy: ScrollViewProxy) async {
        let renderID = displayedTranscriptMessages.first?.renderID
        let capturedExactPosition = scrollPositionController.capture(anchorRowID: renderID)
        let didLoad = await onLoadOlderMessages()
        guard didLoad else {
            scrollPositionController.cancelPreservation()
            return
        }

        if capturedExactPosition,
           scrollPositionController.restoreAfterPrepend() {
            return
        }

        guard let renderID else { return }

        await Task.yield()
        proxy.scrollTo(renderID, anchor: .top)
    }

    @ViewBuilder
    private var transcriptLooseBlocks: some View {
        reasoningBlocks(anchorMessageID: nil)
        toolCallGroups(anchorMessageID: nil)
    }

    @ViewBuilder
    private var liveResponseBlocks: some View {
        if activeStreamID != nil {
            if showsThinkingAndToolCards {
                if hasLiveReasoningText,
                   !hasDisplayedTranscriptMessage(anchorID: reasoningAnchorMessageID) {
                    ReasoningBlockView(text: liveReasoningText, isActive: true)
                }

                if !liveToolCalls.isEmpty,
                   !hasDisplayedTranscriptMessage(anchorID: toolCallAnchorMessageID) {
                    ToolActivityGroupView(
                        group: ToolCallGroup.live(
                            anchorMessageID: toolCallAnchorMessageID,
                            toolCalls: liveToolCalls
                        )
                    )
                }
            }
        } else if showsRunStateCheck {
            StatusChip(ChatActiveRunStatusPresentation(kind: .checking), agentName: assistantName)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
        }
    }

    @ViewBuilder
    private var typingIndicator: some View {
        if showsAssistantTypingIndicator {
            AssistantTypingIndicatorView()
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHidden(hidesRunStatusAccessibility)
        }
    }

    @ViewBuilder
    private var turnChangesCard: some View {
        if let summary = turnChangesSummary {
            GitTurnChangesCard(
                summary: summary,
                onOpenAll: onOpenTurnDiff,
                onOpenFile: onOpenTurnFileDiff
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var inlineCommitButton: some View {
        if let context = inlineCommitContext {
            GitInlineCommitButton(
                runningPhase: context.runningPhase,
                isDisabled: context.isDisabled,
                action: onInlineCommit
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
        }
    }

    private var hasLiveReasoningText: Bool {
        !liveReasoningText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func hasDisplayedTranscriptMessage(anchorID: String?) -> Bool {
        guard let anchorID else { return false }

        return displayedTranscriptMessages.contains { $0.anchorID == anchorID }
    }

    @ViewBuilder
    private func reasoningBlocks(anchorMessageID: String?) -> some View {
        if showsThinkingAndToolCards {
            ForEach(reasoningGroups.filter { $0.anchorMessageID == anchorMessageID }) { group in
                ReasoningBlockView(text: group.text, titles: group.titles)
            }
        }
    }

    @ViewBuilder
    private func toolCallGroups(anchorMessageID: String?) -> some View {
        if showsThinkingAndToolCards {
            ForEach(completedToolCallGroupsForAnchor(anchorMessageID)) { group in
                ToolActivityGroupView(group: group)
            }
        }
    }
}
