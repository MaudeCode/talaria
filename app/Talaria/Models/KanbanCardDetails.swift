import Foundation

enum KanbanDependencyMutationValidator {
    static func validate(
        _ envelope: KanbanDependencyMutationEnvelope,
        request: KanbanDependencyMutationRequest
    ) throws {
        guard envelope.ok == true,
              normalizedKanbanIdentifier(envelope.prerequisiteID) == normalizedKanbanIdentifier(request.prerequisiteID),
              normalizedKanbanIdentifier(envelope.dependentID) == normalizedKanbanIdentifier(request.dependentID) else {
            throw KanbanContractViolation.missingCardIdentity
        }
    }
}

enum KanbanCardMutationValidator {
    static func validate(_ envelope: KanbanCardMutationEnvelope, expectedCardID: String? = nil) throws -> KanbanCard {
        guard let card = envelope.card,
              let cardID = normalizedKanbanIdentifier(card.cardID),
              normalizedKanbanIdentifier(card.status?.rawValue) != nil else {
            throw KanbanContractViolation.missingCardIdentity
        }
        if let expectedCardID, cardID != normalizedKanbanIdentifier(expectedCardID) {
            throw KanbanContractViolation.missingCardIdentity
        }
        return card
    }
}

struct KanbanComment: Decodable, Equatable, Sendable {
    let commentID: String?
    let cardID: String?
    let author: String?
    let body: String?
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case commentID = "id"
        case cardID = "taskId"
        case author, body, createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commentID = container.decodeLossyStringIfPresent(forKey: .commentID)
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        author = container.decodeLossyStringIfPresent(forKey: .author)
        body = container.decodeLossyStringIfPresent(forKey: .body)
        createdAt = container.decodeLossyStringIfPresent(forKey: .createdAt)
    }

    var presentationID: String {
        commentID ?? [cardID, author, createdAt, body].compactMap { $0 }.joined(separator: "|")
    }
}

/// Detail events retain only the fields Talaria intentionally presents. Unknown
/// payload keys are discarded so raw server payloads cannot reach diagnostics or
/// generic error UI.
struct KanbanDetailEvent: Decodable, Equatable, Sendable {
    let eventID: String?
    let cardID: String?
    let runID: String?
    let kind: String?
    let createdAt: String?
    let payload: KanbanDetailEventPayload?

    enum CodingKeys: String, CodingKey {
        case eventID = "id"
        case cardID = "taskId"
        // `runID` without a raw value spells the key "runID", but the decoder
        // runs `.convertFromSnakeCase`, which turns the server's `run_id` into
        // "runId" — so this never matched and `runID` was always nil.
        case runID = "runId"
        case kind, createdAt, payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventID = container.decodeLossyStringIfPresent(forKey: .eventID)
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        runID = container.decodeLossyStringIfPresent(forKey: .runID)
        kind = container.decodeLossyStringIfPresent(forKey: .kind)
        createdAt = container.decodeLossyStringIfPresent(forKey: .createdAt)
        payload = try? container.decodeIfPresent(KanbanDetailEventPayload.self, forKey: .payload)
    }

    var presentationID: String {
        eventID ?? [cardID, runID, kind, createdAt].compactMap { $0 }.joined(separator: "|")
    }
}

struct KanbanDetailEventPayload: Decodable, Equatable, Sendable {
    let status: String?
    let reason: String?
    let summary: String?
    let fields: [String]?

    enum CodingKeys: String, CodingKey { case status, reason, summary, fields }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = container.decodeLossyStringIfPresent(forKey: .status)
        reason = container.decodeLossyStringIfPresent(forKey: .reason)
        summary = container.decodeLossyStringIfPresent(forKey: .summary)
        fields = try? container.decodeIfPresent([String].self, forKey: .fields)
    }
}

struct KanbanDependencyLinks: Decodable, Equatable, Sendable {
    let prerequisites: [String]?
    let dependents: [String]?

    enum CodingKeys: String, CodingKey {
        case prerequisites = "parents"
        case dependents = "children"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        prerequisites = try? container.decodeIfPresent([String].self, forKey: .prerequisites)
        dependents = try? container.decodeIfPresent([String].self, forKey: .dependents)
    }
}

struct KanbanDispatchRun: Decodable, Equatable, Sendable {
    let runID: String?
    let status: String?
    let outcome: String?
    let summary: String?
    let error: String?
    let startedAt: String?
    let finishedAt: String?
    let workerID: String?
    let logTail: String?

    enum CodingKeys: String, CodingKey {
        case runID = "id"
        case alternateRunID = "runId"
        case status, outcome, summary, error, startedAt, finishedAt, endedAt
        case workerID = "worker"
        case workerPID = "workerPid"
        case logTail
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runID = container.decodeLossyStringIfPresent(forKey: .runID)
            ?? container.decodeLossyStringIfPresent(forKey: .alternateRunID)
        status = container.decodeLossyStringIfPresent(forKey: .status)
        outcome = container.decodeLossyStringIfPresent(forKey: .outcome)
        summary = container.decodeLossyStringIfPresent(forKey: .summary)
        error = container.decodeLossyStringIfPresent(forKey: .error)
        startedAt = container.decodeLossyStringIfPresent(forKey: .startedAt)
        finishedAt = container.decodeLossyStringIfPresent(forKey: .endedAt)
            ?? container.decodeLossyStringIfPresent(forKey: .finishedAt)
        workerID = container.decodeLossyStringIfPresent(forKey: .workerPID)
            ?? container.decodeLossyStringIfPresent(forKey: .workerID)
        logTail = container.decodeLossyStringIfPresent(forKey: .logTail)
    }

    var presentationID: String {
        runID ?? [status, outcome, startedAt, finishedAt].compactMap { $0 }.joined(separator: "|")
    }

}

struct KanbanWorkerLog: Decodable, Equatable, Sendable {
    let cardID: String?
    let exists: Bool?
    let sizeBytes: Int?
    let content: String?
    let truncated: Bool?

    enum CodingKeys: String, CodingKey {
        case cardID = "taskId"
        case exists, sizeBytes, content, truncated
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        exists = container.decodeLossyBoolIfPresent(forKey: .exists)
        sizeBytes = container.decodeLossyIntIfPresent(forKey: .sizeBytes)
        content = container.decodeLossyStringIfPresent(forKey: .content)
        truncated = container.decodeLossyBoolIfPresent(forKey: .truncated)
        // The upstream `path` field is deliberately not retained.
    }
}

struct KanbanAddCommentResponse: Decodable, Equatable, Sendable {
    let ok: Bool?
    let commentID: String?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case ok, readOnly
        case commentID = "commentId"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        commentID = container.decodeLossyStringIfPresent(forKey: .commentID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

enum KanbanCardDetailValidator {
    static func validate(_ envelope: KanbanCardDetailEnvelope, requestedCardID: String) throws {
        guard let cardID = normalizedKanbanIdentifier(envelope.card?.cardID),
              cardID == normalizedKanbanIdentifier(requestedCardID) else {
            throw KanbanContractViolation.missingCardIdentity
        }
        guard normalizedKanbanIdentifier(envelope.card?.status?.rawValue) != nil else {
            throw KanbanContractViolation.missingCardStatus
        }
    }
}

private func normalizedKanbanIdentifier(_ value: String?) -> String? {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed?.isEmpty == false ? trimmed : nil
}

struct KanbanLinkCounts: Decodable, Equatable, Sendable {
    let parents: Int?
    let children: Int?

    enum CodingKeys: String, CodingKey { case parents, children }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        parents = container.decodeLossyIntIfPresent(forKey: .parents)
        children = container.decodeLossyIntIfPresent(forKey: .children)
    }
}

struct KanbanAppliedFilters: Decodable, Equatable, Sendable {
    let tenant: String?
    let assignee: String?
    let includeArchived: Bool?
    let onlyMine: Bool?
    let profile: String?

    enum CodingKeys: String, CodingKey { case tenant, assignee, includeArchived, onlyMine, profile }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tenant = container.decodeLossyStringIfPresent(forKey: .tenant)
        assignee = container.decodeLossyStringIfPresent(forKey: .assignee)
        includeArchived = container.decodeLossyBoolIfPresent(forKey: .includeArchived)
        onlyMine = container.decodeLossyBoolIfPresent(forKey: .onlyMine)
        profile = container.decodeLossyStringIfPresent(forKey: .profile)
    }
}

struct KanbanStats: Decodable, Equatable, Sendable {
    let total: Int?
    let byStatus: [String: Int]?
    let byAssignee: [String: Int]?

    enum CodingKeys: String, CodingKey { case total, byStatus, byAssignee }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        total = container.decodeLossyIntIfPresent(forKey: .total)
        byStatus = try? container.decodeIfPresent([String: Int].self, forKey: .byStatus)
        byAssignee = try? container.decodeIfPresent([String: Int].self, forKey: .byAssignee)
    }
}

struct KanbanAssigneeHistory: Decodable, Equatable, Sendable {
    let assignees: [String]?

    enum CodingKeys: String, CodingKey { case assignees }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        assignees = (try? container.decodeIfPresent(
            [KanbanAssigneeValue].self,
            forKey: .assignees
        ))?.compactMap(\.name)
    }
}
