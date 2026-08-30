import Foundation

struct KanbanConfiguration: Decodable, Equatable, Sendable {
    let columns: [String]?
    let assignees: [String]?
    let defaultTenant: String?
    let laneByProfile: Bool?
    let includeArchivedByDefault: Bool?
    let renderMarkdown: Bool?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case columns, assignees, defaultTenant, laneByProfile, includeArchivedByDefault, renderMarkdown, readOnly
    }

    init(from decoder: Decoder) throws {
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

struct KanbanBoardsResponse: Decodable, Equatable, Sendable {
    let boards: [KanbanBoard]?
    let current: String?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case boards, current, readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        boards = try? container.decodeIfPresent([KanbanBoard].self, forKey: .boards)
        current = container.decodeLossyStringIfPresent(forKey: .current)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanBoard: Decodable, Equatable, Sendable {
    let slug: String?
    let name: String?
    let description: String?
    let icon: String?
    let color: String?
    let isCurrent: Bool?
    let total: Int?
    let counts: [String: Int]?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case slug, name, description, icon, color, isCurrent, total, counts, readOnly
    }

    init(from decoder: Decoder) throws {
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

struct KanbanBoardMutationEnvelope: Decodable, Equatable, Sendable {
    let board: KanbanBoard?
    let current: String?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case board, current, readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        board = try? container.decodeIfPresent(KanbanBoard.self, forKey: .board)
        current = container.decodeLossyStringIfPresent(forKey: .current)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanBoardSnapshot: Decodable, Equatable, Sendable {
    let columns: [KanbanColumn]?
    let tenants: [String]?
    let assignees: [String]?
    let filters: KanbanAppliedFilters?
    let changed: Bool?
    let latestEventID: Int?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case columns, tenants, assignees, filters, changed, readOnly
        case latestEventID = "latestEventId"
    }

    init(
        columns: [KanbanColumn]?,
        tenants: [String]?,
        assignees: [String]?,
        filters: KanbanAppliedFilters?,
        changed: Bool?,
        latestEventID: Int?,
        readOnly: Bool?
    ) {
        self.columns = columns
        self.tenants = tenants
        self.assignees = assignees
        self.filters = filters
        self.changed = changed
        self.latestEventID = latestEventID
        self.readOnly = readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        columns = try? container.decodeIfPresent([KanbanColumn].self, forKey: .columns)
        tenants = try? container.decodeIfPresent([String].self, forKey: .tenants)
        assignees = try? container.decodeIfPresent([String].self, forKey: .assignees)
        filters = try? container.decodeIfPresent(KanbanAppliedFilters.self, forKey: .filters)
        changed = container.decodeLossyBoolIfPresent(forKey: .changed)
        latestEventID = container.decodeLossyIntIfPresent(forKey: .latestEventID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanColumn: Decodable, Equatable, Sendable {
    let name: String?
    let cards: [KanbanCard]?

    enum CodingKeys: String, CodingKey {
        case name
        case cards = "tasks"
    }

    init(name: String?, cards: [KanbanCard]?) {
        self.name = name
        self.cards = cards
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        cards = try? container.decodeIfPresent([KanbanCard].self, forKey: .cards)
    }
}

struct KanbanCard: Decodable, Equatable, Sendable {
    let cardID: String?
    let title: String?
    let status: KanbanStatus?
    let assignee: String?
    let body: String?
    let tenant: String?
    let priority: Int?
    let commentCount: Int?
    let linkCounts: KanbanLinkCounts?
    let ageSeconds: Double?
    let createdAt: String?
    let updatedAt: String?
    let workspaceKind: String?
    let workspacePath: String?
    let skills: [String]?
    let maxRuntimeSeconds: Int?
    let currentRunID: String?
    let claimLock: String?
    let claimExpires: String?
    let workerID: String?

    enum CodingKeys: String, CodingKey {
        case cardID = "id"
        case title, body, tenant, priority, commentCount, linkCounts, ageSeconds
        case status
        case assignee
        case createdAt, updatedAt, workspaceKind, workspacePath, skills, maxRuntimeSeconds
        case currentRunID = "currentRunId"
        case claimLock, claimExpires
        case workerID = "workerPid"
    }

    init(
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
        workerID: String?
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
    }

    init(from decoder: Decoder) throws {
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
    }

    var staleness: KanbanStaleness {
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

    func replacingStatus(_ status: String) -> KanbanCard {
        KanbanCard(
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
            workerID: status == "running" ? workerID : nil
        )
    }
}

struct KanbanCardDetailEnvelope: Decodable, Equatable, Sendable {
    let card: KanbanCard?
    let comments: [KanbanComment]?
    let events: [KanbanDetailEvent]?
    let links: KanbanDependencyLinks?
    let runs: [KanbanDispatchRun]?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case card = "task"
        case comments, events, links, runs, readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        card = try? container.decodeIfPresent(KanbanCard.self, forKey: .card)
        comments = try? container.decodeIfPresent([KanbanComment].self, forKey: .comments)
        events = try? container.decodeIfPresent([KanbanDetailEvent].self, forKey: .events)
        links = try? container.decodeIfPresent(KanbanDependencyLinks.self, forKey: .links)
        runs = try? container.decodeIfPresent([KanbanDispatchRun].self, forKey: .runs)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanCardMutationEnvelope: Decodable, Equatable, Sendable {
    let card: KanbanCard?
    let readOnly: Bool?

    enum CodingKeys: String, CodingKey {
        case card = "task"
        case readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        card = try? container.decodeIfPresent(KanbanCard.self, forKey: .card)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}

struct KanbanDependencyMutationEnvelope: Decodable, Equatable, Sendable {
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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        changed = container.decodeLossyBoolIfPresent(forKey: .changed)
        prerequisiteID = container.decodeLossyStringIfPresent(forKey: .prerequisiteID)
        dependentID = container.decodeLossyStringIfPresent(forKey: .dependentID)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
    }
}
