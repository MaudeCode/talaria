import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct MarkdownRenderer: View {
    let content: String
    let isStreaming: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.chatMessageLinkRegionStore) private var linkRegionStore

    init(content: String, isStreaming: Bool = false) {
        self.content = content
        self.isStreaming = isStreaming
    }

    /// Keeps the streaming renderer mounted briefly after streaming ends so
    /// the reveal queue's in-flight glyph cascade can finish instead of
    /// snapping to the solid static rendering mid-fade.
    @State private var lingersAfterStreaming = false

    var body: some View {
        Group {
            if isStreaming || lingersAfterStreaming {
                StreamingMarkdownRenderer(content: content)
            } else if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: " ")
            } else if let fallbackReason = MarkdownContentRenderingPolicy.fallbackReason(for: content) {
                PlainMarkdownFallbackView(
                    content: content,
                    reason: fallbackReason
                )
            } else {
                markdownContent
            }
        }
        .onChange(of: isStreaming) { wasStreaming, nowStreaming in
            if wasStreaming, !nowStreaming {
                lingersAfterStreaming = true
            }
        }
        .task(id: isStreaming) {
            guard !isStreaming else { return }
            try? await Task.sleep(for: .seconds(StreamingTextFadeDefaults.framePauseDelay))
            guard !Task.isCancelled else { return }
            lingersAfterStreaming = false
        }
    }

    @ViewBuilder
    private var markdownContent: some View {
        switch MarkdownMathLayoutCache.layout(for: content) {
        case .segmented(let segments):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .markdown(let markdown):
                        if !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            ChatMarkdownView(
                                content: markdown,
                                colorScheme: colorScheme,
                                isStreaming: isStreaming
                            )
                        }
                    case .displayMath(let latex):
                        DisplayMathView(latex: latex)
                    }
                }
            }
            .modifier(TranscriptAwareTextSelection(tracksLinkRegions: linkRegionStore != nil))
        case .plain(let markdown):
            ChatMarkdownView(
                content: markdown,
                colorScheme: colorScheme,
                isStreaming: isStreaming
            )
            .modifier(TranscriptAwareTextSelection(tracksLinkRegions: linkRegionStore != nil))
        }
    }
}

/// Selectable text renders through a path that skips a custom `TextRenderer`,
/// which is how a message row measures where its links landed (TAL-49). Only a
/// transcript row measures that, and only there was inline selection already
/// unreachable — the long press claims that gesture, as the bubble context menu
/// did before it — with the menu's "Select Text" action in its place. Every
/// other caller (memory, skills, workspace previews, Kanban) keeps selection.
private struct TranscriptAwareTextSelection: ViewModifier {
    let tracksLinkRegions: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if tracksLinkRegions {
            content
        } else {
            content.textSelection(.enabled)
        }
    }
}



/// One block of the streaming fade window, drawn through
/// `StreamingTextFadeRenderer` with its own stamp store so neighbouring
/// blocks' character offsets never collide. The block keeps fading after it
/// completes — it only leaves the window (and joins the solid head) once its
/// cascade is provably finished, which is what prevents end-of-block snaps.


/// Routes a fenced code block to display-math rendering when its language is a
/// math language (`math`/`latex`/`tex`) and the body parses as math; otherwise
/// renders it as a normal syntax-highlighted code block. A math fence whose
/// body SwiftMath can't parse falls back to the code block too, so nothing is
/// lost.




extension MarkdownUI.Theme {
    static func chat(colorScheme: ColorScheme, isStreaming: Bool) -> MarkdownUI.Theme {
        MarkdownUI.Theme.gitHub
            .text {
                ForegroundColor(.primary)
                BackgroundColor(nil)
                FontSize(16)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
                BackgroundColor(
                    colorScheme == .dark
                        ? SwiftUI.Color(red: 0.08, green: 0.09, blue: 0.12)
                        : SwiftUI.Color(.tertiarySystemGroupedBackground)
                )
            }
            // Restates the base theme's own paragraph metrics; the block exists so
            // a paragraph can report where its links landed (TAL-49).
            .paragraph { configuration in
                ChatMarkdownParagraph(configuration: configuration, tracksLinks: !isStreaming)
            }
            .codeBlock { configuration in
                MathFenceOrCodeBlock(
                    language: configuration.language,
                    content: configuration.content,
                    isStreaming: isStreaming
                )
                .markdownMargin(top: 4, bottom: 12)
            }
            .table { configuration in
                ChatMarkdownTable(
                    label: configuration.label,
                    colorScheme: colorScheme
                )
                .markdownMargin(top: 0, bottom: 16)
            }
            .tableCell { configuration in
                TableCellWidthCap(
                    minWidth: ChatMarkdownTable.cellMinWidth,
                    maxWidth: ChatMarkdownTable.cellMaxWidth
                ) {
                    ChatMarkdownLinkTrackedText(
                        content: configuration.content,
                        tracksLinks: !isStreaming
                    ) {
                        configuration.label
                    }
                    .markdownTextStyle {
                        if configuration.row == 0 {
                            FontWeight(.semibold)
                        }
                        BackgroundColor(nil)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 13)
                .relativeLineSpacing(.em(0.25))
            }
    }
}
