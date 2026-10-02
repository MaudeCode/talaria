import SwiftUI
import TalariaKit

struct ChatTranscriptMessageBlock: View, Equatable {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @State private var expandedCompletedActivityIDs = Set<String>()

    let transcriptMessage: TranscriptMessage
    let transcriptBlockSpacing: CGFloat
    let showsThinkingAndToolCards: Bool
    let archivedActivityRows: [AssistantActivityRow]
    let earlierSceneRows: [AssistantActivitySceneRow]
    let liveActivityRows: [AssistantActivityRow]
    let streamingAssistantMessageID: String?
    let liveTokensPerSecond: Double?
    let localAttachmentPreviews: [String: Data]?
    let listeningMessageID: String?
    let isViewingCachedData: Bool
    let isSessionReadOnly: Bool
    let canBranch: Bool
    let hasActiveStream: Bool
    let isRegeneratingMessage: Bool
    let isEditingMessage: Bool
    let isForkingMessage: Bool
    let disablesHistoryActions: Bool
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
    let onLoadEarlierSceneRows: () -> Void

    // Equality over the value inputs only. The closures are pure functions of
    // these values (e.g. `actionContext` is fully determined by
    // `transcriptMessage`), so two blocks that compare equal render identically.
    // This lets `.equatable()` skip re-evaluating rows whose data is unchanged
    // even though their closure props are recreated on every parent body pass.
    static func == (lhs: ChatTranscriptMessageBlock, rhs: ChatTranscriptMessageBlock) -> Bool {
        lhs.transcriptMessage == rhs.transcriptMessage &&
            lhs.transcriptBlockSpacing == rhs.transcriptBlockSpacing &&
            lhs.showsThinkingAndToolCards == rhs.showsThinkingAndToolCards &&
            lhs.archivedActivityRows == rhs.archivedActivityRows &&
            lhs.earlierSceneRows == rhs.earlierSceneRows &&
            lhs.liveActivityRows == rhs.liveActivityRows &&
            lhs.streamingAssistantMessageID == rhs.streamingAssistantMessageID &&
            lhs.liveTokensPerSecond == rhs.liveTokensPerSecond &&
            lhs.localAttachmentPreviews == rhs.localAttachmentPreviews &&
            lhs.listeningMessageID == rhs.listeningMessageID &&
            lhs.isViewingCachedData == rhs.isViewingCachedData &&
            lhs.isSessionReadOnly == rhs.isSessionReadOnly &&
            lhs.canBranch == rhs.canBranch &&
            lhs.hasActiveStream == rhs.hasActiveStream &&
            lhs.isRegeneratingMessage == rhs.isRegeneratingMessage &&
            lhs.isEditingMessage == rhs.isEditingMessage &&
            lhs.isForkingMessage == rhs.isForkingMessage &&
            lhs.disablesHistoryActions == rhs.disablesHistoryActions &&
            lhs.transcriptMediaCacheNamespace == rhs.transcriptMediaCacheNamespace
    }

    var body: some View {
        VStack(alignment: .leading, spacing: transcriptBlockSpacing) {
            if transcriptMessage.message.role == "assistant", !activityRows.isEmpty {
                // Only the server's scene folds work under "Worked"; without one the turn is live (or just ended) and
                // its work stays open until the scene arrives.
                if let turn = CompletedAssistantTurn(rows: activityRows) {
                    if turn.hasSteering {
                        steeredTurn(turn, folds: serverScene != nil)
                        outcomeRow
                    } else if serverScene != nil {
                        // Renders the outcome between the work and the final answer.
                        completedTurn(turn)
                    } else {
                        activityTimeline(turn.segments, activeSegmentID: liveActivityRows.isEmpty ? nil : turn.segments.last?.id)
                    }
                } else {
                    outcomeRow
                    ForEach(Array(activityRows.enumerated()), id: \.element.id) { index, row in
                        activityItem(row, at: index)
                    }
                }
            } else {
                // A scene with no rows and no answer still carries the server's outcome.
                outcomeRow
                messageRow(transcriptMessage.message)
            }
        }
    }

    /// Long turns arrive as a tail preview; this pages the earlier rows in, like Web's "Show earlier steps".
    @ViewBuilder
    private var earlierStepsButton: some View {
        let remaining = (transcriptMessage.message.activityScene?.activityRowsOffset ?? 0) - earlierSceneRows.count
        if remaining > 0 {
            Button(String(localized: "Earlier steps (\(remaining))"), action: onLoadEarlierSceneRows)
                .font(AppFont.body())
                .buttonStyle(.borderless)
        }
    }

    /// The server's outcome for this turn, in its localized wording, when it is not an ordinary completion.
    @ViewBuilder
    private var outcomeRow: some View {
        if let outcome = AssistantTurnOutcome.label(for: transcriptMessage.message.activityScene?.terminalState) {
            Text(outcome)
                .font(AppFont.body())
                .foregroundStyle(.secondary)
        }
    }

    /// The server's scene for a settled turn; live rows win while the turn streams.
    private var serverScene: AssistantActivityTimeline? {
        guard liveActivityRows.isEmpty else { return nil }
        return AssistantActivityTimeline.authoritativeScene(message: transcriptMessage.message, earlierRows: earlierSceneRows)
    }

    private var activityRows: [AssistantActivityRow] {
        if !liveActivityRows.isEmpty {
            return liveActivityRows
        }
        // A completed turn renders the server's scene; before it arrives, the just-finished live rows hold its place.
        // Without either (an older server), the message renders as plain text.
        return serverScene?.rows ?? archivedActivityRows
    }

    @ViewBuilder
    private func completedTurn(_ turn: CompletedAssistantTurn) -> some View {
        let disclosureID = "worked:\(transcriptMessage.anchorID)"
        // The server picks the initial state; a tap flips it relative to that default.
        let expandedByDefault = transcriptMessage.message.activityScene?.expandedByDefault ?? false
        let isExpanded = expandedCompletedActivityIDs.contains(disclosureID) != expandedByDefault
        let title = AssistantTurnSummary.title(duration: transcriptMessage.message.turnDuration)

        workedDisclosureHeader(disclosureID: disclosureID, title: title, isExpanded: isExpanded)

        if isExpanded {
            earlierStepsButton
            activityTimeline(turn.workSegments, activeSegmentID: nil)
                .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
        }

        outcomeRow

        if !turn.finalAnswer.isEmpty {
            messageRow(
                activityMessage(
                    text: turn.finalAnswer,
                    includesAttachments: true,
                    includesTurnMetrics: true,
                    displayExcerpt: finalAnswerExcerpt(for: turn)
                ),
                isStreaming: false
            )
        }
    }

    @ViewBuilder
    private func steeredTurn(_ turn: CompletedAssistantTurn, folds: Bool) -> some View {
        let durations = turn.phaseDurations(
            totalDuration: transcriptMessage.message.turnDuration,
            finalPhaseDuration: transcriptMessage.message.activityScene?.finalPhaseDuration
        )

        // Paged rows are the earliest work, so they land ahead of the first phase.
        earlierStepsButton
        ForEach(Array(turn.phases.enumerated()), id: \.element.id) { index, phase in
            if !phase.workRows.isEmpty {
                if !folds {
                    ForEach(Array(phase.workRows.enumerated()), id: \.element.id) { rowIndex, row in
                        activityItem(
                            row,
                            at: rowIndex,
                            includesAttachments: false,
                            includesTurnMetrics: false,
                            isActive: ownsActiveStream && index == turn.phases.count - 1
                        )
                    }
                } else {
                    workedPhase(
                        phase,
                        duration: durations.indices.contains(index) ? durations[index] : nil
                    )
                }
            }

            if let steering = phase.steeringAfter {
                messageRow(ChatMessage(
                    role: "user",
                    content: steering.text,
                    timestamp: steering.submittedAt,
                    messageId: steering.id,
                    name: SteeringHintState.consumed.rawValue
                ))
            }
        }

        if !turn.finalAnswer.isEmpty {
            messageRow(
                activityMessage(
                    text: turn.finalAnswer,
                    includesAttachments: true,
                    includesTurnMetrics: true,
                    displayExcerpt: finalAnswerExcerpt(for: turn)
                ),
                isStreaming: false
            )
        }
    }

    @ViewBuilder
    private func workedPhase(_ phase: CompletedAssistantTurn.Phase, duration: Double?) -> some View {
        let disclosureID = "worked:\(transcriptMessage.anchorID):\(phase.id)"
        // Steered phases start from the server's default too; a tap flips relative to it.
        let expandedByDefault = transcriptMessage.message.activityScene?.expandedByDefault ?? false
        let isExpanded = expandedCompletedActivityIDs.contains(disclosureID) != expandedByDefault
        let title = AssistantTurnSummary.title(duration: duration)

        workedDisclosureHeader(disclosureID: disclosureID, title: title, isExpanded: isExpanded)

        if isExpanded {
            ForEach(Array(phase.workRows.enumerated()), id: \.element.id) { index, row in
                activityItem(
                    row,
                    at: index,
                    includesAttachments: false,
                    includesTurnMetrics: false,
                    isActive: false
                )
            }
            .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
        }
    }

    private func workedDisclosureHeader(
        disclosureID: String,
        title: String,
        isExpanded: Bool
    ) -> some View {
        Button {
            chatDisclosureToggled()
            withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                // Membership records a flip from the default, so toggling always flips it.
                if expandedCompletedActivityIDs.contains(disclosureID) {
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
            Divider().opacity(0.35)
        }
        .accessibilityLabel(title)
        .accessibilityHint(isExpanded ? "Double tap to collapse work." : "Double tap to expand work.")
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
                        let isActive = activeSegmentID == segment.id
                        if AssistantActivityGroupPolicy.requiresGroup(for: visibleRows) {
                            let disclosureID = "\(activeSegmentID == nil ? "completed" : "live"):\(segment.id)"
                            let isExpanded = expandedCompletedActivityIDs.contains(disclosureID)
                            let title = AssistantActivityHeaderSummary.title(for: visibleRows, isActive: isActive)
                            let titles = AssistantActivityHeaderSummary.titles(for: visibleRows, isActive: isActive)
                            VStack(alignment: .leading, spacing: 0) {
                                Button {
                                    chatDisclosureToggled()
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
                                        activityItem(
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
                        } else if let row = visibleRows.first {
                            activityItem(
                                row,
                                at: 0,
                                includesAttachments: false,
                                includesTurnMetrics: false,
                                isActive: isActive
                            )
                        }
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
                case .steering(let steering):
                    messageRow(ChatMessage(
                        role: "user",
                        content: steering.text,
                        timestamp: steering.submittedAt,
                        messageId: steering.id,
                        name: SteeringHintState.consumed.rawValue
                    ))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func activityItem(
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
        case .steering:
            EmptyView()
        }
    }

    private func isVisibleWorkRow(_ row: AssistantActivityRow) -> Bool {
        switch row.content {
        case .prose:
            true
        case .reasoning, .tools:
            showsThinkingAndToolCards
        case .steering:
            true
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
                isSessionReadOnly: isSessionReadOnly,
                canBranch: canBranch,
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
                disablesHistoryActions: disablesHistoryActions || disablesSyntheticSteeringHistoryActions,
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

    private var ownsActiveStream: Bool {
        transcriptMessage.ownsActiveStream(
            hasLiveActivity: !liveActivityRows.isEmpty,
            streamingAssistantMessageID: streamingAssistantMessageID
        )
    }

    private var disablesSyntheticSteeringHistoryActions: Bool {
        guard transcriptMessage.message.activityScene == nil else { return false }
        return activityRows.contains { row in
            if case .steering = row.content { return true }
            return false
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

    /// The server's collapsed excerpt (TAL-456) when this turn shows the scene's own final answer.
    private func finalAnswerExcerpt(for turn: CompletedAssistantTurn) -> String? {
        guard let scene = transcriptMessage.message.activityScene, scene.finalAnswer == turn.finalAnswer else { return nil }
        return scene.finalAnswerExcerpt
    }

    private func activityMessage(
        text: String,
        includesAttachments: Bool,
        includesTurnMetrics: Bool,
        displayExcerpt: String? = nil
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
            turnTps: includesTurnMetrics ? message.turnTps : nil,
            turnId: message.turnId,
            steer: message.steer,
            displayExcerpt: displayExcerpt
        )
    }
}
