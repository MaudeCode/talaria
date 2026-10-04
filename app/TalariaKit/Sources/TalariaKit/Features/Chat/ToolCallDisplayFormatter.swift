import Foundation

public struct ToolCallDisplayContent: Equatable {
    public let argumentRows: [ToolCallArgumentDisplay]
    public let result: ToolCallResultDisplay?
}

public struct ToolCallArgumentDisplay: Identifiable, Equatable {
    public let key: String
    public let value: String

    public var id: String { key }
}

public struct ToolCallResultDisplay: Equatable {
    public let title: String
    public let text: String
    public let isMonospaced: Bool
}

public enum ToolCallDisplayFormatter {
    public static func content(for toolCall: ToolCall) -> ToolCallDisplayContent {
        ToolCallDisplayContent(
            argumentRows: argumentRows(from: toolCall.args),
            result: resultDisplay(for: toolCall)
        )
    }

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
