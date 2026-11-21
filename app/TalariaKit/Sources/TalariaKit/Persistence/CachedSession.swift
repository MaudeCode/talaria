import Foundation
import SwiftData

enum CachePolicy {
    static let ttl: TimeInterval = 7 * 24 * 60 * 60
    static let maxMessages = 5_000
    static let maintenanceInterval: TimeInterval = 60
}

@Model
public final class CachedSession {
    @Attribute(.unique) var cacheKey: String
    var serverURLString: String
    var sessionID: String
    var title: String?
    var workspace: String?
    /// The server's label for `workspace` (TAL-303). Optional so the unversioned store opens without a migration.
    var workspaceName: String?
    var placeLabel: String?
    var model: String?
    var modelProvider: String?
    var messageCount: Int?
    var createdAt: Double?
    var updatedAt: Double?
    var lastMessageAt: Double?
    /// The server's `sort_ts` (TAL-306). Optional so the unversioned store opens without a migration.
    var sortTs: Double?
    var pinned: Bool?
    var archived: Bool?
    /// The server's `sidebar_group` (TAL-1534). Optional so the unversioned store opens without a migration.
    var sidebarGroup: String?
    var projectId: String?
    var profile: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var estimatedCost: Double?
    var activeStreamId: String?
    var isStreaming: Bool?
    var isCliSession: Bool?
    var userMessageCount: Int?
    var hasPendingUserMessage: Bool?
    var pendingStartedAt: Double?
    var worktreePath: String?
    var sourceTag: String?
    var rawSource: String?
    var sessionSource: String?
    var sourceLabel: String?
    /// `SessionSourceKind` raw value (TAL-310). Optional so the unversioned store opens without a migration.
    var sourceKind: String?
    var parentSessionId: String?
    var relationshipType: String?
    var readOnly: Bool?
    // Retired with the `is_read_only` spelling (TAL-312); kept so the unversioned cache store opens without a migration.
    var isReadOnly: Bool?
    /// The row's place in the server's latest list, so a cached paint keeps the server's order
    /// (TAL-437). Optional so the unversioned store opens without a migration.
    var listPosition: Int?
    /// The detail's `branched_from` (TAL-454), which list rows never carry, so `apply` leaves it alone.
    /// Optional so the unversioned store opens without a migration.
    var branchedFromSessionID: String?
    var branchedFromTitle: String?
    /// The server's row action gates (TAL-723), so a cached paint offers the server's actions.
    /// Optional so the unversioned store opens without a migration.
    var canPin: Bool?
    var canArchive: Bool?
    var canDelete: Bool?
    var canDuplicate: Bool?
    var canBranch: Bool?
    /// The server's `access_provisional` (TAL-2508). Optional so the unversioned store opens without a migration.
    var accessProvisional: Bool?
    /// Metadata-only rows never add a session to the server-owned list.
    var transcriptOnly: Bool?
    /// Last server-selected run presentation, retained for offline display.
    var runStatusData: Data?
    /// The detail's `owner_attachment` (TAL-1043), which list rows never carry, retained for offline display.
    var ownerAttachmentData: Data?
    /// The detail's `execution_mode` (TAL-1045), retained for offline display.
    var executionModeData: Data?
    /// The complete recent server page, stored atomically with its message rows. Nil marks a legacy/incomplete cache.
    var recentMessagesOffset: Int?
    var recentMessagesTruncated: Bool?
    var recentMessagesCount: Int?
    var recentMessagesExpiresAt: Date?
    var cachedAt: Date
    var expiresAt: Date

    init(serverURLString: String, session: SessionSummary, cachedAt: Date = Date()) {
        let sessionID = session.sessionId ?? session.id
        self.cacheKey = Self.cacheKey(serverURLString: serverURLString, sessionID: sessionID)
        self.serverURLString = serverURLString
        self.sessionID = sessionID
        self.cachedAt = cachedAt
        self.expiresAt = cachedAt.addingTimeInterval(CachePolicy.ttl)
        apply(session, cachedAt: cachedAt)
    }

    static func cacheKey(serverURLString: String, sessionID: String) -> String {
        "\(serverURLString)|session|\(sessionID)"
    }

    func apply(_ session: SessionSummary, cachedAt: Date = Date()) {
        var row = CacheRowWriter(row: self)
        row.set(\.transcriptOnly, false)
        row.set(\.title, session.title)
        row.set(\.workspace, session.workspace)
        row.set(\.workspaceName, session.workspaceName)
        row.set(\.placeLabel, session.placeLabel)
        row.set(\.model, session.model)
        row.set(\.modelProvider, session.modelProvider)
        row.set(\.messageCount, session.messageCount)
        row.set(\.createdAt, session.createdAt)
        row.set(\.updatedAt, session.updatedAt)
        row.set(\.lastMessageAt, session.lastMessageAt)
        row.set(\.sortTs, session.sortTs)
        row.set(\.pinned, session.pinned)
        row.set(\.archived, session.archived)
        row.set(\.sidebarGroup, session.sidebarGroup)
        row.set(\.projectId, session.projectId)
        row.set(\.profile, session.profile)
        row.set(\.inputTokens, session.inputTokens)
        row.set(\.outputTokens, session.outputTokens)
        row.set(\.estimatedCost, session.estimatedCost)
        row.set(\.activeStreamId, session.activeStreamId)
        row.set(\.isStreaming, session.isStreaming)
        row.set(\.isCliSession, session.isCliSession)
        row.set(\.userMessageCount, session.userMessageCount)
        row.set(\.hasPendingUserMessage, session.hasPendingUserMessage)
        row.set(\.pendingStartedAt, session.pendingStartedAt)
        row.set(\.worktreePath, session.worktreePath)
        row.set(\.sourceTag, session.sourceTag)
        row.set(\.rawSource, session.rawSource)
        row.set(\.sessionSource, session.sessionSource)
        row.set(\.sourceLabel, session.sourceLabel)
        row.set(\.sourceKind, session.sourceKind?.rawValue)
        row.set(\.parentSessionId, session.parentSessionId)
        row.set(\.relationshipType, session.relationshipType)
        row.set(\.readOnly, session.readOnly)
        row.set(\.canPin, session.canPin)
        row.set(\.canArchive, session.canArchive)
        row.set(\.canDelete, session.canDelete)
        row.set(\.canDuplicate, session.canDuplicate)
        row.set(\.canBranch, session.canBranch)
        row.set(\.accessProvisional, session.accessProvisional)
        row.renew(cachedAt: \.cachedAt, expiresAt: \.expiresAt, at: cachedAt)
    }
}
