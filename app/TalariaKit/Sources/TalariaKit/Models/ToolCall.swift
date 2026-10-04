import Foundation

public struct ToolCall: Identifiable, Equatable {
    public let id: String
    public var name: String?
    public var preview: String?
    public var args: [String: JSONValue]?
    /// Server-derived display fields; nil from an older server (shown as an unknown tool with no target).
    public var kind: ToolDisplayKind?
    public var target: String?
    public var duration: Double?
    public var isError: Bool?
    public var isCompleted: Bool
    public let startedAt: Double
    /// TAL-372: the background work a delegation call started (server scene field); nil on any other call.
    public var background: BackgroundLink?
    /// TAL-315: the server's result sections; nil from an older server, which shows `preview` as sent.
    public var resultView: ToolResultView?

    public init(
        id: String = "live-tool-\(UUID().uuidString)",
        name: String?,
        preview: String?,
        args: [String: JSONValue]?,
        kind: ToolDisplayKind? = nil,
        target: String? = nil,
        resultView: ToolResultView? = nil,
        duration: Double? = nil,
        isError: Bool? = nil,
        isCompleted: Bool = false,
        startedAt: Double = Date().timeIntervalSince1970
    ) {
        self.id = id
        self.name = name
        self.preview = preview
        self.args = args
        self.kind = kind
        self.target = target
        self.resultView = resultView
        self.duration = duration
        self.isError = isError
        self.isCompleted = isCompleted
        self.startedAt = startedAt
    }

    var displayName: String {
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmedName, !trimmedName.isEmpty else {
            return String(localized: "Tool")
        }
        return trimmedName
    }
}

/// TAL-315: a tool result's display sections, decided on the server for every client. Shown in this order: `text`, or
/// `stdout`, `stderr`, a labelled `error` and a labelled `exitCode` (sent only when worth showing).
public struct ToolResultView: Decodable, Equatable {
    public let text: String?
    public let stdout: String?
    public let stderr: String?
    public let error: String?
    public let exitCode: Int?

    public init(text: String? = nil, stdout: String? = nil, stderr: String? = nil, error: String? = nil, exitCode: Int? = nil) {
        self.text = text
        self.stdout = stdout
        self.stderr = stderr
        self.error = error
        self.exitCode = exitCode
    }

    enum CodingKeys: String, CodingKey {
        case text, stdout, stderr, error
        case exitCode = "exit_code"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = container.decodeLossyStringIfPresent(forKey: .text)
        stdout = container.decodeLossyStringIfPresent(forKey: .stdout)
        stderr = container.decodeLossyStringIfPresent(forKey: .stderr)
        error = container.decodeLossyStringIfPresent(forKey: .error)
        exitCode = container.decodeLossyIntIfPresent(forKey: .exitCode)
    }

    /// The view a decoded JSON field holds; nil when the server sent none.
    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let view = try? JSONDecoder().decode(ToolResultView.self, from: data)
        else { return nil }
        self = view
    }
}

public struct PersistedToolCall: Decodable, Equatable {
    let name: String?
    let snippet: String?
    let tid: String?
    let assistantMsgIdx: Int?
    let args: [String: JSONValue]?
    let kind: ToolDisplayKind?
    let target: String?

    enum CodingKeys: String, CodingKey {
        case name
        case snippet
        case tid
        case assistantMsgIdx
        case assistantMsgIdxSnake = "assistant_msg_idx"
        case args
        case kind
        case target
    }

    init(
        name: String?,
        snippet: String?,
        tid: String?,
        assistantMsgIdx: Int?,
        args: [String: JSONValue]?,
        kind: ToolDisplayKind? = nil,
        target: String? = nil
    ) {
        self.name = name
        self.snippet = snippet
        self.tid = tid
        self.assistantMsgIdx = assistantMsgIdx
        self.args = args
        self.kind = kind
        self.target = target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        snippet = container.decodeLossyStringIfPresent(forKey: .snippet)
        tid = container.decodeLossyStringIfPresent(forKey: .tid)
        assistantMsgIdx = container.decodeLossyIntIfPresent(forKey: .assistantMsgIdx)
            ?? container.decodeLossyIntIfPresent(forKey: .assistantMsgIdxSnake)
        args = try? container.decodeIfPresent([String: JSONValue].self, forKey: .args)
        kind = ToolDisplayKind(serverValue: container.decodeLossyStringIfPresent(forKey: .kind))
        target = container.decodeLossyStringIfPresent(forKey: .target)
    }
}

public struct ToolCallGroup: Identifiable, Equatable {
    public let id: String
    public let anchorMessageID: String?
    public let toolCalls: [ToolCall]

    public init(
        id: String = UUID().uuidString,
        anchorMessageID: String?,
        toolCalls: [ToolCall]
    ) {
        self.id = id
        self.anchorMessageID = anchorMessageID
        self.toolCalls = toolCalls
    }

    var activityTitle: String {
        String(localized: "Activity: \(toolCalls.count) tools")
    }

    var isComplete: Bool {
        toolCalls.allSatisfy(\.isCompleted)
    }

    var hasFailedTool: Bool {
        toolCalls.contains { $0.isError == true }
    }

    public static func live(anchorMessageID: String?, toolCalls: [ToolCall]) -> ToolCallGroup {
        ToolCallGroup(
            id: "live-tools-\(anchorMessageID ?? "unanchored")",
            anchorMessageID: anchorMessageID,
            toolCalls: toolCalls
        )
    }

    /// Each assistant message's `tool_calls` as the server resolved them (TAL-313): its done, error, duration and result
    /// fields decide the card. An older server sends none, so its calls show as completed without an error or result.
    public static func groups(messages: [ChatMessage], messageOffset: Int?) -> [ToolCallGroup] {
        messages.enumerated().compactMap { messageIndex, message in
            guard message.role == "assistant" else { return nil }
            let toolCalls = (message.toolCalls ?? []).enumerated().compactMap { toolIndex, value in
                toolCall(from: value, fallbackID: "message-tool-\(messageIndex)-\(toolIndex)")
            }
            guard !toolCalls.isEmpty else { return nil }
            let anchorMessageID = TranscriptTurnClassifier.anchorID(
                for: message,
                at: messageIndex,
                messageOffset: messageOffset
            )
            return ToolCallGroup(
                id: "persisted-tools-\(anchorMessageID)",
                anchorMessageID: anchorMessageID,
                toolCalls: toolCalls
            )
        }
    }

    private static func toolCall(from value: JSONValue, fallbackID: String) -> ToolCall? {
        guard case .object(let object) = value else { return nil }

        let function = object["function"]?.objectValue
        return ToolCall(
            id: nonEmpty(object["id"]?.stringValue) ?? nonEmpty(object["call_id"]?.stringValue) ?? fallbackID,
            name: nonEmpty(function?["name"]?.stringValue) ?? nonEmpty(object["name"]?.stringValue) ?? "tool",
            preview: nonEmpty(object["result"]?.stringValue) ?? nonEmpty(object["preview"]?.stringValue),
            args: arguments(from: function?["arguments"] ?? object["args"]),
            kind: ToolDisplayKind(serverValue: object["kind"]?.stringValue),
            target: object["target"]?.stringValue,
            resultView: ToolResultView(object["result_view"]),
            duration: object["duration"]?.numberValue,
            isError: object["is_error"]?.boolValue,
            isCompleted: object["done"]?.boolValue ?? true
        )
    }

    private static func arguments(from value: JSONValue?) -> [String: JSONValue]? {
        guard let value else { return nil }

        if case .object(let object) = value {
            return object.isEmpty ? nil : object
        }

        guard case .string(let string) = value,
              let data = string.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let object) = decoded
        else {
            return nil
        }

        return object.isEmpty ? nil : object
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public struct ToolCallGroupAnchorLookup: Equatable {
    private let groupsByAnchor: [String?: [ToolCallGroup]]

    public init(groups: [ToolCallGroup] = []) {
        groupsByAnchor = Dictionary(grouping: groups) { group in
            group.anchorMessageID
        }
    }

    public func groups(anchorMessageID: String?) -> [ToolCallGroup] {
        groupsByAnchor[anchorMessageID] ?? []
    }
}

private extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let object) = self {
            return object
        }

        return nil
    }

    var stringValue: String? {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value.formatted()
        case .bool(let value):
            return value ? "true" : "false"
        case .object, .array, .null:
            return nil
        }
    }

    var numberValue: Double? {
        if case .number(let value) = self {
            return value
        }

        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self {
            return value
        }

        return nil
    }
}
