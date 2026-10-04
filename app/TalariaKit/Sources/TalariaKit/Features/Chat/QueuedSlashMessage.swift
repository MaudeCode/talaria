
struct QueuedSlashMessage {
    let text: String
    let attachments: [PendingAttachment]
    /// TAL-441: a steer whose request failed; the server reporting this ID means it has the message.
    let steerID: String?
}
