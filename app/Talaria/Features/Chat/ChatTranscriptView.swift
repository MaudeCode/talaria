import SwiftUI
import UIKit
import TalariaKit

/// Extends ScrollViewProxy with destination mounting before an ID navigation.
@MainActor
struct ChatTranscriptScrollProxy {
    let perform: (String, UnitPoint, Animation?) -> Void

    func scrollTo(id: String, anchor: UnitPoint, animation: Animation? = nil) {
        perform(id, anchor, animation)
    }
}

struct ChatTranscriptView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL
    @State private var scrollPositionController = ChatScrollPositionController(usesLazyLayout: true)
    @State private var initialScrollAnchor: UnitPoint? = .bottom
    @State private var didRestoreReadingRow = false
    @State private var nativeScrollRevision = 0
    @State private var scrollDestination: (id: String, anchor: UnitPoint, animation: Animation?)?
    @State private var scrollDestinationNeedsMount = false
    @State private var readyScrollRevision: Int?
    @State private var ownRowCache = ChatTranscriptRowCache()
    @State private var rowViewportTop: CGFloat = 0
    @State private var rowOriginY: CGFloat = 0
    @State private var pinnedRowIDs = Set<String>()
    @State private var isAdmittingHistory = false
    @State private var isHistoryNearTop = false
    @State private var historyLayoutRevision = 0
    /// Owns the transcript's message long press: one handler for every row,
    /// which is what lets a press be resolved against link geometry first.
    @State private var menuRegistry = ChatMessageMenuRegistry()

    let isLoading: Bool
    let errorMessage: String?
    let messages: [ChatMessage]
    let displayedTranscriptMessages: [TranscriptMessage]
    let compressionReferenceCard: CompressionReferenceCard?
    let branchedFrom: SessionBranchLink?
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
    let showsThinkingAndToolCards: Bool
    let shouldFollowLatestMessage: Bool
    /// True while a disclosure toggle animates; suspends the bottom size-change
    /// anchor and follow-driven scrolls so the tapped row stays stationary.
    let isDisclosureSettling: Bool
    let latestTranscriptMessageRole: String?
    let isScrolledNearBottom: Bool
    let activeStreamID: String?
    let streamingScrollTrigger: Int
    let cacheFirstReconcileScrollToken: Int
    let transcriptMessageSpacing: CGFloat
    let transcriptBlockSpacing: CGFloat
    let transcriptBottomInsetHeight: CGFloat
    /// Bumped by the scroll-to-latest chip above the composer.
    let scrollToBottomRequest: Int
    /// Bumped when a follow blocked by a settling disclosure is due.
    let followReplayRequest: Int
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
    let onLoadOlderMessages: (@MainActor () -> Void) async -> Bool
    let onUpdateScrollMetrics: (ChatScrollMetrics) -> Void
    let onFollowEvent: (ChatScrollPolicy.FollowEvent) -> Void
    let onDisclosureToggle: () -> (() -> Void)
    /// Reports an automatic follow skipped by the guard, so one blocked only by
    /// a settling disclosure replays when the suspension ends.
    let onFollowSuppressed: () -> Void
    let onDismissKeyboard: () -> Void
    let onScrollToBottom: (ChatTranscriptScrollProxy) -> Void
    let onScrollToLatestTranscriptMessage: (ChatTranscriptScrollProxy) -> Void
    let onScrollToLatestContent: (ChatTranscriptScrollProxy, Bool) -> Void
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
    /// Row state the session list keeps across a navigation rebuild, such as expanded disclosures (TAL-1477).
    var retainedRowCache: ChatTranscriptRowCache? = nil
    /// The row to reopen at the top, for a reader who had scrolled away from the latest message before the rebuild.
    var restoredReadingRowID: String? = nil
    /// Reports each move of the reader, with the row at the top computed only when asked for, so a rebuild in the
    /// middle of a drag or deceleration, which ends no gesture, still knows where the reader was.
    var onReaderMoved: (() -> String?) -> Void = { _ in }

    private var rowCache: ChatTranscriptRowCache { retainedRowCache ?? ownRowCache }

    var body: some View {
        if isLoading && messages.isEmpty && clarificationPrompt == nil {
            ChatTranscriptLoadingSkeletonView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottomLeading) {
                    // A cold open has nothing to paint yet; the check still says the run state is unconfirmed.
                    if showsRunStateCheck {
                        RunStatusChip(ChatActiveRunStatusPresentation(kind: .checking), agentName: assistantName)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom, transcriptBottomInsetHeight)
        } else if messages.isEmpty && clarificationPrompt == nil {
            ContentUnavailableView {
                Image(systemName: "bubble.left.and.bubble.right")
            } description: {
                Text("Send a message to start the conversation.")
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom, transcriptBottomInsetHeight)
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
                let readyRevision = readyScrollRevision

                ZStack(alignment: .bottom) {
                    ScrollView {
                        transcriptScrollContent(
                            proxy: proxy,
                            viewportWidth: viewportWidth,
                            contentWidth: contentWidth,
                            viewportFrame: viewport.frame(in: .global)
                        )
                    }
                    .defaultScrollAnchor(initialScrollAnchor, for: .initialOffset)
                    .task(id: readyRevision) {
                        guard !Task.isCancelled, let revision = readyRevision, readyScrollRevision == revision,
                              revision == nativeScrollRevision,
                              let destination = scrollDestination else { return }
                        // A ready command has a unique revision. Resetting its
                        // own task ID adds a second change in the same frame and
                        // can prevent SwiftUI from starting the next command.
                        performScroll(to: destination.id, anchor: destination.anchor,
                                      animation: destination.animation, using: proxy)
                    }
                    .onChange(of: rowCache.layoutRevision) {
                        guard isFollowingLatestContent, !scrollPositionController.isNavigating,
                              !scrollPositionController.isUserInteracting else { return }
                        let latest = displayedTranscriptMessages.last.map { Self.containerID(for: $0.renderID) } ?? Self.emptyContainerID
                        guard scrollDestination?.id == latest else { return }
                        performScroll(to: latest, anchor: .bottom, animation: nil, using: proxy)
                    }
                    .onAppear {
                        scrollPositionController.onHoldAnchor = { id, anchor in
                            if scrollPositionController.isPreservingPosition {
                                if !scrollPositionController.scrollToMeasuredRow(id, anchor: anchor, animated: false) {
                                    proxy.scrollTo(id, anchor: anchor)
                                }
                            } else {
                                scrollCommands.scrollTo(id: id, anchor: anchor)
                            }
                        }
                        scrollPositionController.onPreservationEnded = releaseUnownedRowPins
                        scrollPositionController.onNativeScrollLayoutComplete = { revision in
                            guard revision == nativeScrollRevision, scrollDestinationNeedsMount,
                                  let destination = scrollDestination,
                                  rowCache.containsRow(destination.id) else { return }
                            // Keep admission paused across the mount-to-navigation handoff.
                            scrollDestinationNeedsMount = false
                            beginNativeScroll(targetID: destination.id, anchor: destination.anchor)
                            readyScrollRevision = nativeScrollRevision
                        }
                        if let restoredReadingRowID, !didRestoreReadingRow {
                            // Reopen where the reader was, not at the latest message (TAL-1477).
                            didRestoreReadingRow = true
                            scrollCommands.scrollTo(id: restoredReadingRowID, anchor: .top)
                        }
                    }
                    .onDisappear {
                        scrollPositionController.onHoldAnchor = nil
                        scrollPositionController.onPreservationEnded = nil
                        scrollPositionController.onNativeScrollLayoutComplete = nil
                        scrollDestination = nil
                        scrollDestinationNeedsMount = false
                    }
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
                .onChange(of: messages.map { [$0.displayExcerpt, $0.activityScene?.finalAnswerExcerpt] }) {
                    guard !shouldFollowLatestMessage else { return }
                    scrollPositionController.holdVisiblePosition {
                        proxy.scrollTo(transcriptContentID, anchor: .top)
                    }
                }
                .onChange(of: messages.count) {
                    if latestTranscriptMessageRole == "user" {
                        following { onScrollToLatestTranscriptMessage(scrollCommands) }
                    } else {
                        following { onScrollToLatestContent(scrollCommands, true) }
                    }
                }
                .onChange(of: scrollToBottomRequest) {
                    releasingPreservation { onScrollToBottom(scrollCommands) }
                }
                .onChange(of: streamingScrollTrigger) {
                    following { onScrollToLatestContent(scrollCommands, true) }
                }
                .onChange(of: followReplayRequest) {
                    following { onScrollToLatestContent(scrollCommands, true) }
                }
                .onChange(of: cacheFirstReconcileScrollToken) {
                    // Cache-first reconcile (#289): the server transcript just replaced
                    // the lighter cached render, so snap back to the bottom (no
                    // animation) unless the reader has scrolled away in the meantime.
                    following { onScrollToLatestContent(scrollCommands, false) }
                }
                .onChange(of: clarificationPrompt?.id) {
                    guard clarificationPrompt != nil else { return }
                    following { onScrollToBottom(scrollCommands) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    // The keyboard shrinks the viewport, so keep a following
                    // reader on the latest content. `isScrolledNearBottom` alone
                    // is too loose: its 80/160pt band still covers a reader who
                    // deliberately nudged up, and scrolling for them would reset
                    // the latch they just set.
                    if isScrolledNearBottom {
                        following { onScrollToBottom(scrollCommands) }
                    }
                }
            }
        }
    }

    private var scrollCommands: ChatTranscriptScrollProxy {
        ChatTranscriptScrollProxy { id, anchor, animation in
            initialScrollAnchor = nil
            scrollDestination = (id, anchor, animation)
            let isRow = rowCache.mountedIDs.contains(id) || rowCache.containsRow(id)
            scrollDestinationNeedsMount = isRow && !scrollPositionController.hasMeasuredRow(id)
            beginNativeScroll(targetID: isRow ? id : nil, anchor: anchor,
                              waitsForArrival: !scrollDestinationNeedsMount)
            if !scrollDestinationNeedsMount { readyScrollRevision = nativeScrollRevision }
        }
    }

    private func beginNativeScroll(targetID: String? = nil, anchor: UnitPoint = .top,
                                   waitsForArrival: Bool = true) {
        nativeScrollRevision += 1
        scrollPositionController.prepareNativeScroll(revision: nativeScrollRevision, targetID: targetID,
                                                     anchor: anchor, waitsForArrival: waitsForArrival)
    }

    private func performScroll(to id: String, anchor: UnitPoint, animation: Animation?, using proxy: ScrollViewProxy) {
        if !scrollPositionController.scrollToMeasuredRow(id, anchor: anchor, animated: animation != nil && !reduceMotion) {
            withAnimation(animation) { proxy.scrollTo(id, anchor: anchor) }
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
    /// undo SwiftUI, finish with a native scroll to the same content fraction so
    /// its own offset model, and hit-testing of the visible rows, catch up.
    private func pinReaderForDisclosure(proxy: ScrollViewProxy, anchorRowID: String?) {
        scrollDestination = nil
        scrollDestinationNeedsMount = false
        let completion = onDisclosureToggle()
        let nearReader = scrollPositionController.realizedRowsNearViewport
        scrollPositionController.holdPosition(anchorRowID: anchorRowID, resync: {
            proxy.scrollTo(transcriptContentID, anchor: .top)
        }, completion: completion)
        if scrollPositionController.isPreservingPosition {
            pinnedRowIDs = nearReader
            if let anchorRowID { pinnedRowIDs.insert(anchorRowID) }
        }
    }

    /// Reports the row's content-space top so position preservation can tell
    /// growth above it from growth below, and pins on this row when one of its
    /// disclosures toggles.
    private func positionAnchoredRow(_ row: some View, id: String, proxy: ScrollViewProxy) -> some View {
        let controller = scrollPositionController
        let revision = historyLayoutRevision
        return row
            .onGeometryChange(for: ChatScrollPositionController.RowGeometry.self) {
                ChatScrollPositionController.RowGeometry(revision: revision,
                    contentMinY: $0.frame(in: .named(transcriptContentID)).minY,
                    frame: $0.frame(in: .global))
            } action: {
                controller.recordRowGeometry($0, for: id)
            }
            .onAppear { controller.rowDidAppear(id) }
            .onDisappear { controller.forgetRow(id) }
            .environment(\.chatDisclosureToggled) {
                pinReaderForDisclosure(proxy: proxy, anchorRowID: id)
            }
    }

    /// Runs an automatic follow only while `isFollowingLatestContent` holds.
    /// A skipped one is reported so ChatView can replay it after settling.
    private func following(_ scroll: () -> Void) {
        guard isFollowingLatestContent else {
            onFollowSuppressed()
            return
        }
        releasingPreservation(scroll)
    }

    /// Deliberate scrolls end a disclosure pin first. The pin exists only to
    /// stop SwiftUI moving the reader on its own after a toggle.
    private func releasingPreservation(_ scroll: () -> Void) {
        scrollPositionController.cancelPreservation()
        scroll()
    }

    private func transcriptScrollContent(
        proxy: ScrollViewProxy,
        viewportWidth: CGFloat,
        contentWidth: CGFloat,
        viewportFrame: CGRect
    ) -> some View {
        TranscriptHistorySentinel(isAvailable: hasOlderMessages, isLoading: isLoadingOlderMessages,
                                  isNearTop: isHistoryNearTop, pageRevision: historyLayoutRevision,
                                  canPrefetch: scrollPositionController.shouldPrefetchHistory,
                                  onLoad: { await loadOlderMessagesPreservingPosition(proxy: proxy) }) { historyIndicator in
            VStack(spacing: transcriptMessageSpacing) {
                if let branchedFrom { branchedFromButton(branchedFrom) }
                if hasOlderMessages { historyIndicator }
                if let compressionReferenceCard, compressionReferenceCard.afterRenderID == nil {
                    compressionReferenceCardView(compressionReferenceCard, proxy: proxy)
                }
                if !displayedTranscriptMessages.isEmpty {
                    windowedTranscriptRows(proxy: proxy, viewportFrame: viewportFrame)
                } else {
                    VStack(spacing: transcriptMessageSpacing) { transcriptTailContent }
                        .id(Self.emptyContainerID)
                }
            }
            .padding(.top, 16)
            .coordinateSpace(.named(transcriptContentID))
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
                        contentRevision: historyLayoutRevision,
                        nativeScrollRevision: nativeScrollRevision,
                        onFollowEvent: { event in
                            if case .userScrollBegin = event {
                                initialScrollAnchor = nil
                                scrollDestination = nil
                                scrollDestinationNeedsMount = false
                            }
                            onFollowEvent(event)
                            onReaderMoved { scrollPositionController.readingAnchorRowID }
                        }
                    ) { metrics in
                        isHistoryNearTop = scrollPositionController.shouldPrefetchHistory()
                        updateRowViewport(height: viewportFrame.height)
                        onUpdateScrollMetrics(metrics)
                    }

                    ChatVerticalScrollAxisGuard()
                    ChatMessageMenuHost(registry: menuRegistry)
                }
                .accessibilityHidden(true)
            }
        }
    }

    private func windowedTranscriptRows(proxy: ScrollViewProxy, viewportFrame: CGRect) -> some View {
        let ids = displayedTranscriptMessages.map { Self.containerID(for: $0.renderID) }
        var pins = pinnedRowIDs
        if let target = scrollDestination?.id { pins.insert(target) }
        if let anchor = scrollPositionController.preservationAnchorRowID { pins.insert(anchor) }
        let elements = rowCache.elements(ids: ids, top: rowViewportTop - rowOriginY,
                                         viewportHeight: viewportFrame.height,
                                         spacing: transcriptMessageSpacing, pinned: pins,
                                         freezesWindow: isAdmittingHistory)
        return VStack(spacing: transcriptMessageSpacing) {
            ForEach(elements) { element in
                VStack(spacing: 0) {
                    switch element {
                    case let .row(index, id):
                        ChatTranscriptRow(rowID: id, positionController: scrollPositionController,
                                          cache: rowCache,
                                          priority: rowCache.realizationPriority(at: index, top: rowViewportTop - rowOriginY,
                                                                                 viewportHeight: viewportFrame.height),
                                          isPinned: pins.contains(id), isTail: index == ids.count - 1,
                                          allowsRealization: !isAdmittingHistory,
                                          willRealize: preserveReaderForRealization) {
                            transcriptRow(displayedTranscriptMessages[index], index: index, proxy: proxy)
                        }
                    case let .gap(_, _, height):
                        Color.clear.frame(height: max(0, height))
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .id(element.id)
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .named(transcriptContentID)).minY }) {
            rowOriginY = $0
        }
    }

    private func updateRowViewport(height: CGFloat) {
        guard !isAdmittingHistory, let top = scrollPositionController.viewportTop else { return }
        if abs(top - rowViewportTop) >= max(100, height / 2) { rowViewportTop = top }
    }

    private func transcriptRow(_ transcriptMessage: TranscriptMessage, index: Int, proxy: ScrollViewProxy) -> some View {
        positionAnchoredRow(VStack(spacing: transcriptMessageSpacing) {
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

            row

            if let compressionReferenceCard,
               compressionReferenceCard.afterRenderID == transcriptMessage.renderID {
                compressionReferenceCardView(compressionReferenceCard, proxy: proxy)
            }
            if index == displayedTranscriptMessages.count - 1 { transcriptTailContent }
        }, id: Self.containerID(for: transcriptMessage.renderID), proxy: proxy)
    }

    nonisolated static let emptyContainerID = "chat-bottom-anchor"

    nonisolated static func containerID(for renderID: String) -> String { "transcript-container:\(renderID)" }

    @ViewBuilder
    private var transcriptTailContent: some View {
        transcriptLooseBlocks
        liveResponseBlocks
        turnChangesCard
        inlineCommitButton
        Color.clear.frame(height: 1).allowsHitTesting(false)
    }

    @ViewBuilder
    private func compressionReferenceCardView(_ card: CompressionReferenceCard, proxy: ScrollViewProxy) -> some View {
        let row = MarkerMessageCardView(kind: .compressionReference, content: card.referenceText)
        if card.afterRenderID == nil {
            positionAnchoredRow(row, id: "compression-reference", proxy: proxy)
                .id("compression-reference")
        } else {
            row
        }
    }

    /// Opens the chat this one was branched from through the session deep link (TAL-454), so an offline tap
    /// opens it from the cached chat list when it is there.
    private func branchedFromButton(_ link: SessionBranchLink) -> some View {
        let label = String(localized: "Branched from \(link.title)")
        return Button {
            if let url = TalariaDeepLink.sessionURL(sessionID: link.sessionId) { openURL(url) }
        } label: {
            Label(label, systemImage: "arrow.triangle.branch")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .buttonStyle(.chatTactile(.capsule))
        .frame(maxWidth: .infinity)
        .accessibilityLabel(label)
    }

    private var transcriptHorizontalPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 16
    }

    private func transcriptContentWidth(for viewportWidth: CGFloat) -> CGFloat {
        let columnWidth = min(viewportWidth, AdaptiveReadableContentWidth.chat)
        return max(0, columnWidth - (transcriptHorizontalPadding * 2))
    }

    private func preserveReaderForRealization() {
        guard !isFollowingLatestContent || scrollPositionController.isUserInteracting else { return }
        _ = scrollPositionController.preserveReaderForRealization(isFollowingLatest: isFollowingLatestContent)
        if scrollPositionController.isPreservingPosition, !isAdmittingHistory {
            pinnedRowIDs = scrollPositionController.realizedRowsNearViewport
            if let id = scrollPositionController.preservationAnchorRowID { pinnedRowIDs.insert(id) }
        }
    }

    private func releaseUnownedRowPins() {
        guard !isAdmittingHistory, !scrollPositionController.isPreservingPosition else { return }
        pinnedRowIDs.removeAll()
    }

    @discardableResult
    private func loadOlderMessagesPreservingPosition(proxy: ScrollViewProxy) async -> Bool {
        var renderID: String?
        var capturedExactPosition = false
        defer {
            // Read UIKit's compensated coordinate before allowing a new window.
            if let top = scrollPositionController.viewportTop { rowViewportTop = top }
            isAdmittingHistory = false
            releaseUnownedRowPins()
        }
        // A fling can keep moving while the page is in flight; snapshot immediately before the prepend.
        let didLoad = await onLoadOlderMessages {
            isAdmittingHistory = true
            renderID = scrollPositionController.readingAnchorRowID ?? displayedTranscriptMessages.first.map { Self.containerID(for: $0.renderID) }
            let nearReader = scrollPositionController.realizedRowsNearViewport
            historyLayoutRevision += 1
            capturedExactPosition = scrollPositionController.capture(anchorRowID: renderID, contentRevision: historyLayoutRevision)
                && scrollPositionController.restoreAfterPrepend(whileInteracting: true)
            pinnedRowIDs = nearReader
            if let renderID { pinnedRowIDs.insert(renderID) }
        }
        guard didLoad else {
            scrollPositionController.cancelPreservation()
            return false
        }

        if capturedExactPosition {
            await scrollPositionController.waitForPrependLayout()
            return true
        }

        guard let renderID else { return true }

        await scrollPositionController.waitForPrependLayout()
        proxy.scrollTo(renderID, anchor: .top)
        return true
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
                    ReasoningBlockView(text: liveReasoningText, isActive: true, stateID: streamingAssistantMessageID ?? "live")
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
            RunStatusChip(ChatActiveRunStatusPresentation(kind: .checking), agentName: assistantName)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(ChatMotion.bottomOverlayTransition(reduceMotion: reduceMotion))
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
                ReasoningBlockView(text: group.text, titles: group.titles, stateID: group.id)
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
