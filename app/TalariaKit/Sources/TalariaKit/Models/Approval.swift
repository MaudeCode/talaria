import Foundation

public enum ApprovalChoice: String, Codable, CaseIterable, Equatable {
    case once
    case session
    case always
    case deny
}

public struct ApprovalPendingResponse: Decodable, Equatable {
    public let pending: PendingApproval?
    public let pendingCount: Int?

    init(pending: PendingApproval?, pendingCount: Int?) {
        self.pending = pending
        self.pendingCount = pendingCount
    }

    enum CodingKeys: String, CodingKey {
        case pending
        case pendingCount
        case pendingCountSnake = "pending_count"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
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

public struct PendingApproval: Decodable, Equatable, Identifiable {
    public var id: String {
        if let approvalId, !approvalId.isEmpty {
            return approvalId
        }

        return "\(command ?? "")-\(description ?? "")-\(displayPatternKeys.joined(separator: ","))"
    }

    public let approvalId: String?
    public let command: String?
    public let description: String?
    let patternKey: String?
    let patternKeys: [String]?
    /// TAL-1043: the choices the approval's owner accepts; nil (an older server without the field) allows all four.
    let allowedChoices: [ApprovalChoice]?
    /// TAL-1043: false when the owner cannot turn on approval bypass for the session.
    let canEnableYolo: Bool?

    public func allows(_ choice: ApprovalChoice) -> Bool {
        allowedChoices?.contains(choice) ?? true
    }

    public var allowsApprovalBypass: Bool { canEnableYolo != false }

    public var displayPatternKeys: [String] {
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
        canEnableYolo: Bool? = nil
    ) {
        self.approvalId = Self.normalizedApprovalId(approvalId)
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
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = Self.decodeApprovalId(from: container)
        command = container.decodeLossyStringIfPresent(forKey: .command)
        description = container.decodeLossyStringIfPresent(forKey: .description)
        patternKey = container.decodeLossyStringIfPresent(forKey: .patternKey)
            ?? container.decodeLossyStringIfPresent(forKey: .patternKeySnake)
        patternKeys = Self.decodeStringArray(from: container, keys: [.patternKeys, .patternKeysSnake])
        allowedChoices = Self.decodeAllowedChoices(from: container)
        canEnableYolo = container.decodeLossyBoolIfPresent(forKey: .canEnableYolo)
            ?? container.decodeLossyBoolIfPresent(forKey: .canEnableYoloSnake)
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

public struct ApprovalRespondResponse: Decodable, Equatable {
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

public struct SessionYoloResponse: Decodable, Equatable {
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
