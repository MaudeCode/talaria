import Foundation

enum KanbanBulkAction: Equatable, Sendable {
    case changeStatus(String)
    case assignProfile(String?)
    case setPriority(Int)
    case archiveCards
}

struct KanbanBulkActionRequest: Equatable, Sendable {
    let board: String
    let cardIDs: [String]
    let action: KanbanBulkAction

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanBulkActionEnvelope: Decodable, Equatable, Sendable {
    let results: [KanbanBulkActionResult]?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey { case results, readOnly }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        results = try? container.decodeIfPresent([KanbanBulkActionResult].self, forKey: .results)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanBulkActionResult: Decodable, Equatable, Sendable {
    let cardID: String?
    let ok: Bool?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case cardID = "id"
        case ok, error
    }

    init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            cardID = nil
            ok = nil
            error = nil
            return
        }
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        error = container.decodeLossyStringIfPresent(forKey: .error)
    }
}

struct KanbanCreateCardRequest: Equatable, Sendable {
    let board: String
    let title: String
    let body: String?
    let status: String
    let priority: Int?
    let assignee: String?
    let tenant: String?
    let workspaceKind: String
    let workspacePath: String?
    let skills: [String]?
    let maxRuntimeSeconds: Int?
    let prerequisiteID: String?
    let idempotencyKey: String

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanEditCardRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let title: String
    let body: String
    let tenant: String?
    let priority: Int
    let assignee: String?
    let status: String?

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanCardStatusRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let status: String

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanCardActionRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let reason: String?

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanDependencyMutationRequest: Equatable, Sendable {
    let board: String
    let prerequisiteID: String
    let dependentID: String

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanCardDetailRequest: Equatable, Sendable {
    let cardID: String
    let board: String

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanWorkerLogRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    var tailBytes: Int = 65_536

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "tail", value: String(min(max(1, tailBytes), 2_000_000)))
        ]
    }
}

struct KanbanAddCommentRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let body: String

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

struct KanbanEventsRequest: Equatable, Sendable {
    let board: String
    let since: Int
    var limit: Int = 200

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "since", value: String(max(0, since))),
            URLQueryItem(name: "limit", value: String(min(max(1, limit), 200)))
        ]
    }
}

struct KanbanEventsStreamRequest: Equatable, Sendable {
    let board: String
    let since: Int

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "since", value: String(max(0, since)))
        ]
    }
}

struct KanbanEventsEnvelope: Decodable, Equatable, Sendable {
    let events: [KanbanEvent]?
    let cursor: Int?
    let latestEventID: Int?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case events, cursor, readOnly
        case latestEventID = "latestEventId"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = try? container.decodeIfPresent([KanbanEvent].self, forKey: .events)
        cursor = container.decodeLossyIntIfPresent(forKey: .cursor)
        latestEventID = container.decodeLossyIntIfPresent(forKey: .latestEventID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanEvent: Decodable, Equatable, Sendable {
    let eventID: Int?
    let cardID: String?
    let runID: String?
    let kind: String?
    let createdAt: Int?

    enum CodingKeys: String, CodingKey {
        case eventID = "id"
        case cardID = "taskId"
        case runID = "runId"
        case kind, createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventID = container.decodeLossyIntIfPresent(forKey: .eventID)
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        runID = container.decodeLossyStringIfPresent(forKey: .runID)
        kind = container.decodeLossyStringIfPresent(forKey: .kind)
        createdAt = container.decodeLossyIntIfPresent(forKey: .createdAt)
        // Payload values are intentionally not retained: live browsing only needs
        // identity + cursor to reconcile authoritative state, and payloads must
        // never leak through diagnostics.
    }
}

struct KanbanBoardRequest: Equatable, Sendable {
    let board: String
    var tenant: String?
    var assignee: String?
    var includeArchived: Bool
    var onlyMine: Bool
    var since: Int?

    init(
        board: String,
        tenant: String? = nil,
        assignee: String? = nil,
        includeArchived: Bool = false,
        onlyMine: Bool = false,
        since: Int? = nil
    ) {
        self.board = board
        self.tenant = tenant
        self.assignee = assignee
        self.includeArchived = includeArchived
        self.onlyMine = onlyMine
        self.since = since
    }

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "board", value: board)]
        if let tenant, !tenant.isEmpty {
            items.append(URLQueryItem(name: "tenant", value: tenant))
        }
        if let assignee, !assignee.isEmpty {
            items.append(URLQueryItem(name: "assignee", value: assignee))
        }
        if includeArchived {
            items.append(URLQueryItem(name: "include_archived", value: "true"))
        }
        if onlyMine {
            items.append(URLQueryItem(name: "only_mine", value: "true"))
        }
        if let since {
            items.append(URLQueryItem(name: "since", value: String(since)))
        }
        return items
    }
}

struct KanbanCreateBoardRequest: Equatable, Sendable {
    let slug: String
    let name: String
    let description: String
    let icon: String
    let color: String
}

struct KanbanEditBoardRequest: Equatable, Sendable {
    let slug: String
    let name: String
    let description: String
    let icon: String
    let color: String
}

struct KanbanBoardMutationRequest: Equatable, Sendable {
    let slug: String
}

struct KanbanDispatchRequest: Equatable, Sendable {
    static let maximum = 8

    let board: String
    let dryRun: Bool

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "dry_run", value: dryRun ? "true" : "false"),
            URLQueryItem(name: "max", value: String(Self.maximum))
        ]
    }
}

/// Retains only counts for the operational result categories. Array members
/// are decoded as arbitrary JSON values and immediately discarded so upstream
/// can change member shapes without exposing identifiers or raw payloads.
struct KanbanDispatchResult: Decodable, Equatable, Sendable {
    let spawned: Int?
    let promoted: Int?
    let reclaimed: Int?
    let skippedUnassigned: Int?
    let skippedNonspawnable: Int?
    let autoBlocked: Int?
    let timedOut: Int?
    let crashed: Int?

    var hasKnownCategory: Bool {
        [
            spawned, promoted, reclaimed, skippedUnassigned,
            skippedNonspawnable, autoBlocked, timedOut, crashed
        ].contains { $0 != nil }
    }

    enum CodingKeys: String, CodingKey {
        case spawned, promoted, reclaimed, skippedUnassigned, skippedNonspawnable
        case autoBlocked, timedOut, crashed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spawned = Self.count(container, key: .spawned)
        promoted = Self.count(container, key: .promoted)
        reclaimed = Self.count(container, key: .reclaimed)
        skippedUnassigned = Self.count(container, key: .skippedUnassigned)
        skippedNonspawnable = Self.count(container, key: .skippedNonspawnable)
        autoBlocked = Self.count(container, key: .autoBlocked)
        timedOut = Self.count(container, key: .timedOut)
        crashed = Self.count(container, key: .crashed)
    }

    private static func count(
        _ container: KeyedDecodingContainer<CodingKeys>,
        key: CodingKeys
    ) -> Int? {
        guard let value = try? container.decodeIfPresent(JSONValue.self, forKey: key) else {
            return nil
        }
        switch value {
        case let .array(members):
            return members.count
        case let .number(number):
            guard number.isFinite else { return nil }
            return Int(exactly: number.rounded(.towardZero))
        case let .string(string):
            return Int(string.trimmingCharacters(in: .whitespacesAndNewlines))
        case .bool, .object, .null:
            return nil
        }
    }
}

enum KanbanDispatchResponseError: Error, Equatable, Sendable {
    case missingResultCategories
}

/// Tolerant read-only boundary for the independently-versioned Kanban bridge.
/// Every upstream field stays optional so an added or renamed server field never
/// prevents the rest of the shell from decoding.
