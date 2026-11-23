import SwiftMath
import SwiftUI
import UIKit
import TalariaKit

/// Renders block/display LaTeX (`$$…$$`, `\[…\]`) with the SwiftMath TeX
/// layout engine when the expression parses, and falls back to the Unicode
/// approximation (`MarkdownMathFormatter`) for anything SwiftMath can't parse.
///
/// Tolerant by design: an unparseable or partial expression degrades to the
/// previous Unicode rendering instead of crashing or showing SwiftMath's
/// inline red error. The Unicode approximation is also used as the VoiceOver
/// label on both paths, so the drawn math stays accessible.
struct DisplayMathView: View {
    let latex: String

    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var mathFontSize: CGFloat = 18

    var body: some View {
        Group {
            if MathLaTeX.isRenderable(latex) {
                ScrollView(.horizontal, showsIndicators: false) {
                    SwiftMathLabelView(
                        latex: latex,
                        fontSize: mathFontSize,
                        colorScheme: colorScheme
                    )
                    .padding(.vertical, 8)
                }
            } else {
                fallback
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(approximation)
        .padding(.vertical, 2)
        // Math/LaTeX is read left-to-right regardless of the chat direction (#259);
        // mirroring it would reverse equations inside an RTL message.
        .forcedLeftToRight()
    }

    /// The pre-SwiftMath Unicode/serif rendering, kept verbatim as the graceful
    /// fallback for expressions SwiftMath cannot parse.
    private var fallback: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(approximation)
                .font(.system(.body, design: .serif))
                .lineSpacing(4)
                .fixedSize(horizontal: true, vertical: true)
                .padding(.vertical, 8)
                .textSelection(.enabled)
        }
    }

    private var approximation: String {
        MarkdownMathFormatter.renderedText(for: latex)
    }
}

enum MathLaTeX {
    /// Renderability is a pure, deterministic function of the trimmed LaTeX
    /// string, so we memoize it. `DisplayMathView`/`MathFenceOrCodeBlock`
    /// re-check on every layout pass, and markdown-ui rebuilds code blocks on
    /// each streaming chunk — without this cache the same expression is parsed
    /// many times over. `NSCache` is thread-safe and self-evicts under memory
    /// pressure.
    nonisolated(unsafe) private static let renderableCache = NSCache<NSString, NSNumber>()

    /// True when SwiftMath can parse `latex` into a math list without error.
    /// Used to choose the SwiftMath path vs. the Unicode fallback before the
    /// `MTMathUILabel` is ever mounted, so failures never reach the screen.
    static func isRenderable(_ latex: String) -> Bool {
        let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let key = trimmed as NSString
        if let cached = renderableCache.object(forKey: key) {
            return cached.boolValue
        }

        var error: NSError?
        let mathList = MTMathListBuilder.build(fromString: trimmed, error: &error)
        let renderable = error == nil && mathList != nil
        renderableCache.setObject(NSNumber(value: renderable), forKey: key)
        return renderable
    }
}

/// What an inline expression's image depends on besides its LaTeX, drawn at the chat's body size.
struct InlineMathImageStyle: Hashable {
    let colorScheme: ColorScheme
    let scale: CGFloat
    var fontSize: CGFloat { ChatMarkdownInlineStyle.fontSize }
}

/// Inline math (TAL-971) drawn by SwiftMath into images sized and baselined for a line of text, kept in one bounded
/// cache keyed by every input of the drawing. A line draws its cached images at once; `draw` fills the cache for the
/// rest, on the main actor because SwiftMath typesets through a UIKit label.
@MainActor
enum InlineMathImages {
    struct Drawing {
        let image: CGImage
        let scale: CGFloat
        /// Points from the image's bottom edge up to the expression's baseline.
        let baseline: CGFloat
        let latex: String

        /// Bytes the bitmap holds.
        var cost: Int { image.bytesPerRow * image.height }

        /// The image as a Text attachment on the line's baseline, read aloud as its LaTeX.
        var text: Text {
            Text(Image(image, scale: scale, orientation: .up, label: Text(verbatim: latex))).baselineOffset(-baseline)
        }
    }

    struct Key: Hashable {
        let latex: String
        let style: InlineMathImageStyle
    }

    /// A bitmap holds at most this many pixels; a larger expression draws at a lower scale, so a crafted reply cannot
    /// make one image arbitrarily large.
    static let maxPixels = 1 << 20

    private final class Box {
        let drawing: Drawing
        init(_ drawing: Drawing) { self.drawing = drawing }
    }

    private static let storage: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 256
        cache.totalCostLimit = 16 * 1024 * 1024
        return cache
    }()

    /// Test seam: how many times each expression has been drawn.
    private(set) static var drawCounts: [String: Int] = [:]

    /// Test seam: start from an empty cache.
    static func removeAll() {
        storage.removeAllObjects()
        drawCounts = [:]
    }

    private static let label: MTMathUILabel = {
        let label = MTMathUILabel()
        label.labelMode = .text
        label.textAlignment = .left
        label.displayErrorInline = false
        label.contentInsets = .zero
        return label
    }()

    static func cached(_ latex: String, style: InlineMathImageStyle) -> Drawing? {
        storage.object(forKey: key(latex, style))?.drawing
    }

    @discardableResult
    static func draw(_ latex: String, style: InlineMathImageStyle) -> Drawing {
        if let cached = cached(latex, style: style) { return cached }
        let drawing = typeset(latex, style: style) ?? approximation(latex, style: style)
        drawCounts[latex, default: 0] += 1
        storage.setObject(Box(drawing), forKey: key(latex, style), cost: drawing.cost)
        return drawing
    }

    private static func key(_ latex: String, _ style: InlineMathImageStyle) -> NSString {
        "\(style.fontSize)|\(style.colorScheme == .dark)|\(style.scale)|\(latex)" as NSString
    }

    private static func color(_ style: InlineMathImageStyle) -> UIColor {
        UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: style.colorScheme == .dark ? .dark : .light))
    }

    /// A renderer at the display scale, or lower when that would pass `maxPixels`.
    private static func renderer(_ size: CGSize, _ style: InlineMathImageStyle) -> (UIGraphicsImageRenderer, CGFloat) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(style.scale, (CGFloat(maxPixels) / max(1, size.width * size.height)).squareRoot())
        format.opaque = false
        return (UIGraphicsImageRenderer(size: size, format: format), format.scale)
    }

    private static func typeset(_ latex: String, style: InlineMathImageStyle) -> Drawing? {
        guard MathLaTeX.isRenderable(latex) else { return nil }
        label.fontSize = style.fontSize
        label.textColor = color(style)
        label.latex = latex
        let size = label.intrinsicContentSize
        guard size.width > 0, size.height > 0 else { return nil }
        label.frame = CGRect(origin: .zero, size: size)
        label.layoutSubviews()
        let (renderer, scale) = renderer(size, style)
        guard let display = label.displayList,
              let image = renderer.image(actions: { context in
                  // SwiftMath draws with its origin at the bottom left.
                  context.cgContext.translateBy(x: 0, y: size.height)
                  context.cgContext.scaleBy(x: 1, y: -1)
                  display.draw(context.cgContext)
              }).cgImage
        else { return nil }
        // Where `MTMathUILabel` lays the baseline out: centred, for an expression shorter than half the font size.
        let height = max(display.ascent + display.descent, style.fontSize / 2)
        let baseline = (size.height - height) / 2 + display.descent
        return Drawing(image: image, scale: scale, baseline: baseline, latex: latex)
    }

    /// LaTeX SwiftMath cannot parse keeps the text approximation display math falls back to, drawn the same way.
    private static func approximation(_ latex: String, style: InlineMathImageStyle) -> Drawing {
        let text = MarkdownMathFormatter.renderedText(for: latex) as NSString
        let font = UIFont.systemFont(ofSize: style.fontSize)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color(style)]
        let measured = text.size(withAttributes: attributes)
        let size = CGSize(width: max(1, ceil(measured.width)), height: max(1, ceil(measured.height)))
        let (renderer, scale) = renderer(size, style)
        let image = renderer.image { _ in text.draw(at: .zero, withAttributes: attributes) }
        return Drawing(image: image.cgImage!, scale: scale, baseline: -font.descender, latex: latex)
    }
}

/// One inline expression standing alone, as MarkdownUI lays out an image-only table cell.
struct InlineMathImageView: View {
    let latex: String

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let drawing = InlineMathImages.draw(latex, style: InlineMathImageStyle(colorScheme: colorScheme, scale: displayScale))
        Image(drawing.image, scale: drawing.scale, label: Text(verbatim: latex))
    }
}

/// A paragraph holding inline math, drawn as `ChatMarkdownInlineStyle.flatParagraph` with each expression as its
/// SwiftMath image (TAL-971). Cached images draw in the same pass; an expression not yet drawn shows its text
/// approximation until its image is ready, so a token appended to a streaming reply never redraws an expression.
struct InlineMathParagraphText: View {
    let markdown: String
    let plainText: String

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    /// What this paragraph drew, so the cache evicting an image never sends it back to be drawn again.
    @State private var drawn: [InlineMathImages.Key: InlineMathImages.Drawing] = [:]

    /// Each image adds to a chain of `Text` concatenations, which overflows the stack long before MarkdownUI's limit
    /// on inline elements (TAL-2024); a paragraph with more expressions keeps their approximations in one `Text`.
    static let maxImages = 100
    /// Bytes of images one paragraph draws; expressions past it keep their approximations, so a crafted reply cannot
    /// keep the main actor drawing or the paragraph holding memory without bound.
    static let drawingBudget = 8 * 1024 * 1024

    var body: some View {
        let style = InlineMathImageStyle(colorScheme: colorScheme, scale: displayScale)
        let paragraph = ChatMarkdownInlineStyle.flatParagraph(markdown: markdown, plainText: plainText, colorScheme: colorScheme)
        let composed = Self.compose(paragraph, style: style, drawn: drawn)
        composed.text
            .task(id: composed.missing) {
                guard !composed.missing.isEmpty else { return }
                var drawings = drawn
                var spent = composed.spent
                for latex in composed.missing where spent < Self.drawingBudget {
                    await Task.yield()
                    if Task.isCancelled { return }
                    let drawing = InlineMathImages.draw(latex, style: style)
                    drawings[InlineMathImages.Key(latex: latex, style: style)] = drawing
                    spent += drawing.cost
                }
                drawn = drawings
            }
    }

    /// The paragraph as one `Text`, the bytes of the images it uses, and the expressions it still needs drawn, in
    /// order. Images are used in order, from what the paragraph drew or the cache, until they reach `drawingBudget`;
    /// later expressions keep their approximations and are never drawn.
    static func compose(
        _ paragraph: AttributedString,
        style: InlineMathImageStyle,
        drawn: [InlineMathImages.Key: InlineMathImages.Drawing] = [:]
    ) -> (text: Text, spent: Int, missing: [String]) {
        let expressions = paragraph.runs.compactMap { run in InlineMathReference.latex(from: run.imageURL).map { (run.range, $0) } }
        // Adjacent copies of one expression share a run, one character each, and each is its own attachment.
        let attachments = expressions.reduce(0) { $0 + paragraph[$1.0].characters.count }
        guard attachments <= maxImages else {
            var approximated = paragraph
            for (range, latex) in expressions.reversed() {
                approximated.characters.replaceSubrange(range, with: MarkdownMathFormatter.renderedText(for: latex))
            }
            return (Text(approximated), 0, [])
        }
        var text = Text(verbatim: "")
        var missing: [String] = []
        var spent = 0
        var used: Set<String> = []
        var cursor = paragraph.startIndex
        for (range, latex) in expressions {
            text = text + Text(AttributedString(paragraph[cursor..<range.lowerBound]))
            let withinBudget = spent < drawingBudget || used.contains(latex)
            if withinBudget,
               let drawing = drawn[InlineMathImages.Key(latex: latex, style: style)] ?? InlineMathImages.cached(latex, style: style) {
                if used.insert(latex).inserted { spent += drawing.cost }
                for _ in paragraph[range].characters { text = text + drawing.text }
            } else {
                if withinBudget, !missing.contains(latex) { missing.append(latex) }
                var approximation = AttributedString(paragraph[range])
                approximation.characters.replaceSubrange(approximation.startIndex..., with: MarkdownMathFormatter.renderedText(for: latex))
                text = text + Text(approximation)
            }
            cursor = range.upperBound
        }
        return (text + Text(AttributedString(paragraph[cursor...])), spent, missing)
    }
}
