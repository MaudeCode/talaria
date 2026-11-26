import SwiftUI
import TalariaKit

struct ToolActivityGroupView: View {
    let group: ToolCallGroup
    var isLive = false
    @Environment(\.chatOpenScreen) private var openScreen

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(ToolCallRun.runs(group.toolCalls)) { run in
                if let count = run.mergedCount, let head = run.calls.first {
                    MergedToolCallsView(head: head, count: count, calls: run.calls)
                } else {
                    ForEach(run.calls) { toolCall in
                        ToolCallCardView(toolCall: toolCall)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.chatOpenScreen, isLive ? openScreen : nil)
        .accessibilityElement(children: .contain)
    }
}

/// TAL-2332: consecutive successful calls of one kind the server merged: one row named for them that expands to each call.
private struct MergedToolCallsView: View {
    let head: ToolCall
    let count: Int
    let calls: [ToolCall]
    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let title = AssistantActivitySummary.mergedTitle(for: head, count: count)
        VStack(alignment: .leading, spacing: 2) {
            Button {
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    ToolActivityIcon(name: AssistantActivitySummary.icon(for: head))
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 16)
                    Text(title)
                        .font(AppFont.callout())
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
            .accessibilityLabel(title)
            .accessibilityHint(isExpanded ? "Double tap to collapse work." : "Double tap to expand work.")

            if isExpanded {
                // Indented under the row, so the calls after it read as the group's own.
                ForEach(calls) { toolCall in
                    ToolCallCardView(toolCall: toolCall)
                }
                .padding(.leading, 16)
                .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
    }
}
