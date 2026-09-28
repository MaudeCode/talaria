import Foundation
import Highlightr
import OSLog
import Splash
import SwiftUI

public struct MarkdownPlainCodeLine: Equatable, Identifiable {
    public let id: Int
    public let segments: [MarkdownPlainCodeSegment]
}

public struct MarkdownPlainCodeSegment: Equatable, Identifiable {
    public let id: Int
    public let text: String
}

public struct MarkdownAttributedCodeLine: Identifiable {
    public let id: Int
    public let segments: [MarkdownAttributedCodeSegment]
}

public struct MarkdownAttributedCodeSegment: Identifiable {
    public let id: Int
    public let attributedText: NSAttributedString
}

public enum MarkdownPlainCodeFormatter {
    static let maxSegmentLength = 500

    public static func lines(in code: String) -> [MarkdownPlainCodeLine] {
        let normalizedCode = code
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n")

        let rawLines = normalizedCode
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)

        let renderedLines = rawLines.isEmpty ? [""] : rawLines

        return renderedLines.enumerated().map { lineIndex, line in
            MarkdownPlainCodeLine(
                id: lineIndex,
                segments: segments(in: line)
            )
        }
    }

    private static func segments(in line: String) -> [MarkdownPlainCodeSegment] {
        guard !line.isEmpty else {
            return [MarkdownPlainCodeSegment(id: 0, text: " ")]
        }

        var segments: [MarkdownPlainCodeSegment] = []
        var startIndex = line.startIndex
        var segmentID = 0

        while startIndex < line.endIndex {
            let endIndex = line.index(
                startIndex,
                offsetBy: maxSegmentLength,
                limitedBy: line.endIndex
            ) ?? line.endIndex
            segments.append(
                MarkdownPlainCodeSegment(
                    id: segmentID,
                    text: String(line[startIndex..<endIndex])
                )
            )
            startIndex = endIndex
            segmentID += 1
        }

        return segments
    }
}

public enum MarkdownAttributedCodeFormatter {
    static let maxSegmentLength = MarkdownPlainCodeFormatter.maxSegmentLength

    public static func lines(in attributedCode: NSAttributedString) -> [MarkdownAttributedCodeLine] {
        let string = attributedCode.string as NSString
        guard string.length > 0 else {
            return [
                MarkdownAttributedCodeLine(
                    id: 0,
                    segments: [MarkdownAttributedCodeSegment(id: 0, attributedText: NSAttributedString(string: " "))]
                )
            ]
        }

        var lines: [MarkdownAttributedCodeLine] = []
        var lineStart = 0
        var index = 0

        while index < string.length {
            let character = string.character(at: index)
            if isLineSeparator(character) {
                lines.append(
                    MarkdownAttributedCodeLine(
                        id: lines.count,
                        segments: segments(in: NSRange(location: lineStart, length: index - lineStart), of: attributedCode)
                    )
                )

                if character == 13,
                   index + 1 < string.length,
                   string.character(at: index + 1) == 10 {
                    index += 1
                }
                lineStart = index + 1
            }

            index += 1
        }

        lines.append(
            MarkdownAttributedCodeLine(
                id: lines.count,
                segments: segments(
                    in: NSRange(location: lineStart, length: string.length - lineStart),
                    of: attributedCode
                )
            )
        )

        return lines
    }

    private static func segments(in range: NSRange, of attributedCode: NSAttributedString) -> [MarkdownAttributedCodeSegment] {
        guard range.length > 0 else {
            return [MarkdownAttributedCodeSegment(id: 0, attributedText: NSAttributedString(string: " "))]
        }

        var segments: [MarkdownAttributedCodeSegment] = []
        var location = range.location
        let upperBound = range.location + range.length

        while location < upperBound {
            let length = min(maxSegmentLength, upperBound - location)
            let segmentRange = NSRange(location: location, length: length)
            segments.append(
                MarkdownAttributedCodeSegment(
                    id: segments.count,
                    attributedText: attributedCode.attributedSubstring(from: segmentRange)
                )
            )
            location += length
        }

        return segments
    }

    private static func isLineSeparator(_ character: unichar) -> Bool {
        switch character {
        case 10, 13, 0x2028, 0x2029:
            return true
        default:
            return false
        }
    }
}

public enum MarkdownContentFallbackReason: String, Equatable {
    case tooManyCharacters
    case tooManyLines
}

public enum MarkdownContentRenderingPolicy {
    static let maxMarkdownCharacterCount = 80_000
    static let maxMarkdownLineCount = 2_000

    public static func fallbackReason(for content: String) -> MarkdownContentFallbackReason? {
        if content.count > maxMarkdownCharacterCount {
            return .tooManyCharacters
        }

        if MarkdownHighlightPolicy.lineCount(in: content, stoppingAfter: maxMarkdownLineCount) > maxMarkdownLineCount {
            return .tooManyLines
        }

        return nil
    }
}

enum MarkdownHighlightEngine: Equatable {
    case splashSwift
    case highlightr
}

public enum MarkdownHighlightFallbackReason: String, Equatable {
    case streaming
    case empty
    case missingLanguage
    case unsupportedLanguage
    case highRiskLanguage
    case tooManyCharacters
    case tooManyLines
    case lineTooLong
    case highlighterUnavailable
}

enum MarkdownHighlightDecision: Equatable {
    case highlight(language: String, engine: MarkdownHighlightEngine)
    case plain(reason: MarkdownHighlightFallbackReason, normalizedLanguage: String?)
}

public enum MarkdownHighlightPolicy {
    static let maxHighlightedCodeCharacterCount = 80_000
    static let maxHighlightedCodeLineCount = 2_000
    static let maxHighlightedCodeLineLength = 4_000

    private static let splashSwiftLanguages: Set<String> = ["swift"]
    private static let highRiskLanguages: Set<String> = [
        "ansi",
        "console",
        "diff",
        "log",
        "logs",
        "output",
        "patch",
        "plain",
        "terminal",
        "text",
        "txt"
    ]
    private static let highlightrLanguages: Set<String> = [
        "bash",
        "c",
        "cpp",
        "css",
        "go",
        "html",
        "java",
        "javascript",
        "json",
        "kotlin",
        "markdown",
        "objectivec",
        "python",
        "ruby",
        "rust",
        "scss",
        "sql",
        "toml",
        "typescript",
        "xml",
        "yaml"
    ]
    private static let languageAliases: [String: String] = [
        "c++": "cpp",
        "htm": "html",
        "js": "javascript",
        "jsx": "javascript",
        "jsonc": "json",
        "kt": "kotlin",
        "m": "objectivec",
        "md": "markdown",
        "mm": "objectivec",
        "objc": "objectivec",
        "py": "python",
        "rb": "ruby",
        "rs": "rust",
        "sh": "bash",
        "shell": "bash",
        "ts": "typescript",
        "tsx": "typescript",
        "yml": "yaml",
        "zsh": "bash"
    ]

    static func decision(for code: String, language: String?, isStreaming: Bool) -> MarkdownHighlightDecision {
        if isStreaming {
            return .plain(reason: .streaming, normalizedLanguage: normalizedLanguage(from: language))
        }

        if code.isEmpty {
            return .plain(reason: .empty, normalizedLanguage: normalizedLanguage(from: language))
        }

        if code.count > maxHighlightedCodeCharacterCount {
            return .plain(reason: .tooManyCharacters, normalizedLanguage: normalizedLanguage(from: language))
        }

        if lineCount(in: code, stoppingAfter: maxHighlightedCodeLineCount) > maxHighlightedCodeLineCount {
            return .plain(reason: .tooManyLines, normalizedLanguage: normalizedLanguage(from: language))
        }

        if containsLineLongerThan(maxHighlightedCodeLineLength, in: code) {
            return .plain(reason: .lineTooLong, normalizedLanguage: normalizedLanguage(from: language))
        }

        guard let normalizedLanguage = normalizedLanguage(from: language) else {
            return .plain(reason: .missingLanguage, normalizedLanguage: nil)
        }

        if highRiskLanguages.contains(normalizedLanguage) {
            return .plain(reason: .highRiskLanguage, normalizedLanguage: normalizedLanguage)
        }

        if splashSwiftLanguages.contains(normalizedLanguage) {
            return .highlight(language: normalizedLanguage, engine: .splashSwift)
        }

        if highlightrLanguages.contains(normalizedLanguage) {
            return .highlight(language: normalizedLanguage, engine: .highlightr)
        }

        return .plain(reason: .unsupportedLanguage, normalizedLanguage: normalizedLanguage)
    }

    /// True when a normalized language has an engine (Splash for Swift, Highlightr otherwise).
    static func isHighlightable(_ normalizedLanguage: String) -> Bool {
        splashSwiftLanguages.contains(normalizedLanguage) || highlightrLanguages.contains(normalizedLanguage)
    }

    static func normalizedLanguage(from language: String?) -> String? {
        guard let token = language?
            .split(whereSeparator: { $0.isWhitespace })
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !token.isEmpty
        else {
            return nil
        }

        return languageAliases[token] ?? token
    }

    public static func languageLogCategory(for normalizedLanguage: String?) -> String {
        guard let normalizedLanguage else {
            return "missing"
        }

        if splashSwiftLanguages.contains(normalizedLanguage) {
            return "splashSwift"
        }

        if highlightrLanguages.contains(normalizedLanguage) {
            return "highlightr"
        }

        if highRiskLanguages.contains(normalizedLanguage) {
            return "highRisk"
        }

        return "unsupported"
    }

    public static func lineCount(in text: String, stoppingAfter limit: Int? = nil) -> Int {
        guard !text.isEmpty else { return 0 }

        var count = 1
        var index = text.unicodeScalars.startIndex

        while index < text.unicodeScalars.endIndex {
            let scalar = text.unicodeScalars[index]
            let nextIndex = text.unicodeScalars.index(after: index)

            if isLineSeparator(scalar) {
                count += 1
                if let limit, count > limit {
                    return count
                }

                if scalar.value == 13,
                   nextIndex < text.unicodeScalars.endIndex,
                   text.unicodeScalars[nextIndex].value == 10 {
                    index = text.unicodeScalars.index(after: nextIndex)
                } else {
                    index = nextIndex
                }
            } else {
                index = nextIndex
            }
        }

        return count
    }

    static func containsLineLongerThan(_ maxLength: Int, in text: String) -> Bool {
        guard maxLength >= 0 else { return true }

        var currentLength = 0
        var index = text.unicodeScalars.startIndex

        while index < text.unicodeScalars.endIndex {
            let scalar = text.unicodeScalars[index]
            let nextIndex = text.unicodeScalars.index(after: index)

            if isLineSeparator(scalar) {
                currentLength = 0
                if scalar.value == 13,
                   nextIndex < text.unicodeScalars.endIndex,
                   text.unicodeScalars[nextIndex].value == 10 {
                    index = text.unicodeScalars.index(after: nextIndex)
                } else {
                    index = nextIndex
                }
            } else {
                currentLength += 1
                if currentLength > maxLength {
                    return true
                }
                index = nextIndex
            }
        }

        return false
    }

    private static func isLineSeparator(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 10, 13, 0x2028, 0x2029:
            return true
        default:
            return false
        }
    }
}

public struct MarkdownCodeHighlightRequest: Equatable {
    public let code: String
    let language: String?
    let colorScheme: ColorScheme
    let isStreaming: Bool

    public init(code: String, language: String?, colorScheme: ColorScheme, isStreaming: Bool) {
        self.code = code
        self.language = language
        self.colorScheme = colorScheme
        self.isStreaming = isStreaming
    }
}

public enum MarkdownCodeHighlightResult {
    case highlighted(NSAttributedString)
    case plain(reason: MarkdownHighlightFallbackReason, normalizedLanguage: String?)
}

public enum MarkdownCodeHighlighter {
    @MainActor
    public static func highlightedCode(for request: MarkdownCodeHighlightRequest) -> MarkdownCodeHighlightResult {
        let decision = MarkdownHighlightPolicy.decision(
            for: request.code,
            language: request.language,
            isStreaming: request.isStreaming
        )

        switch decision {
        case .highlight(_, .splashSwift):
            return .highlighted(
                SplashSwiftCodeHighlighter.highlightedAttributedString(
                    for: request.code,
                    colorScheme: request.colorScheme
                )
            )
        case .highlight(let normalizedLanguage, .highlightr):
            guard let highlighted = StableHighlightrStore.shared.highlight(
                request.code,
                language: normalizedLanguage,
                colorScheme: request.colorScheme
            ) else {
                return .plain(reason: .highlighterUnavailable, normalizedLanguage: normalizedLanguage)
            }

            return .highlighted(highlighted)
        case .plain(let reason, let normalizedLanguage):
            return .plain(reason: reason, normalizedLanguage: normalizedLanguage)
        }
    }
}

enum SplashSwiftCodeHighlighter {
    static func highlightedAttributedString(for code: String, colorScheme: ColorScheme) -> NSAttributedString {
        let font = Splash.Font(size: 13)
        let theme = colorScheme == .dark
            ? Splash.Theme.wwdc17(withFont: font)
            : Splash.Theme.presentation(withFont: font)
        let highlighter = SyntaxHighlighter(
            format: AttributedStringOutputFormat(theme: theme)
        )
        return highlighter.highlight(code)
    }
}

@MainActor
private final class StableHighlightrStore {
    static let shared = StableHighlightrStore()

    private enum ThemeKey: Hashable {
        case light
        case dark
    }

    private var highlightrs: [ThemeKey: Highlightr] = [:]

    private init() {}

    func highlight(_ code: String, language: String, colorScheme: ColorScheme) -> NSAttributedString? {
        return highlightr(for: colorScheme)?.highlight(code, as: language, fastRender: true)
    }

    private func highlightr(for colorScheme: ColorScheme) -> Highlightr? {
        let key: ThemeKey = colorScheme == .dark ? .dark : .light
        if let highlightr = highlightrs[key] {
            return highlightr
        }

        guard let highlightr = Highlightr() else {
            return nil
        }

        highlightr.setTheme(to: key == .dark ? "github-dark" : "xcode")
        highlightrs[key] = highlightr
        return highlightr
    }
}

/// Single-child layout that caps a table cell's width while reporting the
/// height the content needs *at that capped width*.
///
/// `Grid` sizes table rows from each cell's ideal size. A plain
/// `.frame(maxWidth:)` caps the ideal width but still reports the
/// single-line ideal height, so long cell text wraps at render time without
/// the row growing — rows end up overlapping (issue #233). Measuring the
/// child at the clamped width makes the reported height match what is
/// actually drawn.
public struct TableCellWidthCap: Layout {
    let minWidth: CGFloat
    let maxWidth: CGFloat

    public init(minWidth: CGFloat, maxWidth: CGFloat) {
        self.minWidth = minWidth
        self.maxWidth = maxWidth
    }

    /// Pure clamp used by `sizeThatFits`: fill the proposed (column) width
    /// when the parent offers one, otherwise fall back to the child's ideal
    /// width, always bounded to `minWidth...maxWidth`.
    static func resolvedWidth(
        idealWidth: CGFloat,
        proposedWidth: CGFloat?,
        minWidth: CGFloat,
        maxWidth: CGFloat
    ) -> CGFloat {
        min(max(proposedWidth ?? idealWidth, minWidth), maxWidth)
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let idealWidth = subview.sizeThatFits(.unspecified).width
        let width = Self.resolvedWidth(
            idealWidth: idealWidth,
            proposedWidth: proposal.width,
            minWidth: minWidth,
            maxWidth: maxWidth
        )
        let measured = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: width, height: measured.height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        subview.place(
            at: CGPoint(x: bounds.minX, y: bounds.midY),
            anchor: .leading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

extension Logger {
    public static let talariaMarkdownRendering = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
        category: "MarkdownRendering"
    )
}
