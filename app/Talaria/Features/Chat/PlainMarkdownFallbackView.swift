import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct PlainMarkdownFallbackView: View {
    let content: String
    let reason: MarkdownContentFallbackReason

    private let logger = Logger.talariaMarkdownRendering

    var body: some View {
        Text(verbatim: content)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .onAppear {
                logger.info(
                    "Markdown plain fallback reason=\(reason.rawValue, privacy: .public) characters=\(content.count, privacy: .public) lines=\(MarkdownHighlightPolicy.lineCount(in: content), privacy: .public)"
                )
            }
    }
}
