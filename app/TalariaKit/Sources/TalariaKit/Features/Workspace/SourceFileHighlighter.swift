import Highlightr
import SwiftUI

/// One line of a source file as the viewer draws it: its one-based number and
/// its text in 500-character segments (see `PlainCodeBlockText.wraps`), coloured
/// when the file's grammar was highlighted.
public struct SourceLine: Identifiable, Equatable {
    public let id: Int
    public let segments: [AttributedString]

    var text: String {
        segments.map { String($0.characters) }.joined()
    }
}

public enum SourceFileLanguage {
    /// Extensions Markdown fences never use, mapped onto grammar names.
    private static let extensionAliases: [String: String] = [
        "cc": "cpp",
        "cjs": "javascript",
        "cxx": "cpp",
        "h": "c",
        "hpp": "cpp",
        "mjs": "javascript",
        "plist": "xml"
    ]

    /// The server's language wins when a grammar exists for it; the path
    /// extension is the fallback. Nil means the file draws as plain text.
    public static func resolve(path: String, serverLanguage: String?) -> String? {
        let candidates = [serverLanguage, (path as NSString).pathExtension].compactMap { $0 }
        for candidate in candidates {
            let lowered = candidate.lowercased()
            let normalized = extensionAliases[lowered] ?? MarkdownHighlightPolicy.normalizedLanguage(from: lowered)
            if let normalized, MarkdownHighlightPolicy.isHighlightable(normalized) {
                return normalized
            }
        }
        return nil
    }
}

/// Builds viewer lines off the main actor. Colour goes through the chat's
/// highlight policy and engines, so the same size limits apply; a line longer
/// than the policy's line limit is handed to the grammar blank and drawn plain,
/// and any result that no longer matches the input falls back to plain text.
/// The text is exact either way.
public actor SourceFileHighlighter {
    public static let shared = SourceFileHighlighter()

    private var highlightrsByAppearance: [Bool: Highlightr] = [:]

    public func lines(in content: String, language: String?, isDark: Bool) -> [SourceLine] {
        let plainLines = MarkdownPlainCodeFormatter.lines(in: content)
        guard let language, let coloured = highlightedLines(plainLines, language: language, isDark: isDark) else {
            return plainLines.map(plainLine)
        }
        return coloured
    }

    private func highlightedLines(_ plainLines: [MarkdownPlainCodeLine], language: String, isDark: Bool) -> [SourceLine]? {
        let texts = plainLines.map { $0.segments.map(\.text).joined() }
        let isLong = texts.map { $0.count > MarkdownHighlightPolicy.maxHighlightedCodeLineLength }
        let source = zip(texts, isLong).map { $1 ? "" : $0 }.joined(separator: "\n")

        guard case let .highlight(normalizedLanguage, _) = MarkdownHighlightPolicy.decision(
            for: source,
            language: language,
            isStreaming: false
        ) else { return nil }

        // Splash recurses once per character of a token and overflows this
        // actor's stack on a long identifier or literal, so every grammar,
        // Swift included, goes through the regex-driven Highlightr here.
        guard let attributed = highlightr(isDark: isDark)?.highlight(source, as: normalizedLanguage, fastRender: true),
              attributed.string == source
        else { return nil }
        let colouredLines = MarkdownAttributedCodeFormatter.lines(in: attributed)
        guard colouredLines.count == plainLines.count else { return nil }

        return zip(plainLines, colouredLines).map { plain, coloured in
            guard !isLong[plain.id] else { return plainLine(plain) }
            let segments = coloured.segments.map { Self.strippedOfFonts($0.attributedText) }
            // Segments are cut at UTF-16 offsets, so a pair straddling a cut
            // decodes as replacement characters; the text must stay exact.
            guard segments.map({ String($0.characters) }).joined() == texts[plain.id] else {
                return plainLine(plain)
            }
            return SourceLine(id: plain.id + 1, segments: segments)
        }
    }

    private func plainLine(_ line: MarkdownPlainCodeLine) -> SourceLine {
        SourceLine(id: line.id + 1, segments: line.segments.map { AttributedString($0.text) })
    }

    /// The engines bake their own fixed-size fonts in; the viewer's Dynamic
    /// Type font must win, so only the colour survives.
    private static func strippedOfFonts(_ attributedText: NSAttributedString) -> AttributedString {
        var attributed = AttributedString(attributedText)
        #if os(iOS)
        attributed.uiKit.font = nil
        attributed.uiKit.backgroundColor = nil
        attributed.uiKit.paragraphStyle = nil
        #else
        // macOS (tests): the engines emit AppKit attributes.
        attributed.appKit.font = nil
        attributed.appKit.backgroundColor = nil
        attributed.appKit.paragraphStyle = nil
        #endif
        return attributed
    }

    private func highlightr(isDark: Bool) -> Highlightr? {
        if let cached = highlightrsByAppearance[isDark] { return cached }
        guard let highlightr = Highlightr() else { return nil }
        highlightr.setTheme(to: isDark ? "github-dark" : "xcode")
        highlightrsByAppearance[isDark] = highlightr
        return highlightr
    }
}
