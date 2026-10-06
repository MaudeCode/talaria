import Foundation

public struct KanbanConfiguration: Decodable, Equatable, Sendable {
    public let columns: [String]?
    public let assignees: [String]?
    let defaultTenant: String?
    let laneByProfile: Bool?
    let includeArchivedByDefault: Bool?
    let renderMarkdown: Bool?
    public let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case columns, assignees, defaultTenant, laneByProfile, includeArchivedByDefault, renderMarkdown, readOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        columns = try? container.decodeIfPresent([String].self, forKey: .columns)
        assignees = (try? container.decodeIfPresent(
            [KanbanAssigneeValue].self,
            forKey: .assignees
        ))?.compactMap(\.name)
        defaultTenant = container.decodeLossyStringIfPresent(forKey: .defaultTenant)
        laneByProfile = container.decodeLossyBoolIfPresent(forKey: .laneByProfile)
        includeArchivedByDefault = container.decodeLossyBoolIfPresent(forKey: .includeArchivedByDefault)
        renderMarkdown = container.decodeLossyBoolIfPresent(forKey: .renderMarkdown)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanAssigneeValue: Decodable {
    let name: String?

    enum CodingKeys: CodingKey { case name }

    init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer(),
           let value = try? container.decode(String.self) {
            name = value
            return
        }

        let container = try? decoder.container(keyedBy: CodingKeys.self)
        name = container?.decodeLossyStringIfPresent(forKey: .name)
    }
}

public struct KanbanBoardsResponse: Decodable, Equatable, Sendable {
    public let boards: [KanbanBoard]?
    public let current: String?
    public let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case boards, current, readOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        boards = try? container.decodeIfPresent([KanbanBoard].self, forKey: .boards)
        current = container.decodeLossyStringIfPresent(forKey: .current)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

public struct KanbanBoard: Decodable, Equatable, Sendable {
    public let slug: String?
    public let name: String?
    public let description: String?
    public let icon: String?
    public let color: String?
    let isCurrent: Bool?
    public let total: Int?
    let counts: [String: Int]?
    public let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case slug, name, description, icon, color, isCurrent, total, counts, readOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        slug = container.decodeLossyStringIfPresent(forKey: .slug)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        description = container.decodeLossyStringIfPresent(forKey: .description)
        icon = container.decodeLossyStringIfPresent(forKey: .icon)
        color = container.decodeLossyStringIfPresent(forKey: .color)
        isCurrent = container.decodeLossyBoolIfPresent(forKey: .isCurrent)
        total = container.decodeLossyIntIfPresent(forKey: .total)
        counts = try? container.decodeIfPresent([String: Int].self, forKey: .counts)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

public struct KanbanBoardMutationEnvelope: Decodable, Equatable, Sendable {
    let board: KanbanBoard?
    let current: String?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case board, current, readOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        board = try? container.decodeIfPresent(KanbanBoard.self, forKey: .board)
        current = container.decodeLossyStringIfPresent(forKey: .current)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

public struct KanbanBoardSnapshot: Decodable, Equatable, Sendable {
    public let columns: [KanbanColumn]?
    public let tenants: [String]?
    public let assignees: [String]?
    public let filters: KanbanAppliedFilters?
    public let changed: Bool?
    public let latestEventID: Int?
    public let readOnly: Bool?
    /// Statuses the server lets a bulk status change target (TAL-557).
    public let bulkMoveTargets: [String]?

    enum CodingKeys: String, CodingKey {
        case columns, tenants, assignees, filters, changed, readOnly, bulkMoveTargets
        case latestEventID = "latestEventId"
    }

    public init(
        columns: [KanbanColumn]?,
        tenants: [String]?,
        assignees: [String]?,
        filters: KanbanAppliedFilters?,
        changed: Bool?,
        latestEventID: Int?,
        readOnly: Bool?,
        bulkMoveTargets: [String]?
    ) {
        self.columns = columns
        self.tenants = tenants
        self.assignees = assignees
        self.filters = filters
        self.changed = changed
        self.latestEventID = latestEventID
        self.readOnly = readOnly
        self.bulkMoveTargets = bulkMoveTargets
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        columns = try? container.decodeIfPresent([KanbanColumn].self, forKey: .columns)
        tenants = try? container.decodeIfPresent([String].self, forKey: .tenants)
        assignees = try? container.decodeIfPresent([String].self, forKey: .assignees)
        filters = try? container.decodeIfPresent(KanbanAppliedFilters.self, forKey: .filters)
        changed = container.decodeLossyBoolIfPresent(forKey: .changed)
        latestEventID = container.decodeLossyIntIfPresent(forKey: .latestEventID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
        bulkMoveTargets = try? container.decodeIfPresent([String].self, forKey: .bulkMoveTargets)
    }
}

/// The card actions the server offers for a card's current status (TAL-557).
public struct KanbanCardActions: Decodable, Equatable, Sendable {
    public let block: Bool
    public let unblock: Bool
    public let complete: Bool
    public let archive: Bool
    /// Statuses a Move may target, in display order.
    public let moveTo: [String]

    enum CodingKeys: String, CodingKey {
        case block, unblock, complete, archive, moveTo
    }

    public init(block: Bool, unblock: Bool, complete: Bool, archive: Bool, moveTo: [String]) {
        self.block = block
        self.unblock = unblock
        self.complete = complete
        self.archive = archive
        self.moveTo = moveTo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        block = container.decodeLossyBoolIfPresent(forKey: .block) ?? false
        unblock = container.decodeLossyBoolIfPresent(forKey: .unblock) ?? false
        complete = container.decodeLossyBoolIfPresent(forKey: .complete) ?? false
        archive = container.decodeLossyBoolIfPresent(forKey: .archive) ?? false
        moveTo = (try? container.decodeIfPresent([String].self, forKey: .moveTo)) ?? []
    }
}

public struct KanbanColumn: Decodable, Equatable, Sendable {
    public let name: String?
    public let cards: [KanbanCard]?

    enum CodingKeys: String, CodingKey {
        case name
        case cards = "tasks"
    }

    public init(name: String?, cards: [KanbanCard]?) {
        self.name = name
        self.cards = cards
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        cards = try? container.decodeIfPresent([KanbanCard].self, forKey: .cards)
    }
}

public struct KanbanCard: Decodable, Equatable, Sendable {
    public let cardID: String?
    public let title: String?
    public let status: KanbanStatus?
    public let assignee: String?
    public let body: String?
    public let tenant: String?
    public let priority: Int?
    public let commentCount: Int?
    public let linkCounts: KanbanLinkCounts?
    public let ageSeconds: Double?
    public let createdAt: String?
    public let updatedAt: String?
    public let workspaceKind: String?
    public let workspacePath: String?
    public let skills: [String]?
    public let maxRuntimeSeconds: Int?
    public let currentRunID: String?
    public let claimLock: String?
    public let claimExpires: String?
    public let workerID: String?
    /// Nil when the server sent no policy; the card then offers no actions.
    public let availableActions: KanbanCardActions?
    public let requiresRunningExitConfirmation: Bool

    enum CodingKeys: String, CodingKey {
        case cardID = "id"
        case title, body, tenant, priority, commentCount, linkCounts, ageSeconds
        case status
        case assignee
        case createdAt, updatedAt, workspaceKind, workspacePath, skills, maxRuntimeSeconds
        case currentRunID = "currentRunId"
        case claimLock, claimExpires
        case workerID = "workerPid"
        case availableActions, requiresRunningExitConfirmation
    }

    public init(
        cardID: String?,
        title: String?,
        status: KanbanStatus?,
        assignee: String?,
        body: String?,
        tenant: String?,
        priority: Int?,
        commentCount: Int?,
        linkCounts: KanbanLinkCounts?,
        ageSeconds: Double?,
        createdAt: String?,
        updatedAt: String?,
        workspaceKind: String?,
        workspacePath: String?,
        skills: [String]?,
        maxRuntimeSeconds: Int?,
        currentRunID: String?,
        claimLock: String?,
        claimExpires: String?,
        workerID: String?,
        availableActions: KanbanCardActions? = nil,
        requiresRunningExitConfirmation: Bool = false
    ) {
        self.cardID = cardID
        self.title = title
        self.status = status
        self.assignee = assignee
        self.body = body
        self.tenant = tenant
        self.priority = priority
        self.commentCount = commentCount
        self.linkCounts = linkCounts
        self.ageSeconds = ageSeconds
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.workspaceKind = workspaceKind
        self.workspacePath = workspacePath
        self.skills = skills
        self.maxRuntimeSeconds = maxRuntimeSeconds
        self.currentRunID = currentRunID
        self.claimLock = claimLock
        self.claimExpires = claimExpires
        self.workerID = workerID
        self.availableActions = availableActions
        self.requiresRunningExitConfirmation = requiresRunningExitConfirmation
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cardID = container.decodeLossyStringIfPresent(forKey: .cardID)
        title = container.decodeLossyStringIfPresent(forKey: .title)
        status = container.decodeLossyStringIfPresent(forKey: .status).map(KanbanStatus.init(rawValue:))
        assignee = container.decodeLossyStringIfPresent(forKey: .assignee)
        body = container.decodeLossyStringIfPresent(forKey: .body)
        tenant = container.decodeLossyStringIfPresent(forKey: .tenant)
        priority = container.decodeLossyIntIfPresent(forKey: .priority)
        commentCount = container.decodeLossyIntIfPresent(forKey: .commentCount)
        linkCounts = try? container.decodeIfPresent(KanbanLinkCounts.self, forKey: .linkCounts)
        ageSeconds = container.decodeLossyDoubleIfPresent(forKey: .ageSeconds)
        createdAt = container.decodeLossyStringIfPresent(forKey: .createdAt)
        updatedAt = container.decodeLossyStringIfPresent(forKey: .updatedAt)
        workspaceKind = container.decodeLossyStringIfPresent(forKey: .workspaceKind)
        workspacePath = container.decodeLossyStringIfPresent(forKey: .workspacePath)
        skills = try? container.decodeIfPresent([String].self, forKey: .skills)
        maxRuntimeSeconds = container.decodeLossyIntIfPresent(forKey: .maxRuntimeSeconds)
        currentRunID = container.decodeLossyStringIfPresent(forKey: .currentRunID)
        claimLock = container.decodeLossyStringIfPresent(forKey: .claimLock)
        claimExpires = container.decodeLossyStringIfPresent(forKey: .claimExpires)
        workerID = container.decodeLossyStringIfPresent(forKey: .workerID)
        availableActions = try? container.decodeIfPresent(KanbanCardActions.self, forKey: .availableActions)
        requiresRunningExitConfirmation = container.decodeLossyBoolIfPresent(forKey: .requiresRunningExitConfirmation) ?? false
    }

    public var staleness: KanbanStaleness {
        guard let ageSeconds, let status else { return .none }
        switch status.rawValue {
        case "running":
            return ageSeconds >= 3_600 ? .critical : ageSeconds >= 600 ? .warning : .none
        case "ready":
            return ageSeconds >= 3_600 ? .warning : .none
        case "blocked":
            return ageSeconds >= 86_400 ? .critical : ageSeconds >= 3_600 ? .warning : .none
        default:
            return .none
        }
    }

    /// The card shown under a status the server has not confirmed yet. Its server policy belongs to the
    /// old status, so it offers no actions until the server's copy of the card arrives.
    public func replacingStatus(_ status: String) -> KanbanCard {
        let unchanged = status == self.status?.rawValue
        return KanbanCard(
            cardID: cardID,
            title: title,
            status: KanbanStatus(rawValue: status),
            assignee: assignee,
            body: body,
            tenant: tenant,
            priority: priority,
            commentCount: commentCount,
            linkCounts: linkCounts,
            ageSeconds: ageSeconds,
            createdAt: createdAt,
            updatedAt: updatedAt,
            workspaceKind: workspaceKind,
            workspacePath: workspacePath,
            skills: skills,
            maxRuntimeSeconds: maxRuntimeSeconds,
            currentRunID: status == "running" ? currentRunID : nil,
            claimLock: status == "running" ? claimLock : nil,
            claimExpires: status == "running" ? claimExpires : nil,
            workerID: status == "running" ? workerID : nil,
            availableActions: unchanged ? availableActions : nil,
            requiresRunningExitConfirmation: unchanged && requiresRunningExitConfirmation
        )
    }
}

public struct KanbanCardDetailEnvelope: Decodable, Equatable, Sendable {
    public let card: KanbanCard?
    public let comments: [KanbanComment]?
    public let events: [KanbanDetailEvent]?
    public let links: KanbanDependencyLinks?
    public let runs: [KanbanDispatchRun]?
    let readOnly: Bool?
    /// The newest Block or Unblock the server recorded for the Card (TAL-557).
    public let lastCardAction: KanbanLastCardAction?

    enum CodingKeys: String, CodingKey {
        case card = "task"
        case comments, events, links, runs, readOnly, lastCardAction
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        card = try? container.decodeIfPresent(KanbanCard.self, forKey: .card)
        comments = try? container.decodeIfPresent([KanbanComment].self, forKey: .comments)
        events = try? container.decodeIfPresent([KanbanDetailEvent].self, forKey: .events)
        links = try? container.decodeIfPresent(KanbanDependencyLinks.self, forKey: .links)
        runs = try? container.decodeIfPresent([KanbanDispatchRun].self, forKey: .runs)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
        lastCardAction = try? container.decodeIfPresent(KanbanLastCardAction.self, forKey: .lastCardAction)
    }
}

public struct KanbanLastCardAction: Decodable, Equatable, Sendable {
    /// `block` or `unblock`.
    public let action: String
    public let eventID: Int

    enum CodingKeys: String, CodingKey {
        case action
        case eventID = "eventId"
    }
}

public struct KanbanCardMutationEnvelope: Decodable, Equatable, Sendable {
    let card: KanbanCard?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case card = "task"
        case readOnly
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        card = try? container.decodeIfPresent(KanbanCard.self, forKey: .card)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

public struct KanbanDependencyMutationEnvelope: Decodable, Equatable, Sendable {
    let ok: Bool?
    let changed: Bool?
    let prerequisiteID: String?
    let dependentID: String?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case ok, changed, readOnly
        case prerequisiteID = "parentId"
        case dependentID = "childId"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        changed = container.decodeLossyBoolIfPresent(forKey: .changed)
        prerequisiteID = container.decodeLossyStringIfPresent(forKey: .prerequisiteID)
        dependentID = container.decodeLossyStringIfPresent(forKey: .dependentID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}
