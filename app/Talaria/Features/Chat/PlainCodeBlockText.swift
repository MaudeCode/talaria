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

    var body: some View {
#if DEBUG
        let _ = ChatBodyEvaluationRecorder.record("diag.plainBody")
#endif
        VStack(alignment: .leading, spacing: 3) {
            ForEach(MarkdownCodeLineGroup.groups(in: content, colorsDiffLines: colorsDiffLines)) { group in
                PlainCodeLineGroup(group: group, wraps: wraps)
                    .equatable()
            }
        }
        .font(.system(size: 13, weight: .regular, design: .monospaced))
        .foregroundStyle(.primary)
    }
}

/// One group of a block's lines. While a reply streams into the block, only its open last group changes, so the
/// finished groups before it skip rebuilding their lines (TAL-1396).
private struct PlainCodeLineGroup: View, Equatable {
    let group: MarkdownCodeLineGroup
    let wraps: Bool

    var body: some View {
#if DEBUG
        let _ = ChatBodyEvaluationRecorder.record("diag.group\(group.id) n\(group.lines.count) w\(wraps)")
#endif
        VStack(alignment: .leading, spacing: 3) {
            ForEach(group.lines.indices, id: \.self) { index in
#if DEBUG
                let _ = ChatBodyEvaluationRecorder.record("codeLine")
#endif
                let text = group.lines[index].text
                let segments = MarkdownPlainCodeFormatter.segments(in: text)
                Group {
                    if wraps {
                        combinedText(for: segments)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .multilineTextAlignment(.leading)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            ForEach(segments) { segment in
                                Text(verbatim: segment.text)
                            }
                        }
                    }
                }
                .modifier(DiffLineStyle(kind: group.diffKinds.isEmpty ? .context : group.diffKinds[index], text: text))
            }
        }
    }

    private func combinedText(for segments: [MarkdownPlainCodeSegment]) -> Text {
        segments.reduce(Text(verbatim: "")) { partial, segment in
            partial + Text(verbatim: segment.text)
        }
    }
}

/// A diff line keeps the workspace diff's row tints (`GitDiffView`); headers
/// recede to the secondary colour. Context lines are left untouched.
private struct DiffLineStyle: ViewModifier {
    let kind: MarkdownDiffLineKind
    let text: String

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
            .accessibilityAddTraits(.isStaticText)
    }
}
