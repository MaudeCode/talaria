import Foundation
import SwiftData

@Model
public final class CachedMessage {
    @Attribute(.unique) var cacheKey: String
    var serverURLString: String
    var sessionID: String
    var sortIndex: Int
    var role: String?
    var content: String?
    var timestamp: Double?
    var messageId: String?
    var name: String?
    var toolCallId: String?
    var toolUseId: String?
    var toolCallsData: Data?
    var contentPartsData: Data?
    var reasoning: String?
    var reasoningTitlesData: Data?
    var activitySceneData: Data?
    var attachmentsData: Data?
    var turnDuration: Double?
    var turnTps: Double?
    var turnId: String?
    var steerData: Data?
    var displayExcerpt: String?
    var collapsible: Bool?
    var displayBodyData: Data?
    var backgroundUpdateData: Data?
    var talariaActivityData: Data?
    var backgroundSilent: Bool?
    var markerKind: String?
    var markerBody: String?
    var refusedNotice: String?
    var display: String?
    var cachedAt: Date
    var expiresAt: Date

    init(
        serverURLString: String,
        sessionID: String,
        message: ChatMessage,
        sortIndex: Int,
        cachedAt: Date = Date()
    ) {
        self.cacheKey = Self.cacheKey(
            serverURLString: serverURLString,
            sessionID: sessionID,
            message: message,
            sortIndex: sortIndex
        )
        self.serverURLString = serverURLString
        self.sessionID = sessionID
        self.sortIndex = sortIndex
        self.cachedAt = cachedAt
        self.expiresAt = cachedAt.addingTimeInterval(CachePolicy.ttl)
        apply(message, sortIndex: sortIndex, cachedAt: cachedAt)
    }

    static func cacheKey(
        serverURLString: String,
        sessionID: String,
        message: ChatMessage,
        sortIndex: Int
    ) -> String {
        let messagePart = message.messageId ?? "\(sortIndex)-\(message.timestamp ?? 0)"
        return "\(serverURLString)|session|\(sessionID)|message|\(messagePart)"
    }

    func apply(_ message: ChatMessage, sortIndex: Int, cachedAt: Date = Date(), encoder: JSONEncoder = JSONEncoder()) {
        var row = CacheRowWriter(row: self, encoder: encoder)
        row.set(\.sortIndex, sortIndex)
        row.set(\.role, message.role)
        row.set(\.content, message.content)
        row.set(\.timestamp, message.timestamp)
        row.set(\.messageId, message.messageId)
        row.set(\.name, message.name)
        row.set(\.toolCallId, message.toolCallId)
        row.set(\.toolUseId, message.toolUseId)
        row.setJSON(\.toolCallsData, message.toolCalls.flatMap { $0.isEmpty ? nil : $0 })
        row.setJSON(\.contentPartsData, message.contentParts.flatMap { $0.isEmpty ? nil : $0 })
        row.set(\.reasoning, message.reasoning)
        row.setJSON(\.reasoningTitlesData, message.reasoningTitles)
        row.setJSON(\.activitySceneData, message.activityScene)
        row.set(\.turnDuration, message.turnDuration)
        row.set(\.turnTps, message.turnTps)
        row.set(\.turnId, message.turnId)
        row.setJSON(\.steerData, message.steer)
        row.set(\.displayExcerpt, message.displayExcerpt)
        row.set(\.collapsible, message.collapsible ? true : nil)
        row.setJSON(\.displayBodyData, message.displayBody)
        row.setJSON(\.backgroundUpdateData, message.backgroundUpdate)
        row.setJSON(\.talariaActivityData, message.talariaActivity)
        row.set(\.backgroundSilent, message.backgroundSilent ? true : nil)
        row.set(\.markerKind, message.markerKind?.wireValue)
        row.set(\.markerBody, message.markerBody)
        row.set(\.refusedNotice, message.markerKind?.refusedNotice)
        row.set(\.display, message.display?.rawValue)
        row.setJSON(\.attachmentsData, message.attachments.flatMap { $0.isEmpty ? nil : $0 })
        row.renew(cachedAt: \.cachedAt, expiresAt: \.expiresAt, at: cachedAt)
    }
}
