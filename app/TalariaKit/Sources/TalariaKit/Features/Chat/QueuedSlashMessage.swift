
struct QueuedSlashMessage {
    let text: String
    let attachments: [PendingAttachment]
    /// TAL-441: a steer whose request failed; the server reporting this ID means it has the message.
    let steerID: String?
}

/// A queued message as the floating queue chip lists it (TAL-630): its text and how many files go with it.
public struct QueuedMessagePreview: Equatable, Sendable {
    public let text: String
    public let attachmentCount: Int

    public init(text: String, attachmentCount: Int) {
        self.text = text
        self.attachmentCount = attachmentCount
    }
}
