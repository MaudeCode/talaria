import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct StreamingMarkdownRenderer: View {
    let content: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var displayedContent: String

    init(content: String) {
        self.content = content
        _displayedContent = State(initialValue: content)
    }

    var body: some View {
        Group {
            if displayedContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: " ")
            } else if let fallbackReason = MarkdownContentRenderingPolicy.fallbackReason(for: displayedContent) {
                PlainMarkdownFallbackView(
                    content: displayedContent,
                    reason: fallbackReason
                )
            } else {
                streamingMarkdownContent
            }
        }
        .task(id: content) {
            await Task.yield()
            guard !Task.isCancelled else { return }
            guard displayedContent != content else { return }
            displayedContent = content
        }
    }

    @ViewBuilder
    private var streamingMarkdownContent: some View {
        // Streaming text changes on nearly every token, so this deliberately
        // does not memoize; it only avoids the redundant second full-string
        // `replacingInlineMath` pass the no-math branch used to run.
        switch MarkdownMathLayoutCache.uncachedLayout(for: displayedContent) {
        case .segmented(let segments):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .markdown(let markdown):
                        if !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            StreamingMarkdownChunkedView(
                                content: markdown,
                                colorScheme: colorScheme
                            )
                        }
                    case .displayMath(let latex):
                        DisplayMathView(latex: latex)
                    }
                }
            }
        case .plain(let markdown):
            StreamingMarkdownChunkedView(
                content: markdown,
                colorScheme: colorScheme
            )
        }
    }

}
