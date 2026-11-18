import Foundation

/// TAL-604: one hunk of a unified diff, parsed on the server (`hunks` on a git diff and on a file edit's `edit_diff`).
public struct DiffHunk: Identifiable, Equatable, Decodable, Sendable {
    public internal(set) var id = 0
    let header: String
    let newStart: Int?
    let newEnd: Int?
    public let additions: Int
    public let deletions: Int
    public internal(set) var lines: [DiffLine]
    var patchCount = 1

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

    /// The server's hunks, numbered for display; none when the field is missing or malformed.
    static func resolved(_ value: JSONValue?) -> [DiffHunk] {
        guard let value,
              let data = try? JSONEncoder().encode(value),
              let hunks = try? JSONDecoder().decode([DiffHunk].self, from: data)
        else { return [] }
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

public struct DiffLine: Identifiable, Equatable, Decodable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case addition, deletion, context
    }

    public internal(set) var id = 0
    public let kind: Kind
    public let text: String
    let oldLineNumber: Int?
    let newLineNumber: Int?

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
