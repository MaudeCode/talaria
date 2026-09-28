import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct MathFenceOrCodeBlock: View {
    let language: String?
    let content: String
    let isStreaming: Bool

    var body: some View {
        if MathFenceLanguage.matches(language), MathLaTeX.isRenderable(content) {
            DisplayMathView(latex: content)
        } else {
            ChatCodeBlock(
                language: language,
                content: content,
                isStreaming: isStreaming
            )
        }
    }
}
