import CoreGraphics

/// One piece of a Markdown file preview, drawn lazily on its own (TAL-844).
public struct MarkdownPreviewChunk: Identifiable, Equatable, Sendable {
    public let id: Int
    public let text: String
    /// The gap one document would draw between this chunk's first block and the block before it; zero for the first.
    public let topSpacing: CGFloat

    public init(id: Int, text: String, topSpacing: CGFloat) {
        self.id = id
        self.text = text
        self.topSpacing = topSpacing
    }

    /// The file in fence-aware pieces, or whole as one piece when it is short, has no safe boundary, or falls back to
    /// plain text.
    public static func chunks(for markdown: String) -> [MarkdownPreviewChunk] {
        let whole = [MarkdownPreviewChunk(id: 0, text: markdown, topSpacing: 0)]
        guard MarkdownContentRenderingPolicy.fallbackReason(for: markdown) == nil else { return whole }
        let segments = StreamingMarkdownBlockSplitter.split(markdown)
        guard !segments.stableChunks.isEmpty else { return whole }

        var texts = segments.stableChunks.map(\.text)
        if !segments.activeMarkdown.allSatisfy(\.isWhitespace) {
            texts.append(segments.activeMarkdown)
        }
        return texts.enumerated().map { index, text in
            let topSpacing = index == 0 ? 0 : max(
                ChatMarkdownBlockMargin.closing(texts[index - 1]).bottom,
                ChatMarkdownBlockMargin.opening(text).top
            )
            return MarkdownPreviewChunk(id: index, text: text, topSpacing: topSpacing)
        }
    }
}

/// The chat Markdown theme's block margins in points, read by the theme and by the preview's seams (TAL-844).
///
/// MarkdownUI separates two blocks by the larger of the first's bottom margin and the second's top margin. Thematic
/// breaks and list items keep the base `gitHub` theme's margins from the pinned MarkdownUI 2.4.1 (a list item's
/// `0.25em` at the chat's 16-point text); a list or quote reports its paragraphs' margins.
public struct ChatMarkdownBlockMargin: Equatable, Sendable {
    public let top: CGFloat
    public let bottom: CGFloat

    public static let paragraph = Self(top: 0, bottom: 16)
    public static let heading = Self(top: 24, bottom: 16)
    public static let codeBlock = Self(top: 4, bottom: 12)
    public static let table = Self(top: 0, bottom: 16)
    static let thematicBreak = Self(top: 24, bottom: 24)
    static let list = Self(top: 4, bottom: 16)

    /// The margins of the block `markdown` opens with.
    // ponytail: first-line classification; a list or quote whose first item holds a heading or code block reports
    // that block's larger top margin in MarkdownUI. Measure the rendered seam if one is ever visibly off.
    static func opening(_ markdown: String) -> Self {
        guard let line = markdown.split(separator: "\n", omittingEmptySubsequences: true)
            .first(where: { !$0.allSatisfy(\.isWhitespace) }) else { return .paragraph }
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        if line.count - trimmed.count >= 4 { return .codeBlock }
        if StreamingMarkdownBlockSplitter.isHeading(trimmed) { return .heading }
        if StreamingOpenCodeFence.fenceRun(in: trimmed) != nil { return .codeBlock }
        if isThematicBreak(trimmed) { return .thematicBreak }
        if trimmed.first == "|" { return .table }
        if isListMarker(trimmed) { return .list }
        return .paragraph
    }

    /// The margins of the block `markdown` closes with. Only a code block or thematic break ends on a bottom margin
    /// other than 16 points.
    static func closing(_ markdown: String) -> Self {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false)
        guard let lastIndex = lines.lastIndex(where: { !$0.allSatisfy(\.isWhitespace) }) else { return .paragraph }
        let last = lines[lastIndex]
        if let fence = StreamingOpenCodeFence.fenceRun(in: last), fence.indent == 0 { return .codeBlock }
        // `---` right under a paragraph line underlines a heading instead.
        let underlinesParagraph = last.first == "-" && lastIndex > 0 && !lines[lastIndex - 1].allSatisfy(\.isWhitespace)
        return isThematicBreak(last) && !underlinesParagraph ? .thematicBreak : .paragraph
    }

    private static func isThematicBreak(_ line: Substring) -> Bool {
        let marks = line.filter { !$0.isWhitespace }
        guard let mark = marks.first, "-*_".contains(mark) else { return false }
        return marks.count >= 3 && marks.allSatisfy { $0 == mark }
    }

    private static func isListMarker(_ line: Substring) -> Bool {
        if let marker = line.first, "-*+".contains(marker) {
            return line.dropFirst().first?.isWhitespace == true
        }
        let digits = line.prefix(while: \.isNumber)
        guard (1...9).contains(digits.count), let delimiter = line.dropFirst(digits.count).first,
              delimiter == "." || delimiter == ")" else { return false }
        return line.dropFirst(digits.count + 1).first?.isWhitespace == true
    }
}
