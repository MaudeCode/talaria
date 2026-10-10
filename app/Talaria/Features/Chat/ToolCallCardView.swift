import SwiftUI
import TalariaKit

struct ToolCallCardView: View {
    let toolCall: ToolCall
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @Environment(\.chatFullToolResultLoader) private var loadFullToolResult
    @AppStorage(ChatTranscriptDisplaySettings.toolCardsStartExpandedKey) private var startsExpanded = false
    @State private var userToggledExpansion: Bool?
    /// TAL-331: the whole result of a call the server clipped or capped, once the reader asked for it.
    @State private var fullResult: ToolResultView?
    @State private var isLoadingFullResult = false
    @State private var fullResultFailed = false

    private var isExpanded: Bool {
        ChatTranscriptDisplaySettings.isCardExpanded(
            userToggled: userToggledExpansion,
            startsExpanded: startsExpanded
        )
    }

    var body: some View {
        let statusDisplay = ToolCallStatusDisplay(toolCall: toolCall)

        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                chatDisclosureToggled()
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                    userToggledExpansion = !isExpanded
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Self.accessibilityText(for: toolCall, detail: statusDisplay.detailText))
            .accessibilityHint(isExpanded ? "Double tap to collapse details." : "Double tap to expand details.")

            if isExpanded {
                expandedContent(statusDisplay: statusDisplay)
                    .padding(.leading, 24)
                    .forcedLeftToRight()
                    .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func expandedContent(statusDisplay: ToolCallStatusDisplay) -> some View {
        var shownCall = toolCall
        if let fullResult {
            shownCall.resultView = fullResult
        }
        let displayContent = ToolCallDisplayFormatter.content(for: shownCall)

        return VStack(alignment: .leading, spacing: 7) {
            // TAL-448: a file edit shows its change; its arguments and result restate the same diff.
            if let editDiff = toolCall.editDiff {
                editDiffSection(editDiff)
            } else {
                if !displayContent.argumentRows.isEmpty {
                    argumentsSection(displayContent.argumentRows)
                }

                if let result = displayContent.result {
                    resultSection(result)
                }
            }

            if toolCall.resultTruncated, fullResult == nil, loadFullToolResult != nil {
                fullResultButton
            }

            if shouldShowStatusDetail(displayContent: displayContent) {
                statusDetail(statusDisplay.detailText)
            }
        }
    }

    private var usesStackedHeader: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: statusIcon)
                .font(.system(size: 14))
                .foregroundStyle(statusColor)
                .frame(width: 16, height: 16)

            titleText

            // TAL-448: a file edit's added and removed line counts, beside its label.
            if let editDiff = toolCall.editDiff {
                DiffCountsLabel(additions: editDiff.added, deletions: editDiff.removed)
                    .fixedSize()
            }

            Spacer(minLength: 6)

            // TAL-372: a delegation row shows its subagents' progress, updated in place as they finish.
            if let background = toolCall.background {
                Text(Self.backgroundSummary(background))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if hasExpandableContent {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// The row's spoken label: what the call did, its status, a file edit's counts, and a delegation's progress.
    static func accessibilityText(for toolCall: ToolCall, detail: String) -> String {
        var label = String(localized: "\(AssistantActivitySummary.label(for: toolCall)), \(detail)")
        if let editDiff = toolCall.editDiff {
            label += ", \(String(localized: "\(editDiff.added) added")), \(String(localized: "\(editDiff.removed) removed"))"
        }
        guard let background = toolCall.background else { return label }
        return "\(label), \(Self.backgroundSummary(background))"
    }

    static func backgroundSummary(_ link: BackgroundLink) -> String {
        let counts = BackgroundWorkCard.agentsSummary(link.agents)
        switch link.status {
        case .running, .completed: return counts
        default: return "\(BackgroundWorkCard.statusLabel(link.status)) · \(counts)"
        }
    }

    private var titleText: some View {
        ActivityGlowText(
            text: AssistantActivitySummary.label(for: toolCall),
            isActive: !toolCall.isCompleted && toolCall.isError != true
        )
            .font(AppFont.callout())
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var statusIcon: String {
        if toolCall.isError == true {
            return "exclamationmark.triangle.fill"
        }

        return AssistantActivitySummary.icon(for: toolCall)
    }

    private var statusColor: Color {
        if toolCall.isError == true {
            return .red
        }

        return .secondary
    }

    private var hasExpandableContent: Bool {
        let content = ToolCallDisplayFormatter.content(for: toolCall)
        return toolCall.editDiff != nil || !content.argumentRows.isEmpty || content.result != nil || shouldShowStatusDetail(displayContent: content)
    }

    private func shouldShowStatusDetail(displayContent: ToolCallDisplayContent) -> Bool {
        let hasPrimaryContent = toolCall.editDiff != nil || !displayContent.argumentRows.isEmpty || displayContent.result != nil
        return !hasPrimaryContent || !toolCall.isCompleted || toolCall.isError == true || toolCall.duration != nil
    }

    private func statusDetail(_ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Status")
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            Text(value)
                .font(AppFont.caption())
                .foregroundStyle(statusColor)
                .textSelection(.enabled)
        }
    }

    private func argumentsSection(_ rows: [ToolCallArgumentDisplay]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Arguments")
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(rows) { row in
                    argumentRow(row)
                }
            }
            .padding(7)
            .chatTimelineAccessoryInsetSurface()
        }
    }

    private var fullResultButton: some View {
        Button {
            Task { await showFullResult() }
        } label: {
            Text(isLoadingFullResult ? String(localized: "Loading…") : fullResultFailed ? String(localized: "Retry") : String(localized: "Show full output"))
                .font(AppFont.caption(weight: .semibold))
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(isLoadingFullResult)
    }

    private func showFullResult() async {
        guard let loadFullToolResult, !isLoadingFullResult else { return }
        isLoadingFullResult = true
        defer { isLoadingFullResult = false }
        do {
            let result = try await loadFullToolResult(toolCall.id)
            chatDisclosureToggled()
            fullResultFailed = false
            fullResult = result
        } catch {
            fullResultFailed = true
        }
    }

    private func resultSection(_ result: ToolCallResultDisplay) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(result.title)
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            Text(result.text)
                .font(result.isMonospaced ? AppFont.mono(style: .caption) : AppFont.caption())
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(7)
                .chatTimelineAccessoryInsetSurface()
        }
    }

    /// The diff in the workspace diff view's rows, each hunk under its line label; long lines wrap.
    private func editDiffSection(_ editDiff: ToolEditDiff) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Changes")
                .font(AppFont.caption2(weight: .semibold))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(editDiff.hunks) { hunk in
                    Text(hunk.displayLabel)
                        .font(AppFont.mono(style: .caption))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemBackground))
                    ForEach(hunk.lines) { DiffLineRow(line: $0) }
                }
            }
            .textSelection(.enabled)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

            if editDiff.truncated {
                Text("Diff truncated")
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func argumentRow(_ row: ToolCallArgumentDisplay) -> some View {
        if usesStackedHeader {
            VStack(alignment: .leading, spacing: 2) {
                argumentKey(row.key)
                argumentValue(row.value)
            }
        } else {
            HStack(alignment: .top, spacing: 7) {
                argumentKey(row.key)
                    .frame(width: 78, alignment: .leading)

                argumentValue(row.value)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func argumentKey(_ value: String) -> some View {
        Text(value)
            .font(AppFont.mono(style: .caption2, weight: .semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }

    private func argumentValue(_ value: String) -> some View {
        Text(value)
            .font(AppFont.mono(style: .caption))
            .foregroundStyle(.primary)
            .textSelection(.enabled)
    }
}

/// TAL-331: fetches the whole result of a tool call the server clipped; the chat screen supplies it for its session.
struct ChatFullToolResultLoaderKey: EnvironmentKey {
    static let defaultValue: (@MainActor (String) async throws -> ToolResultView)? = nil
}

extension EnvironmentValues {
    var chatFullToolResultLoader: (@MainActor (String) async throws -> ToolResultView)? {
        get { self[ChatFullToolResultLoaderKey.self] }
        set { self[ChatFullToolResultLoaderKey.self] = newValue }
    }
}
