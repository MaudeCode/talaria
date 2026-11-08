import Foundation

public struct StreamingMarkdownChunk: Identifiable, Equatable, Sendable {
    public let id: Int
    public let text: String
}

public struct StreamingMarkdownBlockSegments: Equatable, Sendable {
    public let stableChunks: [StreamingMarkdownChunk]
    public let activeMarkdown: String
}

public enum StreamingMarkdownBlockSplitter {
    static let stableChunkTargetCharacterCount = 6_000

    public static func split(_ text: String) -> StreamingMarkdownBlockSegments {
#if DEBUG
        ChatBodyEvaluationRecorder.record("markdownSplit")
#endif
        var lineStart = text.startIndex
        var chunkStart = text.startIndex
        var isInsideFence = false
        var stableChunks: [StreamingMarkdownChunk] = []

        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let nextLineStart = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
            let hasLineBreak = lineEnd < text.endIndex
            let trimmedLine = String(text[lineStart..<lineEnd])
                .trimmingCharacters(in: .whitespacesAndNewlines)

            var stableBoundary: String.Index?
            if isFenceDelimiter(trimmedLine) {
                isInsideFence.toggle()
                if !isInsideFence {
                    stableBoundary = nextLineStart
                }
            } else if !isInsideFence, hasLineBreak {
                if trimmedLine.isEmpty || isStableSingleLineBlock(trimmedLine) {
                    stableBoundary = nextLineStart
                }
            }

            if let stableBoundary,
               shouldSealChunk(in: text, from: chunkStart, to: stableBoundary) {
                appendChunk(in: text, from: chunkStart, to: stableBoundary, into: &stableChunks)
                chunkStart = stableBoundary
            }

            lineStart = nextLineStart
        }

        return StreamingMarkdownBlockSegments(
            stableChunks: stableChunks,
            activeMarkdown: String(text[chunkStart...])
        )
    }

    private static func shouldSealChunk(
        in text: String,
        from start: String.Index,
        to boundary: String.Index
    ) -> Bool {
        guard boundary < text.endIndex else { return false }
        return text.distance(from: start, to: boundary) >= stableChunkTargetCharacterCount
    }

    private static func appendChunk(
        in text: String,
        from start: String.Index,
        to end: String.Index,
        into chunks: inout [StreamingMarkdownChunk]
    ) {
        guard start < end else { return }
        let chunkText = String(text[start..<end])
        guard !chunkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        chunks.append(
            StreamingMarkdownChunk(
                id: chunks.count,
                text: chunkText
            )
        )
    }

    private static func isFenceDelimiter(_ trimmedLine: String) -> Bool {
        trimmedLine.hasPrefix("```") || trimmedLine.hasPrefix("~~~")
    }

    private static func isStableSingleLineBlock(_ trimmedLine: String) -> Bool {
        let headingMarkerCount = trimmedLine.prefix(while: { $0 == "#" }).count
        let isHeading = (1...6).contains(headingMarkerCount)
            && trimmedLine.dropFirst(headingMarkerCount).first?.isWhitespace == true
        return isHeading || trimmedLine == "---" || trimmedLine == "***"
    }
}

/// The code fence a streaming reply ends inside, split from the Markdown before it (TAL-1396).
///
/// The Markdown renderer identifies each block by its content, so an open fence it draws becomes a new view on every
/// update and rebuilds every line. Drawn on its own, the block keeps one identity while it grows. Only a fence at the
/// left margin is split out; an indented one may belong to a list item, so it stays with the Markdown.
public struct StreamingOpenCodeFence: Equatable, Sendable {
    /// The Markdown before the fence's opening line.
    public let leadingMarkdown: String
    /// The info string after the opening backticks or tildes, as the Markdown renderer passes it.
    public let language: String?
    /// The lines after the opening line, without the last line's newline, as the Markdown renderer passes them.
    public let code: String

    public static func trailing(in markdown: String) -> StreamingOpenCodeFence? {
        var open: (marker: Character, length: Int, indent: Int, lineStart: String.Index, info: Substring)?
        var insideHTMLBlock = false
        var openerAfterTag = false
        var lineStart = markdown.startIndex
        while lineStart < markdown.endIndex {
            let lineEnd = markdown[lineStart...].firstIndex(of: "\n") ?? markdown.endIndex
            let line = markdown[lineStart..<lineEnd]
            let fence = fenceRun(in: line)
            if let current = open {
                if let fence, fence.marker == current.marker, fence.length >= current.length,
                   fence.rest.allSatisfy(\.isWhitespace) {
                    open = nil
                    insideHTMLBlock = false
                }
            } else if let fence, fence.marker == "~" || !fence.rest.contains("`") {
                open = (fence.marker, fence.length, fence.indent, lineStart, fence.rest)
                openerAfterTag = insideHTMLBlock
            } else if line.allSatisfy(\.isWhitespace) {
                insideHTMLBlock = false
            } else if !insideHTMLBlock, line.drop(while: { $0 == " " }).first == "<" {
                // An HTML block runs to the next blank line and swallows any fence inside it.
                insideHTMLBlock = true
            }
            lineStart = lineEnd < markdown.endIndex ? markdown.index(after: lineEnd) : markdown.endIndex
        }

        guard let open, open.indent == 0, !openerAfterTag else { return nil }
        let codeStart = markdown[open.lineStart...].firstIndex(of: "\n").map(markdown.index(after:)) ?? markdown.endIndex
        var code = markdown[codeStart...]
        if code.hasSuffix("\n") { code = code.dropLast() }
        let info = open.info.trimmingCharacters(in: .whitespacesAndNewlines)
        return StreamingOpenCodeFence(
            leadingMarkdown: String(markdown[..<open.lineStart]),
            language: info.isEmpty ? nil : info,
            code: String(code)
        )
    }

    /// A line's run of three or more backticks or tildes after at most three spaces, with what follows it.
    private static func fenceRun(in line: Substring) -> (marker: Character, length: Int, indent: Int, rest: Substring)? {
        let line = line.hasSuffix("\r") ? line.dropLast() : line
        let indent = line.prefix(while: { $0 == " " }).count
        guard indent <= 3, let marker = line.dropFirst(indent).first, marker == "`" || marker == "~" else { return nil }
        let run = line.dropFirst(indent).prefix(while: { $0 == marker })
        guard run.count >= 3 else { return nil }
        return (marker, run.count, indent, line[run.endIndex...])
    }
}
