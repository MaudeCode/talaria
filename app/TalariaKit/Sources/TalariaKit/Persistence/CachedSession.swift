import Foundation
import SwiftData

enum CachePolicy {
    static let ttl: TimeInterval = 7 * 24 * 60 * 60
    static let maxMessages = 5_000
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
        title = session.title
        workspace = session.workspace
        workspaceName = session.workspaceName
        model = session.model
        modelProvider = session.modelProvider
        messageCount = session.messageCount
        createdAt = session.createdAt
        updatedAt = session.updatedAt
        lastMessageAt = session.lastMessageAt
        sortTs = session.sortTs
        pinned = session.pinned
        archived = session.archived
        projectId = session.projectId
        profile = session.profile
        inputTokens = session.inputTokens
        outputTokens = session.outputTokens
        estimatedCost = session.estimatedCost
        activeStreamId = session.activeStreamId
        isStreaming = session.isStreaming
        isCliSession = session.isCliSession
        userMessageCount = session.userMessageCount
        hasPendingUserMessage = session.hasPendingUserMessage
        pendingStartedAt = session.pendingStartedAt
        worktreePath = session.worktreePath
        sourceTag = session.sourceTag
        rawSource = session.rawSource
        sessionSource = session.sessionSource
        sourceLabel = session.sourceLabel
        sourceKind = session.sourceKind?.rawValue
        parentSessionId = session.parentSessionId
        relationshipType = session.relationshipType
        readOnly = session.readOnly
        self.cachedAt = cachedAt
        expiresAt = cachedAt.addingTimeInterval(CachePolicy.ttl)
    }
}
