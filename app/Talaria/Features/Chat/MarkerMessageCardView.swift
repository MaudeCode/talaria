import SwiftUI
import TalariaKit

/// Collapsible card for context-compaction marker messages, replacing the user
/// bubble they would otherwise render as. Mirrors the web UI's collapsed cards
/// and follows the `ReasoningBlockView` disclosure pattern.
struct MarkerMessageCardView: View {
    let kind: ChatMarkerMessageKind
    let content: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @State private var isExpanded = false

    var body: some View {
        let cardBody = ChatMarkerMessageClassifier.cardBody(for: kind, content: content)
        let summary = summary(for: cardBody)

        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                chatDisclosureToggled()
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                header(summary: summary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(kind.title), \(summary)")
            .accessibilityHint(isExpanded ? String(localized: "Double tap to collapse details.") : String(localized: "Double tap to expand details."))

            if isExpanded {
                Text(cardBody.isEmpty ? kind.title : cardBody)
                    .font(AppFont.caption())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .accessorySurface(
            fallbackMaterial: .thinMaterial,
            cornerRadius: 10
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var usesStackedHeader: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private var iconName: String {
        switch kind {
        case .contextCompaction:
            return "arrow.down.right.and.arrow.up.left"
        case .preservedTaskList:
            return "checklist"
        case .compressionReference:
            return "star"
        }
    }

    private func header(summary: String) -> some View {
        HStack(alignment: usesStackedHeader ? .top : .center, spacing: 8) {
            Image(systemName: iconName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18, height: 18)

            if usesStackedHeader {
                VStack(alignment: .leading, spacing: 1) {
                    titleText
                    summaryText(summary, lineLimit: 2)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    titleText
                    summaryText(summary, lineLimit: 1)
                }
            }

            Spacer(minLength: 6)

            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    private var titleText: some View {
        Text(kind.title)
            .font(AppFont.caption(weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)
    }

    private func summaryText(_ value: String, lineLimit: Int) -> some View {
        Text(value)
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
            .lineLimit(lineLimit)
    }

    private func summary(for value: String) -> String {
        let oneLine = value
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // The synthesized anchor card mirrors the web UI's
        // "Reference only · <preview>" collapsed line.
        if kind == .compressionReference {
            guard !oneLine.isEmpty else { return String(localized: "Reference only") }
            return String(localized: "Reference only · \(truncated(oneLine))")
        }

        if oneLine.isEmpty {
            return kind.title
        }

        return truncated(oneLine)
    }

    private func truncated(_ oneLine: String) -> String {
        if oneLine.count <= 80 {
            return oneLine
        }

        return "\(oneLine.prefix(80))..."
    }
}

/// An automatic background wakeup (TAL-460): one quiet line per finished item, never the user's bubble. The Agent's
/// reply follows as an ordinary message; tapping the lines shows the full notification.
struct BackgroundUpdateLinesView: View {
    let update: BackgroundUpdate
    let message: ChatMessage

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.chatDisclosureToggled) private var chatDisclosureToggled
    @State private var isExpanded = false
    @State private var showsFullBody = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                chatDisclosureToggled()
                withAnimation(ChatMotion.disclosure(reduceMotion: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(update.lines.enumerated()), id: \.offset) { _, line in
                        BackgroundLineRow(line: line)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(update.lines.map(BackgroundLineRow.text(for:)).joined(separator: ", "))
            .accessibilityHint(isExpanded ? String(localized: "Double tap to collapse details.") : String(localized: "Double tap to expand details."))
            .accessibilityIdentifier("background-update-lines")

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: bodyText)
                        .font(AppFont.caption())
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if message.displayExcerpt != nil {
                        Button(showsFullBody ? String(localized: "Show less") : String(localized: "Show more")) {
                            showsFullBody.toggle()
                        }
                        .font(AppFont.caption())
                        .buttonStyle(.borderless)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .accessorySurface(fallbackMaterial: .thinMaterial, cornerRadius: 10)
                .transition(ChatMotion.disclosureTransition(reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var bodyText: String {
        if !showsFullBody, let excerpt = message.displayExcerpt { return excerpt }
        return message.content ?? ""
    }
}

private struct BackgroundLineRow: View {
    let line: BackgroundLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(line.status == .failed ? Color.orange : Color.secondary)
            styledText
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var icon: String {
        switch line.status {
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.triangle.fill"
        case .notice: "info.circle"
        }
    }

    /// The command is set in code type; every other line is its plain wording.
    private var styledText: Text {
        guard line.kind == .command else { return Text(verbatim: Self.text(for: line)) }
        let command = Text(verbatim: line.label).font(AppFont.mono(style: .footnote))
        switch (line.status, line.exitCode) {
        case (.failed, let code?):
            return Text("Background command \(command) failed (exit \(code))")
        case (.failed, nil):
            return Text("Background command \(command) failed")
        default:
            return Text("Background command \(command) finished")
        }
    }

    static func text(for line: BackgroundLine) -> String {
        switch (line.kind, line.status, line.exitCode) {
        case (.agent, .failed, _):
            return String(localized: "Agent “\(line.label)” failed")
        case (.agent, _, _):
            return String(localized: "Agent “\(line.label)” completed")
        case (.command, .failed, let code?):
            return String(localized: "Background command \(line.label) failed (exit \(code))")
        case (.command, .failed, nil):
            return String(localized: "Background command \(line.label) failed")
        case (.command, _, _):
            return String(localized: "Background command \(line.label) finished")
        case (.other, _, _):
            return line.label
        }
    }
}
