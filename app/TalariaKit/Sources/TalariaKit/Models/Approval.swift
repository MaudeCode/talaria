import Foundation

public enum ApprovalChoice: String, Codable, CaseIterable, Equatable, Sendable {
    case once
    case session
    case always
    case deny
}

public struct PromptWithdrawal: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable { case approval, clarify }
    public enum Reason: String, Decodable, Sendable { case timeout, stopped, shutdown }

    public let kind: Kind
    public let reason: Reason
}

public struct ApprovalPendingResponse: Decodable, Equatable, Sendable {
    public let pending: PendingApproval?
    public let pendingCount: Int?
    public let withdrawn: PromptWithdrawal?

    init(pending: PendingApproval?, pendingCount: Int?, withdrawn: PromptWithdrawal? = nil) {
        self.pending = pending
        self.pendingCount = pendingCount
        self.withdrawn = withdrawn
    }

    enum CodingKeys: String, CodingKey {
        case pending
        case pendingCount
        case withdrawn
        case pendingCountSnake = "pending_count"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        withdrawn = try? container.decodeIfPresent(PromptWithdrawal.self, forKey: .withdrawn)
        pending = try? container.decodeIfPresent(PendingApproval.self, forKey: .pending)
        pendingCount = container.decodeLossyIntIfPresent(forKey: .pendingCount)
            ?? container.decodeLossyIntIfPresent(forKey: .pendingCountSnake)
    }

    static func streamPayload(from data: Data, decoder: JSONDecoder = JSONDecoder()) -> ApprovalPendingResponse {
        let wrapped = try? decoder.decode(Self.self, from: data)
        if let wrapped, wrapped.pending != nil {
            return wrapped
        }

        // The live chat frame is the queue head itself, with the queue depth beside it (TAL-1043).
        if let direct = try? decoder.decode(PendingApproval.self, from: data),
           !direct.isEmpty {
            return ApprovalPendingResponse(pending: direct, pendingCount: wrapped?.pendingCount ?? 1)
        }

        return wrapped ?? ApprovalPendingResponse(pending: nil, pendingCount: nil)
    }
}

/// TAL-974: what Allow session and Always allow cover, as the server classifies the Agent's pattern keys.
public struct ApprovalScope: Decodable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case commandPattern = "command_pattern", toolRule = "tool_rule", python, sshConfig = "ssh_config"
        case computerUse = "computer_use", securityFinding = "security_finding", unknown
    }

    public let kind: Kind
    /// The danger description, tool, or computer-use action the sentence names; nil for the other kinds.
    public let subject: String?
    /// An Always answer keeps the security finding for this session only.
    public let alwaysIsSessionOnly: Bool

    init(kind: Kind, subject: String? = nil, alwaysIsSessionOnly: Bool = false) {
        self.kind = kind
        self.subject = subject
        self.alwaysIsSessionOnly = alwaysIsSessionOnly
    }

    enum CodingKeys: String, CodingKey {
        case kind, subject, alwaysIsSessionOnly
        case alwaysIsSessionOnlySnake = "always_is_session_only"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A kind a newer server adds reads as the generic sentence.
        kind = container.decodeLossyStringIfPresent(forKey: .kind).flatMap(Kind.init(rawValue:)) ?? .unknown
        subject = container.decodeLossyStringIfPresent(forKey: .subject)
        alwaysIsSessionOnly = container.decodeLossyBoolIfPresent(forKey: .alwaysIsSessionOnly)
            ?? container.decodeLossyBoolIfPresent(forKey: .alwaysIsSessionOnlySnake) ?? false
    }
}

public struct PendingApproval: Decodable, Equatable, Identifiable, Sendable {
    public var id: String {
        if let approvalId, !approvalId.isEmpty {
            return approvalId
        }

        return "\(command ?? "")-\(description ?? "")-\(displayPatternKeys.joined(separator: ","))"
    }

    public let approvalId: String?
    /// TAL-1463: the identity Relay shows for this approval on a Live Activity (`head_id`).
    public let headId: String?
    public let command: String?
    public let description: String?
    /// TAL-1469: what the approval runs, whole and on one line, for a one-tap Allow to sit beside; nil when the server
    /// offers no one-tap Allow for it.
    public let actionText: String?
    /// TAL-2333: the call this approval holds, with its tool row's display fields, still running; nil when the server
    /// names none. A shell call carries no argument rows: its `command` shows instead.
    public let tool: ToolCall?
    /// TAL-2333: the server's `allow_text`; `sendsAllowText` is false only for an older server without the field.
    let allowText: String?
    let sendsAllowText: Bool
    let patternKey: String?
    let patternKeys: [String]?
    /// TAL-974: what Allow session and Always allow cover; nil when Allow session is not offered or the server is older.
    public let scope: ApprovalScope?
    /// TAL-974: false only for an older server without the `scope` field, whose help names the raw keys instead.
    let sendsScope: Bool
    /// TAL-1043: the choices the approval's owner accepts; nil (an older server without the field) allows all four.
    let allowedChoices: [ApprovalChoice]?
    /// TAL-1043: false when the owner cannot turn on approval bypass for the session.
    let canEnableYolo: Bool?

    /// TAL-2333: what an Allow outside the card (Siri, Shortcuts) confirms, as the server words it: the command or the
    /// Agent's own description, never a question or reason; nil sends the user to the chat. An older server's
    /// `description` is the Agent's own, so its command or description stands in.
    public var allowAction: String? {
        let text = sendsAllowText ? allowText : [command, description].compactMap { $0 }.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return text.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func allows(_ choice: ApprovalChoice) -> Bool {
        allowedChoices?.contains(choice) ?? true
    }

    public var allowsApprovalBypass: Bool { canEnableYolo != false }

    var displayPatternKeys: [String] {
        let keys = patternKeys?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? []
        if !keys.isEmpty {
            return keys
        }

        guard let patternKey = patternKey?.trimmingCharacters(in: .whitespacesAndNewlines),
              !patternKey.isEmpty
        else {
            return []
        }

        return [patternKey]
    }

    public var isEmpty: Bool {
        approvalId == nil
            && command == nil
            && description == nil
            && patternKey == nil
            && (patternKeys?.isEmpty ?? true)
    }

    init(
        approvalId: String? = nil,
        command: String? = nil,
        description: String? = nil,
        patternKey: String? = nil,
        patternKeys: [String]? = nil,
        allowedChoices: [ApprovalChoice]? = nil,
        canEnableYolo: Bool? = nil,
        headId: String? = nil,
        actionText: String? = nil,
        tool: ToolCall? = nil,
        allowText: String? = nil,
        sendsAllowText: Bool = false,
        scope: ApprovalScope? = nil,
        sendsScope: Bool = false
    ) {
        self.scope = scope
        self.sendsScope = sendsScope
        self.tool = tool
        self.allowText = allowText
        self.sendsAllowText = sendsAllowText
        self.approvalId = Self.normalizedApprovalId(approvalId)
        self.headId = headId
        self.actionText = actionText
        self.command = command
        self.description = description
        self.patternKey = patternKey
        self.patternKeys = patternKeys
        self.allowedChoices = allowedChoices
        self.canEnableYolo = canEnableYolo
    }

    enum CodingKeys: String, CodingKey {
        case id
        case approvalId
        case approvalIdSnake = "approval_id"
        case command
        case description
        case patternKey
        case patternKeySnake = "pattern_key"
        case patternKeys
        case patternKeysSnake = "pattern_keys"
        case allowedChoices
        case allowedChoicesSnake = "allowed_choices"
        case canEnableYolo
        case canEnableYoloSnake = "can_enable_yolo"
        case headId
        case headIdSnake = "head_id"
        case actionText
        case actionTextSnake = "action_text"
        case tool
        case allowText
        case allowTextSnake = "allow_text"
        case scope
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = Self.decodeApprovalId(from: container)
        headId = Self.normalizedApprovalId(
            container.decodeLossyStringIfPresent(forKey: .headId) ?? container.decodeLossyStringIfPresent(forKey: .headIdSnake)
        )
        command = container.decodeLossyStringIfPresent(forKey: .command)
        description = container.decodeLossyStringIfPresent(forKey: .description)
        actionText = (container.decodeLossyStringIfPresent(forKey: .actionText)
            ?? container.decodeLossyStringIfPresent(forKey: .actionTextSnake)).flatMap { $0.isEmpty ? nil : $0 }
        tool = Self.heldCall((try? container.decodeIfPresent(JSONValue.self, forKey: .tool)) ?? nil)
        sendsAllowText = container.contains(.allowText) || container.contains(.allowTextSnake)
        allowText = container.decodeLossyStringIfPresent(forKey: .allowText) ?? container.decodeLossyStringIfPresent(forKey: .allowTextSnake)
        patternKey = container.decodeLossyStringIfPresent(forKey: .patternKey)
            ?? container.decodeLossyStringIfPresent(forKey: .patternKeySnake)
        patternKeys = Self.decodeStringArray(from: container, keys: [.patternKeys, .patternKeysSnake])
        allowedChoices = Self.decodeAllowedChoices(from: container)
        sendsScope = container.contains(.scope)
        scope = try? container.decodeIfPresent(ApprovalScope.self, forKey: .scope)
        canEnableYolo = container.decodeLossyBoolIfPresent(forKey: .canEnableYolo)
            ?? container.decodeLossyBoolIfPresent(forKey: .canEnableYoloSnake)
    }

    /// The held call as a running tool row, from the server's `tool` object (its keys kept as sent).
    private static func heldCall(_ value: JSONValue?) -> ToolCall? {
        guard case .object(var object)? = value else { return nil }
        object["done"] = .bool(false)
        return ToolCallGroup.toolCall(from: .object(object), fallbackID: "approval-tool")
    }

    private static func decodeStringArray(
        from container: KeyedDecodingContainer<CodingKeys>,
        keys: [CodingKeys]
    ) -> [String]? {
        for key in keys {
            if let values = try? container.decodeIfPresent([String].self, forKey: key) {
                return values
            }

            if let values = try? container.decodeIfPresent([JSONValue].self, forKey: key) {
                return values.compactMap(\.lossyString)
            }

            if let value = container.decodeLossyStringIfPresent(forKey: key) {
                return [value]
            }
        }

        return nil
    }

    /// TAL-1414: a present field offers only the listed choices Talaria can send; null, an object, a scalar, or a list
    /// holding a non-string offers none. Only an absent field keeps an older server's allow-all behavior.
    private static func decodeAllowedChoices(from container: KeyedDecodingContainer<CodingKeys>) -> [ApprovalChoice]? {
        for key in [CodingKeys.allowedChoices, .allowedChoicesSnake] where container.contains(key) {
            guard let values = try? container.decode([String].self, forKey: key) else { return [] }
            return values.compactMap(ApprovalChoice.init(rawValue:))
        }

        return nil
    }

    private static func decodeApprovalId(from container: KeyedDecodingContainer<CodingKeys>) -> String? {
        for key in [CodingKeys.approvalId, .approvalIdSnake, .id] {
            if let value = normalizedApprovalId(container.decodeLossyStringIfPresent(forKey: key)) {
                return value
            }
        }

        return nil
    }

    private static func normalizedApprovalId(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public struct ApprovalRespondResponse: Decodable, Equatable, Sendable {
    public let ok: Bool?
    let choice: ApprovalChoice?
    /// Server cleared a stale card whose approval already resolved (benign 200; issue #25).
    public let staleCleared: Bool?
    /// The respond was relayed to a gateway-managed run rather than resolved locally.
    let relayed: Bool?
    /// The prompt already expired (paired with a 409 on the docs' respond contract).
    let stale: Bool?

    enum CodingKeys: String, CodingKey {
        case ok
        case choice
        case staleCleared
        case staleClearedSnake = "stale_cleared"
        case relayed
        case stale
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        choice = try? container.decodeIfPresent(ApprovalChoice.self, forKey: .choice)
        staleCleared = container.decodeLossyBoolIfPresent(forKey: .staleCleared)
            ?? container.decodeLossyBoolIfPresent(forKey: .staleClearedSnake)
        relayed = container.decodeLossyBoolIfPresent(forKey: .relayed)
        stale = container.decodeLossyBoolIfPresent(forKey: .stale)
    }
}

public struct SessionYoloResponse: Decodable, Equatable, Sendable {
    let ok: Bool?
    public let yoloEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case ok
        case yoloEnabled
        case yoloEnabledSnake = "yolo_enabled"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        yoloEnabled = container.decodeLossyBoolIfPresent(forKey: .yoloEnabled)
            ?? container.decodeLossyBoolIfPresent(forKey: .yoloEnabledSnake)
    }
}

private extension JSONValue {
    var lossyString: String? {
        switch self {
        case .string(let value):
            value
        case .number(let value):
            "\(value)"
        case .bool(let value):
            value ? "true" : "false"
        case .object, .array, .null:
            nil
        }
    }
}
