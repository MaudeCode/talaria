import Foundation

public struct DiffHunk: Identifiable, Equatable {
    public let id: Int
    let header: String
    public let lines: [DiffLine]
    let isSynthetic: Bool
    let patchNumber: Int
    let patchCount: Int
    let newStart: Int?
    let newCount: Int?

    public var additions: Int { lines.filter { $0.kind == .addition }.count }
    public var deletions: Int { lines.filter { $0.kind == .deletion }.count }

    public var displayLabel: String {
        if isSynthetic { return "Patch \(patchNumber) of \(patchCount)" }
        guard let start = newStart else { return header }
        let count = max(newCount ?? 1, 1)
        return count == 1 ? "Line \(start)" : "Lines \(start)-\(start + count - 1)"
    }

    public static func parse(_ raw: String) -> [DiffHunk] {
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
            guard !groups.isEmpty else { return [] }
            return groups.enumerated().map { index, lines in
                makeHunk(
                    id: index,
                    header: "",
                    rawLines: lines,
                    synthetic: true,
                    patchNumber: index + 1,
                    patchCount: groups.count
                )
            }
        }

        return headerIndexes.enumerated().map { offset, index in
            let end = offset + 1 < headerIndexes.count ? headerIndexes[offset + 1] : allLines.endIndex
            var rawLines = Array(allLines[(index + 1)..<end])
            // A multi-file diff (TAL-448): the next file's `---` / `+++` header and the blank line joining files are no change.
            if rawLines.count >= 2, rawLines[rawLines.count - 2].hasPrefix("--- "), rawLines[rawLines.count - 1].hasPrefix("+++ ") {
                rawLines.removeLast(2)
                while rawLines.last?.isEmpty == true { rawLines.removeLast() }
            }
            return makeHunk(
                id: offset,
                header: allLines[index],
                rawLines: rawLines,
                synthetic: false,
                patchNumber: offset + 1,
                patchCount: headerIndexes.count
            )
        }
    }

    private static func makeHunk(
        id: Int,
        header: String,
        rawLines: [String],
        synthetic: Bool,
        patchNumber: Int,
        patchCount: Int
    ) -> DiffHunk {
        let range = parseRange(header)
        var oldLine = range.oldStart
        var newLine = range.newStart
        let lines = rawLines.enumerated().map { offset, rawLine -> DiffLine in
            let kind = DiffLine.Kind(rawLine)
            let isMarker = rawLine.hasPrefix("\\")
            let line = DiffLine(
                id: offset,
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
            id: id,
            header: header,
            lines: lines,
            isSynthetic: synthetic,
            patchNumber: patchNumber,
            patchCount: patchCount,
            newStart: range.newStart,
            newCount: range.newCount
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

public struct DiffLine: Identifiable, Equatable {
    public enum Kind: Equatable {
        case addition, deletion, context

        init(_ line: String) {
            switch line.first {
            case "+": self = .addition
            case "-": self = .deletion
            default: self = .context
            }
        }
    }

    public let id: Int
    public let kind: Kind
    public let text: String
    let oldLineNumber: Int?
    let newLineNumber: Int?

    public var gutterLabel: String {
        let value = kind == .deletion ? oldLineNumber : newLineNumber
        return value.map(String.init) ?? ""
    }
}
