import Foundation

enum TranscriptMediaSource: Equatable {
    case localPath(String)
    case remoteURL(URL)
}

public enum TranscriptMediaKind: Equatable {
    case image
    case audio
    case video
    case unsupported
}

public struct TranscriptMediaReference: Equatable, Identifiable {
    public let rawReference: String
    /// Markdown image alt text; nil for `MEDIA:` tokens and bare file URLs.
    var altText: String? = nil

    public var id: String {
        rawReference
    }

    /// Alt text when the author supplied one, otherwise the file name.
    public var accessibilityName: String {
        guard let altText = altText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !altText.isEmpty
        else {
            return displayName
        }
        return altText
    }

    var source: TranscriptMediaSource {
        let trimmed = rawReference.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            return .remoteURL(url)
        }

        return .localPath(trimmed)
    }

    public var displayName: String {
        let trimmed = rawReference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return String(localized: "Media") }

        switch source {
        case let .remoteURL(url):
            let name = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? String(localized: "Image") : name
        case .localPath:
            let name = URL(fileURLWithPath: trimmed).lastPathComponent
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? trimmed : name
        }
    }

    public var mediaKind: TranscriptMediaKind {
        let ext = pathExtension
        if Self.rasterImageExtensions.contains(ext) {
            return .image
        }

        if Self.audioExtensions.contains(ext) {
            return .audio
        }

        if Self.videoExtensions.contains(ext) {
            return .video
        }

        if case .remoteURL = source, ext.isEmpty {
            return .image
        }

        return .unsupported
    }

    var isRasterImageCandidate: Bool {
        mediaKind == .image
    }

    var isAudioCandidate: Bool {
        mediaKind == .audio
    }

    var isVideoCandidate: Bool {
        mediaKind == .video
    }

    public var isExtensionlessRemoteMediaCandidate: Bool {
        if case .remoteURL = source, pathExtension.isEmpty {
            return true
        }
        return false
    }

    private var pathExtension: String {
        switch source {
        case let .remoteURL(url):
            return url.pathExtension.lowercased()
        case let .localPath(path):
            return URL(fileURLWithPath: path).pathExtension.lowercased()
        }
    }

    private static let rasterImageExtensions: Set<String> = [
        "bmp", "gif", "heic", "heif", "ico", "jpg", "jpeg", "png", "tif", "tiff", "webp"
    ]

    private static let audioExtensions: Set<String> = [
        "aac", "caf", "m4a", "mp3", "wav"
    ]

    private static let videoExtensions: Set<String> = [
        "m4v", "mov", "mp4"
    ]
}

public enum TranscriptMediaSegment: Equatable {
    case text(String)
    case media(TranscriptMediaReference)
}

public enum TranscriptMediaParser {
    /// `workspaceRoot` is the session workspace that `./` and `../` Markdown
    /// image destinations resolve against; without it those images stay text.
    public static func segments(in markdown: String, workspaceRoot: String? = nil) -> [TranscriptMediaSegment] {
        guard !markdown.isEmpty else { return [] }

        var segments: [TranscriptMediaSegment] = []
        var index = markdown.startIndex
        var isInFence = false
        var fenceCharacter: Character?
        var isInHTMLComment = false

        while index < markdown.endIndex {
            let lineRange = markdown.lineRange(for: index..<index)
            let line = String(markdown[lineRange])

            if isInFence {
                appendText(line, to: &segments)
                if fenceMarker(in: line) == fenceCharacter {
                    isInFence = false
                    fenceCharacter = nil
                }
            } else if isInHTMLComment {
                if let close = line.range(of: htmlCommentClose) {
                    appendText(String(line[..<close.upperBound]), to: &segments)
                    isInHTMLComment = appendMediaSegments(
                        in: String(line[close.upperBound...]),
                        workspaceRoot: workspaceRoot,
                        to: &segments
                    )
                } else {
                    appendText(line, to: &segments)
                }
            } else if let marker = fenceMarker(in: line) {
                appendText(line, to: &segments)
                isInFence = true
                fenceCharacter = marker
            } else {
                isInHTMLComment = appendMediaSegments(in: line, workspaceRoot: workspaceRoot, to: &segments)
            }

            index = lineRange.upperBound
        }

        return segments
    }

    /// Returns true when the line opens an HTML comment it does not close, so
    /// the following lines stay literal until `-->`.
    private static func appendMediaSegments(
        in line: String,
        workspaceRoot: String?,
        to segments: inout [TranscriptMediaSegment]
    ) -> Bool {
        var cursor = line.startIndex
        var textStart = cursor
        let codeRanges = inlineCodeRanges(in: line)
        let (commentRanges, leavesCommentOpen) = htmlCommentRanges(in: line, skipping: codeRanges)
        // Spans the Markdown renderer treats literally or hides: inline code and HTML comments.
        let inlineCodeRanges = codeRanges + commentRanges

        while cursor < line.endIndex {
            if line[cursor...].hasPrefix("!["),
               !isBackslashEscaped(cursor, in: line),
               !inlineCodeRanges.contains(where: { $0.contains(cursor) }),
               let image = markdownImage(in: line, from: cursor),
               let reference = markdownImageReference(for: image, workspaceRoot: workspaceRoot) {
                appendText(String(line[textStart..<cursor]), to: &segments)
                segments.append(.media(reference))

                cursor = image.end
                textStart = cursor
                continue
            }

            if line[cursor...].hasPrefix("MEDIA:"),
               let referenceRange = referenceRange(
                   in: line,
                   markerStart: cursor,
                   from: line.index(cursor, offsetBy: 6),
                   syntax: .mediaToken
               ) {
                appendText(String(line[textStart..<cursor]), to: &segments)

                let reference = TranscriptMediaReference(rawReference: String(line[referenceRange]))
                segments.append(.media(reference))

                cursor = referenceRange.upperBound
                textStart = cursor
                continue
            }

            if line[cursor...].hasPrefix(fileURLMarker),
               isBareFileURLStart(cursor, in: line),
               !inlineCodeRanges.contains(where: { $0.contains(cursor) }),
               let pathRange = referenceRange(
                   in: line,
                   markerStart: cursor,
                   from: line.index(cursor, offsetBy: fileURLMarker.count),
                   syntax: .fileURL
               ) {
                appendText(String(line[textStart..<cursor]), to: &segments)

                let rawURL = String(line[cursor..<pathRange.upperBound])
                let reference = TranscriptMediaReference(
                    rawReference: normalizedLocalPath(fromFileURL: rawURL)
                )
                segments.append(.media(reference))

                cursor = pathRange.upperBound
                textStart = cursor
                continue
            }

            cursor = line.index(after: cursor)
        }

        appendText(String(line[textStart..<line.endIndex]), to: &segments)
        return leavesCommentOpen
    }

    /// `<!-- … -->` spans on the line; an opener inside inline code is literal.
    private static func htmlCommentRanges(
        in line: String,
        skipping codeRanges: [Range<String.Index>]
    ) -> (ranges: [Range<String.Index>], leavesOpen: Bool) {
        var ranges: [Range<String.Index>] = []
        var search = line.startIndex

        while let open = line.range(of: htmlCommentOpen, range: search..<line.endIndex) {
            if codeRanges.contains(where: { $0.contains(open.lowerBound) }) {
                search = open.upperBound
                continue
            }
            guard let close = line.range(of: htmlCommentClose, range: open.upperBound..<line.endIndex) else {
                ranges.append(open.lowerBound..<line.endIndex)
                return (ranges, true)
            }
            ranges.append(open.lowerBound..<close.upperBound)
            search = close.upperBound
        }

        return (ranges, false)
    }

    private static func appendText(_ text: String, to segments: inout [TranscriptMediaSegment]) {
        guard !text.isEmpty else { return }

        if case let .text(existing) = segments.last {
            segments[segments.count - 1] = .text(existing + text)
        } else {
            segments.append(.text(text))
        }
    }

    private static func referenceRange(
        in line: String,
        markerStart: String.Index,
        from start: String.Index,
        syntax: ReferenceSyntax
    ) -> Range<String.Index>? {
        guard start < line.endIndex else { return nil }

        var end = start
        while end < line.endIndex, !isReferenceTerminator(line[end], syntax: syntax) {
            end = line.index(after: end)
        }

        var trimmedEnd = end
        while trimmedEnd > start {
            let previous = line.index(before: trimmedEnd)
            if trailingPunctuation.contains(line[previous]) {
                trimmedEnd = previous
            } else {
                break
            }
        }

        if syntax == .mediaToken,
           let delimiter = emphasisDelimiter(in: line, immediatelyBefore: markerStart),
           line[start..<trimmedEnd].hasSuffix(delimiter) {
            trimmedEnd = line.index(trimmedEnd, offsetBy: -delimiter.count)
        }

        guard trimmedEnd > start else { return nil }
        return start..<trimmedEnd
    }

    private static func emphasisDelimiter(
        in line: String,
        immediatelyBefore index: String.Index
    ) -> String? {
        for delimiter in ["***", "___", "**", "__", "*", "_"] {
            guard let delimiterStart = line.index(
                index,
                offsetBy: -delimiter.count,
                limitedBy: line.startIndex
            ) else {
                continue
            }

            if line[delimiterStart..<index] == delimiter {
                return delimiter
            }
        }

        return nil
    }

    private static func isReferenceTerminator(
        _ character: Character,
        syntax: ReferenceSyntax
    ) -> Bool {
        if character.isWhitespace || character == ")" || character == "]" {
            return true
        }

        return syntax == .fileURL && fileURLTerminators.contains(character)
    }

    private static func isBareFileURLStart(_ index: String.Index, in line: String) -> Bool {
        index == line.startIndex || line[line.index(before: index)].isWhitespace
    }

    // MARK: - Markdown images

    private struct MarkdownImage {
        let altText: String
        let destination: String
        let end: String.Index
    }

    /// Parses `![alt](destination "title")` starting at the `!`, honoring
    /// nested brackets and backslash escapes. Returns nil for malformed syntax.
    private static func markdownImage(in line: String, from start: String.Index) -> MarkdownImage? {
        let altOpen = line.index(after: start)
        guard let altClose = balancedClose(in: line, opening: altOpen, open: "[", close: "]") else {
            return nil
        }

        let parenthesisOpen = line.index(after: altClose)
        guard parenthesisOpen < line.endIndex,
              line[parenthesisOpen] == "(",
              let parenthesisClose = balancedClose(
                  in: line,
                  opening: parenthesisOpen,
                  open: "(",
                  close: ")"
              ),
              let destination = destination(
                  inLinkBody: String(line[line.index(after: parenthesisOpen)..<parenthesisClose])
              )
        else {
            return nil
        }

        return MarkdownImage(
            altText: unescaped(String(line[line.index(after: altOpen)..<altClose]))
                .trimmingCharacters(in: .whitespacesAndNewlines),
            destination: destination,
            end: line.index(after: parenthesisClose)
        )
    }

    private static func markdownImageReference(
        for image: MarkdownImage,
        workspaceRoot: String?
    ) -> TranscriptMediaReference? {
        guard let path = localMediaPath(forMarkdownDestination: image.destination, workspaceRoot: workspaceRoot) else {
            return nil
        }

        let reference = TranscriptMediaReference(
            rawReference: path,
            altText: image.altText.isEmpty ? nil : image.altText
        )
        return reference.isRasterImageCandidate ? reference : nil
    }

    /// Destinations the server media contract can serve as a `path` query:
    /// absolute paths, `file://` URLs, `~/` paths (sent as-is; the server owns
    /// home expansion), and `./` `../` paths joined to the session workspace.
    /// Remote URLs and bare relative paths stay with the Markdown renderer.
    static func localMediaPath(forMarkdownDestination destination: String, workspaceRoot: String?) -> String? {
        if destination.lowercased().hasPrefix(fileURLMarker) {
            return normalizedLocalPath(fromFileURL: destination)
        }

        // Markdown destinations percent-encode spaces and punctuation; decode
        // once so the server receives the filesystem path, as the file-URL branch does.
        let path = destination.removingPercentEncoding ?? destination

        if destination.hasPrefix("/") || destination.hasPrefix("~/") {
            return path
        }

        if destination.hasPrefix("./") || destination.hasPrefix("../") {
            guard let workspaceRoot = workspaceRoot?.trimmingCharacters(in: .whitespacesAndNewlines),
                  workspaceRoot.hasPrefix("/")
            else {
                return nil
            }
            return normalizedAbsolutePath(workspaceRoot + "/" + path)
        }

        return nil
    }

    /// Textual `.`/`..` collapse; never touches the client filesystem.
    private static func normalizedAbsolutePath(_ path: String) -> String {
        var components: [Substring] = []
        for component in path.split(separator: "/", omittingEmptySubsequences: true) {
            switch component {
            case ".":
                continue
            case "..":
                _ = components.popLast()
            default:
                components.append(component)
            }
        }
        return "/" + components.joined(separator: "/")
    }

    /// Index of the `close` matching the `open` at `opening`, or nil when the
    /// line ends first.
    private static func balancedClose(
        in line: String,
        opening: String.Index,
        open: Character,
        close: Character
    ) -> String.Index? {
        guard opening < line.endIndex, line[opening] == open else { return nil }

        var depth = 0
        var index = opening
        while index < line.endIndex {
            let character = line[index]
            if character == "\\" {
                index = line.index(index, offsetBy: 2, limitedBy: line.endIndex) ?? line.endIndex
                continue
            }
            if character == open {
                depth += 1
            } else if character == close {
                depth -= 1
                if depth == 0 {
                    return index
                }
            }
            index = line.index(after: index)
        }
        return nil
    }

    /// The destination of a link body, dropping `<...>` wrapping and an
    /// optional quoted title. Any other trailing content is malformed.
    private static func destination(inLinkBody body: String) -> String? {
        let trimmed = body.trimmingCharacters(in: .whitespaces)
        let raw: Substring
        let remainder: Substring
        if trimmed.hasPrefix("<") {
            guard let close = trimmed.firstIndex(of: ">") else { return nil }
            raw = trimmed[trimmed.index(after: trimmed.startIndex)..<close]
            remainder = trimmed[trimmed.index(after: close)...]
        } else {
            raw = trimmed.prefix { !$0.isWhitespace }
            remainder = trimmed[raw.endIndex...]
        }

        guard isOptionalLinkTitle(remainder) else { return nil }
        let destination = unescaped(String(raw))
        return destination.isEmpty ? nil : destination
    }

    /// Empty, or whitespace followed by a `"…"`, `'…'`, or `(…)` title.
    private static func isOptionalLinkTitle(_ remainder: Substring) -> Bool {
        let title = remainder.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return true }
        guard remainder.first?.isWhitespace == true, title.count >= 2,
              let open = title.first, let close = title.last
        else {
            return false
        }
        switch (open, close) {
        case ("\"", "\""), ("'", "'"), ("(", ")"):
            return !title.dropFirst().dropLast().contains(close)
        default:
            return false
        }
    }

    private static func isBackslashEscaped(_ index: String.Index, in line: String) -> Bool {
        var backslashes = 0
        var cursor = index
        while cursor > line.startIndex {
            cursor = line.index(before: cursor)
            guard line[cursor] == "\\" else { break }
            backslashes += 1
        }
        return backslashes % 2 == 1
    }

    /// Removes CommonMark backslash escapes (a backslash before ASCII punctuation).
    private static func unescaped(_ text: String) -> String {
        guard text.contains("\\") else { return text }

        var result = ""
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)
            if character == "\\",
               next < text.endIndex,
               text[next].isASCII,
               text[next].isPunctuation || text[next].isSymbol {
                result.append(text[next])
                index = text.index(after: next)
                continue
            }
            result.append(character)
            index = next
        }
        return result
    }

    private static func normalizedLocalPath(fromFileURL rawURL: String) -> String {
        if let components = URLComponents(string: rawURL) {
            let encodedPath = components.percentEncodedPath
            if !encodedPath.isEmpty {
                return encodedPath.removingPercentEncoding ?? encodedPath
            }
        }

        let schemeStripped = String(rawURL.dropFirst(fileURLMarker.count))
        return schemeStripped.removingPercentEncoding ?? schemeStripped
    }

    private static func inlineCodeRanges(in line: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var cursor = line.startIndex

        while cursor < line.endIndex {
            guard line[cursor] == "`" else {
                cursor = line.index(after: cursor)
                continue
            }

            let openingStart = cursor
            let openingEnd = backtickRunEnd(in: line, from: cursor)
            let delimiterLength = line.distance(from: openingStart, to: openingEnd)
            var search = openingEnd
            var closingEnd: String.Index?

            while search < line.endIndex {
                guard line[search] == "`" else {
                    search = line.index(after: search)
                    continue
                }

                let candidateEnd = backtickRunEnd(in: line, from: search)
                if line.distance(from: search, to: candidateEnd) == delimiterLength {
                    closingEnd = candidateEnd
                    break
                }
                search = candidateEnd
            }

            guard let closingEnd else { break }
            ranges.append(openingStart..<closingEnd)
            cursor = closingEnd
        }

        return ranges
    }

    private static func backtickRunEnd(in line: String, from start: String.Index) -> String.Index {
        var end = start
        while end < line.endIndex, line[end] == "`" {
            end = line.index(after: end)
        }
        return end
    }

    private static func fenceMarker(in line: String) -> Character? {
        var index = line.startIndex
        var leadingSpaces = 0

        while index < line.endIndex, line[index] == " ", leadingSpaces < 4 {
            leadingSpaces += 1
            index = line.index(after: index)
        }

        guard leadingSpaces <= 3 else { return nil }
        if line[index...].hasPrefix("```") {
            return "`"
        }
        if line[index...].hasPrefix("~~~") {
            return "~"
        }
        return nil
    }

    private static let trailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?"]
    private static let fileURLTerminators: Set<Character> = ["<", ">", "\"", "'"]
    private static let fileURLMarker = "file://"
    private static let htmlCommentOpen = "<!--"
    private static let htmlCommentClose = "-->"

    private enum ReferenceSyntax {
        case mediaToken
        case fileURL
    }
}
