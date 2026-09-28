import Foundation

public struct PendingNewChatRoute: Identifiable, Hashable {
    public let id = UUID()
    public let initialDraft: String
    public let initialAttachments: [SharedAttachmentImport]
    /// When true, the composer auto-starts voice dictation on appear (#338).
    public let autoStartsVoiceInput: Bool
    /// When set, the new session is created pinned to this profile (#339).
    public let profileName: String?
    public let providerID: String?

    public init(
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        autoStartsVoiceInput: Bool = false,
        profileName: String? = nil,
        providerID: String? = nil
    ) {
        self.initialDraft = initialDraft
        self.initialAttachments = initialAttachments
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
    }

    public static func == (lhs: PendingNewChatRoute, rhs: PendingNewChatRoute) -> Bool {
        lhs.id == rhs.id
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
