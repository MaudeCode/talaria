import Foundation


struct QueuedSlashMessage {
    let id = UUID()
    let text: String
    let attachments: [PendingAttachment]
    /// TAL-441: a steer whose request failed; the server reporting this ID means it has the message.
    let steerID: String?
}

/// A queued message as the queue sheet lists it (TAL-630): its text and the files that go with it.
public struct QueuedMessagePreview: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let text: String
    public let attachmentNames: [String]
    /// A failed steer's queued copy: the server may have it, so it cannot be changed or sent again.
    public let mayBeOnServer: Bool

    public init(id: UUID, text: String, attachmentNames: [String], mayBeOnServer: Bool = false) {
        self.id = id
        self.text = text
        self.attachmentNames = attachmentNames
        self.mayBeOnServer = mayBeOnServer
    }

    public var attachmentCount: Int { attachmentNames.count }

    /// Send now steers the message into the running reply, and a steer carries text only.
    public var canSendNow: Bool { attachmentCount == 0 && !text.isEmpty && !mayBeOnServer }

    /// Edit and Remove take it out of the queue, which only works for a message the server does not hold.
    public var canChange: Bool { !mayBeOnServer }
}
