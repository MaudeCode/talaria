import Foundation

public struct ClarificationPendingResponse: Decodable, Equatable {
    public let pending: PendingClarification?
    public let pendingCount: Int?

    public init(pending: PendingClarification?, pendingCount: Int?) {
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
        pending = try? container.decodeIfPresent(PendingClarification.self, forKey: .pending)
        pendingCount = container.decodeLossyIntIfPresent(forKey: .pendingCount)
            ?? container.decodeLossyIntIfPresent(forKey: .pendingCountSnake)
    }

    static func streamPayload(from data: Data, decoder: JSONDecoder = JSONDecoder()) -> ClarificationPendingResponse {
        let wrapped = try? decoder.decode(Self.self, from: data)
        if let wrapped, wrapped.pending != nil {
            return wrapped
        }

        // The live chat frame is the queue head itself, with the queue depth beside it (TAL-1043).
        if let direct = try? decoder.decode(PendingClarification.self, from: data),
           !direct.isEmpty {
            return ClarificationPendingResponse(pending: direct, pendingCount: wrapped?.pendingCount ?? 1)
        }

        return wrapped ?? ClarificationPendingResponse(pending: nil, pendingCount: nil)
    }

    static func containsClarificationMarkers(in data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }

        let candidate = object["pending"] as? [String: Any] ?? object
        return candidate["question"] != nil
            || candidate["choices_offered"] != nil
            || candidate["choicesOffered"] != nil
            || candidate["questions"] != nil
            || candidate["steps"] != nil
    }
}

public struct PendingClarification: Decodable, Equatable, Identifiable {
    public var id: String {
        if let clarifyId, !clarifyId.isEmpty {
            return clarifyId
        }

        return "\(sessionId ?? "")-\(question ?? "")-\(requestedAt ?? 0)"
    }

    public let clarifyId: String?
    let question: String?
    let sessionId: String?
    let requestedAt: Double?
    public let timeoutSeconds: Int?
    public let expiresAt: Double?
    public let steps: [ClarificationStep]?
    /// The Agent's password-manager prompt, which the server sends with no `steps` (TAL-887).
    public let vault: VaultPrompt?

    /// Only server `steps` or a vault prompt are answerable; a payload without either renders no prompt.
    public var isEmpty: Bool { (steps?.isEmpty ?? true) && vault == nil }

    init(
        clarifyId: String? = nil,
        question: String? = nil,
        sessionId: String? = nil,
        requestedAt: Double? = nil,
        timeoutSeconds: Int? = nil,
        expiresAt: Double? = nil,
        steps: [ClarificationStep]? = nil,
        vault: VaultPrompt? = nil
    ) {
        self.clarifyId = clarifyId
        self.question = question
        self.sessionId = sessionId
        self.requestedAt = requestedAt
        self.timeoutSeconds = timeoutSeconds
        self.expiresAt = expiresAt
        self.steps = steps
        self.vault = vault
    }

    enum CodingKeys: String, CodingKey {
        case clarifyId
        case clarifyIdSnake = "clarify_id"
        case question
        case sessionId
        case sessionIdSnake = "session_id"
        case requestedAt
        case requestedAtSnake = "requested_at"
        case timeoutSeconds
        case timeoutSecondsSnake = "timeout_seconds"
        case expiresAt
        case expiresAtSnake = "expires_at"
        case steps
        case vault
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clarifyId = container.decodeLossyStringIfPresent(forKey: .clarifyId)
            ?? container.decodeLossyStringIfPresent(forKey: .clarifyIdSnake)
        question = container.decodeLossyStringIfPresent(forKey: .question)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
            ?? container.decodeLossyStringIfPresent(forKey: .sessionIdSnake)
        requestedAt = container.decodeLossyDoubleIfPresent(forKey: .requestedAt)
            ?? container.decodeLossyDoubleIfPresent(forKey: .requestedAtSnake)
        timeoutSeconds = container.decodeLossyIntIfPresent(forKey: .timeoutSeconds)
            ?? container.decodeLossyIntIfPresent(forKey: .timeoutSecondsSnake)
        expiresAt = container.decodeLossyDoubleIfPresent(forKey: .expiresAt)
            ?? container.decodeLossyDoubleIfPresent(forKey: .expiresAtSnake)
        steps = try container.decodeIfPresent([ClarificationStep].self, forKey: .steps)
        vault = try? container.decodeIfPresent(VaultPrompt.self, forKey: .vault)
    }
}

/// The Agent asks for a password manager's master password, a login to save, a one-time code (TAL-887), or a skill's
/// missing environment secret (TAL-1046). The server owns every field; the answers go back once, keyed by field, and
/// are never kept. An unknown kind or field fails the whole prompt's decode, so it renders nothing.
public struct VaultPrompt: Decodable, Equatable {
    public enum Kind: String, Decodable {
        case unlock = "vault_unlock"
        case saveLogin = "vault_save_login"
        case code = "vault_code"
        case skillSecret = "skill_secret"
    }

    public struct Field: Decodable, Equatable, Identifiable {
        public enum Key: String, Decodable {
            case masterPassword = "master_password"
            case identifier, password, code, secret
        }

        public let key: Key
        public let secure: Bool
        public var id: Key { key }
    }

    public let kind: Kind
    public let backend: String?
    public let displayName: String?
    public let site: String?
    public let hint: String?
    /// The skill setup a `skill_secret` prompt is for.
    public let skill: Skill?
    public let fields: [Field]
    public let timeoutAt: Double

    public struct Skill: Decodable, Equatable {
        public let envVar: String
        public let skillName: String
        public let help: String?
        public let requiredFor: String?

        enum CodingKeys: String, CodingKey {
            case help
            case envVar = "env_var"
            case skillName = "skill_name"
            case requiredFor = "required_for"
        }
    }

    enum CodingKeys: String, CodingKey {
        case kind, backend, site, hint, skill, fields
        case displayName = "display_name"
        case timeoutAt = "timeout_at"
    }
}

/// Server-owned display fields for one clarification question.
public struct ClarificationStep: Decodable, Equatable {
    public let qid: String
    public let question: String
    public let choices: [String]
    public let multiSelect: Bool

    enum CodingKeys: String, CodingKey {
        case qid, question, choices, multiSelect
        case multiSelectSnake = "multi_select"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        qid = try container.decode(String.self, forKey: .qid)
        question = try container.decode(String.self, forKey: .question)
        choices = try container.decode([String].self, forKey: .choices)
        multiSelect = try container.decodeIfPresent(Bool.self, forKey: .multiSelect)
            ?? container.decode(Bool.self, forKey: .multiSelectSnake)
    }
}

public struct ClarificationRespondResponse: Decodable, Equatable {
    let ok: Bool?
    let response: String?
    /// The prompt already expired or was resolved (paired with a 409; issue #25).
    let stale: Bool?
    /// Server cleared a stale card whose prompt already resolved (mirrors approvals).
    let staleCleared: Bool?
    /// The respond was relayed to a gateway-managed run rather than resolved locally.
    let relayed: Bool?

    enum CodingKeys: String, CodingKey {
        case ok
        case response
        case stale
        case staleCleared
        case staleClearedSnake = "stale_cleared"
        case relayed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        response = container.decodeLossyStringIfPresent(forKey: .response)
        stale = container.decodeLossyBoolIfPresent(forKey: .stale)
        staleCleared = container.decodeLossyBoolIfPresent(forKey: .staleCleared)
            ?? container.decodeLossyBoolIfPresent(forKey: .staleClearedSnake)
        relayed = container.decodeLossyBoolIfPresent(forKey: .relayed)
    }
}
