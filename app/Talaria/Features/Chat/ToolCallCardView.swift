import SwiftUI
import TalariaKit

struct ToolCallCardView: View {
    let toolCall: ToolCall
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @AppStorage(ChatTranscriptDisplaySettings.toolCardsStartExpandedKey) private var startsExpanded = false
    @State private var userToggledExpansion: Bool?

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
            .accessibilityLabel(String(localized: "\(AssistantActivitySummary.label(for: toolCall)), \(statusDisplay.detailText)"))
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
        let displayContent = ToolCallDisplayFormatter.content(for: toolCall)

        return VStack(alignment: .leading, spacing: 7) {
            if !displayContent.argumentRows.isEmpty {
                argumentsSection(displayContent.argumentRows)
            }

            if let result = displayContent.result {
                resultSection(result)
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

            Spacer(minLength: 6)

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
        return !content.argumentRows.isEmpty || content.result != nil || shouldShowStatusDetail(displayContent: content)
    }

    private func shouldShowStatusDetail(displayContent: ToolCallDisplayContent) -> Bool {
        let hasPrimaryContent = !displayContent.argumentRows.isEmpty || displayContent.result != nil
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
