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
    /// The reader's place, kept by a host that shows this file in more than one place (TAL-1540).
    var scrollOffset: Binding<CGPoint>?

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
            .keepsScrollOffset(targetLine == nil ? scrollOffset : nil)
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

extension View {
    /// Keeps the reader's place in `offset` and, once the content reaches it again, scrolls back there: a second copy of
    /// the same view opens where the first was left (TAL-1540). Nil leaves the scroll view as it is.
    @ViewBuilder
    func keepsScrollOffset(_ offset: Binding<CGPoint>?) -> some View {
        if let offset { modifier(ScrollOffsetKeeping(offset: offset)) } else { self }
    }
}

private struct ScrollOffsetKeeping: ViewModifier {
    @Binding var offset: CGPoint
    @State private var position = ScrollPosition()
    @State private var restored = false

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geometry in
                guard restored else {
                    // Lazily loaded rows arrive after the first layout; wait until the content reaches the kept place.
                    // ponytail: a file that shrank below its kept place opens at its top and keeps no new place.
                    if offset == .zero {
                        restored = true
                    } else if geometry.contentSize.height >= offset.y + geometry.containerSize.height {
                        position.scrollTo(point: offset)
                        restored = true
                    }
                    return
                }
                offset = geometry.contentOffset
            }
    }
}
