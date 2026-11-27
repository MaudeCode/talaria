import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct HighlightedCodeBlockText: View {
    let content: NSAttributedString
    /// See `PlainCodeBlockText.wraps`; the concatenated `Text` preserves each
    /// segment's syntax-highlight attributes.
    var wraps = false
    var findRange: NSRange?
    @Environment(\.chatFindReveal) private var reveal
    @State private var findTextID = UUID()

    private var lines: [MarkdownAttributedCodeLine] {
        MarkdownAttributedCodeFormatter.lines(in: content)
    }

    var body: some View {
        let selected = findRange.flatMap(selectedLine)
        VStack(alignment: .leading, spacing: 3) {
            ForEach(lines) { line in
                if wraps {
                    wrappedText(for: line, range: selected?.id == line.id ? selected?.range : nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .multilineTextAlignment(.leading)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        ForEach(line.segments) { segment in
                            Text(AttributedString(segment.attributedText))
                        }
                    }
                    .background {
                        if selected?.id == line.id, let reveal {
                            Color.clear
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(ChatFindReveal.rowSpace)) } action: {
                                    reveal.scroll($0, true)
                                }
                                .id(reveal.selection)
                        }
                    }
                }
            }
        }
    }

    private func selectedLine(_ range: NSRange) -> (id: Int, range: NSRange)? {
        var offset = 0
        for (id, line) in MarkdownPlainCodeFormatter.sourceLines(in: content.string).enumerated() {
            let lineLength = line.text.utf16.count
            let intersection = NSIntersectionRange(range, NSRange(location: offset, length: lineLength))
            if intersection.length > 0 {
                return (id, NSRange(location: intersection.location - offset, length: intersection.length))
            }
            offset += lineLength + line.separator.utf16.count
        }
        return nil
    }

    @ViewBuilder
    private func wrappedText(for line: MarkdownAttributedCodeLine, range: NSRange?) -> some View {
        let text = combinedText(for: line)
        if let range {
            let source = line.segments.map { $0.attributedText.string }.joined()
            text.modifier(ChatFindTextTracking(renderer: ChatLinkRegionTextRenderer(
                links: [], expectedCharacterCount: source.count, store: nil, paragraphID: findTextID,
                highlight: ChatFindBlocks.characters(in: source, at: range), paintsHighlight: false
            )))
        } else {
            text
        }
    }

    private func combinedText(for line: MarkdownAttributedCodeLine) -> Text {
        line.segments.reduce(Text(verbatim: "")) { partial, segment in
            partial + Text(AttributedString(segment.attributedText))
        }
    }
}
