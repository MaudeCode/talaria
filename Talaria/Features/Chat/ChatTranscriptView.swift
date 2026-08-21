import SwiftUI
import UIKit

struct ChatTranscriptView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let isLoading: Bool
    let errorMessage: String?
    let messages: [ChatMessage]
    let displayedTranscriptMessages: [TranscriptMessage]
    let compressionReferenceCard: CompressionReferenceCard?
    let reasoningGroups: [ReasoningGroup]
    let completedToolCallGroupsForAnchor: (String?) -> [ToolCallGroup]
    let archivedActivityRowsForAnchor: (String?) -> [AssistantActivityRow]
    let liveReasoningText: String
    let liveActivityRows: [AssistantActivityRow]
    let reasoningAnchorMessageID: String?
    let liveToolCalls: [ToolCall]
    let toolCallAnchorMessageID: String?
    let streamingAssistantMessageID: String?
    let liveTokensPerSecond: Double?
    let activeStreamRecoveryState: ActiveStreamRecoveryState
    let clarificationPrompt: ClarificationPromptState?
    let isRespondingToClarification: Bool
    let clarificationErrorMessage: String?
    let hidesRunStatusAccessibility: Bool
    let showsThinkingAndToolCards: Bool
    let showsAssistantTypingIndicator: Bool
    let showsScrollToBottomButton: Bool
    let shouldFollowLatestMessage: Bool
    let latestTranscriptMessageRole: String?
    let isScrolledNearBottom: Bool
    let activeStreamID: String?
    let streamingScrollTrigger: Int
    let cacheFirstReconcileScrollToken: Int
    let bottomAnchorID: String
    let transcriptMessageSpacing: CGFloat
    let transcriptBlockSpacing: CGFloat
    let transcriptBottomInsetHeight: CGFloat
    let scrollToBottomButtonBottomPadding: CGFloat
    let localAttachmentPreviews: [String: [String: Data]]
    let listeningMessageID: String?
    let isViewingCachedData: Bool
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
    let onDismissKeyboard: () -> Void
    let onScrollToBottom: (ScrollViewProxy) -> Void
    let onScrollToLatestTranscriptMessage: (ScrollViewProxy) -> Void
    let onScrollToLatestContent: (ScrollViewProxy, Bool) -> Void
    let onPreviewAttachment: (MessageAttachment, Data?) -> Void
    let onPreviewTranscriptMedia: (TranscriptMediaReference) -> Void
    let onToggleListening: (MessageActionContext) -> Void
    let onSubmitClarification: (String) -> Void
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
                            shouldFollowLatestMessage: shouldFollowLatestMessage
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

                    if showsScrollToBottomButton {
                        ChatScrollToBottomButton(
                            bottomPadding: scrollToBottomButtonBottomPadding,
                            onTap: {
                                onScrollToBottom(proxy)
                            }
                        )
                        .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
                    }
                }
                .animation(ChatMotion.quickState(reduceMotion: reduceMotion), value: showsScrollToBottomButton)
                .background(Color(.systemBackground))
                .onChange(of: messages.count) {
                    guard shouldFollowLatestMessage else { return }

                    if latestTranscriptMessageRole == "user" {
                        onScrollToLatestTranscriptMessage(proxy)
                    } else {
                        onScrollToLatestContent(proxy, true)
                    }
                }
                .onChange(of: streamingScrollTrigger) {
                    if shouldFollowLatestMessage {
                        onScrollToLatestContent(proxy, true)
                    }
                }
                .onChange(of: cacheFirstReconcileScrollToken) {
                    // Cache-first reconcile (#289): the server transcript just replaced
                    // the lighter cached render, so snap back to the bottom (no
                    // animation) unless the reader has scrolled away in the meantime.
                    guard shouldFollowLatestMessage else { return }
                    onScrollToLatestContent(proxy, false)
                }
                .onChange(of: clarificationPrompt?.id) {
                    guard clarificationPrompt != nil, shouldFollowLatestMessage else { return }
                    onScrollToBottom(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    if isScrolledNearBottom {
                        onScrollToBottom(proxy)
                    }
                }
            }
        }
    }

    private func transcriptScrollContent(
        proxy: ScrollViewProxy,
        viewportWidth: CGFloat,
        contentWidth: CGFloat
    ) -> some View {
        VStack(spacing: transcriptMessageSpacing) {
            olderMessagesButton(proxy: proxy)

            if let compressionReferenceCard, compressionReferenceCard.afterRenderID == nil {
                compressionReferenceCardView(compressionReferenceCard)
            }

            ForEach(displayedTranscriptMessages) { transcriptMessage in
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

                ChatTranscriptMessageBlock(
                    transcriptMessage: transcriptMessage,
                    transcriptBlockSpacing: transcriptBlockSpacing,
                    showsThinkingAndToolCards: showsThinkingAndToolCards,
                    reasoningGroups: reasoningGroups,
                    toolCallGroups: activityAnchorIDs.flatMap(completedToolCallGroupsForAnchor),
                    archivedActivityRows: activityAnchorIDs.flatMap(archivedActivityRowsForAnchor),
                    liveActivityRows: (isReasoningAnchor || isToolCallAnchor || isStreamingRow) ? liveActivityRows : [],
                    streamingAssistantMessageID: isStreamingRow ? streamingAssistantMessageID : nil,
                    liveTokensPerSecond: isStreamingRow ? liveTokensPerSecond : nil,
                    localAttachmentPreviews: localAttachmentPreviews[transcriptMessage.message.id],
                    listeningMessageID: listeningMessageID,
                    isViewingCachedData: isViewingCachedData,
                    hasActiveStream: activeStreamID != nil,
                    isRegeneratingMessage: isRegeneratingMessage,
                    isEditingMessage: isEditingMessage,
                    isForkingMessage: isForkingMessage,
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
                    onCopy: onCopy
                )
                .equatable()
                .id(transcriptMessage.renderID)

                if let compressionReferenceCard,
                   compressionReferenceCard.afterRenderID == transcriptMessage.renderID {
                    compressionReferenceCardView(compressionReferenceCard)
                }
            }

            transcriptLooseBlocks
            liveResponseBlocks
            inlineClarificationCard
            typingIndicator
            turnChangesCard
            inlineCommitButton

            Color.clear
                .frame(height: 1)
                .id(bottomAnchorID)
                .allowsHitTesting(false)
        }
        .padding(.top, 16)
        .frame(width: contentWidth, alignment: .leading)
        .padding(.horizontal, transcriptHorizontalPadding)
        .frame(width: viewportWidth, alignment: .leading)
        .clipped()
        .background {
            ZStack {
                ChatScrollObserver(isStreaming: activeStreamID != nil) { metrics in
                    onUpdateScrollMetrics(metrics)
                }

                ChatVerticalScrollAxisGuard()
            }
            .accessibilityHidden(true)
        }
    }

    private func compressionReferenceCardView(_ card: CompressionReferenceCard) -> some View {
        MarkerMessageCardView(kind: .compressionReference, content: card.referenceText)
    }

    private var transcriptHorizontalPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 16
    }

    private func transcriptContentWidth(for viewportWidth: CGFloat) -> CGFloat {
        max(0, viewportWidth - (transcriptHorizontalPadding * 2))
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
        let didLoad = await onLoadOlderMessages()
        guard didLoad, let renderID else { return }

        await Task.yield()
        if reduceMotion {
            proxy.scrollTo(renderID, anchor: .top)
        } else {
            withAnimation(ChatMotion.quickState(reduceMotion: reduceMotion)) {
                proxy.scrollTo(renderID, anchor: .top)
            }
        }
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

            if activeStreamRecoveryState != .idle {
                StreamRecoveryStatusView(state: activeStreamRecoveryState)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(hidesRunStatusAccessibility)
                    .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
            }
        }
    }

    @ViewBuilder
    private var inlineClarificationCard: some View {
        if let clarificationPrompt {
            ClarificationRequestCard(
                prompt: clarificationPrompt,
                isResponding: isRespondingToClarification,
                errorMessage: clarificationErrorMessage,
                onSubmit: onSubmitClarification
            )
            .id(clarificationPrompt.id)
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

private struct ChatTranscriptMessageBlock: View, Equatable {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expandedCompletedActivityIDs = Set<String>()

    let transcriptMessage: TranscriptMessage
    let transcriptBlockSpacing: CGFloat
    let showsThinkingAndToolCards: Bool
    let reasoningGroups: [ReasoningGroup]
    let toolCallGroups: [ToolCallGroup]
    let archivedActivityRows: [AssistantActivityRow]
    let liveActivityRows: [AssistantActivityRow]
    let streamingAssistantMessageID: String?
    let liveTokensPerSecond: Double?
    let localAttachmentPreviews: [String: Data]?
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let hasActiveStream: Bool
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
    let onPreviewAttachment: (MessageAttachment, Data?) -> Void
    let onPreviewTranscriptMedia: (TranscriptMediaReference) -> Void
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void

    // Equality over the value inputs only. The closures are pure functions of
    // these values (e.g. `actionContext` is fully determined by
    // `transcriptMessage`), so two blocks that compare equal render identically.
    // This lets `.equatable()` skip re-evaluating rows whose data is unchanged
    // even though their closure props are recreated on every parent body pass.
    static func == (lhs: ChatTranscriptMessageBlock, rhs: ChatTranscriptMessageBlock) -> Bool {
        lhs.transcriptMessage == rhs.transcriptMessage &&
            lhs.transcriptBlockSpacing == rhs.transcriptBlockSpacing &&
            lhs.showsThinkingAndToolCards == rhs.showsThinkingAndToolCards &&
            lhs.reasoningGroups == rhs.reasoningGroups &&
            lhs.toolCallGroups == rhs.toolCallGroups &&
            lhs.archivedActivityRows == rhs.archivedActivityRows &&
            lhs.liveActivityRows == rhs.liveActivityRows &&
            lhs.streamingAssistantMessageID == rhs.streamingAssistantMessageID &&
            lhs.liveTokensPerSecond == rhs.liveTokensPerSecond &&
            lhs.localAttachmentPreviews == rhs.localAttachmentPreviews &&
            lhs.listeningMessageID == rhs.listeningMessageID &&
            lhs.isViewingCachedData == rhs.isViewingCachedData &&
            lhs.hasActiveStream == rhs.hasActiveStream &&
            lhs.isRegeneratingMessage == rhs.isRegeneratingMessage &&
            lhs.isEditingMessage == rhs.isEditingMessage &&
            lhs.isForkingMessage == rhs.isForkingMessage &&
            lhs.transcriptMediaCacheNamespace == rhs.transcriptMediaCacheNamespace
    }

    var body: some View {
        VStack(alignment: .leading, spacing: transcriptBlockSpacing) {
            if transcriptMessage.message.role == "assistant", !activityRows.isEmpty {
                if let turn = CompletedAssistantTurn(rows: activityRows) {
                    if liveActivityRows.isEmpty {
                        completedRun(turn)
                    } else {
                        activityTimeline(turn.segments, activeSegmentID: turn.segments.last?.id)
                    }
                } else {
                    ForEach(Array(activityRows.enumerated()), id: \.element.id) { index, row in
                        activityRow(row, at: index)
                    }
                }
            } else {
                messageRow(transcriptMessage.message)
            }
        }
    }

    private var activityRows: [AssistantActivityRow] {
        if !liveActivityRows.isEmpty {
            return liveActivityRows
        }
        if let authoritativeScene = AssistantActivityTimeline.authoritativeScene(
            message: transcriptMessage.message
        ) {
            return authoritativeScene.rows
        }
        if !archivedActivityRows.isEmpty {
            return archivedActivityRows
        }
        let persisted = AssistantActivityTimeline.persisted(
            assistantSegments: transcriptMessage.assistantSegments,
            reasoningGroups: reasoningGroups,
            toolCallGroups: toolCallGroups
        ).rows
        return persisted
    }

    @ViewBuilder
    private func completedRun(_ turn: CompletedAssistantTurn) -> some View {
        let disclosureID = "worked:\(transcriptMessage.anchorID)"
        let isExpanded = expandedCompletedActivityIDs.contains(disclosureID)
        let title = AssistantWorkSummary.title(duration: transcriptMessage.message.turnDuration)

        Button {
            withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                if isExpanded {
                    expandedCompletedActivityIDs.remove(disclosureID)
                } else {
                    expandedCompletedActivityIDs.insert(disclosureID)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Text(title)
                    .font(AppFont.body())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 4)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Divider()
                .opacity(0.35)
        }
        .accessibilityLabel(title)
        .accessibilityHint(isExpanded ? "Double tap to collapse work." : "Double tap to expand work.")

        if isExpanded {
            activityTimeline(turn.workSegments, activeSegmentID: nil)
                .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
        }

        if !turn.finalAnswer.isEmpty {
            messageRow(
                activityMessage(
                    text: turn.finalAnswer,
                    includesAttachments: true,
                    includesTurnMetrics: true
                ),
                isStreaming: false
            )
        }
    }

    @ViewBuilder
    private func activityTimeline(
        _ segments: [CompletedAssistantTurn.Segment],
        activeSegmentID: String?
    ) -> some View {
        VStack(alignment: .leading, spacing: transcriptBlockSpacing) {
            ForEach(segments) { segment in
                switch segment.content {
                case .activity(let rows):
                    let visibleRows = rows.filter(isVisibleWorkRow)
                    if !visibleRows.isEmpty {
                        let disclosureID = "\(activeSegmentID == nil ? "completed" : "live"):\(segment.id)"
                        let isExpanded = expandedCompletedActivityIDs.contains(disclosureID)
                        let isActive = activeSegmentID == segment.id
                        let title = AssistantActivityHeaderSummary.title(for: visibleRows, isActive: isActive)
                        let titles = AssistantActivityHeaderSummary.titles(for: visibleRows, isActive: isActive)
                        VStack(alignment: .leading, spacing: 0) {
                            Button {
                                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                                    if isExpanded {
                                        expandedCompletedActivityIDs.remove(disclosureID)
                                    } else {
                                        expandedCompletedActivityIDs.insert(disclosureID)
                                    }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: activityIcon(for: visibleRows))
                                        .font(.system(size: 14))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 16, height: 16)

                                    RotatingActivityTitle(
                                        fallback: title,
                                        titles: titles,
                                        isActive: isActive
                                    )
                                    .font(AppFont.callout())
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .multilineTextAlignment(.leading)

                                    Spacer(minLength: 4)

                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(String(localized: "\(isActive ? "Active" : "Completed") activity, \(titles.last ?? title)"))
                            .accessibilityHint(isExpanded ? "Double tap to collapse work." : "Double tap to expand work.")

                            if isExpanded {
                                ForEach(Array(visibleRows.enumerated()), id: \.element.id) { index, row in
                                    activityRow(
                                        row,
                                        at: index,
                                        includesAttachments: false,
                                        includesTurnMetrics: false,
                                        isActive: isActive && index == visibleRows.count - 1
                                    )
                                }
                                .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .prose(let text):
                    messageRow(
                        activityMessage(
                            text: text,
                            includesAttachments: false,
                            includesTurnMetrics: false
                        ),
                        isStreaming: activeSegmentID == segment.id
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func activityRow(
        _ row: AssistantActivityRow,
        at index: Int,
        includesAttachments: Bool? = nil,
        includesTurnMetrics: Bool? = nil,
        isActive: Bool? = nil
    ) -> some View {
        switch row.content {
        case .prose(let text):
            messageRow(
                activityMessage(
                    text: text,
                    includesAttachments: includesAttachments ?? (index == firstProseIndex),
                    includesTurnMetrics: includesTurnMetrics ?? (index == lastProseIndex)
                ),
                isStreaming: liveActivityRows.isEmpty ? nil : index == lastProseIndex
            )
        case .reasoning(let reasoning):
            if showsThinkingAndToolCards {
                ReasoningBlockView(
                    text: reasoning.text,
                    titles: reasoning.titles,
                    isActive: isActive ?? (!liveActivityRows.isEmpty && index == activityRows.count - 1)
                )
            }
        case .tools(let toolCalls):
            if showsThinkingAndToolCards {
                ToolActivityGroupView(group: ToolCallGroup(
                    id: row.id,
                    anchorMessageID: transcriptMessage.anchorID,
                    toolCalls: toolCalls
                ))
            }
        }
    }

    private func isVisibleWorkRow(_ row: AssistantActivityRow) -> Bool {
        switch row.content {
        case .prose:
            true
        case .reasoning, .tools:
            showsThinkingAndToolCards
        }
    }

    private func activityIcon(for rows: [AssistantActivityRow]) -> String {
        let tools = rows.flatMap(\.toolCalls)
        return tools.isEmpty ? "brain" : AssistantActivitySummary.icon(for: tools)
    }

    @ViewBuilder
    private func messageRow(_ message: ChatMessage, isStreaming: Bool? = nil) -> some View {
        if shouldRenderMessageRow(message) {
            ChatTranscriptMessageRow(
                message: message,
                visibleIndex: transcriptMessage.loadedIndex,
                actionContext: actionContext(message, transcriptMessage.loadedIndex),
                localAttachmentPreviews: localAttachmentPreviews,
                listeningMessageID: listeningMessageID,
                isViewingCachedData: isViewingCachedData,
                hasActiveStream: hasActiveStream,
                isStreaming: isStreaming ?? ChatTranscriptDisplaySettings.shouldUseStreamingBubbleRendering(
                    hasActiveStream: hasActiveStream,
                    messageRole: message.role,
                    messageID: message.messageId,
                    streamingAssistantMessageID: streamingAssistantMessageID
                ),
                liveTokensPerSecond: isStreaming == false ? nil : liveTokensPerSecond,
                isRegeneratingMessage: isRegeneratingMessage,
                isEditingMessage: isEditingMessage,
                isForkingMessage: isForkingMessage,
                loadAttachmentImage: loadAttachmentImage,
                loadAttachmentData: loadAttachmentData,
                loadTranscriptMediaImage: loadTranscriptMediaImage,
                loadTranscriptMediaData: loadTranscriptMediaData,
                transcriptMediaCacheNamespace: transcriptMediaCacheNamespace,
                onPreviewAttachment: onPreviewAttachment,
                onPreviewTranscriptMedia: onPreviewTranscriptMedia,
                onToggleListening: onToggleListening,
                onSelectText: onSelectText,
                onRegenerate: onRegenerate,
                onEdit: onEdit,
                onFork: onFork,
                onCopy: onCopy
            )
        }
    }

    private var firstProseIndex: Int? {
        activityRows.firstIndex { row in
            if case .prose = row.content { return true }
            return false
        }
    }

    private var lastProseIndex: Int? {
        activityRows.lastIndex { row in
            if case .prose = row.content { return true }
            return false
        }
    }

    private func activityMessage(
        text: String,
        includesAttachments: Bool,
        includesTurnMetrics: Bool
    ) -> ChatMessage {
        let message = transcriptMessage.message
        return ChatMessage(
            role: message.role,
            content: text,
            timestamp: includesTurnMetrics ? message.timestamp : nil,
            messageId: message.messageId,
            name: message.name,
            toolCallId: message.toolCallId,
            toolUseId: message.toolUseId,
            attachments: includesAttachments ? message.attachments : nil,
            turnDuration: includesTurnMetrics ? message.turnDuration : nil,
            turnTps: includesTurnMetrics ? message.turnTps : nil
        )
    }
}

private struct ChatTranscriptMessageRow: View {
    let message: ChatMessage
    let visibleIndex: Int
    let actionContext: MessageActionContext?
    let localAttachmentPreviews: [String: Data]?
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let hasActiveStream: Bool
    let isStreaming: Bool
    let liveTokensPerSecond: Double?
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let loadAttachmentImage: (String) async -> Data?
    let loadAttachmentData: (String) async -> Data?
    let loadTranscriptMediaImage: (TranscriptMediaReference) async -> Data?
    let loadTranscriptMediaData: (TranscriptMediaReference) async -> Data?
    let transcriptMediaCacheNamespace: String
    let onPreviewAttachment: (MessageAttachment, Data?) -> Void
    let onPreviewTranscriptMedia: (TranscriptMediaReference) -> Void
    let onToggleListening: (MessageActionContext) -> Void
    let onSelectText: (MessageActionContext) -> Void
    let onRegenerate: (MessageActionContext) -> Void
    let onEdit: (MessageActionContext) -> Void
    let onFork: (MessageActionContext) -> Void
    let onCopy: (MessageActionContext) -> Void

    var body: some View {
        // Compaction marker messages render as collapsible cards (matching the
        // web UI), never as user bubbles — and without bubble actions, which
        // don't apply to system-emitted markers.
        if let markerKind = ChatMarkerMessageClassifier.classify(message) {
            MarkerMessageCardView(kind: markerKind, content: message.content)
        } else if let actionContext {
            bubble
                .contextMenu {
                    ChatMessageActionMenu(
                        context: actionContext,
                        listeningMessageID: listeningMessageID,
                        isViewingCachedData: isViewingCachedData,
                        hasActiveStream: hasActiveStream,
                        isRegeneratingMessage: isRegeneratingMessage,
                        isEditingMessage: isEditingMessage,
                        isForkingMessage: isForkingMessage,
                        onToggleListening: onToggleListening,
                        onSelectText: onSelectText,
                        onRegenerate: onRegenerate,
                        onEdit: onEdit,
                        onFork: onFork,
                        onCopy: onCopy
                    )
                }
        } else {
            bubble
        }
    }

    private var bubble: some View {
        MessageBubbleView(
            message: message,
            loadAttachmentImage: loadAttachmentImage,
            loadAttachmentData: loadAttachmentData,
            loadTranscriptMediaImage: loadTranscriptMediaImage,
            loadTranscriptMediaData: loadTranscriptMediaData,
            transcriptMediaCacheNamespace: transcriptMediaCacheNamespace,
            localAttachmentPreviews: localAttachmentPreviews,
            onPreviewAttachment: onPreviewAttachment,
            onPreviewTranscriptMedia: onPreviewTranscriptMedia,
            isStreaming: isStreaming,
            liveTokensPerSecond: liveTokensPerSecond
        )
    }
}

private struct ChatScrollToBottomButton: View {
    @Environment(\.colorScheme) private var colorScheme

    let bottomPadding: CGFloat
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 32, height: 32)
                .foregroundStyle(.primary)
                .adaptiveGlass(
                    .regular,
                    isInteractive: true,
                    fallbackMaterial: .regularMaterial,
                    in: Circle()
                )
                .chatMinimumHitTarget(in: Circle())
        }
        .buttonStyle(.chatTactile(
            .icon,
            shadow: ChatTactileButtonStyle.Shadow(
                color: .black,
                opacity: colorScheme == .dark ? 0.32 : 0.16,
                radius: 8,
                y: 4,
                pressedOpacity: colorScheme == .dark ? 0.18 : 0.08,
                pressedRadius: 3,
                pressedY: 2
            )
        ))
        .padding(.bottom, bottomPadding)
        .accessibilityLabel("Scroll to latest message")
    }
}

private struct LoadOlderMessagesButton: View {
    let isLoading: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.caption.weight(.semibold))
                        .accessibilityHidden(true)
                }

                Text(isLoading ? String(localized: "Loading older messages") : String(localized: "Load older messages"))
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.88)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(Color(.separator).opacity(0.32), lineWidth: 0.5)
            )
        }
        .buttonStyle(.chatTactile(.capsule))
        .disabled(isLoading)
        .frame(maxWidth: .infinity)
        .accessibilityLabel(isLoading ? String(localized: "Loading older messages") : String(localized: "Load older messages"))
    }
}
