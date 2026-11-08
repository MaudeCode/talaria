import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct ChatMarkdownView: View {
    let content: String
    let colorScheme: ColorScheme
    let isStreaming: Bool

    /// Space above a fence drawn after the Markdown: the code block's own top margin, or the bottom margin every
    /// chat block ends with, whichever is larger, as the renderer spaces them.
    private static let openFenceSpacing: CGFloat = 16

    var body: some View {
        // A fence still streaming is drawn outside the renderer, which would make it a new view on every update
        // (TAL-1396). The Markdown stays first, so its view survives the fence opening and closing.
        let openFence = isStreaming ? StreamingOpenCodeFence.trailing(in: content) : nil
        let markdown = openFence?.leadingMarkdown ?? content
        let hasMarkdown = !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 0) {
            if hasMarkdown {
                Markdown(markdown)
                    .markdownTheme(MarkdownUI.Theme.chat(colorScheme: colorScheme, isStreaming: isStreaming))
                    .markdownTextStyle {
                        ForegroundColor(.primary)
                        BackgroundColor(nil)
                    }
                    .markdownTextStyle(\.code) {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.88))
                        BackgroundColor(SwiftUI.Color(.tertiarySystemGroupedBackground))
                    }
                    .markdownCodeSyntaxHighlighter(.plainText)
            }
            if let openFence {
                MathFenceOrCodeBlock(language: openFence.language, content: openFence.code, isStreaming: true)
                    .padding(.top, hasMarkdown ? Self.openFenceSpacing : 0)
            }
        }
    }
}
