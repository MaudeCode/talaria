import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct PlainCodeBlockText: View {
    let content: String
    /// When `true`, each line's 500-char segments are concatenated into a single
    /// `Text` so SwiftUI soft-wraps the line; when `false`, they stay side by side
    /// in an `HStack` for the horizontal-scroll layout.
    var wraps = false
    /// Tints each line by its diff prefix, for `diff` and `patch` fences (TAL-447).
    var colorsDiffLines = false

    private var lines: [MarkdownPlainCodeLine] {
        MarkdownPlainCodeFormatter.lines(in: content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(lines) { line in
                let kind = colorsDiffLines
                    ? MarkdownDiffLineKind(line: line.segments.first?.text ?? "")
                    : .context
                Group {
                    if wraps {
                        combinedText(for: line)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .multilineTextAlignment(.leading)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            ForEach(line.segments) { segment in
                                Text(verbatim: segment.text)
                            }
                        }
                    }
                }
                .modifier(DiffLineStyle(kind: kind, line: line))
            }
        }
        .font(.system(size: 13, weight: .regular, design: .monospaced))
        .foregroundStyle(.primary)
    }

    private func combinedText(for line: MarkdownPlainCodeLine) -> Text {
        line.segments.reduce(Text(verbatim: "")) { partial, segment in
            partial + Text(verbatim: segment.text)
        }
    }
}

/// A diff line keeps the workspace diff's row tints (`GitDiffView`); headers
/// recede to the secondary colour. Context lines are left untouched.
private struct DiffLineStyle: ViewModifier {
    let kind: MarkdownDiffLineKind
    let line: MarkdownPlainCodeLine

    func body(content: Content) -> some View {
        switch kind {
        case .added:
            changed(content, tint: DiffLine.Kind.addition.rowBackground, label: Text("Added: \(text)"))
        case .removed:
            changed(content, tint: DiffLine.Kind.deletion.rowBackground, label: Text("Removed: \(text)"))
        case .hunkHeader:
            content.foregroundStyle(.secondary)
        case .fileHeader:
            content.foregroundStyle(.secondary).fontWeight(.semibold)
        case .context:
            content
        }
    }

    private var text: String {
        line.segments.map(\.text).joined()
    }

    /// The tint bleeds into the block's padding and the line spacing so
    /// consecutive changed lines form one band, as in the workspace diff.
    private func changed(_ content: Content, tint: SwiftUI.Color, label: Text) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                tint.padding(.horizontal, -16).padding(.vertical, -1.5)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
    }
}
