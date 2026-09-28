import Foundation
import TalariaKit

struct ActiveChatStreamSnapshot: Equatable {
    let messages: [ChatMessage]
    let messagesOffset: Int
    let displayTitle: String
    let completedToolCallGroups: [ToolCallGroup]
    let completedReasoningGroups: [ReasoningGroup]
    let liveAssistantActivity: AssistantActivityTimeline
    let activeStreamLastEventID: String?
    let streamingAssistantMessageID: String?
    let toolCallAnchorMessageID: String?
    let reasoningAnchorMessageID: String?
    let contextWindowSnapshot: ContextWindowSnapshot?
    let localAttachmentPreviews: [String: [String: Data]]
    let pinnedLocalNotices: [String]
}

struct ActiveChatStreamSnapshotKey: Hashable {
    let server: String
    let sessionID: String
    let streamID: String
}

final class ActiveChatStreamSnapshotStore {
    static let shared = ActiveChatStreamSnapshotStore()

    private let lock = NSLock()
    private var snapshots: [ActiveChatStreamSnapshotKey: ActiveChatStreamSnapshot] = [:]

    private init() {}

    func save(
        _ snapshot: ActiveChatStreamSnapshot,
        server: URL,
        sessionID: String,
        streamID: String
    ) {
        lock.lock()
        defer { lock.unlock() }
        snapshots[key(server: server, sessionID: sessionID, streamID: streamID)] = snapshot
    }

    func snapshot(server: URL, sessionID: String, streamID: String) -> ActiveChatStreamSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        return snapshots[key(server: server, sessionID: sessionID, streamID: streamID)]
    }

    func remove(server: URL, sessionID: String, streamID: String) {
        lock.lock()
        defer { lock.unlock() }
        snapshots.removeValue(forKey: key(server: server, sessionID: sessionID, streamID: streamID))
    }

    func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        snapshots.removeAll()
    }

    private func key(server: URL, sessionID: String, streamID: String) -> ActiveChatStreamSnapshotKey {
        ActiveChatStreamSnapshotKey(
            server: server.absoluteString,
            sessionID: sessionID,
            streamID: streamID
        )
    }
}
