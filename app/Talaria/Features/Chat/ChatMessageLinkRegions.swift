import MarkdownUI
import SwiftUI
import TalariaKit

/// Draws the paragraph unchanged and records where its links landed.
struct ChatLinkRegionTextRenderer: TextRenderer {
    let links: [MarkdownLinkRange]
    /// Characters the paragraph is expected to draw. A layout that reports a
    /// different total is not the text these ranges describe, so its regions
    /// are dropped rather than guessed at.
    let expectedCharacterCount: Int
    let store: ChatMessageLinkRegionStore
    let paragraphID: UUID

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        var offset = 0
        var regions: [ChatMessageLinkRegion] = []

        for line in layout {
            for run in line {
                let count = run.reduce(0) { $0 + $1.characterIndices.count }
                let runRange = offset..<(offset + count)
                offset += count

                if let link = links.first(where: { $0.range.overlaps(runRange) }) {
                    regions.append(
                        ChatMessageLinkRegion(rect: run.typographicBounds.rect, url: link.url)
                    )
                }

                ctx.draw(run)
            }
        }

        store.setRegions(offset == expectedCharacterCount ? regions : [], forParagraph: paragraphID)
    }
}

private struct ChatMessageLinkRegionStoreKey: EnvironmentKey {
    static let defaultValue: ChatMessageLinkRegionStore? = nil
}

extension EnvironmentValues {
    /// Set by a message row that offers long-press actions; nil everywhere else,
    /// which is what keeps link tracking off the rows that cannot use it.
    var chatMessageLinkRegionStore: ChatMessageLinkRegionStore? {
        get { self[ChatMessageLinkRegionStoreKey.self] }
        set { self[ChatMessageLinkRegionStoreKey.self] = newValue }
    }
}

/// Markdown inline text that reports where its links landed while a message row
/// is listening. Without a store — every other `Markdown` in the app — it
/// renders exactly as before, with no renderer attached.
///
/// The label must be the text itself, not a padded container: the rects the
/// renderer reports are relative to the text's own origin.
///
/// Streaming text is left alone. Its fade is drawn by `TextRenderer` too, and
/// this one would sit closer to the `Text` and replace it; a link becomes a hit
/// target once its message settles.
struct ChatMarkdownLinkTrackedText<Label: View>: View {
    let content: MarkdownContent
    let tracksLinks: Bool
    @ViewBuilder let label: Label

    @Environment(\.chatMessageLinkRegionStore) private var store
    @State private var paragraphID = UUID()

    @ViewBuilder
    var body: some View {
        if tracksLinks, let store, case let links = self.links, !links.isEmpty {
            label
                .textRenderer(
                    ChatLinkRegionTextRenderer(
                        links: links,
                        expectedCharacterCount: plainTextCount,
                        store: store,
                        paragraphID: paragraphID
                    )
                )
                .onGeometryChange(for: CGPoint.self) { proxy in
                    proxy.frame(in: .named(ChatMessageInteraction.rowCoordinateSpace)).origin
                } action: { origin in
                    store.setOrigin(origin, forParagraph: paragraphID)
                }
                .onDisappear { store.removeParagraph(paragraphID) }
        } else {
            label
        }
    }

    private var links: [MarkdownLinkRange] {
        MarkdownLinkRanges.cachedRanges(
            markdown: content.renderMarkdown(),
            plainText: content.renderPlainText()
        )
    }

    private var plainTextCount: Int {
        content
            .renderPlainText()
            .trimmingCharacters(in: .newlines)
            .replacingOccurrences(of: "\n", with: " ")
            .count
    }
}

/// A Markdown paragraph, tracked for links.
///
/// The styling repeats what the base `gitHub` theme applies to a paragraph,
/// because installing this style replaces that one.
struct ChatMarkdownParagraph: View {
    let configuration: BlockConfiguration
    let tracksLinks: Bool

    var body: some View {
        ChatMarkdownLinkTrackedText(content: configuration.content, tracksLinks: tracksLinks) {
            configuration.label
        }
        .fixedSize(horizontal: false, vertical: true)
        .relativeLineSpacing(.em(0.25))
        .markdownMargin(top: 0, bottom: 16)
    }
}
