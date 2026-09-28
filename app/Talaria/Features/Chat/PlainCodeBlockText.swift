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

    private var lines: [MarkdownPlainCodeLine] {
        MarkdownPlainCodeFormatter.lines(in: content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(lines) { line in
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
