import Foundation
import SwiftData

public enum CacheStore {
    // Weak keys avoid retaining discarded contexts or confusing a new context with a reused address.
    @MainActor private static let maintenanceDates = NSMapTable<ModelContext, NSDate>(
        keyOptions: [.weakMemory, .objectPointerPersonality], valueOptions: .strongMemory
    )

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
            .filter { $0.transcriptOnly != true && $0.archived != true && $0.expiresAt > now }
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

    /// Restores the server-selected page without applying a second raw-row limit. Legacy or
    /// partially evicted pages use the existing bounded fallback until the next successful load.
    @MainActor
    public static func cachedTranscriptWindow(
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        legacyLimit: Int = 50,
        now: Date = Date()
    ) throws -> (messages: [ChatMessage], messagesOffset: Int, hasOlderMessages: Bool, recentMessagesOffset: Int?) {
        let key = CachedSession.cacheKey(serverURLString: serverURL.absoluteString, sessionID: sessionID)
        if let row = try cachedSession(cacheKey: key, in: context),
           let offset = row.recentMessagesOffset,
           let count = row.recentMessagesCount,
           let expiresAt = row.recentMessagesExpiresAt, expiresAt > now {
            let messages = try cachedMessages(serverURL: serverURL, sessionID: sessionID, in: context, now: now)
            if messages.count == count {
                return (messages, offset, row.recentMessagesTruncated == true, offset)
            }
        }
        return (try cachedMessages(serverURL: serverURL, sessionID: sessionID, in: context, limit: legacyLimit, now: now), 0, false, nil)
    }

    @MainActor
    public static func cacheRunStatus(_ status: RunStatus?, serverURL: URL, sessionID: String, in context: ModelContext) throws {
        try cacheDetailField(status, at: \.runStatusData, serverURL: serverURL, sessionID: sessionID, in: context)
    }

    @MainActor
    public static func cachedRunStatus(serverURL: URL, sessionID: String, in context: ModelContext, now: Date = Date()) throws -> RunStatus? {
        try cachedDetailField(RunStatus.self, at: \.runStatusData, serverURL: serverURL, sessionID: sessionID, in: context, now: now)
    }

    @MainActor
    public static func cacheOwnerAttachment(_ attachment: OwnerAttachment?, serverURL: URL, sessionID: String, in context: ModelContext) throws {
        try cacheDetailField(attachment, at: \.ownerAttachmentData, serverURL: serverURL, sessionID: sessionID, in: context)
    }

    @MainActor
    public static func cachedOwnerAttachment(serverURL: URL, sessionID: String, in context: ModelContext, now: Date = Date()) throws -> OwnerAttachment? {
        try cachedDetailField(OwnerAttachment.self, at: \.ownerAttachmentData, serverURL: serverURL, sessionID: sessionID, in: context, now: now)
    }

    @MainActor
    public static func cacheExecutionMode(_ mode: ExecutionMode?, serverURL: URL, sessionID: String, in context: ModelContext) throws {
        try cacheDetailField(mode, at: \.executionModeData, serverURL: serverURL, sessionID: sessionID, in: context)
    }

    @MainActor
    public static func cachedExecutionMode(serverURL: URL, sessionID: String, in context: ModelContext, now: Date = Date()) throws -> ExecutionMode? {
        try cachedDetailField(ExecutionMode.self, at: \.executionModeData, serverURL: serverURL, sessionID: sessionID, in: context, now: now)
    }

    /// A detail-only server field kept as JSON on the session's cached row, which must already exist.
    @MainActor
    private static func cacheDetailField<Value: Encodable>(
        _ value: Value?,
        at field: ReferenceWritableKeyPath<CachedSession, Data?>,
        serverURL: URL,
        sessionID: String,
        in context: ModelContext
    ) throws {
        let key = CachedSession.cacheKey(serverURLString: serverURL.absoluteString, sessionID: sessionID)
        guard let row = try cachedSession(cacheKey: key, in: context) else { return }
        let data = try value.map { try JSONEncoder().encode($0) }
        guard row[keyPath: field] != data else { return }
        row[keyPath: field] = data
        try context.save()
    }

    @MainActor
    private static func cachedDetailField<Value: Decodable>(
        _ type: Value.Type,
        at field: KeyPath<CachedSession, Data?>,
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        now: Date
    ) throws -> Value? {
        let key = CachedSession.cacheKey(serverURLString: serverURL.absoluteString, sessionID: sessionID)
        guard let row = try cachedSession(cacheKey: key, in: context), row.expiresAt > now,
              let data = row[keyPath: field] else { return nil }
        return try? JSONDecoder().decode(type, from: data)
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
                if cachedSession.listPosition != position {
                    cachedSession.listPosition = position
                }
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
            removeFromCachedList(staleSession, in: context, now: cachedAt)
        }

        try saveChanges(in: context, now: cachedAt)
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
                removeFromCachedList(cachedSession, in: context, now: cachedAt)
            }
        } else if let cachedSession = try cachedSession(cacheKey: cacheKey, in: context) {
            cachedSession.apply(session, cachedAt: cachedAt)
        } else {
            context.insert(CachedSession(serverURLString: serverURLString, session: session, cachedAt: cachedAt))
        }

        try saveChanges(in: context, now: cachedAt)
    }

    /// Records a session's `branched_from` from its detail (TAL-454). A chat the list has not cached yet (one opened
    /// straight from `/fork`) gets its row from that detail, so the link shows offline too.
    @MainActor
    public static func cacheBranchedFrom(
        _ link: SessionBranchLink?,
        session: SessionSummary,
        serverURL: URL,
        in context: ModelContext
    ) throws {
        guard let sessionID = session.sessionId else { return }
        let serverURLString = serverURL.absoluteString
        let cacheKey = CachedSession.cacheKey(serverURLString: serverURLString, sessionID: sessionID)
        let row: CachedSession
        if let cachedSession = try cachedSession(cacheKey: cacheKey, in: context) {
            guard cachedSession.branchedFromSessionID != link?.sessionId || cachedSession.branchedFromTitle != link?.title else { return }
            row = cachedSession
        } else {
            guard link != nil, session.archived != true else { return }
            row = CachedSession(serverURLString: serverURLString, session: session)
            context.insert(row)
        }
        row.branchedFromSessionID = link?.sessionId
        row.branchedFromTitle = link?.title
        try context.save()
    }

    @MainActor
    public static func cachedBranchedFrom(
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        now: Date = Date()
    ) throws -> SessionBranchLink? {
        let cacheKey = CachedSession.cacheKey(serverURLString: serverURL.absoluteString, sessionID: sessionID)
        guard let cachedSession = try cachedSession(cacheKey: cacheKey, in: context),
              cachedSession.expiresAt > now,
              let sessionID = cachedSession.branchedFromSessionID,
              let title = cachedSession.branchedFromTitle
        else { return nil }
        return SessionBranchLink(sessionId: sessionID, title: title)
    }

    @MainActor
    public static func cacheMessages(
        _ messages: [ChatMessage],
        serverURL: URL,
        sessionID: String,
        in context: ModelContext,
        messagesOffset: Int? = nil,
        hasOlderMessages: Bool = false,
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

        let key = CachedSession.cacheKey(serverURLString: serverURLString, sessionID: sessionID)
        var session = try cachedSession(cacheKey: key, in: context)
        if session == nil, messagesOffset != nil {
            let row = CachedSession(serverURLString: serverURLString, session: SessionSummary(sessionId: sessionID), cachedAt: cachedAt)
            row.transcriptOnly = true
            context.insert(row)
            session = row
        }
        session?.recentMessagesOffset = messagesOffset
        session?.recentMessagesTruncated = messagesOffset.map { _ in hasOlderMessages }
        session?.recentMessagesCount = messagesOffset.map { _ in messages.count }
        session?.recentMessagesExpiresAt = messagesOffset.map { _ in cachedAt.addingTimeInterval(CachePolicy.ttl) }

        try saveChanges(in: context, now: cachedAt)
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
    /// leaves orphaned rows behind. `sessionIDs` narrows the same purge to confirmed deletions.
    @MainActor
    public static func clearCache(for serverURL: URL, sessionIDs: [String]? = nil, in context: ModelContext) throws {
        let serverURLString = serverURL.absoluteString
        let allSessions = sessionIDs == nil
        let targetIDs = sessionIDs ?? []

        let sessionDescriptor = FetchDescriptor<CachedSession>(
            predicate: #Predicate { cachedSession in
                cachedSession.serverURLString == serverURLString && (allSessions || targetIDs.contains(cachedSession.sessionID))
            }
        )
        for cachedSession in try context.fetch(sessionDescriptor) {
            context.delete(cachedSession)
        }

        let messageDescriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { cachedMessage in
                cachedMessage.serverURLString == serverURLString && (allSessions || targetIDs.contains(cachedMessage.sessionID))
            }
        )
        for cachedMessage in try context.fetch(messageDescriptor) {
            context.delete(cachedMessage)
        }

        try context.save()
    }

    @MainActor
    private static func removeFromCachedList(_ session: CachedSession, in context: ModelContext, now: Date) {
        if (session.recentMessagesExpiresAt ?? .distantPast) > now {
            if session.transcriptOnly != true {
                session.transcriptOnly = true
            }
        } else {
            context.delete(session)
        }
    }

    /// Foreground entry bypasses the write-path throttle, even when no server refresh succeeds.
    @MainActor
    public static func maintainCache(in context: ModelContext, now: Date = Date()) throws {
        try saveChanges(in: context, now: now, forceMaintenance: true)
    }

    @MainActor
    private static func saveChanges(in context: ModelContext, now: Date, forceMaintenance: Bool = false) throws {
        let lastMaintenance = maintenanceDates.object(forKey: context) as Date?
        let needsMaintenance = forceMaintenance || lastMaintenance.map {
            now.timeIntervalSince($0) >= CachePolicy.maintenanceInterval || now < $0
        } ?? true
        if needsMaintenance {
            try performMaintenance(in: context, now: now)
        }
        if context.hasChanges {
            try context.save()
        }
        // A failed maintenance/save must remain eligible for retry.
        if needsMaintenance {
            maintenanceDates.setObject(now as NSDate, forKey: context)
        }
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
            guard (session.recentMessagesExpiresAt ?? .distantPast) <= now else { continue }
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
        let messages = try context.fetch(descriptor)
        try invalidateTranscriptWindows(for: messages, in: context)
        for message in messages {
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
        let messages = try context.fetch(descriptor)
        try invalidateTranscriptWindows(for: messages, in: context)
        for message in messages {
            context.delete(message)
        }
    }

    @MainActor
    private static func invalidateTranscriptWindows(for messages: [CachedMessage], in context: ModelContext) throws {
        let keys = Set(messages.map { CachedSession.cacheKey(serverURLString: $0.serverURLString, sessionID: $0.sessionID) })
        for key in keys {
            guard let session = try cachedSession(cacheKey: key, in: context) else { continue }
            session.recentMessagesOffset = nil
            session.recentMessagesTruncated = nil
            session.recentMessagesCount = nil
            session.recentMessagesExpiresAt = nil
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
        sidebarGroup = cachedSession.sidebarGroup
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
        canBranch = cachedSession.canBranch
        canPin = cachedSession.canPin
        canArchive = cachedSession.canArchive
        canDelete = cachedSession.canDelete
        canDuplicate = cachedSession.canDuplicate
        matchType = nil
        matchPreview = nil
        // A prompt waiting on the user is live state; a cached row shows none.
        attention = nil
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
            collapsible: cachedMessage.collapsible == true,
            displayBody: cachedMessage.displayBodyData.flatMap { try? JSONDecoder().decode(TranscriptDisplayBody.self, from: $0) },
            backgroundUpdate: cachedMessage.backgroundUpdateData.flatMap { try? JSONDecoder().decode(BackgroundUpdate.self, from: $0) },
            backgroundSilent: cachedMessage.backgroundSilent == true,
            markerKind: ChatMarkerMessageKind(wireValue: cachedMessage.markerKind),
            markerBody: cachedMessage.markerBody,
            display: cachedMessage.display.flatMap(ChatMessage.Display.init(rawValue:))
        )
    }
}
