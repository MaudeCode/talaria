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

/// Records a control's frame while a message row is listening, so a long press
/// that starts on it leaves the control its own tap (TAL-485).
struct ChatMessageControlRegion: ViewModifier {
    @Environment(\.chatMessageLinkRegionStore) private var store
    @State private var controlID = UUID()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(ChatMessageInteraction.rowCoordinateSpace))
            } action: { frame in
                store?.setControlFrame(frame, forControl: controlID)
            }
            .onDisappear { store?.setControlFrame(nil, forControl: controlID) }
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
    @Environment(\.transcriptMediaParagraphImages) private var media
    @State private var paragraphID = UUID()

    /// TAL-2582: a link to each remote image follows the text, which never loads it; paragraphs, headings and table cells
    /// all draw their text here.
    @ViewBuilder
    var body: some View {
        let remote = RemoteMarkdownImage.all(in: content.renderMarkdown(), display: media?.display)
        if remote.isEmpty {
            tracked
        } else {
            VStack(alignment: .leading, spacing: 8) {
                tracked
                ForEach(remote) { RemoteMarkdownImageLink(image: $0) }
            }
        }
    }

    /// TAL-971: an inline-math image reads as an object placeholder, so text holding one reads its LaTeX instead.
    /// Selectable text ignores a label on the `Text` itself, so the label replaces the element.
    @ViewBuilder
    private var tracked: some View {
        if let spoken = InlineMathReference.spokenText(plainText: content.renderPlainText(), markdown: content.renderMarkdown()) {
            trackedLinks
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: spoken))
        } else {
            trackedLinks
        }
    }

    @ViewBuilder
    private var trackedLinks: some View {
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

    @Environment(\.transcriptMediaParagraphImages) private var media
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let media, case let nested = media.nestedImages(in: configuration.content.renderMarkdown()), !nested.isEmpty {
            // TAL-186: server images inside emphasis, which MarkdownUI does not load inline, follow the text.
            VStack(alignment: .leading, spacing: 8) {
                text
                ForEach(nested) { media.thumbnail($0) }
            }
            .markdownMargin(.paragraph)
        } else {
            text.markdownMargin(.paragraph)
        }
    }

    private var text: some View {
        ChatMarkdownLinkTrackedText(content: configuration.content, tracksLinks: tracksLinks) {
            label
        }
        .fixedSize(horizontal: false, vertical: true)
        .relativeLineSpacing(.em(0.25))
    }

    /// TAL-2024: MarkdownUI's label is one `Text` `+` per inline, which overflows the phone's stack on a long paragraph;
    /// such a paragraph draws as one `Text` instead. A paragraph with inline math draws its expressions in the line of
    /// text, which MarkdownUI does only after loading its images (TAL-971).
    @ViewBuilder
    private var label: some View {
        let markdown = configuration.content.renderMarkdown()
        if InlineMathReference.occurs(in: markdown) {
            InlineMathParagraphText(markdown: markdown, plainText: configuration.content.renderPlainText())
        } else if MarkdownContentRenderingPolicy.hasTooManyInlineElements(markdown) {
            Text(
                ChatMarkdownInlineStyle.flatParagraph(
                    markdown: markdown,
                    plainText: configuration.content.renderPlainText(),
                    colorScheme: colorScheme
                )
            )
        } else {
            configuration.label
        }
    }
}

/// The chat theme's inline text styles, shared by `Theme.chat` and the paragraphs drawn without MarkdownUI's label.
enum ChatMarkdownInlineStyle {
    static let fontSize: CGFloat = 16
    static let codeFontScale: CGFloat = 0.85
    /// The base `gitHub` theme's link color, which `Theme.chat` keeps.
    static let link = Color(light: Color(rgba: 0x2c65_cfff), dark: Color(rgba: 0x4c8e_f8ff))

    static func codeBackground(_ colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? Color(red: 0.08, green: 0.09, blue: 0.12) : Color(.tertiarySystemGroupedBackground)
    }

    /// A paragraph as one attributed string in these styles: Foundation's inline Markdown plus the bare URLs GFM
    /// autolinks. Soft breaks draw as spaces, as in MarkdownUI, so the link ranges' character offsets still apply.
    static func flatParagraph(markdown: String, plainText: String, colorScheme: ColorScheme) -> AttributedString {
        let source = markdown.trimmingCharacters(in: .newlines)
        let parsed = (try? AttributedString(
            markdown: source,
            options: .init(
                allowsExtendedAttributes: false,
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(source)

        // MarkdownUI sizes code as a scale of the fixed body size, rounded.
        let codeSize = (fontSize * codeFontScale).rounded()
        var text = AttributedString()
        for run in parsed.runs {
            let characters = parsed[run.range].characters.map { $0.isNewline ? " " : $0 }
            var piece = AttributedString(String(characters), attributes: run.attributes)
            let intent = run.inlinePresentationIntent ?? []
            let code = intent.contains(.code)
            var font = Font.system(
                size: code ? codeSize : fontSize,
                weight: intent.contains(.stronglyEmphasized) ? .semibold : .regular,
                design: code ? .monospaced : .default
            )
            if intent.contains(.emphasized) { font = font.italic() }
            piece.font = font
            piece.foregroundColor = run.link == nil ? .primary : link
            if code { piece.backgroundColor = codeBackground(colorScheme) }
            if intent.contains(.strikethrough) { piece.strikethroughStyle = .single }
            text.append(piece)
        }

        let count = text.characters.count
        for range in MarkdownLinkRanges.cachedRanges(markdown: markdown, plainText: plainText)
        where range.range.upperBound <= count {
            let lower = text.characters.index(text.startIndex, offsetBy: range.range.lowerBound)
            let upper = text.characters.index(lower, offsetBy: range.range.count)
            text[lower..<upper].link = range.url
            text[lower..<upper].foregroundColor = link
        }
        return text
    }
}

/// A Markdown heading, tracked for links (TAL-172).
///
/// The styling restates the base `gitHub` theme's six heading styles from the
/// pinned MarkdownUI 2.4.1, because installing this style replaces them; keep it
/// in step when MarkdownUI is upgraded. The h1/h2 bottom padding sits outside
/// the tracked text so the reported rects stay relative to the text itself.
struct ChatMarkdownHeading: View {
    let level: Int
    let configuration: BlockConfiguration
    let tracksLinks: Bool

    var body: some View {
        if level <= 2 {
            VStack(alignment: .leading, spacing: 0) {
                heading
                Divider().overlay(Self.divider)
            }
        } else {
            heading
        }
    }

    private var heading: some View {
        ChatMarkdownLinkTrackedText(content: configuration.content, tracksLinks: tracksLinks) {
            configuration.label
        }
        // Inside the heading's text style, so `em` resolves against its font size.
        .relativePadding(.bottom, length: .em(level <= 2 ? 0.3 : 0))
        .relativeLineSpacing(.em(0.125))
        .markdownMargin(.heading)
        .markdownTextStyle {
            FontWeight(.semibold)
            if let fontScale {
                FontSize(.em(fontScale))
            }
            if level == 6 {
                ForegroundColor(Self.tertiaryText)
            }
        }
    }

    private var fontScale: CGFloat? {
        switch level {
        case 1: 2
        case 2: 1.5
        case 3: 1.25
        case 5: 0.875
        case 6: 0.85
        default: nil
        }
    }

    private static let divider = Color(light: Color(rgba: 0xd0d0_d3ff), dark: Color(rgba: 0x3334_38ff))
    private static let tertiaryText = Color(light: Color(rgba: 0x6b6e_7bff), dark: Color(rgba: 0x6d70_7dff))
}
