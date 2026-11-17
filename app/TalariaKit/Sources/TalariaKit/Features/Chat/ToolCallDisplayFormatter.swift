import Foundation

public struct ToolCallDisplayContent: Equatable, Sendable {
    public let argumentRows: [ToolCallArgumentDisplay]
    public let result: ToolCallResultDisplay?
}

public struct ToolCallArgumentDisplay: Identifiable, Equatable, Sendable {
    public let key: String
    public let value: String

    public var id: String { key }
}

public struct ToolCallResultDisplay: Equatable, Sendable {
    public let title: String
    public let text: String
    public let isMonospaced: Bool
    /// TAL-2318: a JSON-object result's server rows, shown in place of `text`; empty for any other result.
    public var rows: [ToolCallArgumentDisplay] = []
}

public enum ToolCallDisplayFormatter {
    public static func content(for toolCall: ToolCall) -> ToolCallDisplayContent {
        ToolCallDisplayContent(
            argumentRows: toolCall.argsFields.map(rows) ?? argumentRows(from: toolCall.args),
            result: resultDisplay(for: toolCall)
        )
    }

    /// TAL-2338: what Copy copies in the formatted view: a file edit's diff, which the card shows alone (TAL-448); else the
    /// argument rows, then the result as the card shows it (a read's lines under its path, a search's `line: text` matches
    /// under each file, links, pages, an analysis, rows), else the result's rows or text. A row's multi-line value goes
    /// under its key.
    public static func copyText(for toolCall: ToolCall) -> String {
        if let editDiff = toolCall.editDiff { return editDiff.diff }
        func joined(_ parts: [String?], _ separator: String = "\n") -> String {
            parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: separator)
        }
        func lines(_ rows: [ToolCallArgumentDisplay]) -> String {
            rows.map { $0.value.contains("\n") ? "\($0.key):\n\($0.value)" : "\($0.key): \($0.value)" }.joined(separator: "\n")
        }
        let content = content(for: toolCall)
        let text = content.result.map { $0.rows.isEmpty ? $0.text : lines($0.rows) }
        let view = toolCall.resultView
        let result: String?
        if let excerpt = view?.fileExcerpt {
            let code = excerpt.lines.map(\.text).joined(separator: "\n")
            result = excerpt.path.isEmpty ? joined([code, text], "\n\n") : joined([excerpt.path, code])
        } else if let matches = view?.matches {
            result = matches.files.map { file in joined([file.path] + file.matches.map { "\($0.line): \($0.text)" }) }.joined(separator: "\n\n")
        } else if let links = view?.links {
            result = joined([links.answer] + links.items.map { joined([$0.title, $0.url, $0.snippet]) }, "\n\n")
        } else if let pages = view?.pages {
            result = pages.map { joined([$0.title, $0.url, $0.error ?? $0.excerpt]) }.joined(separator: "\n\n")
        } else if let analysis = view?.analysis {
            result = analysis
        } else if let rows = view?.rows {
            result = joined([rows.title] + rows.rows.map { joined([$0.label, $0.detail], ": ") } + [rows.markdown])
        } else {
            result = text
        }
        return joined([lines(content.argumentRows), result], "\n\n")
    }

    /// TAL-2318: the server's rows, in its order.
    static func rows(_ fields: [ToolField]) -> [ToolCallArgumentDisplay] {
        fields.map { ToolCallArgumentDisplay(key: $0.key, value: $0.value) }
    }

    // ponytail: older-server fallback; delete with `JSONValue.toolDisplayText` once every supported server sends `args_fields`.
    static func argumentRows(from args: [String: JSONValue]?) -> [ToolCallArgumentDisplay] {
        (args ?? [:])
            .sorted { $0.key < $1.key }
            .map { key, value in
                ToolCallArgumentDisplay(key: key, value: value.toolDisplayText)
            }
    }

    /// TAL-315: the server's result sections, one per line, in its order; an older server's flat preview as sent.
    static func resultDisplay(for toolCall: ToolCall) -> ToolCallResultDisplay? {
        let text: String
        var isMonospaced = toolCall.kind == .shell
        if let view = toolCall.resultView, let fields = view.fields, !fields.isEmpty {
            return ToolCallResultDisplay(title: String(localized: "Result"), text: view.text ?? "", isMonospaced: true, rows: rows(fields))
        }
        if let view = toolCall.resultView {
            let sections: [String?] = [
                view.text,
                view.stdout,
                view.stderr,
                view.error.map { String(localized: "Error: \($0)") },
                view.exitCode.map { String(localized: "Exit code: \($0)") }
            ]
            text = sections.compactMap { $0 }.joined(separator: "\n")
            isMonospaced = isMonospaced || view.stdout != nil || view.stderr != nil
        } else {
            // ponytail: old-server fallback; delete once every supported server sends `result_view`.
            text = toolCall.preview ?? ""
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return ToolCallResultDisplay(title: String(localized: "Result"), text: text, isMonospaced: isMonospaced)
    }

    fileprivate static func normalizedDisplayString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: #"\\r\\n"#, with: "\n")
            .replacingOccurrences(of: #"\r\n"#, with: "\n")
            .replacingOccurrences(of: #"\\n"#, with: "\n")
            .replacingOccurrences(of: #"\n"#, with: "\n")
            .replacingOccurrences(of: #"\\t"#, with: "\t")
            .replacingOccurrences(of: #"\t"#, with: "\t")
    }
}

private extension JSONValue {
    var inlineDisplayText: String? {
        switch self {
        case .string(let value):
            let text = ToolCallDisplayFormatter.normalizedDisplayString(value)
            return text.contains("\n") ? nil : text
        case .number(let value):
            return value.formatted()
        case .bool(let value):
            return value ? "true" : "false"
        case .object(let value):
            return value.isEmpty ? "{}" : nil
        case .array(let value):
            return value.isEmpty ? "[]" : nil
        case .null:
            return "null"
        }
    }

    var toolDisplayText: String {
        multilineDisplayText(indentation: 0)
    }

    private func multilineDisplayText(indentation: Int) -> String {
        let indent = String(repeating: " ", count: indentation)

        if let inlineDisplayText {
            return "\(indent)\(inlineDisplayText)"
        }

        switch self {
        case .object(let value):
            return value
                .sorted { $0.key < $1.key }
                .map { key, value in
                    if let inline = value.inlineDisplayText {
                        return "\(indent)\(key): \(inline)"
                    }

                    return "\(indent)\(key):\n\(value.multilineDisplayText(indentation: indentation + 2))"
                }
                .joined(separator: "\n")
        case .array(let value):
            return value
                .map { item in
                    if let inline = item.inlineDisplayText {
                        return "\(indent)- \(inline)"
                    }

                    return "\(indent)-\n\(item.multilineDisplayText(indentation: indentation + 2))"
                }
                .joined(separator: "\n")
        case .string(let value):
            let text = ToolCallDisplayFormatter.normalizedDisplayString(value)
            return text
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { "\(indent)\($0)" }
                .joined(separator: "\n")
        case .number, .bool, .null:
            return "\(indent)\(inlineDisplayText ?? "")"
        }
    }
}
