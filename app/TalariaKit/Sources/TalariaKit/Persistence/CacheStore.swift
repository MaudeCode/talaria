import Foundation
import SwiftData

public enum CacheStore {
    @MainActor
    public static func cachedSessions(
        serverURL: URL,
        in context: ModelContext,
        now: Date = Date()
    ) throws -> [SessionSummary] {
        let serverURLString = serverURL.absoluteString
        let descriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.serverURLString == serverURLString
            }
        )

        return try context.fetch(descriptor)
            .filter { $0.archived != true && $0.expiresAt > now }
            .sorted { ($0.listPosition ?? .max) < ($1.listPosition ?? .max) }
            .map(SessionSummary.init(cachedSession:))
    }

    @MainActor
    public static func cachedMessages(
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        limit: Int? = nil,
        now: Date = Date()
    ) throws -> [ChatMessage] {
        if let limit, limit <= 0 {
            return []
        }

        let serverURLString = serverURL.absoluteString
        var descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { cachedMessage in
                cachedMessage.serverURLString == serverURLString
                    && cachedMessage.sessionID == sessionID
                    && cachedMessage.expiresAt > now
            },
            sortBy: [
                SortDescriptor(
                    \CachedMessage.sortIndex,
                    order: limit == nil ? .forward : .reverse
                )
            ]
        )
        if let limit {
            descriptor.fetchLimit = limit
        }

        let cachedMessages = try context.fetch(descriptor)
        if limit != nil {
            return cachedMessages.reversed().map(ChatMessage.init(cachedMessage:))
        }
        return cachedMessages.map(ChatMessage.init(cachedMessage:))
    }

    @MainActor
    public static func cacheSessions(
        _ sessions: [SessionSummary],
        serverURL: URL,
        in context: ModelContext,
        cachedAt: Date = Date()
    ) throws {
        let serverURLString = serverURL.absoluteString
        let cacheableSessions = sessions.filter { $0.archived != true && $0.sessionId != nil }
        let freshKeys = Set(cacheableSessions.compactMap { session -> String? in
            guard let sessionID = session.sessionId else { return nil }
            return CachedSession.cacheKey(serverURLString: serverURLString, sessionID: sessionID)
        })
        let descriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.serverURLString == serverURLString
            }
        )
        let existingSessions = try context.fetch(descriptor)
        var existingByKey = Dictionary(uniqueKeysWithValues: existingSessions.map { ($0.cacheKey, $0) })

        for (position, session) in cacheableSessions.enumerated() {
            guard let sessionID = session.sessionId else { continue }
            let cacheKey = CachedSession.cacheKey(serverURLString: serverURLString, sessionID: sessionID)
            if let cachedSession = existingByKey[cacheKey] {
                cachedSession.apply(session, cachedAt: cachedAt)
                cachedSession.listPosition = position
            } else {
                let cachedSession = CachedSession(
                    serverURLString: serverURLString,
                    session: session,
                    cachedAt: cachedAt
                )
                cachedSession.listPosition = position
                context.insert(cachedSession)
                existingByKey[cacheKey] = cachedSession
            }
        }

        for staleSession in existingSessions where !freshKeys.contains(staleSession.cacheKey) {
            context.delete(staleSession)
        }

        try performMaintenance(in: context, now: cachedAt)
        try context.save()
    }

    @MainActor
    public static func cacheSession(
        _ session: SessionSummary,
        serverURL: URL,
        in context: ModelContext,
        cachedAt: Date = Date()
    ) throws {
        guard let sessionID = session.sessionId else { return }

        let serverURLString = serverURL.absoluteString
        let cacheKey = CachedSession.cacheKey(serverURLString: serverURLString, sessionID: sessionID)

        if session.archived == true {
            if let cachedSession = try cachedSession(cacheKey: cacheKey, in: context) {
                context.delete(cachedSession)
            }
        } else if let cachedSession = try cachedSession(cacheKey: cacheKey, in: context) {
            cachedSession.apply(session, cachedAt: cachedAt)
        } else {
            context.insert(CachedSession(serverURLString: serverURLString, session: session, cachedAt: cachedAt))
        }

        try performMaintenance(in: context, now: cachedAt)
        try context.save()
    }

    @MainActor
    public static func cacheMessages(
        _ messages: [ChatMessage],
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        cachedAt: Date = Date()
    ) throws {
        let serverURLString = serverURL.absoluteString
        let freshKeys = Set(messages.enumerated().map { offset, message in
            CachedMessage.cacheKey(
                serverURLString: serverURLString,
                sessionID: sessionID,
                message: message,
                sortIndex: offset
            )
        })
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { cachedMessage in
                cachedMessage.serverURLString == serverURLString
                    && cachedMessage.sessionID == sessionID
            }
        )
        let existingMessages = try context.fetch(descriptor)
        var existingByKey = Dictionary(uniqueKeysWithValues: existingMessages.map { ($0.cacheKey, $0) })

        for (offset, message) in messages.enumerated() {
            let cacheKey = CachedMessage.cacheKey(
                serverURLString: serverURLString,
                sessionID: sessionID,
                message: message,
                sortIndex: offset
            )
            if let cachedMessage = existingByKey[cacheKey] {
                cachedMessage.apply(message, sortIndex: offset, cachedAt: cachedAt)
            } else {
                let cachedMessage = CachedMessage(
                    serverURLString: serverURLString,
                    sessionID: sessionID,
                    message: message,
                    sortIndex: offset,
                    cachedAt: cachedAt
                )
                context.insert(cachedMessage)
                existingByKey[cacheKey] = cachedMessage
            }
        }

        for staleMessage in existingMessages where !freshKeys.contains(staleMessage.cacheKey) {
            context.delete(staleMessage)
        }

        try performMaintenance(in: context, now: cachedAt)
        try context.save()
    }

    @MainActor
    static func clearAll(in context: ModelContext) throws {
        for cachedSession in try context.fetch(FetchDescriptor<CachedSession>()) {
            context.delete(cachedSession)
        }

        for cachedMessage in try context.fetch(FetchDescriptor<CachedMessage>()) {
            context.delete(cachedMessage)
        }

        try context.save()
    }

    /// Deletes only the cached sessions and messages belonging to `serverURL`,
    /// leaving every other configured server's offline data intact (#18). Backs
    /// the Settings "Clear Offline Cache" action (active server) and the purge
    /// of a server's cache when it is removed, so a removed/reset server never
    /// leaves orphaned rows behind.
    @MainActor
    public static func clearCache(for serverURL: URL, in context: ModelContext) throws {
        let serverURLString = serverURL.absoluteString

        let sessionDescriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.serverURLString == serverURLString
            }
        )
        for cachedSession in try context.fetch(sessionDescriptor) {
            context.delete(cachedSession)
        }

        let messageDescriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { cachedMessage in
                cachedMessage.serverURLString == serverURLString
            }
        )
        for cachedMessage in try context.fetch(messageDescriptor) {
            context.delete(cachedMessage)
        }

        try context.save()
    }

    @MainActor
    private static func performMaintenance(in context: ModelContext, now: Date) throws {
        try deleteExpiredSessions(in: context, now: now)
        try deleteExpiredMessages(in: context, now: now)
        try evictOldestMessagesIfNeeded(in: context)
    }

    @MainActor
    private static func deleteExpiredSessions(in context: ModelContext, now: Date) throws {
        let descriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.expiresAt <= now
            }
        )
        for session in try context.fetch(descriptor) {
            context.delete(session)
        }
    }

    @MainActor
    private static func deleteExpiredMessages(in context: ModelContext, now: Date) throws {
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { cachedMessage in
                cachedMessage.expiresAt <= now
            }
        )
        for message in try context.fetch(descriptor) {
            context.delete(message)
        }
    }

    @MainActor
    private static func evictOldestMessagesIfNeeded(in context: ModelContext) throws {
        let overflowCount = try context.fetchCount(FetchDescriptor<CachedMessage>()) - CachePolicy.maxMessages
        guard overflowCount > 0 else { return }

        var descriptor = FetchDescriptor<CachedMessage>(
            sortBy: [
                SortDescriptor(\CachedMessage.cachedAt),
                SortDescriptor(\CachedMessage.timestamp),
                SortDescriptor(\CachedMessage.sortIndex)
            ]
        )
        descriptor.fetchLimit = overflowCount
        for message in try context.fetch(descriptor) {
            context.delete(message)
        }
    }

    @MainActor
    private static func cachedSession(cacheKey: String, in context: ModelContext) throws -> CachedSession? {
        var descriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.cacheKey == cacheKey
            }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

}

private extension SessionSummary {
    public init(cachedSession: CachedSession) {
        sessionId = cachedSession.sessionID
        title = cachedSession.title
        workspace = cachedSession.workspace
        workspaceName = cachedSession.workspaceName
        model = cachedSession.model
        modelProvider = cachedSession.modelProvider
        // Pairs with the live catalog only; the cached row has none (TAL-301).
        modelOptionID = nil
        messageCount = cachedSession.messageCount
        createdAt = cachedSession.createdAt
        updatedAt = cachedSession.updatedAt
        lastMessageAt = cachedSession.lastMessageAt
        sortTs = cachedSession.sortTs
        pinned = cachedSession.pinned
        archived = cachedSession.archived
        projectId = cachedSession.projectId
        profile = cachedSession.profile
        inputTokens = cachedSession.inputTokens
        outputTokens = cachedSession.outputTokens
        estimatedCost = cachedSession.estimatedCost
        activeStreamId = cachedSession.activeStreamId
        isStreaming = cachedSession.isStreaming
        isCliSession = cachedSession.isCliSession
        userMessageCount = cachedSession.userMessageCount
        hasPendingUserMessage = cachedSession.hasPendingUserMessage
        pendingStartedAt = cachedSession.pendingStartedAt
        worktreePath = cachedSession.worktreePath
        sourceTag = cachedSession.sourceTag
        rawSource = cachedSession.rawSource
        sessionSource = cachedSession.sessionSource
        sourceLabel = cachedSession.sourceLabel
        sourceKind = SessionSourceKind(serverValue: cachedSession.sourceKind)
        parentSessionId = cachedSession.parentSessionId
        relationshipType = cachedSession.relationshipType
        readOnly = cachedSession.readOnly
        canBranch = nil
        canPin = nil
        canArchive = nil
        canDelete = nil
        canDuplicate = nil
        matchType = nil
        matchPreview = nil
    }
}

private extension ChatMessage {
    public init(cachedMessage: CachedMessage) {
        let attachments: [MessageAttachment]?
        if let data = cachedMessage.attachmentsData {
            attachments = try? JSONDecoder().decode([MessageAttachment].self, from: data)
        } else {
            attachments = nil
        }
        let toolCalls: [JSONValue]?
        if let data = cachedMessage.toolCallsData {
            toolCalls = try? JSONDecoder().decode([JSONValue].self, from: data)
        } else {
            toolCalls = nil
        }
        let contentParts: [JSONValue]?
        if let data = cachedMessage.contentPartsData {
            contentParts = try? JSONDecoder().decode([JSONValue].self, from: data)
        } else {
            contentParts = nil
        }
        let activityScene = cachedMessage.activitySceneData.flatMap {
            try? JSONDecoder().decode(AssistantActivityScene.self, from: $0)
        }
        self.init(
            role: cachedMessage.role,
            content: cachedMessage.content,
            timestamp: cachedMessage.timestamp,
            messageId: cachedMessage.messageId,
            name: cachedMessage.name,
            toolCallId: cachedMessage.toolCallId,
            toolUseId: cachedMessage.toolUseId,
            toolCalls: toolCalls,
            contentParts: contentParts,
            reasoning: cachedMessage.reasoning,
            reasoningTitles: cachedMessage.reasoningTitlesData.flatMap { try? JSONDecoder().decode([String].self, from: $0) },
            activityScene: activityScene,
            attachments: attachments,
            turnDuration: cachedMessage.turnDuration,
            turnTps: cachedMessage.turnTps,
            turnId: cachedMessage.turnId,
            steer: cachedMessage.steerData.flatMap { try? JSONDecoder().decode([String: JSONValue].self, from: $0) },
            displayExcerpt: cachedMessage.displayExcerpt,
            displayBody: cachedMessage.displayBodyData.flatMap { try? JSONDecoder().decode(TranscriptDisplayBody.self, from: $0) },
            backgroundUpdate: cachedMessage.backgroundUpdateData.flatMap { try? JSONDecoder().decode(BackgroundUpdate.self, from: $0) },
            backgroundSilent: cachedMessage.backgroundSilent == true,
            markerKind: ChatMarkerMessageKind(wireValue: cachedMessage.markerKind),
            markerBody: cachedMessage.markerBody
        )
    }
}
