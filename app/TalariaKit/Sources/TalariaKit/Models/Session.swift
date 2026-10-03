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

    enum CodingKeys: String, CodingKey {
        case sessions, query, count
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = SessionSummary.decodingRowsIndependently(from: container, forKey: .sessions)
        query = container.decodeLossyStringIfPresent(forKey: .query)
        count = container.decodeLossyIntIfPresent(forKey: .count)
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

/// `POST /api/session/import_cli`. `imported` is false when the session was
/// already present and was only refreshed, and when the server answers a
/// read-only source with a view-only payload instead of materializing a
/// writable session.
public struct SessionImportResponse: Decodable, Equatable {
    public let session: SessionDetail?
    let imported: Bool?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case session, imported, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        session = try? container.decodeIfPresent(SessionDetail.self, forKey: .session)
        imported = container.decodeLossyBoolIfPresent(forKey: .imported)
        error = container.decodeLossyStringIfPresent(forKey: .error)
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

    public var compressedTokenEstimate: Int? {
        guard let tokenLine, !tokenLine.isEmpty else { return nil }

        let trailingTokenText = tokenLine
            .components(separatedBy: "\u{2192}")
            .last?
            .components(separatedBy: "->")
            .last ?? tokenLine

        let digits = trailingTokenText.filter { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        return Int(digits)
    }
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
    public let model: String?
    public let modelProvider: String?
    public let messageCount: Int?
    public let createdAt: Double?
    public let updatedAt: Double?
    public let lastMessageAt: Double?
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
    public let canDuplicate: Bool?
    public let matchType: String?
    /// Server-redacted excerpt around the content hit; only `/api/sessions/search`
    /// rows with `match_type == "content"` carry it, and older servers omit it.
    public let matchPreview: String?

    public init(
        sessionId: String? = nil,
        title: String? = nil,
        workspace: String? = nil,
        model: String? = nil,
        modelProvider: String? = nil,
        messageCount: Int? = nil,
        createdAt: Double? = nil,
        updatedAt: Double? = nil,
        lastMessageAt: Double? = nil,
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
        canDuplicate: Bool? = nil,
        matchType: String? = nil,
        matchPreview: String? = nil
    ) {
        self.sessionId = sessionId
        self.title = title
        self.workspace = workspace
        self.model = model
        self.modelProvider = modelProvider
        self.messageCount = messageCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
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
        self.canDuplicate = canDuplicate
        self.matchType = matchType
        self.matchPreview = matchPreview
    }

    enum CodingKeys: String, CodingKey {
        case sessionId, title, workspace, model, modelProvider
        case messageCount, createdAt, updatedAt, lastMessageAt
        case pinned, archived, projectId, profile
        case inputTokens, outputTokens, estimatedCost
        case activeStreamId, isStreaming, isCliSession
        case userMessageCount, hasPendingUserMessage, pendingStartedAt, worktreePath
        case sourceTag, rawSource, sessionSource, sourceLabel, sourceKind
        case parentSessionId, relationshipType, readOnly, canBranch, canPin, canArchive, canDuplicate, matchType, matchPreview
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
        model = container.decodeLossyStringIfPresent(forKey: .model)
        modelProvider = container.decodeLossyStringIfPresent(forKey: .modelProvider)
        messageCount = container.decodeLossyIntIfPresent(forKey: .messageCount)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        updatedAt = container.decodeLossyDoubleIfPresent(forKey: .updatedAt)
        lastMessageAt = container.decodeLossyDoubleIfPresent(forKey: .lastMessageAt)
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
        model = detail.model
        modelProvider = detail.modelProvider
        messageCount = detail.messageCount ?? detail.messages?.count
        createdAt = detail.createdAt
        updatedAt = detail.updatedAt
        lastMessageAt = detail.lastMessageAt
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
        canPin = nil
        canArchive = nil
        canDuplicate = nil
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
            model: model,
            modelProvider: modelProvider,
            messageCount: messageCount,
            createdAt: createdAt,
            updatedAt: updatedAt,
            lastMessageAt: lastMessageAt,
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
    /// messaging channel — so the server must import or refresh it through
    /// `POST /api/session/import_cli` before the app can continue it. A WebUI-born
    /// session never is, whatever a stale `is_cli_session` says.
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
            model: model ?? row.model,
            modelProvider: modelProvider ?? row.modelProvider,
            messageCount: messageCount ?? row.messageCount,
            createdAt: createdAt ?? row.createdAt,
            updatedAt: updatedAt ?? row.updatedAt,
            lastMessageAt: lastMessageAt ?? row.lastMessageAt,
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

/// Which non-standard session kinds the session list should show. Webhooks,
/// cron jobs, CLI imports, Claude Code imports, and delegated subagents are
/// controlled independently. A row with unknown/missing source data remains visible.
public struct AutomatedSessionVisibility: Equatable {
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
    public let model: String?
    public let modelProvider: String?
    public let messageCount: Int?
    let createdAt: Double?
    let updatedAt: Double?
    let lastMessageAt: Double?
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
    public let contextLength: Int?
    public let thresholdTokens: Int?
    public let lastPromptTokens: Int?
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
    /// The agent's display name (TAL-458); nil from a server that predates it.
    public let assistantName: String?
    public let messages: [ChatMessage]?
    public let toolCalls: [PersistedToolCall]?
    public let messagesTruncated: Bool?
    public let messagesOffset: Int?
    public let compressionAnchorVisibleIdx: Int?
    public let compressionAnchorMessageKey: CompressionAnchorMessageKey?
    public let compressionAnchorSummary: String?
    /// Where `messages` end in the active run's journal (TAL-316); nil means attach live without replay.
    public let transcriptSeq: TranscriptSeq?
    /// False for a server that predates `transcript_seq` (the key is absent, not null).
    public let statesTranscriptSeq: Bool

    enum CodingKeys: String, CodingKey {
        case sessionId
        case title
        case workspace
        case model
        case modelProvider
        case messageCount
        case createdAt
        case updatedAt
        case lastMessageAt
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
        case contextLength
        case thresholdTokens
        case lastPromptTokens
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
        case assistantName
        case messages
        case toolCalls
        case messagesTruncated
        case messagesOffset
        case underscoredMessagesTruncated = "_messages_truncated"
        case underscoredMessagesOffset = "_messages_offset"
        case transformedMessagesTruncated = "_messagesTruncated"
        case transformedMessagesOffset = "_messagesOffset"
        case compressionAnchorVisibleIdx
        case compressionAnchorMessageKey
        case compressionAnchorSummary
        case snakeCasedCompressionAnchorVisibleIdx = "compression_anchor_visible_idx"
        case snakeCasedCompressionAnchorMessageKey = "compression_anchor_message_key"
        case snakeCasedCompressionAnchorSummary = "compression_anchor_summary"
        case transcriptSeq
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        title = container.decodeLossyStringIfPresent(forKey: .title)
        workspace = container.decodeLossyStringIfPresent(forKey: .workspace)
        model = container.decodeLossyStringIfPresent(forKey: .model)
        modelProvider = container.decodeLossyStringIfPresent(forKey: .modelProvider)
        messageCount = container.decodeLossyIntIfPresent(forKey: .messageCount)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        updatedAt = container.decodeLossyDoubleIfPresent(forKey: .updatedAt)
        lastMessageAt = container.decodeLossyDoubleIfPresent(forKey: .lastMessageAt)
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
        pendingSteers = (try? container.decodeIfPresent([LossyPendingSteer].self, forKey: .pendingSteers))?.compactMap(\.steer)
        pendingUserMessage = container.decodeLossyStringIfPresent(forKey: .pendingUserMessage)
        pendingAttachments = try? container.decodeIfPresent([JSONValue].self, forKey: .pendingAttachments)
        pendingStartedAt = container.decodeLossyDoubleIfPresent(forKey: .pendingStartedAt)
        worktreePath = container.decodeLossyStringIfPresent(forKey: .worktreePath)
        contextLength = container.decodeLossyIntIfPresent(forKey: .contextLength)
        thresholdTokens = container.decodeLossyIntIfPresent(forKey: .thresholdTokens)
        lastPromptTokens = container.decodeLossyIntIfPresent(forKey: .lastPromptTokens)
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
        assistantName = container.decodeLossyStringIfPresent(forKey: .assistantName)
        messages = Self.decodeMessagesTolerantly(from: container)
        toolCalls = Self.decodeToolCallsTolerantly(from: container)
        messagesTruncated = container.decodeLossyBoolIfPresent(forKey: .underscoredMessagesTruncated)
            ?? container.decodeLossyBoolIfPresent(forKey: .transformedMessagesTruncated)
            ?? container.decodeLossyBoolIfPresent(forKey: .messagesTruncated)
        messagesOffset = container.decodeLossyIntIfPresent(forKey: .underscoredMessagesOffset)
            ?? container.decodeLossyIntIfPresent(forKey: .transformedMessagesOffset)
            ?? container.decodeLossyIntIfPresent(forKey: .messagesOffset)
        compressionAnchorVisibleIdx = container.decodeLossyIntIfPresent(forKey: .compressionAnchorVisibleIdx)
            ?? container.decodeLossyIntIfPresent(forKey: .snakeCasedCompressionAnchorVisibleIdx)
        compressionAnchorMessageKey = ((try? container.decodeIfPresent(
            CompressionAnchorMessageKey.self,
            forKey: .compressionAnchorMessageKey
        )) ?? nil)
            ?? ((try? container.decodeIfPresent(
                CompressionAnchorMessageKey.self,
                forKey: .snakeCasedCompressionAnchorMessageKey
            )) ?? nil)
        compressionAnchorSummary = container.decodeLossyStringIfPresent(forKey: .compressionAnchorSummary)
            ?? container.decodeLossyStringIfPresent(forKey: .snakeCasedCompressionAnchorSummary)
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

/// Anchor key the server builds in `_anchor_message_key` (`api/routes.py`):
/// role, optional timestamp, first 160 chars of whitespace-normalized text,
/// and attachment count of the last visible message after compaction.
/// The server's statement that a session detail's `messages` hold nothing the journal of `streamId` delivers after `seq`,
/// so resuming that stream with `after_seq = seq` renders the replay as-is.
public struct TranscriptSeq: Decodable, Equatable {
    let streamId: String
    let seq: Int
}

public struct CompressionAnchorMessageKey: Decodable, Equatable {
    public let role: String?
    public let ts: Double?
    public let text: String?
    public let attachments: Int?

    init(role: String?, ts: Double?, text: String?, attachments: Int?) {
        self.role = role
        self.ts = ts
        self.text = text
        self.attachments = attachments
    }

    enum CodingKeys: String, CodingKey {
        case role
        case ts
        case text
        case attachments
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = container.decodeLossyStringIfPresent(forKey: .role)
        ts = container.decodeLossyDoubleIfPresent(forKey: .ts)
        text = container.decodeLossyStringIfPresent(forKey: .text)
        attachments = container.decodeLossyIntIfPresent(forKey: .attachments)
    }
}

private struct LossyPendingSteer: Decodable {
    let steer: PendingSteer?

    init(from decoder: Decoder) throws {
        steer = try? PendingSteer(from: decoder)
    }
}
