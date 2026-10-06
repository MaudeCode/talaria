import Foundation

public struct SessionsResponse: Decodable {
    public let sessions: [SessionSummary]?
    let cliCount: Int?
    /// Total archived sessions in the active profile (`archived_count`), present
    /// on every response regardless of `include_archived` (issue #17). Optional so
    /// older servers that omit it decode fine.
    public let archivedCount: Int?
    /// Server totals for the sidebar's automated-session groups (TAL-482); nil from
    /// older servers that omit them.
    public let automatedSessionCounts: AutomatedSessionCounts?
    let serverTime: Double?
    let serverTz: String?

    enum CodingKeys: String, CodingKey {
        case sessions, cliCount, archivedCount, serverTime, serverTz
        case scheduledSessionCount, scheduledSessionsTruncated, webhookSessionCount, webhookSessionsTruncated
    }

    init(
        sessions: [SessionSummary]? = nil,
        cliCount: Int? = nil,
        archivedCount: Int? = nil,
        automatedSessionCounts: AutomatedSessionCounts? = nil,
        serverTime: Double? = nil,
        serverTz: String? = nil
    ) {
        self.sessions = sessions
        self.cliCount = cliCount
        self.archivedCount = archivedCount
        self.automatedSessionCounts = automatedSessionCounts
        self.serverTime = serverTime
        self.serverTz = serverTz
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = SessionSummary.decodingRowsIndependently(from: container, forKey: .sessions)
        cliCount = container.decodeLossyIntIfPresent(forKey: .cliCount)
        archivedCount = container.decodeLossyIntIfPresent(forKey: .archivedCount)
        if let scheduled = container.decodeLossyIntIfPresent(forKey: .scheduledSessionCount),
           let webhook = container.decodeLossyIntIfPresent(forKey: .webhookSessionCount) {
            automatedSessionCounts = AutomatedSessionCounts(
                scheduled: scheduled,
                scheduledIsPartial: container.decodeLossyBoolIfPresent(forKey: .scheduledSessionsTruncated) ?? false,
                webhook: webhook,
                webhookIsPartial: container.decodeLossyBoolIfPresent(forKey: .webhookSessionsTruncated) ?? false
            )
        } else {
            automatedSessionCounts = nil
        }
        serverTime = container.decodeLossyDoubleIfPresent(forKey: .serverTime)
        serverTz = container.decodeLossyStringIfPresent(forKey: .serverTz)
    }
}

/// `scheduled_session_count` / `webhook_session_count` and their `_truncated` flags: a
/// partial count means more sessions of that kind exist than the server lists.
public struct AutomatedSessionCounts: Equatable, Sendable {
    public let scheduled: Int
    public let scheduledIsPartial: Bool
    public let webhook: Int
    public let webhookIsPartial: Bool

    public init(scheduled: Int, scheduledIsPartial: Bool, webhook: Int, webhookIsPartial: Bool) {
        self.scheduled = scheduled
        self.scheduledIsPartial = scheduledIsPartial
        self.webhook = webhook
        self.webhookIsPartial = webhookIsPartial
    }
}

public struct SessionSearchResponse: Decodable, Equatable {
    public let sessions: [SessionSummary]?
    let query: String?
    let count: Int?
    /// The server answered within the requested project and visibility (TAL-308).
    let sidebarFiltered: Bool?

    enum CodingKeys: String, CodingKey {
        case sessions, query, count, sidebarFiltered
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = SessionSummary.decodingRowsIndependently(from: container, forKey: .sessions)
        query = container.decodeLossyStringIfPresent(forKey: .query)
        count = container.decodeLossyIntIfPresent(forKey: .count)
        sidebarFiltered = container.decodeLossyBoolIfPresent(forKey: .sidebarFiltered)
    }
}

public struct SessionResponse: Decodable {
    public let session: SessionDetail?
}

public struct SessionMutationResponse: Decodable {
    public let ok: Bool?
    public let session: SessionSummary?
    public let error: String?
}

public enum SessionBulkAction: String, Encodable, Sendable {
    case archive, unarchive, delete
}

/// `POST /api/sessions/bulk` (TAL-627): one result per requested id, in request order.
public struct SessionBulkResponse: Decodable, Equatable {
    public let results: [SessionBulkResult]?

    enum CodingKeys: String, CodingKey { case results }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        results = try? container.decodeIfPresent([SessionBulkResult].self, forKey: .results)
    }
}

public struct SessionBulkResult: Decodable, Equatable {
    public let sessionId: String?
    public let ok: Bool?
    public let error: String?
    /// A delete that removed the chat here but not the Agent's own record.
    public let stateDbCleanupFailed: Bool?

    enum CodingKeys: String, CodingKey { case sessionId, ok, error, stateDbCleanupFailed }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        error = container.decodeLossyStringIfPresent(forKey: .error)
        stateDbCleanupFailed = container.decodeLossyBoolIfPresent(forKey: .stateDbCleanupFailed)
    }
}

public struct ProjectsResponse: Decodable, Equatable {
    public let projects: [ProjectSummary]?

    enum CodingKeys: String, CodingKey {
        case projects
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projects = try? container.decodeIfPresent([ProjectSummary].self, forKey: .projects)
    }
}

public struct ProjectMutationResponse: Decodable, Equatable {
    let ok: Bool?
    public let project: ProjectSummary?
    public let error: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case project
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = container.decodeLossyBoolIfPresent(forKey: .ok)
        project = try? container.decodeIfPresent(ProjectSummary.self, forKey: .project)
        error = container.decodeLossyStringIfPresent(forKey: .error)
    }
}

public struct ProjectSummary: Decodable, Equatable, Hashable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String { projectId ?? fallbackIdentity.value }

    public let projectId: String?
    public let name: String?
    public let color: String?
    let createdAt: Double?

    enum CodingKeys: String, CodingKey {
        case projectId
        case name
        case color
        case createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectId = container.decodeLossyStringIfPresent(forKey: .projectId)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        color = container.decodeLossyStringIfPresent(forKey: .color)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
    }
}

public struct SessionBranchResponse: Decodable, Equatable {
    public let sessionId: String?
    let title: String?
    let parentSessionId: String?
    public let error: String?
}

public struct SessionCompressResponse: Decodable, Equatable {
    let ok: Bool?
    public let session: SessionDetail?
    public let summary: SessionCompressionSummary?
    public let focusTopic: String?
    public let error: String?
}

public struct SessionCompressionSummary: Decodable, Equatable {
    public let headline: String?
    public let tokenLine: String?
    let note: String?
    let referenceMessage: String?
}

public struct SessionUndoResponse: Decodable, Equatable {
    let ok: Bool?
    let removedCount: Int?
    let removedPreview: String?
    public let error: String?
}

public struct SessionRetryResponse: Decodable, Equatable {
    let ok: Bool?
    public let lastUserText: String?
    let removedCount: Int?
    public let error: String?
}

struct SessionStatusResponse: Decodable, Equatable {
    let sessionId: String?
    let activeStreamId: String?
    let isStreaming: Bool?
    let pendingUserMessage: String?
    let error: String?

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case activeStreamId
        case isStreaming
        case agentRunning
        case pendingUserMessage
        case error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        activeStreamId = try container.decodeIfPresent(String.self, forKey: .activeStreamId)
        isStreaming = try container.decodeIfPresent(Bool.self, forKey: .isStreaming)
            ?? container.decodeIfPresent(Bool.self, forKey: .agentRunning)
        pendingUserMessage = try container.decodeIfPresent(String.self, forKey: .pendingUserMessage)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }
}

/// The server's classification of where a session came from (`source_kind`, TAL-310).
/// An older server omits it, so the row has no kind and reads as an ordinary session;
/// a kind this build does not know decodes as `.other`.
public enum SessionSourceKind: String, Sendable, Hashable {
    case webui, cli, messaging, cron, webhook, subagent, claudeCode = "claude_code", kanban, api, other

    init?(serverValue: String?) {
        guard let serverValue else { return nil }
        self = SessionSourceKind(rawValue: serverValue) ?? .other
    }
}

public struct SessionSummary: Decodable, Equatable, Hashable, Identifiable {
    public var id: String {
        if let sessionId, !sessionId.isEmpty {
            return sessionId
        }

        let titlePart = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "untitled"
        let timestamp = createdAt ?? updatedAt ?? lastMessageAt ?? 0
        return "session-\(titlePart)-\(timestamp)"
    }

    public let sessionId: String?
    public let title: String?
    public let workspace: String?
    /// The server's label for `workspace` (TAL-303); nil from an older server, which shows none.
    public let workspaceName: String?
    public let model: String?
    public let modelProvider: String?
    /// TAL-301: the catalog entry the server says `model`/`modelProvider` selects.
    public let modelOptionID: String?
    public let messageCount: Int?
    public let createdAt: Double?
    public let updatedAt: Double?
    public let lastMessageAt: Double?
    /// The server's sort and date-bucket time (`sort_ts`, TAL-306); absent on older servers.
    public let sortTs: Double?
    public let pinned: Bool?
    public let archived: Bool?
    public let projectId: String?
    public let profile: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCost: Double?
    public let activeStreamId: String?
    public let isStreaming: Bool?
    public let isCliSession: Bool?
    let userMessageCount: Int?
    let hasPendingUserMessage: Bool?
    let pendingStartedAt: Double?
    let worktreePath: String?
    let sourceTag: String?
    let rawSource: String?
    let sessionSource: String?
    public let sourceLabel: String?
    public let sourceKind: SessionSourceKind?
    let parentSessionId: String?
    let relationshipType: String?
    let readOnly: Bool?
    /// The server's branch gate (TAL-312): absent on older servers, which offered branching everywhere.
    public let canBranch: Bool?
    /// The server's pin, archive and duplicate gates (TAL-312); absent on older servers.
    public let canPin: Bool?
    public let canArchive: Bool?
    /// The server's delete gate (TAL-627); absent on older servers, which follow `readOnly`.
    public let canDelete: Bool?
    public let canDuplicate: Bool?
    public let matchType: String?
    /// Server-redacted excerpt around the content hit; only `/api/sessions/search`
    /// rows with `match_type == "content"` carry it, and older servers omit it.
    public let matchPreview: String?

    public init(
        sessionId: String? = nil,
        title: String? = nil,
        workspace: String? = nil,
        workspaceName: String? = nil,
        model: String? = nil,
        modelProvider: String? = nil,
        modelOptionID: String? = nil,
        messageCount: Int? = nil,
        createdAt: Double? = nil,
        updatedAt: Double? = nil,
        lastMessageAt: Double? = nil,
        sortTs: Double? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        projectId: String? = nil,
        profile: String? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        estimatedCost: Double? = nil,
        activeStreamId: String? = nil,
        isStreaming: Bool? = nil,
        isCliSession: Bool? = nil,
        userMessageCount: Int? = nil,
        hasPendingUserMessage: Bool? = nil,
        pendingStartedAt: Double? = nil,
        worktreePath: String? = nil,
        sourceTag: String? = nil,
        rawSource: String? = nil,
        sessionSource: String? = nil,
        sourceLabel: String? = nil,
        sourceKind: SessionSourceKind? = nil,
        parentSessionId: String? = nil,
        relationshipType: String? = nil,
        readOnly: Bool? = nil,
        canBranch: Bool? = nil,
        canPin: Bool? = nil,
        canArchive: Bool? = nil,
        canDelete: Bool? = nil,
        canDuplicate: Bool? = nil,
        matchType: String? = nil,
        matchPreview: String? = nil
    ) {
        self.sessionId = sessionId
        self.title = title
        self.workspace = workspace
        self.workspaceName = workspaceName
        self.model = model
        self.modelProvider = modelProvider
        self.modelOptionID = modelOptionID
        self.messageCount = messageCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.sortTs = sortTs
        self.pinned = pinned
        self.archived = archived
        self.projectId = projectId
        self.profile = profile
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.estimatedCost = estimatedCost
        self.activeStreamId = activeStreamId
        self.isStreaming = isStreaming
        self.isCliSession = isCliSession
        self.userMessageCount = userMessageCount
        self.hasPendingUserMessage = hasPendingUserMessage
        self.pendingStartedAt = pendingStartedAt
        self.worktreePath = worktreePath
        self.sourceTag = sourceTag
        self.rawSource = rawSource
        self.sessionSource = sessionSource
        self.sourceLabel = sourceLabel
        self.sourceKind = sourceKind
        self.parentSessionId = parentSessionId
        self.relationshipType = relationshipType
        self.readOnly = readOnly
        self.canBranch = canBranch
        self.canPin = canPin
        self.canArchive = canArchive
        self.canDelete = canDelete
        self.canDuplicate = canDuplicate
        self.matchType = matchType
        self.matchPreview = matchPreview
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, title, workspace, workspaceName, model, modelProvider
        case modelOptionID = "modelOptionId"
        case messageCount, createdAt, updatedAt, lastMessageAt, sortTs
        case pinned, archived, projectId, profile
        case inputTokens, outputTokens, estimatedCost
        case activeStreamId, isStreaming, isCliSession
        case userMessageCount, hasPendingUserMessage, pendingStartedAt, worktreePath
        case sourceTag, rawSource, sessionSource, sourceLabel, sourceKind
        case parentSessionId, relationshipType, readOnly, canBranch, canPin, canArchive, canDelete, canDuplicate, matchType, matchPreview
    }

    /// Lossy field by field, like `SessionDetail` and `ProjectSummary` already
    /// are (`AGENTS.md` hard rule 3).
    ///
    /// The synthesized `Decodable` this replaces failed the whole value on one
    /// mistyped field, and `SessionsResponse` decoded the array as a unit — so a
    /// single malformed row emptied the entire session list, with pull-to-refresh
    /// unable to recover it. The rows come from three different sources (sidecar
    /// JSON, the state.db overlay, `get_cli_sessions()`), and upstream coerces
    /// these same fields with `_numeric_count` / `_safe_first` on its way out,
    /// which is the server conceding the inputs are not uniform.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        title = container.decodeLossyStringIfPresent(forKey: .title)
        workspace = container.decodeLossyStringIfPresent(forKey: .workspace)
        workspaceName = container.decodeLossyStringIfPresent(forKey: .workspaceName)
        model = container.decodeLossyStringIfPresent(forKey: .model)
        modelProvider = container.decodeLossyStringIfPresent(forKey: .modelProvider)
        modelOptionID = container.decodeLossyStringIfPresent(forKey: .modelOptionID)
        messageCount = container.decodeLossyIntIfPresent(forKey: .messageCount)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        updatedAt = container.decodeLossyDoubleIfPresent(forKey: .updatedAt)
        lastMessageAt = container.decodeLossyDoubleIfPresent(forKey: .lastMessageAt)
        sortTs = container.decodeLossyDoubleIfPresent(forKey: .sortTs)
        pinned = container.decodeLossyBoolIfPresent(forKey: .pinned)
        archived = container.decodeLossyBoolIfPresent(forKey: .archived)
        projectId = container.decodeLossyStringIfPresent(forKey: .projectId)
        profile = container.decodeLossyStringIfPresent(forKey: .profile)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        estimatedCost = container.decodeLossyDoubleIfPresent(forKey: .estimatedCost)
        activeStreamId = container.decodeLossyStringIfPresent(forKey: .activeStreamId)
        isStreaming = container.decodeLossyBoolIfPresent(forKey: .isStreaming)
        isCliSession = container.decodeLossyBoolIfPresent(forKey: .isCliSession)
        userMessageCount = container.decodeLossyIntIfPresent(forKey: .userMessageCount)
        hasPendingUserMessage = container.decodeLossyBoolIfPresent(forKey: .hasPendingUserMessage)
        pendingStartedAt = container.decodeLossyDoubleIfPresent(forKey: .pendingStartedAt)
        worktreePath = container.decodeLossyStringIfPresent(forKey: .worktreePath)
        sourceTag = container.decodeLossyStringIfPresent(forKey: .sourceTag)
        rawSource = container.decodeLossyStringIfPresent(forKey: .rawSource)
        sessionSource = container.decodeLossyStringIfPresent(forKey: .sessionSource)
        sourceLabel = container.decodeLossyStringIfPresent(forKey: .sourceLabel)
        sourceKind = SessionSourceKind(serverValue: container.decodeLossyStringIfPresent(forKey: .sourceKind))
        parentSessionId = container.decodeLossyStringIfPresent(forKey: .parentSessionId)
        relationshipType = container.decodeLossyStringIfPresent(forKey: .relationshipType)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
        canBranch = container.decodeLossyBoolIfPresent(forKey: .canBranch)
        canPin = container.decodeLossyBoolIfPresent(forKey: .canPin)
        canArchive = container.decodeLossyBoolIfPresent(forKey: .canArchive)
        canDelete = container.decodeLossyBoolIfPresent(forKey: .canDelete)
        canDuplicate = container.decodeLossyBoolIfPresent(forKey: .canDuplicate)
        matchType = container.decodeLossyStringIfPresent(forKey: .matchType)
        matchPreview = container.decodeLossyStringIfPresent(forKey: .matchPreview)
    }

    /// Decodes a session array a row at a time, so one unreadable row costs that
    /// row instead of the whole list. Returns nil only when the key is absent
    /// or is not an array at all.
    static func decodingRowsIndependently<Key: CodingKey>(
        from container: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) -> [SessionSummary]? {
        if let rows = try? container.decodeIfPresent([SessionSummary].self, forKey: key) {
            return rows
        }

        guard let values = try? container.decodeIfPresent([JSONValue].self, forKey: key) else {
            return nil
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return values.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? decoder.decode(SessionSummary.self, from: data)
        }
    }

    public init(from detail: SessionDetail) {
        sessionId = detail.sessionId
        title = detail.title
        workspace = detail.workspace
        workspaceName = detail.workspaceName
        model = detail.model
        modelProvider = detail.modelProvider
        modelOptionID = detail.modelOptionID
        messageCount = detail.messageCount ?? detail.messages?.count
        createdAt = detail.createdAt
        updatedAt = detail.updatedAt
        lastMessageAt = detail.lastMessageAt
        sortTs = detail.sortTs
        pinned = detail.pinned
        archived = detail.archived
        projectId = detail.projectId
        profile = detail.profile
        inputTokens = detail.inputTokens
        outputTokens = detail.outputTokens
        estimatedCost = detail.estimatedCost
        activeStreamId = detail.activeStreamId
        isStreaming = detail.isStreaming
        isCliSession = detail.isCliSession
        userMessageCount = nil
        if Self.nonEmpty(detail.pendingUserMessage) != nil || detail.pendingAttachments?.isEmpty == false {
            hasPendingUserMessage = true
        } else {
            hasPendingUserMessage = nil
        }
        pendingStartedAt = detail.pendingStartedAt
        worktreePath = detail.worktreePath
        sourceTag = detail.sourceTag
        rawSource = detail.rawSource
        sessionSource = detail.sessionSource
        sourceLabel = detail.sourceLabel
        sourceKind = detail.sourceKind
        parentSessionId = detail.parentSessionId
        relationshipType = detail.relationshipType
        readOnly = detail.readOnly
        canBranch = detail.canBranch
        canPin = detail.canPin
        canArchive = detail.canArchive
        canDelete = detail.canDelete
        canDuplicate = detail.canDuplicate
        matchType = nil
        matchPreview = nil
    }

    /// Mirrors all stored fields so local title patches preserve session-list metadata.
    /// Update this when `SessionSummary` gains a new stored property.
    public func replacingTitle(with title: String) -> SessionSummary {
        SessionSummary(
            sessionId: sessionId,
            title: title,
            workspace: workspace,
            workspaceName: workspaceName,
            model: model,
            modelProvider: modelProvider,
            modelOptionID: modelOptionID,
            messageCount: messageCount,
            createdAt: createdAt,
            updatedAt: updatedAt,
            lastMessageAt: lastMessageAt,
            sortTs: sortTs,
            pinned: pinned,
            archived: archived,
            projectId: projectId,
            profile: profile,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            estimatedCost: estimatedCost,
            activeStreamId: activeStreamId,
            isStreaming: isStreaming,
            isCliSession: isCliSession,
            userMessageCount: userMessageCount,
            hasPendingUserMessage: hasPendingUserMessage,
            pendingStartedAt: pendingStartedAt,
            worktreePath: worktreePath,
            sourceTag: sourceTag,
            rawSource: rawSource,
            sessionSource: sessionSource,
            sourceLabel: sourceLabel,
            sourceKind: sourceKind,
            parentSessionId: parentSessionId,
            relationshipType: relationshipType,
            readOnly: readOnly,
            canBranch: canBranch,
            canPin: canPin,
            canArchive: canArchive,
            canDelete: canDelete,
            canDuplicate: canDuplicate,
            matchType: matchType,
            matchPreview: matchPreview
        )
    }
}

extension SessionSummary {
    /// Classified by the server (`source_kind`, TAL-310); the app never reads source markers.
    var isDelegatedSubagentSession: Bool { sourceKind == .subagent }

    var isClaudeCodeSession: Bool { sourceKind == .claudeCode }

    /// A gateway chat (Telegram, Signal, WhatsApp, …).
    var isMessagingSession: Bool { sourceKind == .messaging }

    /// True when the row came from outside the WebUI — a CLI/TUI bridge or a
    /// messaging channel — so the app reloads its detail before opening it, for the
    /// server's current writability. A WebUI-born session never is, whatever a stale
    /// `is_cli_session` says.
    public var isExternalSourceSession: Bool {
        sourceKind != .webui && (isCliSession == true || isMessagingSession)
    }

    /// Overlays this server-authoritative row onto the list row it was opened
    /// from: every field the authoritative payload omits keeps the list value, so
    /// list-only metadata (streaming state, `user_message_count`, search
    /// `match_type`) survives an import round trip. Update this when
    /// `SessionSummary` gains a new stored property.
    public func merging(onto row: SessionSummary) -> SessionSummary {
        return SessionSummary(
            sessionId: sessionId ?? row.sessionId,
            title: title ?? row.title,
            workspace: workspace ?? row.workspace,
            // The name labels its own path, so it moves with the workspace it came with.
            workspaceName: workspace != nil ? workspaceName : row.workspaceName,
            model: model ?? row.model,
            modelProvider: modelProvider ?? row.modelProvider,
            modelOptionID: model != nil ? modelOptionID : row.modelOptionID,
            messageCount: messageCount ?? row.messageCount,
            createdAt: createdAt ?? row.createdAt,
            updatedAt: updatedAt ?? row.updatedAt,
            lastMessageAt: lastMessageAt ?? row.lastMessageAt,
            sortTs: sortTs ?? row.sortTs,
            pinned: pinned ?? row.pinned,
            archived: archived ?? row.archived,
            projectId: projectId ?? row.projectId,
            profile: profile ?? row.profile,
            inputTokens: inputTokens ?? row.inputTokens,
            outputTokens: outputTokens ?? row.outputTokens,
            estimatedCost: estimatedCost ?? row.estimatedCost,
            activeStreamId: activeStreamId ?? row.activeStreamId,
            isStreaming: isStreaming ?? row.isStreaming,
            isCliSession: isCliSession ?? row.isCliSession,
            userMessageCount: userMessageCount ?? row.userMessageCount,
            hasPendingUserMessage: hasPendingUserMessage ?? row.hasPendingUserMessage,
            pendingStartedAt: pendingStartedAt ?? row.pendingStartedAt,
            worktreePath: worktreePath ?? row.worktreePath,
            sourceTag: sourceTag ?? row.sourceTag,
            rawSource: rawSource ?? row.rawSource,
            sessionSource: sessionSource ?? row.sessionSource,
            sourceLabel: sourceLabel ?? row.sourceLabel,
            sourceKind: sourceKind ?? row.sourceKind,
            parentSessionId: parentSessionId ?? row.parentSessionId,
            relationshipType: relationshipType ?? row.relationshipType,
            readOnly: readOnly ?? row.readOnly,
            canBranch: canBranch ?? row.canBranch,
            canPin: canPin ?? row.canPin,
            canArchive: canArchive ?? row.canArchive,
            canDelete: canDelete ?? row.canDelete,
            canDuplicate: canDuplicate ?? row.canDuplicate,
            matchType: matchType ?? row.matchType,
            matchPreview: matchPreview ?? row.matchPreview
        )
    }

    /// The server folds read-only imports, view-only subagent children and
    /// not-claimable foreign sessions into `read_only` (TAL-312); an absent flag
    /// is writable, and the server still refuses a mutation it does not allow.
    public var isSessionReadOnly: Bool {
        readOnly == true
    }

    /// The time the row is labelled and date-bucketed by: the server's `sort_ts`, else
    /// the same field chain for an older server that does not ship it.
    public var sortTimestamp: Double? {
        sortTs ?? lastMessageAt ?? updatedAt ?? createdAt
    }

    public var shouldAppearInSessionList: Bool {
        !isEmptySidebarPlaceholder
    }

    /// Mirrors hermes-webui's visible-sidebar safety net for just-created
    /// placeholders: hide only the known empty Untitled shape, while keeping rows
    /// with content, pending work, streaming state, or explicit user/server state.
    /// Sort timestamps such as ``lastMessageAt`` are intentionally ignored here —
    /// ``compact()`` sets them from ``updated_at`` even for zero-message sessions.
    var isEmptySidebarPlaceholder: Bool {
        guard hasPlaceholderTitle else { return false }
        guard !hasSidebarState else { return false }
        guard !hasMessageActivity else { return false }

        return (messageCount ?? 0) == 0 && (userMessageCount ?? 0) == 0
    }

    public var isCronSession: Bool { sourceKind == .cron }

    public var isWebhookSession: Bool { sourceKind == .webhook }

    private var hasPlaceholderTitle: Bool {
        guard let normalizedTitle = Self.nonEmpty(title)?.lowercased() else { return true }
        return normalizedTitle == "untitled" || normalizedTitle == "untitled session"
    }

    private var hasSidebarState: Bool {
        pinned == true
            || isStreaming == true
            || hasPendingUserMessage == true
            || pendingStartedAt != nil
            || Self.nonEmpty(worktreePath) != nil
    }

    private var hasMessageActivity: Bool {
        if let messageCount, messageCount > 0 { return true }
        if let userMessageCount, userMessageCount > 0 { return true }
        return false
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public extension Array where Element == SessionSummary {
    /// The rows in display order. A server that ships `sort_ts` sends its canonical order, which
    /// the list keeps (TAL-306). An older server's order is not pinned-first, so its rows keep the
    /// previous pinned-first, newest-first sort; delete this fallback once every supported server
    /// ships `sort_ts`.
    var inDisplayOrder: [SessionSummary] {
        guard !contains(where: { $0.sortTs != nil }) else { return self }
        return sorted { left, right in
            if (left.pinned == true) != (right.pinned == true) {
                return left.pinned == true
            }
            return (left.sortTimestamp ?? 0) > (right.sortTimestamp ?? 0)
        }
    }
}

/// Which non-standard session kinds the session list should show. Webhooks,
/// cron jobs, CLI imports, Claude Code imports, and delegated subagents are
/// controlled independently. A row with unknown/missing source data remains visible.
public struct AutomatedSessionVisibility: Hashable {
    public var showsCron: Bool
    var showsCli: Bool
    public var showsWebhook: Bool
    var showsClaudeCode: Bool
    var showsSubagents: Bool

    /// Show every kind, primarily for explicit opt-in and tests.
    public static let showAll = AutomatedSessionVisibility(
        showsCron: true,
        showsCli: true,
        showsWebhook: true,
        showsClaudeCode: true,
        showsSubagents: true
    )

    public init(
        showsCron: Bool,
        showsCli: Bool,
        showsWebhook: Bool = true,
        showsClaudeCode: Bool = true,
        showsSubagents: Bool = false
    ) {
        self.showsCron = showsCron
        self.showsCli = showsCli
        self.showsWebhook = showsWebhook
        self.showsClaudeCode = showsClaudeCode
        self.showsSubagents = showsSubagents
    }

    /// Whether `session` should remain visible under these toggles.
    ///
    /// Every kind is the server's (`source_kind` and `is_cli_session`, TAL-310).
    public func shows(_ session: SessionSummary) -> Bool {
        if session.isWebhookSession, !showsWebhook { return false }
        if session.isDelegatedSubagentSession, !showsSubagents { return false }
        if session.isCronSession, !showsCron { return false }
        if session.isCliSession == true, !showsCli { return false }
        if session.isClaudeCodeSession, !showsClaudeCode { return false }
        return true
    }
}

public struct SessionDetail: Decodable, Equatable, Identifiable {
    public var id: String {
        if let sessionId, !sessionId.isEmpty {
            return sessionId
        }

        let titlePart = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "untitled"
        let timestamp = createdAt ?? updatedAt ?? lastMessageAt ?? 0
        return "session-\(titlePart)-\(timestamp)"
    }

    public let sessionId: String?
    public let title: String?
    public let workspace: String?
    /// The server's label for `workspace` (TAL-303); nil from an older server, which shows none.
    public let workspaceName: String?
    public let model: String?
    public let modelProvider: String?
    /// TAL-301: the catalog entry the server says `model`/`modelProvider` selects.
    public let modelOptionID: String?
    public let messageCount: Int?
    let createdAt: Double?
    let updatedAt: Double?
    let lastMessageAt: Double?
    let sortTs: Double?
    let pinned: Bool?
    let archived: Bool?
    let projectId: String?
    public let profile: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCost: Double?
    public let activeStreamId: String?
    let isStreaming: Bool?
    /// Who started the running turn (TAL-460): `background` when a background result did; nil while idle or on older servers.
    public let activeTurnOrigin: String?
    /// The running turn's pending steers, oldest first (TAL-424); nil from a Web older than that.
    public let pendingSteers: [PendingSteer]?
    let pendingUserMessage: String?
    let pendingAttachments: [JSONValue]?
    public let pendingStartedAt: Double?
    let worktreePath: String?
    public let thresholdTokens: Int?
    /// The context ring's server figures (TAL-299); nil when unknown or from an older server.
    public let contextUsedTokens: Int?
    public let contextWindowTokens: Int?
    public let contextUsagePercent: Int?
    public let contextThresholdPercent: Int?
    let isCliSession: Bool?
    let sourceTag: String?
    let rawSource: String?
    let sessionSource: String?
    let sourceLabel: String?
    let sourceKind: SessionSourceKind?
    let parentSessionId: String?
    let relationshipType: String?
    public let readOnly: Bool?
    public let canBranch: Bool?
    public let canPin: Bool?
    public let canArchive: Bool?
    public let canDelete: Bool?
    public let canDuplicate: Bool?
    /// The agent's display name (TAL-458); nil from a server that predates it.
    public let assistantName: String?
    public let messages: [ChatMessage]?
    public let toolCalls: [PersistedToolCall]?
    public let messagesTruncated: Bool?
    public let messagesOffset: Int?
    /// The server-placed "Context compaction · Reference only" card (TAL-560); nil shows none.
    public let compressionReference: CompressionReference?
    /// Where `messages` end in the active run's journal (TAL-316); nil means attach live without replay.
    public let transcriptSeq: TranscriptSeq?
    /// False for a server that predates `transcript_seq` (the key is absent, not null).
    public let statesTranscriptSeq: Bool

    enum CodingKeys: String, CodingKey {
        case sessionId
        case title
        case workspace
        case workspaceName
        case model
        case modelProvider
        case modelOptionID = "modelOptionId"
        case messageCount
        case createdAt
        case updatedAt
        case lastMessageAt
        case sortTs
        case pinned
        case archived
        case projectId
        case profile
        case inputTokens
        case outputTokens
        case estimatedCost
        case activeStreamId
        case isStreaming
        case activeTurnOrigin
        case pendingSteers
        case pendingUserMessage
        case pendingAttachments
        case pendingStartedAt
        case worktreePath
        case thresholdTokens
        case contextUsedTokens
        case contextWindowTokens
        case contextUsagePercent
        case contextThresholdPercent
        case isCliSession
        case sourceTag
        case rawSource
        case sessionSource
        case sourceLabel
        case sourceKind
        case parentSessionId
        case relationshipType
        case readOnly
        case canBranch
        case canPin
        case canArchive
        case canDelete
        case canDuplicate
        case assistantName
        case messages
        case toolCalls
        case messagesTruncated
        case messagesOffset
        case underscoredMessagesTruncated = "_messages_truncated"
        case underscoredMessagesOffset = "_messages_offset"
        case transformedMessagesTruncated = "_messagesTruncated"
        case transformedMessagesOffset = "_messagesOffset"
        case compressionReference
        case transcriptSeq
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        title = container.decodeLossyStringIfPresent(forKey: .title)
        workspace = container.decodeLossyStringIfPresent(forKey: .workspace)
        workspaceName = container.decodeLossyStringIfPresent(forKey: .workspaceName)
        model = container.decodeLossyStringIfPresent(forKey: .model)
        modelProvider = container.decodeLossyStringIfPresent(forKey: .modelProvider)
        modelOptionID = container.decodeLossyStringIfPresent(forKey: .modelOptionID)
        messageCount = container.decodeLossyIntIfPresent(forKey: .messageCount)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        updatedAt = container.decodeLossyDoubleIfPresent(forKey: .updatedAt)
        lastMessageAt = container.decodeLossyDoubleIfPresent(forKey: .lastMessageAt)
        sortTs = container.decodeLossyDoubleIfPresent(forKey: .sortTs)
        pinned = container.decodeLossyBoolIfPresent(forKey: .pinned)
        archived = container.decodeLossyBoolIfPresent(forKey: .archived)
        projectId = container.decodeLossyStringIfPresent(forKey: .projectId)
        profile = container.decodeLossyStringIfPresent(forKey: .profile)
        inputTokens = container.decodeLossyIntIfPresent(forKey: .inputTokens)
        outputTokens = container.decodeLossyIntIfPresent(forKey: .outputTokens)
        estimatedCost = container.decodeLossyDoubleIfPresent(forKey: .estimatedCost)
        activeStreamId = container.decodeLossyStringIfPresent(forKey: .activeStreamId)
        isStreaming = container.decodeLossyBoolIfPresent(forKey: .isStreaming)
        activeTurnOrigin = container.decodeLossyStringIfPresent(forKey: .activeTurnOrigin)
        // One malformed entry never hides the others.
        pendingSteers = container.decodeLossyArrayIfPresent(PendingSteer.self, forKey: .pendingSteers)
        pendingUserMessage = container.decodeLossyStringIfPresent(forKey: .pendingUserMessage)
        pendingAttachments = try? container.decodeIfPresent([JSONValue].self, forKey: .pendingAttachments)
        pendingStartedAt = container.decodeLossyDoubleIfPresent(forKey: .pendingStartedAt)
        worktreePath = container.decodeLossyStringIfPresent(forKey: .worktreePath)
        thresholdTokens = container.decodeLossyIntIfPresent(forKey: .thresholdTokens)
        contextUsedTokens = container.decodeLossyIntIfPresent(forKey: .contextUsedTokens)
        contextWindowTokens = container.decodeLossyIntIfPresent(forKey: .contextWindowTokens)
        contextUsagePercent = container.decodeLossyIntIfPresent(forKey: .contextUsagePercent)
        contextThresholdPercent = container.decodeLossyIntIfPresent(forKey: .contextThresholdPercent)
        isCliSession = container.decodeLossyBoolIfPresent(forKey: .isCliSession)
        sourceTag = container.decodeLossyStringIfPresent(forKey: .sourceTag)
        rawSource = container.decodeLossyStringIfPresent(forKey: .rawSource)
        sessionSource = container.decodeLossyStringIfPresent(forKey: .sessionSource)
        sourceLabel = container.decodeLossyStringIfPresent(forKey: .sourceLabel)
        sourceKind = SessionSourceKind(serverValue: container.decodeLossyStringIfPresent(forKey: .sourceKind))
        parentSessionId = container.decodeLossyStringIfPresent(forKey: .parentSessionId)
        relationshipType = container.decodeLossyStringIfPresent(forKey: .relationshipType)
        readOnly = container.decodeLossyBoolIfPresent(forKey: .readOnly)
        canBranch = container.decodeLossyBoolIfPresent(forKey: .canBranch)
        canPin = container.decodeLossyBoolIfPresent(forKey: .canPin)
        canArchive = container.decodeLossyBoolIfPresent(forKey: .canArchive)
        canDelete = container.decodeLossyBoolIfPresent(forKey: .canDelete)
        canDuplicate = container.decodeLossyBoolIfPresent(forKey: .canDuplicate)
        assistantName = container.decodeLossyStringIfPresent(forKey: .assistantName)
        messages = Self.decodeMessagesTolerantly(from: container)
        toolCalls = Self.decodeToolCallsTolerantly(from: container)
        messagesTruncated = container.decodeLossyBoolIfPresent(forKey: .underscoredMessagesTruncated)
            ?? container.decodeLossyBoolIfPresent(forKey: .transformedMessagesTruncated)
            ?? container.decodeLossyBoolIfPresent(forKey: .messagesTruncated)
        messagesOffset = container.decodeLossyIntIfPresent(forKey: .underscoredMessagesOffset)
            ?? container.decodeLossyIntIfPresent(forKey: .transformedMessagesOffset)
            ?? container.decodeLossyIntIfPresent(forKey: .messagesOffset)
        compressionReference = try? container.decodeIfPresent(CompressionReference.self, forKey: .compressionReference)
        transcriptSeq = try? container.decodeIfPresent(TranscriptSeq.self, forKey: .transcriptSeq)
        statesTranscriptSeq = container.contains(.transcriptSeq)
    }

    private static func decodeMessagesTolerantly(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> [ChatMessage]? {
        if let direct = try? container.decodeIfPresent([ChatMessage].self, forKey: .messages) {
            return direct
        }

        guard let values = try? container.decodeIfPresent([JSONValue].self, forKey: .messages) else {
            return nil
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        return values.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? decoder.decode(ChatMessage.self, from: data)
        }
    }

    private static func decodeToolCallsTolerantly(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> [PersistedToolCall]? {
        if let direct = try? container.decodeIfPresent([PersistedToolCall].self, forKey: .toolCalls) {
            return direct
        }

        guard let values = try? container.decodeIfPresent([JSONValue].self, forKey: .toolCalls) else {
            return nil
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        return values.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? decoder.decode(PersistedToolCall.self, from: data)
        }
    }
}

/// The server's statement that a session detail's `messages` hold nothing the journal of `streamId` delivers after `seq`,
/// so resuming that stream with `after_seq = seq` renders the replay as-is.
public struct TranscriptSeq: Decodable, Equatable {
    let streamId: String
    let seq: Int
}

/// The "Context compaction · Reference only" card the server places (TAL-560): its text, and the full-transcript index of
/// the row it follows (the `_messages_offset` space); nil puts it above the transcript.
public struct CompressionReference: Decodable, Equatable {
    public let text: String
    public let afterMessageIndex: Int?

    init(text: String, afterMessageIndex: Int?) {
        self.text = text
        self.afterMessageIndex = afterMessageIndex
    }
}
