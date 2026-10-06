import Foundation

public enum KanbanBulkAction: Equatable, Sendable {
    case changeStatus(String)
    case assignProfile(String?)
    case setPriority(Int)
    case archiveCards
}

public struct KanbanBulkActionRequest: Equatable, Sendable {
    public let board: String
    public let cardIDs: [String]
    public let action: KanbanBulkAction

    public init(board: String, cardIDs: [String], action: KanbanBulkAction) {
        self.board = board
        self.cardIDs = cardIDs
        self.action = action
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanBulkActionEnvelope: Decodable, Equatable, Sendable {
    let results: [KanbanBulkActionResult]?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey { case results, readOnly }

    public init(from decoder: Decoder) throws {
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

public struct KanbanCreateCardRequest: Equatable, Sendable {
    public let board: String
    public let title: String
    public let body: String?
    public let status: String
    public let priority: Int?
    public let assignee: String?
    public let tenant: String?
    public let workspaceKind: String
    public let workspacePath: String?
    public let skills: [String]?
    public let maxRuntimeSeconds: Int?
    public let prerequisiteID: String?
    public let idempotencyKey: String

    public init(board: String, title: String, body: String?, status: String, priority: Int?, assignee: String?, tenant: String?, workspaceKind: String, workspacePath: String?, skills: [String]?, maxRuntimeSeconds: Int?, prerequisiteID: String?, idempotencyKey: String) {
        self.board = board
        self.title = title
        self.body = body
        self.status = status
        self.priority = priority
        self.assignee = assignee
        self.tenant = tenant
        self.workspaceKind = workspaceKind
        self.workspacePath = workspacePath
        self.skills = skills
        self.maxRuntimeSeconds = maxRuntimeSeconds
        self.prerequisiteID = prerequisiteID
        self.idempotencyKey = idempotencyKey
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanEditCardRequest: Equatable, Sendable {
    public let cardID: String
    public let board: String
    public let title: String
    public let body: String
    public let tenant: String?
    public let priority: Int
    public let assignee: String?
    public let status: String?

    public init(cardID: String, board: String, title: String, body: String, tenant: String?, priority: Int, assignee: String?, status: String?) {
        self.cardID = cardID
        self.board = board
        self.title = title
        self.body = body
        self.tenant = tenant
        self.priority = priority
        self.assignee = assignee
        self.status = status
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanCardStatusRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let status: String
    /// The user confirmed leaving Running; the server refuses that exit without it (TAL-557).
    let confirmRunningExit: Bool

    public init(cardID: String, board: String, status: String, confirmRunningExit: Bool = false) {
        self.cardID = cardID
        self.board = board
        self.status = status
        self.confirmRunningExit = confirmRunningExit
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanCardActionRequest: Equatable, Sendable {
    let cardID: String
    let board: String
    let reason: String?
    /// The user confirmed leaving Running; the server refuses that exit without it (TAL-557).
    let confirmRunningExit: Bool

    public init(cardID: String, board: String, reason: String?, confirmRunningExit: Bool = false) {
        self.cardID = cardID
        self.board = board
        self.reason = reason
        self.confirmRunningExit = confirmRunningExit
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanDependencyMutationRequest: Equatable, Sendable {
    public let board: String
    public let prerequisiteID: String
    public let dependentID: String

    public init(board: String, prerequisiteID: String, dependentID: String) {
        self.board = board
        self.prerequisiteID = prerequisiteID
        self.dependentID = dependentID
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanCardDetailRequest: Equatable, Sendable {
    public let cardID: String
    public let board: String

    public init(cardID: String, board: String) {
        self.cardID = cardID
        self.board = board
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanWorkerLogRequest: Equatable, Sendable {
    public let cardID: String
    let board: String
    var tailBytes: Int = 65_536

    public init(cardID: String, board: String, tailBytes: Int = 65_536) {
        self.cardID = cardID
        self.board = board
        self.tailBytes = tailBytes
    }

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "tail", value: String(min(max(1, tailBytes), 2_000_000)))
        ]
    }
}

public struct KanbanAddCommentRequest: Equatable, Sendable {
    public let cardID: String
    public let board: String
    public let body: String

    public init(cardID: String, board: String, body: String) {
        self.cardID = cardID
        self.board = board
        self.body = body
    }

    var queryItems: [URLQueryItem] {
        [URLQueryItem(name: "board", value: board)]
    }
}

public struct KanbanEventsRequest: Equatable, Sendable {
    let board: String
    let since: Int
    var limit: Int = 200

    public init(board: String, since: Int, limit: Int = 200) {
        self.board = board
        self.since = since
        self.limit = limit
    }

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "since", value: String(max(0, since))),
            URLQueryItem(name: "limit", value: String(min(max(1, limit), 200)))
        ]
    }
}

public struct KanbanEventsStreamRequest: Equatable, Sendable {
    let board: String
    let since: Int

    public init(board: String, since: Int) {
        self.board = board
        self.since = since
    }

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "board", value: board),
            URLQueryItem(name: "since", value: String(max(0, since)))
        ]
    }
}

public struct KanbanEventsEnvelope: Decodable, Equatable, Sendable {
    public let events: [KanbanEvent]?
    public let cursor: Int?
    let latestEventID: Int?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case events, cursor, readOnly
        case latestEventID = "latestEventId"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = try? container.decodeIfPresent([KanbanEvent].self, forKey: .events)
        cursor = container.decodeLossyIntIfPresent(forKey: .cursor)
        latestEventID = container.decodeLossyIntIfPresent(forKey: .latestEventID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

public struct KanbanEvent: Decodable, Equatable, Sendable {
    public let eventID: Int?
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

    public init(from decoder: Decoder) throws {
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

public struct KanbanBoardRequest: Equatable, Sendable {
    public let board: String
    public var tenant: String?
    public var assignee: String?
    public var includeArchived: Bool
    public var onlyMine: Bool
    public var since: Int?

    public init(
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

public struct KanbanCreateBoardRequest: Equatable, Sendable {
    public let slug: String
    public let name: String
    public let description: String
    public let icon: String
    public let color: String

    public init(slug: String, name: String, description: String, icon: String, color: String) {
        self.slug = slug
        self.name = name
        self.description = description
        self.icon = icon
        self.color = color
    }
}

public struct KanbanEditBoardRequest: Equatable, Sendable {
    public let slug: String
    public let name: String
    public let description: String
    public let icon: String
    public let color: String

    public init(slug: String, name: String, description: String, icon: String, color: String) {
        self.slug = slug
        self.name = name
        self.description = description
        self.icon = icon
        self.color = color
    }
}

public struct KanbanBoardMutationRequest: Equatable, Sendable {
    public let slug: String

    public init(slug: String) {
        self.slug = slug
    }
}

public struct KanbanDispatchRequest: Equatable, Sendable {
    public static let maximum = 8

    public let board: String
    public let dryRun: Bool

    public init(board: String, dryRun: Bool) {
        self.board = board
        self.dryRun = dryRun
    }

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
public struct KanbanDispatchResult: Decodable, Equatable, Sendable {
    public let spawned: Int?
    public let promoted: Int?
    public let reclaimed: Int?
    public let skippedUnassigned: Int?
    public let skippedNonspawnable: Int?
    public let autoBlocked: Int?
    public let timedOut: Int?
    public let crashed: Int?

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

    public init(from decoder: Decoder) throws {
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
