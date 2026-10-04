import SwiftUI
import TalariaKit

struct MessageBubbleView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.pendingSteerControls) private var pendingSteerControls
    @AppStorage(ChatTranscriptDisplaySettings.hidesAttachmentPathsKey) private var hidesAttachmentPaths = true
    @AppStorage(ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey) private var showsAssistantTurnTimestamps = false
    @AppStorage(ChatTranscriptDisplaySettings.showsResponseSpeedKey) private var showsResponseSpeed = false
    /// Device-local disclosure for a body the server collapsed (TAL-456).
    @State private var isExpanded = false

    let message: ChatMessage
    let loadAttachmentImage: ((String) async -> Data?)?
    let loadAttachmentData: ((String) async -> Data?)?
    let loadTranscriptMediaImage: ((TranscriptMediaReference) async -> Data?)?
    let loadTranscriptMediaData: ((TranscriptMediaReference) async -> Data?)?
    let transcriptMediaCacheNamespace: String
    let localAttachmentPreviews: [String: Data]?
    let onPreviewAttachment: ((MessageAttachment, Data?) -> Void)?
    let onPreviewTranscriptMedia: ((TranscriptMediaReference) -> Void)?
    let isStreaming: Bool
    let liveTokensPerSecond: Double?

    init(
        message: ChatMessage,
        loadAttachmentImage: ((String) async -> Data?)? = nil,
        loadAttachmentData: ((String) async -> Data?)? = nil,
        loadTranscriptMediaImage: ((TranscriptMediaReference) async -> Data?)? = nil,
        loadTranscriptMediaData: ((TranscriptMediaReference) async -> Data?)? = nil,
        transcriptMediaCacheNamespace: String = "",
        localAttachmentPreviews: [String: Data]? = nil,
        onPreviewAttachment: ((MessageAttachment, Data?) -> Void)? = nil,
        onPreviewTranscriptMedia: ((TranscriptMediaReference) -> Void)? = nil,
        isStreaming: Bool = false,
        liveTokensPerSecond: Double? = nil
    ) {
        self.message = message
        self.loadAttachmentImage = loadAttachmentImage
        self.loadAttachmentData = loadAttachmentData
        self.loadTranscriptMediaImage = loadTranscriptMediaImage
        self.loadTranscriptMediaData = loadTranscriptMediaData
        self.transcriptMediaCacheNamespace = transcriptMediaCacheNamespace
        self.localAttachmentPreviews = localAttachmentPreviews
        self.onPreviewAttachment = onPreviewAttachment
        self.onPreviewTranscriptMedia = onPreviewTranscriptMedia
        self.isStreaming = isStreaming
        self.liveTokensPerSecond = liveTokensPerSecond
    }

    var body: some View {
        if isLocalNotice {
            localNoticeRow
        } else if isLocalAssistant {
            localAssistantRow
        } else if isUserMessage {
            userMessageRow
        } else {
            assistantMessageRow
        }
    }

    private var userMessageRow: some View {
        VStack(alignment: .trailing, spacing: 8) {
            steeringHintHeader

            if let attachments = message.attachments, !attachments.isEmpty {
                attachmentPreviews
            }

            // When the attachment-path line is hidden, an attachment-only
            // message has no bubble text left; skip the empty pill so only the
            // attachment grid shows.
            if hasVisibleUserBubbleText || hasLinkPreview {
                HStack(alignment: .bottom, spacing: 0) {
                    Spacer(minLength: userBubbleLeadingGutter)
                    VStack(alignment: .trailing, spacing: 8) {
                        if hasVisibleUserBubbleText {
                            userBubble
                        }
                        collapseToggle
                        linkPreview
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var steeringHintHeader: some View {
        if let state = message.steeringHintState {
            HStack(spacing: 5) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.turn.up.right")
                        .accessibilityHidden(true)

                    Text("Steering hint")

                    switch state {
                    case .sending:
                        ProgressView()
                            .controlSize(.mini)
                            .accessibilityHidden(true)
                        Text("Sending")
                    case .waiting:
                        Image(systemName: "clock")
                            .accessibilityHidden(true)
                        Text("Waiting for agent")
                    case .consumed:
                        EmptyView()
                    }
                }
                .accessibilityElement(children: .combine)

                pendingSteerButtons
            }
            .font(AppFont.footnote())
            .foregroundStyle(.secondary)
            .padding(.trailing, 4)
        }
    }

    /// TAL-426: the actions the server allows for this pending steer (none once the Agent took it).
    private var pendingSteerActions: PendingSteer.Actions? {
        guard let id = message.messageId, let actions = pendingSteerControls.actions[id], actions.any else { return nil }
        return actions
    }

    @ViewBuilder
    private var pendingSteerButtons: some View {
        if let actions = pendingSteerActions, let id = message.messageId {
            let busy = pendingSteerControls.inFlight.contains(id)
            HStack(spacing: 0) {
                if actions.sendNow { pendingSteerButton(String(localized: "Send now"), systemImage: "arrow.up", id: id, action: .sendNow) }
                if actions.edit { pendingSteerButton(String(localized: "Edit steering message"), systemImage: "pencil", id: id, action: .edit) }
                if actions.cancel { pendingSteerButton(String(localized: "Cancel steering message"), systemImage: "xmark", id: id, action: .cancel) }
            }
            .disabled(busy)
        }
    }

    private func pendingSteerButton(_ label: String, systemImage: String, id: String, action: PendingSteerAction) -> some View {
        Button {
            pendingSteerControls.perform(id, action)
        } label: {
            Image(systemName: systemImage)
                .font(.footnote.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// The same actions on a long press of the pending bubble, as the App's other user messages offer theirs.
    @ViewBuilder
    private var pendingSteerMenu: some View {
        if let actions = pendingSteerActions, let id = message.messageId {
            if actions.sendNow { Button(String(localized: "Send now"), systemImage: "arrow.up") { pendingSteerControls.perform(id, .sendNow) } }
            if actions.edit { Button(String(localized: "Edit steering message"), systemImage: "pencil") { pendingSteerControls.perform(id, .edit) } }
            if actions.cancel { Button(String(localized: "Cancel steering message"), systemImage: "xmark", role: .destructive) { pendingSteerControls.perform(id, .cancel) } }
        }
    }

    private var assistantMessageRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsAssistantTurnHeaderForThisMessage {
                assistantTurnHeader
            }

            // The server's display text, when it rewrote media references; `content` stays for copy and edit (TAL-186).
            if let display = message.displayBody {
                TranscriptMediaContentView(
                    markdown: collapsedExcerpt ?? display.text,
                    display: display,
                    cacheNamespace: transcriptMediaCacheNamespace,
                    loadMediaImage: loadTranscriptMediaImage,
                    loadMediaData: loadTranscriptMediaData,
                    onPreviewMedia: onPreviewTranscriptMedia,
                    isStreaming: isStreaming
                )
            } else {
                MarkdownRenderer(content: messageText, isStreaming: isStreaming)
            }

            collapseToggle
            linkPreview
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        // While this row is the active streaming message, animate its height
        // growth at the same curve as the bottom-follow scroll so the streaming
        // edge stays visually stationary instead of stepping per word flush.
        .animation(
            isStreaming ? ChatMotion.streamingFollow(reduceMotion: reduceMotion) : nil,
            value: messageText
        )
    }

    // MARK: - Assistant turn header (issue #258)

    /// A compact, generic `glyph + time` marker drawn above each assistant text
    /// turn so back-to-back responses are visually separable. Deliberately carries
    /// no model/profile/agent identity — only the message's own timestamp, which
    /// is the single per-message-accurate datum available.
    private var assistantTurnHeader: some View {
        HStack(spacing: 5) {
            Image(systemName: "sparkle")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)

            if let time = assistantTurnTimeText {
                Text(time)
                    .foregroundStyle(.secondary)
            }

            if let speed = assistantResponseSpeedText {
                Text(speed)
                    .foregroundStyle(.secondary)
            }
        }
        .font(AppFont.footnote())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(assistantTurnHeaderAccessibilityLabel)
    }

    private var showsAssistantTurnHeaderForThisMessage: Bool {
        ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: message.role,
            hasTextContent: hasVisibleAssistantText,
            isEnabled: showsAssistantTurnTimestamps,
            showsResponseSpeed: showsResponseSpeed,
            hasResponseSpeed: assistantResponseSpeedText != nil
        )
    }

    /// Uses the raw `content` (not `messageText`, which substitutes a placeholder
    /// space) so an empty or tool-call-only assistant row never shows a floating
    /// header.
    private var hasVisibleAssistantText: Bool {
        guard let content = message.content else { return false }
        return !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var assistantTurnTimeText: String? {
        guard showsAssistantTurnTimestamps else { return nil }
        return AssistantTurnTimestampFormatter.shortTime(forUnixTimestamp: message.timestamp)
    }

    private var assistantResponseSpeedText: String? {
        guard showsResponseSpeed else { return nil }
        return ResponseSpeedFormatter.compactText(isStreaming ? liveTokensPerSecond : message.turnTps)
    }

    private var assistantTurnHeaderAccessibilityLabel: String {
        let details = [
            assistantTurnTimeText,
            assistantResponseSpeedAccessibilityText
        ].compactMap { $0 }
        guard !details.isEmpty else { return String(localized: "Assistant") }
        return String(localized: "Assistant, \(details.joined(separator: ", "))")
    }

    private var assistantResponseSpeedAccessibilityText: String? {
        guard showsResponseSpeed else { return nil }
        return ResponseSpeedFormatter.accessibilityText(isStreaming ? liveTokensPerSecond : message.turnTps)
    }

    private var localNoticeRow: some View {
        localStatusRow(
            iconName: "checkmark.circle.fill",
            iconColor: .green
        )
    }

    private var localAssistantRow: some View {
        localStatusRow(
            iconName: "command.circle.fill",
            iconColor: .accentColor
        )
    }

    private func localStatusRow(iconName: String, iconColor: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 28, height: 28)
                .background(iconColor.opacity(colorScheme == .dark ? 0.18 : 0.12), in: Circle())

            MarkdownRenderer(content: messageText, isStreaming: isStreaming)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(.separator).opacity(colorScheme == .dark ? 0.42 : 0.28), lineWidth: 0.5)
        )
        .padding(.vertical, 4)
    }

    private var userBubble: some View {
        Text(verbatim: userBubbleText)
            .font(.body)
            .textSelection(.enabled)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(userBubbleBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .foregroundStyle(userBubbleForeground)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(userBubbleBorder, style: isPendingSteer ? StrokeStyle(lineWidth: 1, dash: [4, 3]) : StrokeStyle(lineWidth: 0.5))
            )
            .modifier(PendingSteerMenuModifier(isEnabled: pendingSteerActions != nil) { pendingSteerMenu })
    }

    /// A steer the Agent has not taken yet is drawn dashed (TAL-426), like Web's pending bubble.
    private var isPendingSteer: Bool {
        message.steeringHintState == .waiting || message.steeringHintState == .sending
    }

    @ViewBuilder
    private var linkPreview: some View {
        if let url = TranscriptLinkPreviewEligibility.previewURL(for: message, isStreaming: isStreaming) {
            TranscriptLinkPreviewView(url: url)
                .frame(maxWidth: 300)
        }
    }

    private var hasLinkPreview: Bool {
        TranscriptLinkPreviewEligibility.previewURL(for: message, isStreaming: isStreaming) != nil
    }

    // Audio attachments render as full-width Telegram-style player bars stacked
    // above the square image/file grid; everything else stays in the grid.
    private var attachmentPreviews: some View {
        let allItems = attachmentsWithPreviews
        let audioItems = allItems.filter { $0.attachment.inferredIsAudio }
        let gridItems = allItems.filter { !$0.attachment.inferredIsAudio }
        let columns = 2
        let spacing: CGFloat = 8
        let cellSize: CGFloat = 118
        let contentWidth = CGFloat(columns) * cellSize + CGFloat(columns - 1) * spacing

        return VStack(alignment: .trailing, spacing: spacing) {
            ForEach(audioItems.indices, id: \.self) { index in
                let attachment = audioItems[index].attachment
                InlineAudioPlayerView(
                    title: audioDisplayName(for: attachment),
                    load: audioLoader(for: attachment)
                )
                // Identity follows the attachment, not the row position. The
                // transcript bubble's id is positional (`transcript:<index>`),
                // so without this a recycled row would keep its old `@State`
                // model (and stale audio bytes) for a different clip.
                .id(attachment.path ?? attachment.name ?? "\(index)")
                .frame(width: contentWidth, alignment: .trailing)
            }

            if !gridItems.isEmpty {
                attachmentGrid(
                    items: gridItems,
                    columns: columns,
                    cellSize: cellSize,
                    spacing: spacing,
                    width: contentWidth
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func attachmentGrid(
        items: [(attachment: MessageAttachment, localData: Data?)],
        columns: Int,
        cellSize: CGFloat,
        spacing: CGFloat,
        width: CGFloat
    ) -> some View {
        VStack(alignment: .trailing, spacing: spacing) {
            ForEach(0..<rowCount(items: items, columns: columns), id: \.self) { row in
                HStack(spacing: spacing) {
                    let start = row * columns
                    let end = min(start + columns, items.count)
                    ForEach(start..<end, id: \.self) { index in
                        let item = items[index]
                        GridAttachmentCell(
                            attachment: item.attachment,
                            cacheNamespace: transcriptMediaCacheNamespace,
                            localData: item.localData,
                            loadAttachmentImage: loadAttachmentImage,
                            onPreviewAttachment: onPreviewAttachment,
                            size: cellSize
                        )
                        .frame(width: cellSize, height: cellSize)
                    }
                }
            }
        }
        .frame(width: width, alignment: .trailing)
    }

    /// Display name for an audio bar, mirroring the grid file cell's logic.
    private func audioDisplayName(for attachment: MessageAttachment) -> String {
        if let name = attachment.name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }
        if let path = attachment.path?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
            let lastPathComponent = URL(fileURLWithPath: path).lastPathComponent
            return lastPathComponent.isEmpty ? path : lastPathComponent
        }
        return String(localized: "Audio")
    }

    /// Builds the lazy byte loader for an audio bar. Resolves the server path
    /// (or filename fallback) once and defers to the injected raw-data loader.
    private func audioLoader(for attachment: MessageAttachment) -> () async -> Data? {
        let resolvedPath: String? = {
            if let path = attachment.path, !path.isEmpty { return path }
            if let name = attachment.name, !name.isEmpty { return name }
            return nil
        }()
        let loadAttachmentData = loadAttachmentData
        return {
            guard let resolvedPath, let loadAttachmentData else { return nil }
            return await loadAttachmentData(resolvedPath)
        }
    }

    private func rowCount(items: [(attachment: MessageAttachment, localData: Data?)], columns: Int) -> Int {
        (items.count + columns - 1) / columns
    }

    private var attachmentsWithPreviews: [(attachment: MessageAttachment, localData: Data?)] {
        guard let attachments = message.attachments else { return [] }
        return attachments.map { attachment in
            let key = attachment.path ?? attachment.name ?? ""
            let localData = localAttachmentPreviews?[key]
            return (attachment, localData)
        }
    }

    private var isUserMessage: Bool {
        message.role == "user"
    }

    private var isLocalNotice: Bool {
        message.role == "local_notice"
    }

    private var isLocalAssistant: Bool {
        message.role == "local_assistant"
    }

    private var userBubbleLeadingGutter: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 32
    }

    private var userBubbleBackground: Color {
        colorScheme == .dark ? Color(.systemGray3) : Color(.systemGray6)
    }

    private var userBubbleForeground: Color {
        Color(.label)
    }

    private var userBubbleBorder: Color {
        colorScheme == .dark
            ? Color.white.opacity(0.08)
            : Color.black.opacity(0.04)
    }

    private var messageText: String {
        if let excerpt = collapsedExcerpt {
            return excerpt
        }
        guard let content = message.content, !content.isEmpty else {
            return " "
        }

        return content
    }

    /// The server's excerpt while this settled row is collapsed; `nil` shows the whole body.
    private var collapsedExcerpt: String? {
        guard !isStreaming, !isExpanded else { return nil }
        return message.displayExcerpt
    }

    @ViewBuilder
    private var collapseToggle: some View {
        if message.displayExcerpt != nil, !isStreaming {
            Button(isExpanded ? String(localized: "Show less") : String(localized: "Show more")) {
                isExpanded.toggle()
            }
            .font(AppFont.body())
            .buttonStyle(.borderless)
            .accessibilityIdentifier("message-collapse-toggle")
            .modifier(ChatMessageControlRegion())
        }
    }

    /// The user bubble's text, with the appended attachment-path marker stripped
    /// when the user has opted to hide it. Display-only: `message.content` and the
    /// sent payload are untouched.
    private var userBubbleText: String {
        let content = collapsedExcerpt ?? message.content ?? ""
        guard hidesAttachmentPaths else { return content }
        return MessageAttachment.contentWithoutAttachmentReferences(
            in: content,
            attachments: message.attachments
        )
    }

    private var hasVisibleUserBubbleText: Bool {
        !userBubbleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Long-press actions only on a pending steer: every other user bubble keeps the transcript's own message menu.
private struct PendingSteerMenuModifier<Menu: View>: ViewModifier {
    let isEnabled: Bool
    @ViewBuilder let menu: () -> Menu

    func body(content: Content) -> some View {
        if isEnabled { content.contextMenu { menu() } } else { content }
    }
}

/// TAL-426: what a pending steer bubble may offer (from the server's actions) and how the chat performs it.
enum PendingSteerAction {
    case sendNow, edit, cancel
}

struct PendingSteerControls {
    var actions: [String: PendingSteer.Actions] = [:]
    var inFlight: Set<String> = []
    var perform: (String, PendingSteerAction) -> Void = { _, _ in }
}

private struct PendingSteerControlsKey: EnvironmentKey {
    static let defaultValue = PendingSteerControls()
}

extension EnvironmentValues {
    var pendingSteerControls: PendingSteerControls {
        get { self[PendingSteerControlsKey.self] }
        set { self[PendingSteerControlsKey.self] = newValue }
    }
}

// MARK: - Remote image loading with cookie-aware session

/// Loads attachment images through the authenticated `APIClient` instead of
/// `AsyncImage`, which uses `URLSession.shared` and may not carry our auth
/// cookie. Deduplicates concurrent requests and caches in memory.

// MARK: - Assistant turn timestamp formatting
