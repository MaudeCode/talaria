import Foundation
import SwiftUI

/// A rendered link's hit target inside a message row, in the row's coordinate
/// space. A link that wraps contributes one region per line fragment.
public struct ChatMessageLinkRegion: Equatable {
    let rect: CGRect
    let url: URL

    public init(rect: CGRect, url: URL) {
        self.rect = rect
        self.url = url
    }
}

/// A link's character range inside a paragraph's rendered plain text.
public struct MarkdownLinkRange: Equatable {
    public let range: Range<Int>
    public let url: URL
}

/// Locates a paragraph's links in the same character space the text renderer
/// walks, so a press point can be resolved to a link without asking SwiftUI —
/// which exposes neither link geometry nor an accessibility tree while no
/// assistive technology is attached.
///
/// `MarkdownUI` renders inline links through `AttributedString`, whose link
/// attribute is invisible to `TextRenderer`. What a run *does* report is how
/// many characters it drew, and runs break at attribute boundaries, so counting
/// characters in reading order maps every run onto this paragraph's plain text.
///
/// The ranges come from Foundation's Markdown parser plus the same bare-URL
/// autolinking `MarkdownUI` enables (GFM `autolink`). Both parses must agree on
/// the paragraph's plain text; when they don't, the paragraph reports no links
/// at all, so a mismatch degrades to the message menu instead of stealing a
/// press from it.
public enum MarkdownLinkRanges {
    static func ranges(markdown: String, plainText: String) -> [MarkdownLinkRange] {
        let expected = normalized(plainText)
        guard !expected.isEmpty else { return [] }

        // A heading block's Markdown keeps its ATX marker (`## `), which is not
        // drawn. A paragraph never starts with one: cmark escapes a leading `#`.
        guard let attributed = try? AttributedString(
            markdown: markdown.replacing(/^#{1,6}[ \t]+/, with: ""),
            options: AttributedString.MarkdownParsingOptions(
                allowsExtendedAttributes: false,
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) else {
            return []
        }

        let parsed = normalized(String(attributed.characters))
        guard parsed == expected else { return [] }

        var ranges: [MarkdownLinkRange] = []
        for run in attributed.runs {
            guard let url = run.link else { continue }
            let lower = attributed.characters.distance(from: attributed.startIndex, to: run.range.lowerBound)
            let upper = attributed.characters.distance(from: attributed.startIndex, to: run.range.upperBound)
            guard lower < upper else { continue }
            ranges.append(MarkdownLinkRange(range: lower..<upper, url: url))
        }

        return (ranges + autolinkRanges(in: expected, excluding: ranges)).sorted {
            $0.range.lowerBound < $1.range.lowerBound
        }
    }

    /// `MarkdownUI` parses with GFM's `autolink` extension, so a bare URL is a
    /// link on screen even though Foundation leaves it as plain text. Detected
    /// matches are narrowed to the shapes that extension linkifies, so ordinary
    /// prose ("read chapter 2.1") never swallows a message press.
    private static func autolinkRanges(
        in plainText: String,
        excluding linked: [MarkdownLinkRange]
    ) -> [MarkdownLinkRange] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return []
        }

        let text = plainText as NSString
        let matches = detector.matches(in: plainText, range: NSRange(location: 0, length: text.length))

        return matches.compactMap { match -> MarkdownLinkRange? in
            guard let url = match.url else { return nil }
            let matched = text.substring(with: match.range)
            guard isAutolinked(matched) else { return nil }

            guard let lower = characterOffset(in: plainText, utf16Offset: match.range.location),
                  let upper = characterOffset(in: plainText, utf16Offset: match.range.location + match.range.length)
            else {
                return nil
            }

            let range = lower..<upper
            guard !linked.contains(where: { $0.range.overlaps(range) }) else { return nil }
            return MarkdownLinkRange(range: range, url: url)
        }
    }

    private static func isAutolinked(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        return lowercased.hasPrefix("http://")
            || lowercased.hasPrefix("https://")
            || lowercased.hasPrefix("www.")
            || lowercased.hasPrefix("mailto:")
            || (text.contains("@") && !text.contains("/"))
    }

    private static func characterOffset(in text: String, utf16Offset: Int) -> Int? {
        let index = String.Index(utf16Offset: utf16Offset, in: text)
        guard index <= text.endIndex else { return nil }
        return text.distance(from: text.startIndex, to: index)
    }

    /// `cmark`'s plain-text rendering ends the block with a newline, and a soft
    /// break inside the paragraph draws as a space. Both are folded away so the
    /// comparison — and the character count the renderer validates against —
    /// describe the same string the paragraph draws.
    private static func normalized(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .newlines)
            .replacingOccurrences(of: "\n", with: " ")
    }

    /// Parsing is pure over the paragraph's Markdown, and SwiftUI re-evaluates
    /// transcript bodies for reasons unrelated to the text, so results are
    /// memoized the way `MarkdownMathLayoutCache` memoizes segmentation.
    private static let cache: NSCache<NSString, CachedRanges> = {
        let cache = NSCache<NSString, CachedRanges>()
        cache.countLimit = 240
        return cache
    }()

    private final class CachedRanges {
        let ranges: [MarkdownLinkRange]
        init(_ ranges: [MarkdownLinkRange]) { self.ranges = ranges }
    }

    public static func cachedRanges(markdown: String, plainText: String) -> [MarkdownLinkRange] {
        let key = markdown as NSString
        if let cached = cache.object(forKey: key) { return cached.ranges }
        let ranges = self.ranges(markdown: markdown, plainText: plainText)
        cache.setObject(CachedRanges(ranges), forKey: key)
        return ranges
    }
}

/// The link and control geometry of one message row, filled in by the
/// paragraphs and controls it renders and read by the long-press handler.
///
/// `TextRenderer.draw` is not bound to an actor, so access is serialized with a
/// lock rather than actor isolation — the same arrangement
/// `StreamingTextFadeStampStore` uses.
public final class ChatMessageLinkRegionStore: @unchecked Sendable {
    private struct Paragraph {
        var origin: CGPoint = .zero
        var regions: [ChatMessageLinkRegion] = []
    }

    private let lock = NSLock()
    private var paragraphs: [UUID: Paragraph] = [:]
    private var controls: [UUID: CGRect] = [:]

    public init() {}

    /// The paragraph's position inside the message row, published from layout.
    public func setOrigin(_ origin: CGPoint, forParagraph id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        paragraphs[id, default: Paragraph()].origin = origin
    }

    /// Link rects in the paragraph's own coordinate space, published from draw.
    public func setRegions(_ regions: [ChatMessageLinkRegion], forParagraph id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        paragraphs[id, default: Paragraph()].regions = regions
    }

    public func removeParagraph(_ id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        paragraphs.removeValue(forKey: id)
    }

    /// A control's frame in the row's coordinate space; nil removes it.
    public func setControlFrame(_ frame: CGRect?, forControl id: UUID) {
        lock.lock()
        defer { lock.unlock() }
        controls[id] = frame
    }

    /// Every control frame in the row's coordinate space.
    public func controlRegions() -> [CGRect] {
        lock.lock()
        defer { lock.unlock() }
        return Array(controls.values)
    }

    /// Every link hit target in the row's coordinate space.
    public func regions() -> [ChatMessageLinkRegion] {
        lock.lock()
        defer { lock.unlock() }
        return paragraphs.values.flatMap { paragraph in
            paragraph.regions.map {
                ChatMessageLinkRegion(
                    rect: $0.rect.offsetBy(dx: paragraph.origin.x, dy: paragraph.origin.y),
                    url: $0.url
                )
            }
        }
    }
}

public enum ChatMessageInteraction {
    /// Coordinate space of one message row: link regions, the row's marker view,
    /// and the press point are all resolved in it.
    public static let rowCoordinateSpace = "chat-message-row"
}
