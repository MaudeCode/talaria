import Foundation

/// TAL-1967: a change an agent asks the owner to make for it (`ProposalSchema`): a catalog plugin, an MCP server, a
/// setting or a scheduled task. The server owns the summary, diff, field list, risk notes, actions, status and outcome;
/// the App renders them. Proposal payloads decode with `DecisionReview.decoder`, like every agent-request model.
public struct Proposal: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Equatable, Sendable {
        case pending, approved, rejected, applied, failed, expired
    }

    public struct Field: Decodable, Equatable, Sendable {
        public let label: String
        public let value: String
    }

    /// What this requester may do; only the server owner can approve or reject.
    public struct Actions: Decodable, Equatable, Sendable {
        public let canApprove: Bool
        public let canReject: Bool

        public init(canApprove: Bool, canReject: Bool) {
            self.canApprove = canApprove
            self.canReject = canReject
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            canApprove = (try? container.decode(Bool.self, forKey: .canApprove)) ?? false
            canReject = (try? container.decode(Bool.self, forKey: .canReject)) ?? false
        }

        enum CodingKeys: String, CodingKey { case canApprove, canReject }
    }

    /// The route's result text once applied, its error once failed; both nil until decided.
    public struct Outcome: Decodable, Equatable, Sendable {
        public let text: String?
        public let error: String?

        public init(text: String? = nil, error: String? = nil) {
            self.text = text
            self.error = error
        }
    }

    public let proposalId: String
    public let sessionId: String
    public let summary: String
    /// `setting` and `mcp_server` changes as the workspace diff view's lines: the current value removed, the proposed one added.
    public let diff: [DiffLine]
    public let fields: [Field]
    public let riskNotes: [String]
    /// Binds an approval to exactly the change shown.
    public let payloadHash: String
    public var actions: Actions
    public var status: Status
    public let outcome: Outcome

    enum CodingKeys: String, CodingKey {
        case proposalId, sessionId, summary, diff, fields, riskNotes, payloadHash, actions, status, outcome
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        proposalId = try container.decode(String.self, forKey: .proposalId)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId) ?? ""
        summary = container.decodeLossyStringIfPresent(forKey: .summary) ?? ""
        // `DiffLine` names its snake-case keys itself, so it decodes without the key conversion this model uses.
        let rawLines = (try? container.decodeIfPresent([JSONValue].self, forKey: .diff)) ?? nil
        let lines = (rawLines ?? []).compactMap { raw in
            (try? JSONEncoder().encode(raw)).flatMap { try? JSONDecoder().decode(DiffLine.self, from: $0) }
        }
        diff = lines.enumerated().map { index, line in
            var line = line
            line.id = index
            return line
        }
        fields = container.decodeLossyArrayIfPresent(Field.self, forKey: .fields) ?? []
        riskNotes = container.decodeLossyArrayIfPresent(String.self, forKey: .riskNotes) ?? []
        payloadHash = container.decodeLossyStringIfPresent(forKey: .payloadHash) ?? ""
        let known = try? container.decode(Status.self, forKey: .status)
        status = known ?? .pending
        // A status this App does not know offers no action.
        actions = known == nil ? Actions(canApprove: false, canReject: false)
            : (try? container.decode(Actions.self, forKey: .actions)) ?? Actions(canApprove: false, canReject: false)
        outcome = (try? container.decode(Outcome.self, forKey: .outcome)) ?? Outcome()
    }
}

/// The transcript card's reference from a `propose` result (`ProposalRefSchema`).
public struct ProposalRef: Decodable, Equatable, Sendable {
    public let proposalId: String
    public let kind: String
    public let summary: String

    public init(proposalId: String, kind: String, summary: String) {
        self.proposalId = proposalId
        self.kind = kind
        self.summary = summary
    }
}

/// The `proposal` session stream event (`ProposalEventSchema`): the card rereads its proposal.
public struct ProposalEvent: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let proposalId: String

    public init(sessionId: String, proposalId: String) {
        self.sessionId = sessionId
        self.proposalId = proposalId
    }
}
