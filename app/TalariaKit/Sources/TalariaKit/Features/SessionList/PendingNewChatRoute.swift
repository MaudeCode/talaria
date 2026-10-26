import Foundation

/// One creation request's outcome, kept with its own error and retry safety across navigation.
public enum ChatSessionStartResult {
    /// `detail` is the server's created session, which carries what a list row lacks (TAL-1045).
    case started(SessionSummary, detail: SessionDetail? = nil)
    case failed(String, canRetry: Bool = true, error: Error? = nil)
}

public struct PendingNewChatRoute: Identifiable, Hashable {
    public let id = UUID()
    public let initialDraft: String
    public let initialAttachments: [SharedAttachmentImport]
    /// Explicit compose/intent routes focus the composer; every route waits for Send or Files to create a session.
    public let isExplicit: Bool
    /// When true, the composer auto-starts voice dictation on appear (#338).
    public let autoStartsVoiceInput: Bool
    /// When set, the new session is created pinned to this profile (#339).
    public let profileName: String?
    public let providerID: String?
    /// The project the Chats list was filtered to when New Chat opened (TAL-455).
    public let projectID: String?
    /// The diagnostic mode the server creates the chat in (TAL-1045); nil starts a normal chat.
    public let executionMode: ExecutionMode?

    public init(
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        isExplicit: Bool = true,
        autoStartsVoiceInput: Bool = false,
        profileName: String? = nil,
        providerID: String? = nil,
        projectID: String? = nil,
        executionMode: ExecutionMode? = nil
    ) {
        self.initialDraft = initialDraft
        self.initialAttachments = initialAttachments
        self.isExplicit = isExplicit
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
        self.projectID = projectID
        self.executionMode = executionMode
    }

    public static func == (lhs: PendingNewChatRoute, rhs: PendingNewChatRoute) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
