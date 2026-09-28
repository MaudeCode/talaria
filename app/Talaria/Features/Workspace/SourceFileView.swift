import SwiftUI
import TalariaKit

/// Read-only source viewer: lazy numbered rows, syntax colour prepared off the
/// main actor when the grammar is known, a wrap toggle owned by the caller, and
/// a one-based target line scrolled into view and highlighted. Copy and
/// Select Text stay with the caller, which owns the exact whole-file text.
struct SourceFileView: View {
    let content: String
    let path: String
    let serverLanguage: String?
    /// One-based; clamped into the file so an out-of-range link still lands.
    let targetLine: Int?
    let wrapsLines: Bool

    @Environment(\.colorScheme) private var colorScheme
    @State private var lines: [SourceLine] = []
    /// Widest row seen so far while not wrapping. Rows adopt it as a minimum so
    /// the horizontal extent never shrinks when a wide row scrolls away.
    @State private var contentWidth: CGFloat = 0
    @ScaledMetric(relativeTo: .callout) private var digitWidth: CGFloat = 10

    private struct HighlightRequest: Equatable {
        let content: String
        let language: String?
        let isDark: Bool
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(wrapsLines ? .vertical : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in
                        row(line)
                            .id(line.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: lines.isEmpty) { _, isEmpty in
                guard !isEmpty, let target = highlightedLine else { return }
                proxy.scrollTo(target, anchor: .center)
            }
        }
        .onChange(of: wrapsLines) { _, _ in
            contentWidth = 0
        }
        .task(id: highlightRequest) {
            let request = highlightRequest
            let prepared = await SourceFileHighlighter.shared.lines(
                in: request.content,
                language: request.language,
                isDark: request.isDark
            )
            guard !Task.isCancelled else { return }
            lines = prepared
        }
        // Source never mirrors: gutter, text and scrolling stay LTR under an RTL layout.
        .forcedLeftToRight()
    }

    private var highlightRequest: HighlightRequest {
        HighlightRequest(
            content: content,
            language: SourceFileLanguage.resolve(path: path, serverLanguage: serverLanguage),
            isDark: colorScheme == .dark
        )
    }

    private var highlightedLine: Int? {
        SourceFileNavigation.clampedTargetLine(targetLine, lineCount: lines.count)
    }

    private var gutterWidth: CGFloat {
        CGFloat(String(lines.count).count) * digitWidth
    }

    private func row(_ line: SourceLine) -> some View {
        let isTarget = line.id == highlightedLine
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: String(line.id))
                .foregroundStyle(isTarget ? Color.accentColor : Color.secondary)
                .frame(minWidth: gutterWidth, alignment: .trailing)
                .accessibilityLabel(String(localized: "Line \(line.id)"))

            lineText(line)
                .textSelection(.enabled)
                .fixedSize(horizontal: !wrapsLines, vertical: true)
                .frame(maxWidth: wrapsLines ? CGFloat.infinity : nil, alignment: .leading)
                .multilineTextAlignment(.leading)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.width
                } action: { width in
                    if !wrapsLines, width > contentWidth {
                        contentWidth = width
                    }
                }
        }
        .font(.system(.callout, design: .monospaced))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
        .frame(minWidth: wrapsLines ? nil : contentWidth, alignment: .leading)
        .background(isTarget ? Color.accentColor.opacity(0.18) : Color.clear)
        .accessibilityAddTraits(isTarget ? .isSelected : [])
    }

    private func lineText(_ line: SourceLine) -> Text {
        line.segments.reduce(Text(verbatim: "")) { partial, segment in
            partial + Text(segment)
        }
    }
}
