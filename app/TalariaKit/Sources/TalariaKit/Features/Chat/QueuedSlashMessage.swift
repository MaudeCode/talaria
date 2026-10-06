import Foundation


struct QueuedSlashMessage {
    let id = UUID()
    let text: String
    let attachments: [PendingAttachment]
    /// TAL-441: a steer whose request failed; the server reporting this ID means it has the message.
    let steerID: String?
}

/// A queued message as the floating queue chip lists it (TAL-630): its text and how many files go with it.
public struct QueuedMessagePreview: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let text: String
    public let attachmentCount: Int

    public init(id: UUID, text: String, attachmentCount: Int) {
        self.id = id
        self.text = text
        self.attachmentCount = attachmentCount
    }

    /// Send now steers the message into the running reply, and a steer carries text only.
    public var canSendNow: Bool { attachmentCount == 0 && !text.isEmpty }
}
