import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit

struct ChatMarkdownView: View {
    let content: String
    let colorScheme: ColorScheme
    let isStreaming: Bool

    var body: some View {
        Markdown(content)
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
            .markdownBlockStyle(\.paragraph) { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.18))
                    .markdownMargin(top: 0, bottom: 8)
            }
    }
}
