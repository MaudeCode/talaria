import SwiftUI
import TalariaKit

struct ChatTranscriptMessageRow: View {
    let message: ChatMessage
    let visibleIndex: Int
    let actionContext: MessageActionContext?
    let localAttachmentPreviews: [String: Data]?
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let isSessionReadOnly: Bool
    let canBranch: Bool
    let hasActiveStream: Bool
    let isStreaming: Bool
    let liveTokensPerSecond: Double?
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let disablesHistoryActions: Bool
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

    @Environment(\.chatMessageMenuRegistry) private var menuRegistry
    /// One store per row: its paragraphs fill in where their links landed, and
    /// the row's marker hands them to the long-press handler (TAL-49).
    @State private var linkRegions = ChatMessageLinkRegionStore()

    var body: some View {
        // Rows the server marked as compaction markers render as collapsible
        // cards (as on Web), never as user bubbles — and without bubble actions,
        // which don't apply to system-emitted markers.
        if let markerKind = message.markerKind {
            MarkerMessageCardView(kind: markerKind, content: message.markerBody ?? message.content)
        } else if let actionContext {
            // The actions hang off the transcript's long press rather than a
            // bubble `contextMenu`: a press over a link opens the link's own
            // actions, and a press on prose opens the message menu at the press
            // point instead of lifting a snapshot of the whole bubble.
            bubble
                .environment(\.chatMessageLinkRegionStore, linkRegions)
                .coordinateSpace(.named(ChatMessageInteraction.rowCoordinateSpace))
                .background {
                    ChatMessageInteractionMarker(registry: menuRegistry) {
                        menuContent(for: actionContext)
                    }
                    .accessibilityHidden(true)
                }
                .accessibilityActions {
                    ForEach(actions(for: actionContext).filter(\.isEnabled)) { action in
                        Button(action.title) { action.handler() }
                    }
                }
        } else {
            bubble
        }
    }

    @ViewBuilder
    private var bubble: some View {
        if let update = message.backgroundUpdate {
            BackgroundUpdateLinesView(update: update, message: message)
        } else {
            messageBubble
        }
    }

    private var messageBubble: some View {
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

    private func menuContent(for context: MessageActionContext) -> ChatMessageMenuContent {
        ChatMessageMenuContent(
            messageID: context.messageID,
            actions: actions(for: context),
            linkRegions: linkRegions.regions(),
            controlRegions: linkRegions.controlRegions()
        )
    }

    private func actions(for context: MessageActionContext) -> [ChatMessageAction] {
        ChatMessageActionCatalog.actions(
            context: context,
            state: ChatMessageActionState(
                listeningMessageID: listeningMessageID,
                isViewingCachedData: isViewingCachedData,
                isSessionReadOnly: isSessionReadOnly,
                hasActiveStream: hasActiveStream,
                isRegeneratingMessage: isRegeneratingMessage,
                isEditingMessage: isEditingMessage,
                isForkingMessage: isForkingMessage,
                disablesHistoryActions: disablesHistoryActions,
                canBranch: canBranch
            ),
            handlers: ChatMessageActionHandlers(
                onToggleListening: onToggleListening,
                onSelectText: onSelectText,
                onRegenerate: onRegenerate,
                onEdit: onEdit,
                onFork: onFork,
                onCopy: onCopy
            )
        )
    }
}
