import Foundation

/// TAL-604: one hunk of a unified diff, parsed on the server (`hunks` on a git diff and on a file edit's `edit_diff`).
public struct DiffHunk: Identifiable, Equatable, Decodable {
    public internal(set) var id = 0
    let header: String
    let newStart: Int?
    let newEnd: Int?
    public let additions: Int
    public let deletions: Int
    public internal(set) var lines: [DiffLine]
    var patchCount = 1

    init(header: String, newStart: Int?, newEnd: Int?, additions: Int, deletions: Int, lines: [DiffLine]) {
        self.header = header
        self.newStart = newStart
        self.newEnd = newEnd
        self.additions = additions
        self.deletions = deletions
        self.lines = lines
    }

    enum CodingKeys: String, CodingKey {
        case header, additions, deletions, lines
        case newStart = "new_start"
        case newEnd = "new_end"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        header = container.decodeLossyStringIfPresent(forKey: .header) ?? ""
        newStart = container.decodeLossyIntIfPresent(forKey: .newStart)
        newEnd = container.decodeLossyIntIfPresent(forKey: .newEnd)
        additions = container.decodeLossyIntIfPresent(forKey: .additions) ?? 0
        deletions = container.decodeLossyIntIfPresent(forKey: .deletions) ?? 0
        lines = (try? container.decodeIfPresent([DiffLine].self, forKey: .lines)) ?? []
    }

    public var displayLabel: String {
        guard let start = newStart else { return header.isEmpty ? "Patch \(id + 1) of \(patchCount)" : header }
        let end = max(newEnd ?? start, start)
        return end == start ? "Line \(start)" : "Lines \(start)-\(end)"
    }

    /// The server's hunks for `diff`, numbered for display. A Web from before TAL-604 sends none, so the App parses `diff`
    /// itself until every supported Web ships them (TAL-697).
    static func resolved(_ value: JSONValue?, diff: String) -> [DiffHunk] {
        guard let value,
              let data = try? JSONEncoder().encode(value),
              let hunks = try? JSONDecoder().decode([DiffHunk].self, from: data)
        else { return numbered(legacyParse(diff)) }
        return numbered(hunks)
    }

    /// Line ids run across the whole diff: a lazy stack flattens each hunk's rows into one list, where ids repeated from
    /// hunk to hunk would show one hunk's rows under another's header.
    private static func numbered(_ hunks: [DiffHunk]) -> [DiffHunk] {
        var nextLineID = 0
        return hunks.enumerated().map { index, hunk in
            var hunk = hunk
            hunk.id = index
            hunk.patchCount = hunks.count
            hunk.lines = hunk.lines.map { line in
                var line = line
                line.id = nextLineID
                nextLineID += 1
                return line
            }
            return hunk
        }
    }
}

public struct DiffLine: Identifiable, Equatable, Decodable {
    public enum Kind: String, Equatable {
        case addition, deletion, context
    }

    public internal(set) var id = 0
    public let kind: Kind
    public let text: String
    let oldLineNumber: Int?
    let newLineNumber: Int?

    init(kind: Kind, text: String, oldLineNumber: Int?, newLineNumber: Int?) {
        self.kind = kind
        self.text = text
        self.oldLineNumber = oldLineNumber
        self.newLineNumber = newLineNumber
    }

    enum CodingKeys: String, CodingKey {
        case kind, text
        case oldLineNumber = "old_line"
        case newLineNumber = "new_line"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = container.decodeLossyStringIfPresent(forKey: .kind).flatMap(Kind.init(rawValue:)) ?? .context
        text = container.decodeLossyStringIfPresent(forKey: .text) ?? ""
        oldLineNumber = container.decodeLossyIntIfPresent(forKey: .oldLineNumber)
        newLineNumber = container.decodeLossyIntIfPresent(forKey: .newLineNumber)
    }

    public var gutterLabel: String {
        let value = kind == .deletion ? oldLineNumber : newLineNumber
        return value.map(String.init) ?? ""
    }
}

// MARK: - Old-server fallback (TAL-697)

extension DiffHunk {
    /// The App's parser from before TAL-604, for a Web that sends no `hunks`. Delete with TAL-697.
    static func legacyParse(_ raw: String) -> [DiffHunk] {
        guard !raw.isEmpty else { return [] }
        let allLines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let headerIndexes = allLines.indices.filter { allLines[$0].hasPrefix("@@") }

        if headerIndexes.isEmpty {
            var groups: [[String]] = []
            var current: [String] = []
            for line in allLines {
                if line.hasPrefix("diff --git") {
                    if !current.isEmpty { groups.append(current) }
                    current = []
                } else if isPatchLine(line) {
                    current.append(line)
                }
            }
            if !current.isEmpty { groups.append(current) }
            return groups.map { makeHunk(header: "", rawLines: $0) }
        }

        return headerIndexes.enumerated().map { offset, index in
            let end = offset + 1 < headerIndexes.count ? headerIndexes[offset + 1] : allLines.endIndex
            var rawLines = Array(allLines[(index + 1)..<end])
            // A multi-file diff (TAL-448): the next file's `---` / `+++` header and the blank line joining files are no change.
            if rawLines.count >= 2, rawLines[rawLines.count - 2].hasPrefix("--- "), rawLines[rawLines.count - 1].hasPrefix("+++ ") {
                rawLines.removeLast(2)
                while rawLines.last?.isEmpty == true { rawLines.removeLast() }
            }
            return makeHunk(header: allLines[index], rawLines: rawLines)
        }
    }

    private static func makeHunk(header: String, rawLines: [String]) -> DiffHunk {
        let range = parseRange(header)
        var oldLine = range.oldStart
        var newLine = range.newStart
        let lines = rawLines.map { rawLine -> DiffLine in
            let kind: DiffLine.Kind = rawLine.hasPrefix("+") ? .addition : rawLine.hasPrefix("-") ? .deletion : .context
            let isMarker = rawLine.hasPrefix("\\")
            let line = DiffLine(
                kind: kind,
                text: rawLine,
                oldLineNumber: isMarker || kind == .addition ? nil : oldLine,
                newLineNumber: isMarker || kind == .deletion ? nil : newLine
            )
            if !isMarker, kind != .addition { oldLine = oldLine.map { $0 + 1 } }
            if !isMarker, kind != .deletion { newLine = newLine.map { $0 + 1 } }
            return line
        }
        return DiffHunk(
            header: header,
            newStart: range.newStart,
            newEnd: range.newStart.map { $0 + max(range.newCount ?? 1, 1) - 1 },
            additions: lines.filter { $0.kind == .addition }.count,
            deletions: lines.filter { $0.kind == .deletion }.count,
            lines: lines
        )
    }

    private static func parseRange(_ header: String) -> (oldStart: Int?, newStart: Int?, newCount: Int?) {
        let pieces = header.split(separator: " ")
        guard pieces.count >= 3 else { return (nil, nil, nil) }
        func values(_ token: Substring) -> (Int?, Int?) {
            let cleaned = token.dropFirst()
            let values = cleaned.split(separator: ",", maxSplits: 1).compactMap { Int($0) }
            return (values.first, values.count > 1 ? values[1] : 1)
        }
        let old = values(pieces[1])
        let new = values(pieces[2])
        return (old.0, new.0, new.1)
    }

    private static func isPatchLine(_ line: String) -> Bool {
        guard let first = line.first else { return false }
        if line.hasPrefix("+++ b/") || line == "+++ /dev/null" { return false }
        if line.hasPrefix("--- a/") || line == "--- /dev/null" { return false }
        return first == "+" || first == "-" || first == " " || first == "\\"
    }
}
