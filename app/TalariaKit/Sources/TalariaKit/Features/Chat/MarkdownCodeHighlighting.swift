import Foundation
import Highlightr
import OSLog
import Splash
import SwiftUI

public struct MarkdownPlainCodeLine: Equatable, Identifiable, Sendable {
    public let id: Int
    public let segments: [MarkdownPlainCodeSegment]
}

public struct MarkdownPlainCodeSegment: Equatable, Identifiable, Sendable {
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

/// How a line of a `diff` or `patch` code block is tinted (TAL-447). Kinds
/// come from each line's leading characters in one O(lines) pass with no
/// tokenizer; the only state is the open hunk's remaining line counts.
public enum MarkdownDiffLineKind: Equatable, Sendable {
    case added
    case removed
    case hunkHeader
    case fileHeader
    case context

    private static let languages: Set<String> = ["diff", "patch"]

    /// True when a fence language is `diff` or `patch`.
    public static func applies(to language: String?) -> Bool {
        MarkdownHighlightPolicy.normalizedLanguage(from: language).map(languages.contains) ?? false
    }

    /// Inside a hunk whose `@@ -a,b +c,d @@` header gives line counts, every
    /// line is a change or context until both counts run out, so removing
    /// `-- note` (`--- note`) stays a removal. Elsewhere, `--- ` is a file
    /// header only when `+++ ` follows it, as git writes them.
    public static func kinds(forLines lines: [String]) -> [MarkdownDiffLineKind] {
        var kinds: [MarkdownDiffLineKind] = []
        kinds.reserveCapacity(lines.count)
        var oldRemaining = 0
        var newRemaining = 0

        for (index, line) in lines.enumerated() {
            if oldRemaining > 0 || newRemaining > 0, isHunkBody(line) {
                if line.hasPrefix("-") {
                    oldRemaining -= 1
                    kinds.append(.removed)
                } else if line.hasPrefix("+") {
                    newRemaining -= 1
                    kinds.append(.added)
                } else {
                    // `\ No newline at end of file` belongs to the previous line.
                    if !line.hasPrefix("\\") {
                        oldRemaining -= 1
                        newRemaining -= 1
                    }
                    kinds.append(.context)
                }
                continue
            }

            oldRemaining = 0
            newRemaining = 0
            if line.hasPrefix("@@") {
                (oldRemaining, newRemaining) = hunkLineCounts(line)
                kinds.append(.hunkHeader)
            } else if line.hasPrefix("diff ") || line.hasPrefix("index ") {
                kinds.append(.fileHeader)
            } else if line.hasPrefix("--- "), index + 1 < lines.count, lines[index + 1].hasPrefix("+++ ") {
                kinds.append(.fileHeader)
            } else if line.hasPrefix("+++ "), kinds.last == .fileHeader, lines[index - 1].hasPrefix("--- ") {
                kinds.append(.fileHeader)
            } else if line.hasPrefix("+") {
                kinds.append(.added)
            } else if line.hasPrefix("-") {
                kinds.append(.removed)
            } else {
                kinds.append(.context)
            }
        }
        return kinds
    }

    /// Hunk lines start with a space, `+`, `-` or `\\`; a blank line is a
    /// context line whose space was trimmed. Anything else, such as the next
    /// `diff ` line under a header that overstated its counts, ends the hunk.
    private static func isHunkBody(_ line: String) -> Bool {
        guard let first = line.first else { return true }
        return first == " " || first == "+" || first == "-" || first == "\\"
    }

    /// The old and new line counts of `@@ -a[,b] +c[,d] @@`; an omitted count
    /// is 1. A header without parseable ranges opens no counted hunk.
    private static func hunkLineCounts(_ header: String) -> (old: Int, new: Int) {
        let tokens = header.split(separator: " ")
        guard tokens.count >= 3, tokens[1].hasPrefix("-"), tokens[2].hasPrefix("+") else { return (0, 0) }
        func count(_ range: Substring) -> Int? {
            let parts = range.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
            guard parts.count <= 2, Int(parts[0]) != nil else { return nil }
            return parts.count == 2 ? Int(parts[1]) : 1
        }
        guard let old = count(tokens[1]), let new = count(tokens[2]) else { return (0, 0) }
        return (old, new)
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

public enum MarkdownContentFallbackReason: String, Equatable, Sendable {
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

public enum MarkdownHighlightFallbackReason: String, Equatable, Sendable {
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

public struct MarkdownCodeHighlightRequest: Equatable, Sendable {
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

/// `@unchecked Sendable`: nothing mutates a highlighted string after its engine returns it.
public enum MarkdownCodeHighlightResult: @unchecked Sendable {
    case highlighted(NSAttributedString)
    case plain(reason: MarkdownHighlightFallbackReason, normalizedLanguage: String?)
}

/// Highlights chat code blocks on `CodeHighlighterStore`'s thread, never the main thread, and remembers each settled
/// block's result so a rebuilt block (scrolled back into view, re-themed) draws coloured at once (TAL-854).
public enum MarkdownCodeHighlighter: Sendable {
    /// A settled block's earlier result, read synchronously so a rebuilt block never flashes plain text.
    public static func cachedHighlightedCode(for request: MarkdownCodeHighlightRequest) -> NSAttributedString? {
        guard case .highlight(let language, let engine) = decision(for: request) else { return nil }
        return MarkdownCodeHighlightCache.object(for: request, language: language, engine: engine)
    }

    public static func highlightedCode(for request: MarkdownCodeHighlightRequest) async -> MarkdownCodeHighlightResult {
        // A streaming block decides plain here, so token-by-token updates never reach the cache.
        switch decision(for: request) {
        case .plain(let reason, let normalizedLanguage):
            return .plain(reason: reason, normalizedLanguage: normalizedLanguage)
        case .highlight(let language, let engine):
            if let cached = MarkdownCodeHighlightCache.object(for: request, language: language, engine: engine) {
                return .highlighted(cached)
            }
            let result = await CodeHighlighterStore.shared.highlight(
                request.code,
                language: language,
                engine: engine,
                colorScheme: request.colorScheme
            )
            if case .highlighted(let highlighted) = result {
                MarkdownCodeHighlightCache.store(highlighted, for: request, language: language, engine: engine)
            }
            return result
        }
    }

    private static func decision(for request: MarkdownCodeHighlightRequest) -> MarkdownHighlightDecision {
        MarkdownHighlightPolicy.decision(for: request.code, language: request.language, isStreaming: request.isStreaming)
    }
}

/// Settled highlight results keyed by code, language, colour scheme and engine, bounded by the code's UTF-16 length.
enum MarkdownCodeHighlightCache {
    /// About six of the largest blocks the policy highlights, or thousands of typical ones.
    static let totalCostLimit = 500_000

    /// `nonisolated(unsafe)`: `NSCache` serializes access with its own internal lock.
    nonisolated(unsafe) private static let storage: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        cache.totalCostLimit = totalCostLimit
        return cache
    }()

    static func object(
        for request: MarkdownCodeHighlightRequest,
        language: String,
        engine: MarkdownHighlightEngine
    ) -> NSAttributedString? {
        storage.object(forKey: key(for: request, language: language, engine: engine))
    }

    static func store(
        _ highlighted: NSAttributedString,
        for request: MarkdownCodeHighlightRequest,
        language: String,
        engine: MarkdownHighlightEngine
    ) {
        storage.setObject(
            highlighted,
            forKey: key(for: request, language: language, engine: engine),
            cost: request.code.utf16.count
        )
    }

    private static func key(
        for request: MarkdownCodeHighlightRequest,
        language: String,
        engine: MarkdownHighlightEngine
    ) -> NSString {
        "\(engine) \(language) \(request.colorScheme == .dark ? "dark" : "light")\n\(request.code)" as NSString
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

/// Owns both engines. Highlightr's JavaScriptCore context stays confined to this actor, which runs on its own thread.
private actor CodeHighlighterStore {
    static let shared = CodeHighlighterStore()

    private static let executor = DeepStackThreadExecutor()

    nonisolated var unownedExecutor: UnownedSerialExecutor {
        Self.executor.asUnownedSerialExecutor()
    }

    private enum ThemeKey: Hashable {
        case light
        case dark
    }

    private var highlightrs: [ThemeKey: Highlightr] = [:]

    private init() {}

    func highlight(
        _ code: String,
        language: String,
        engine: MarkdownHighlightEngine,
        colorScheme: ColorScheme
    ) -> MarkdownCodeHighlightResult {
#if DEBUG
        // Counts only main-thread work, so the stream-tick budget (TAL-851) catches highlighting moving back there.
        ChatBodyEvaluationRecorder.record("highlight")
#endif
        switch engine {
        case .splashSwift:
            return .highlighted(SplashSwiftCodeHighlighter.highlightedAttributedString(for: code, colorScheme: colorScheme))
        case .highlightr:
            guard let highlighted = highlightr(for: colorScheme)?.highlight(code, as: language, fastRender: true) else {
                return .plain(reason: .highlighterUnavailable, normalizedLanguage: language)
            }
            return .highlighted(highlighted)
        }
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

/// Runs `CodeHighlighterStore` on one thread with a deep stack. Splash recurses once per character of a token: a
/// line at the policy's 4,000-character limit needs about 5 MB of stack in Release and 32 MB in Debug, where a
/// cooperative-pool thread has 512 KB. The stack is reserved address space; only the pages a run touches are used.
private final class DeepStackThreadExecutor: SerialExecutor, @unchecked Sendable {
    static let stackSize = 64 << 20

    private let condition = NSCondition()
    private var jobs: [UnownedJob] = []

    init() {
        let thread = Thread { [self] in run() }
        thread.name = "Talaria code highlighting"
        thread.qualityOfService = .userInitiated
        thread.stackSize = Self.stackSize
        thread.start()
    }

    func enqueue(_ job: consuming ExecutorJob) {
        let job = UnownedJob(job)
        condition.lock()
        jobs.append(job)
        condition.signal()
        condition.unlock()
    }

    private func run() -> Never {
        while true {
            condition.lock()
            while jobs.isEmpty {
                condition.wait()
            }
            let job = jobs.removeFirst()
            condition.unlock()
            job.runSynchronously(on: asUnownedSerialExecutor())
        }
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
public struct TableCellWidthCap: Layout, Sendable {
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
