import Foundation

/// TAL-1043: a chat another Agent client (CLI, TUI, Desktop, messaging) owns, as the server reports it in the session's
/// `owner_attachment` (TAL-1038). The server decides every capability and every admission action; the App renders
/// them and never infers ownership from source labels. Decoded with `convertFromSnakeCase`; cached with the default coders.
public struct OwnerAttachment: Codable, Equatable, Sendable {
    /// `attached` while the owner accepts input; `stopped`, `unavailable`, `incompatible` or `refused` keep the chat
    /// read-only, with `reason` saying why.
    public let state: String
    public let reason: String?
    public let canSubmit: Bool
    public let canInterrupt: Bool
    public let canAttach: Bool
    public let revision: Int?
    public let executionGeneration: Int?
    public let modelChange: ModelChange?

    /// The owner model decision differs from a direct writer's HTTP confirmation refusal.
    public struct ModelChange: Codable, Equatable, Sendable {
        public let state: String
        public let message: String?
        public let confirm: String?
        public let model: String?
        public let provider: String?
    }
    /// Queued and outcome-unknown inputs, oldest first.
    public let admissions: [OwnerAdmission]

    public var isAttached: Bool { state == "attached" }
    public var hasUnknownAdmission: Bool { admissions.contains(where: \.isOutcomeUnknown) }

    enum CodingKeys: String, CodingKey {
        case state, reason, canSubmit, canInterrupt, canAttach, revision, executionGeneration, modelChange, admissions
    }

    public init(state: String, reason: String? = nil, canSubmit: Bool, canInterrupt: Bool, canAttach: Bool, admissions: [OwnerAdmission] = [], revision: Int? = nil, executionGeneration: Int? = nil) {
        self.state = state
        self.reason = reason
        self.canSubmit = canSubmit
        self.canInterrupt = canInterrupt
        self.canAttach = canAttach
        self.revision = revision
        self.executionGeneration = executionGeneration
        self.modelChange = nil
        self.admissions = admissions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let state = container.decodeLossyStringIfPresent(forKey: .state) else {
            throw DecodingError.keyNotFound(CodingKeys.state, .init(codingPath: decoder.codingPath, debugDescription: "An owner attachment needs its state."))
        }
        self.state = state
        reason = container.decodeLossyStringIfPresent(forKey: .reason)
        // A missing capability is a refusal.
        canSubmit = container.decodeLossyBoolIfPresent(forKey: .canSubmit) ?? false
        canInterrupt = container.decodeLossyBoolIfPresent(forKey: .canInterrupt) ?? false
        canAttach = container.decodeLossyBoolIfPresent(forKey: .canAttach) ?? false
        revision = container.decodeLossyIntIfPresent(forKey: .revision)
        executionGeneration = container.decodeLossyIntIfPresent(forKey: .executionGeneration)
        modelChange = try? container.decodeIfPresent(ModelChange.self, forKey: .modelChange)
        admissions = container.decodeLossyArrayIfPresent(OwnerAdmission.self, forKey: .admissions) ?? []
    }
}

/// One input the owner admitted but has not finished, with the actions the server allows on it.
public struct OwnerAdmission: Codable, Equatable, Identifiable, Sendable {
    public enum Action: String, Codable, Sendable {
        case cancel, retry, discard
    }

    public let admissionId: String
    /// `queued` or `unknown`: the owner cannot say whether an unknown input ran.
    public let status: String
    public let text: String?
    public let executionGeneration: Int?
    public let actions: [Action]

    public var id: String { admissionId }
    public var isOutcomeUnknown: Bool { status == "unknown" }

    enum CodingKeys: String, CodingKey {
        case admissionId, status, text, executionGeneration, actions
    }

    public init(admissionId: String, status: String, text: String?, executionGeneration: Int?, actions: [Action]) {
        self.admissionId = admissionId
        self.status = status
        self.text = text
        self.executionGeneration = executionGeneration
        self.actions = actions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let admissionId = container.decodeLossyStringIfPresent(forKey: .admissionId),
              let status = container.decodeLossyStringIfPresent(forKey: .status) else {
            throw DecodingError.keyNotFound(CodingKeys.admissionId, .init(codingPath: decoder.codingPath, debugDescription: "An admission needs its id and status."))
        }
        self.admissionId = admissionId
        self.status = status
        text = container.decodeLossyStringIfPresent(forKey: .text)
        executionGeneration = container.decodeLossyIntIfPresent(forKey: .executionGeneration)
        // An action this build does not know is not offered.
        actions = ((try? container.decodeIfPresent([JSONValue].self, forKey: .actions)) ?? [])
            .compactMap { if case .string(let name) = $0 { Action(rawValue: name) } else { nil } }
    }
}

/// `POST /api/chat/owner-action`'s answer: the refreshed session, and for Retry the original text to review.
public struct OwnerActionResponse: Decodable, Equatable {
    public let session: SessionDetail?
    public let draft: String?
}
